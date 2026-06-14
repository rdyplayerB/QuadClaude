// DelegationLog — QuadClaude's owner of delegation telemetry on disk.
//
// The `qcdelegate` worker (see qcdelegate.sh) appends one JSON line per run to
// ~/.quadclaude/events.jsonl. That raw stream is append-only and crash-safe, but it
// grows forever, so THIS module owns its lifecycle:
//   • rollup    — fold events into a compact per-project summary (summary.json) so the
//                 UI can answer "how much of this project was delegated, and did it
//                 work?" without re-parsing a huge log every time.
//   • rotation  — when events.jsonl crosses a size cap, fold everything into the
//                 cumulative summary, then truncate the raw file. Lifetime totals
//                 survive rotation; the raw file stays bounded.
//   • retention — drop summaries for projects untouched for longer than the retention
//                 window so the store doesn't accumulate dead projects.
//
// One global events file (keyed by a `project` field per event) is deliberately simpler
// to manage than N per-project files — one rotation policy, one place to prune — while
// still giving fully per-project views in the UI.
import os from 'os'
import fs from 'fs'
import path from 'path'
import { logger } from './logger'
import { DelegationEvent, DelegationProjectSummary } from '../shared/types'

const QC_DIR = path.join(os.homedir(), '.quadclaude')
const EVENTS_PATH = path.join(QC_DIR, 'events.jsonl')
const SUMMARY_PATH = path.join(QC_DIR, 'summary.json')

// Raw event log is folded into summary.json + truncated past this size.
const MAX_EVENTS_BYTES = 2 * 1024 * 1024 // 2MB (~10k events)
// Projects with no delegation activity for this long are pruned on maintenance.
const RETENTION_DAYS = 90

// Persisted shape of summary.json: a cumulative rollup keyed by absolute project path.
interface SummaryStore {
  version: 1
  projects: Record<string, DelegationProjectSummary>
}

function emptySummary(project: string): DelegationProjectSummary {
  return {
    project,
    projectName: path.basename(project) || project,
    delegations: 0,
    succeeded: 0,
    failed: 0,
    checked: 0,
    checkPassed: 0,
    coldStartRetries: 0,
    insertions: 0,
    deletions: 0,
    filesTouched: 0,
    firstAt: '',
    lastAt: '',
  }
}

function readSummaryStore(): SummaryStore {
  try {
    const raw = fs.readFileSync(SUMMARY_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.projects) return parsed as SummaryStore
  } catch {
    /* missing or corrupt — start fresh */
  }
  return { version: 1, projects: {} }
}

function writeSummaryStore(store: SummaryStore): void {
  try {
    fs.mkdirSync(QC_DIR, { recursive: true })
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    logger.error('delegation', 'Failed to write summary.json', error instanceof Error ? error.message : String(error))
  }
}

// Parse events.jsonl tolerantly: skip blank/garbled lines rather than throwing, so one
// bad append (e.g. a crash mid-write) can never poison the whole metrics view.
function readEvents(): DelegationEvent[] {
  let raw: string
  try {
    raw = fs.readFileSync(EVENTS_PATH, 'utf8')
  } catch {
    return []
  }
  const out: DelegationEvent[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const e = JSON.parse(t)
      if (e && e.type === 'delegation' && typeof e.project === 'string') out.push(e as DelegationEvent)
    } catch {
      /* skip malformed line */
    }
  }
  return out
}

// Fold a single event into a project's running totals.
function applyEvent(s: DelegationProjectSummary, e: DelegationEvent): void {
  s.delegations += 1
  if (e.exit === 0) s.succeeded += 1
  else s.failed += 1
  s.coldStartRetries += e.coldStartRetries || 0
  s.insertions += e.insertions || 0
  s.deletions += e.deletions || 0
  s.filesTouched += e.files ? e.files.split(';').filter(Boolean).length : 0
  if (e.check && typeof e.check.exit === 'number') {
    s.checked += 1
    if (e.check.exit === 0) s.checkPassed += 1
  }
  if (!s.firstAt || e.ts < s.firstAt) s.firstAt = e.ts
  if (!s.lastAt || e.ts > s.lastAt) s.lastAt = e.ts
}

function foldEventsInto(store: SummaryStore, events: DelegationEvent[]): void {
  for (const e of events) {
    const key = e.project
    if (!store.projects[key]) store.projects[key] = emptySummary(key)
    applyEvent(store.projects[key], e)
  }
}

// Compute a "% delegated" once totals are known. We can only attribute lines we
// measured (delegated insertions); direct (orchestrator) authorship isn't captured
// here, so this is reported as delegated-lines and the UI frames it accordingly.
function withDerived(s: DelegationProjectSummary): DelegationProjectSummary {
  const checkRate = s.checked > 0 ? s.checkPassed / s.checked : null
  const successRate = s.delegations > 0 ? s.succeeded / s.delegations : null
  return { ...s, checkRate, successRate }
}

class DelegationLog {
  // Current per-project summaries: cumulative store (folded/rotated history) PLUS a live
  // fold of whatever is still in events.jsonl. Cheap and always up to date.
  getSummaries(): DelegationProjectSummary[] {
    const store = readSummaryStore()
    // Clone so the live fold doesn't mutate the persisted store in memory.
    const merged: SummaryStore = { version: 1, projects: {} }
    for (const [k, v] of Object.entries(store.projects)) merged.projects[k] = { ...v }
    foldEventsInto(merged, readEvents())
    return Object.values(merged.projects)
      .map(withDerived)
      .sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''))
  }

  // Raw events for the dashboard timeline, most-recent-first, capped. (Only events
  // still in events.jsonl — rotated history lives aggregated in summary.json.)
  getEvents(limit = 2000): DelegationEvent[] {
    const events = readEvents()
    events.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    return events.slice(0, limit)
  }

  // A single self-contained, human- AND machine-readable report of all delegation
  // activity — built to be pasted straight back to Claude to analyze and improve how
  // it delegates to custom LLMs. Markdown summary + a fenced JSON block of every event.
  buildReport(): string {
    const summaries = this.getSummaries()
    const events = this.getEvents()
    const stamp = new Date().toISOString()
    const L: string[] = []
    L.push(`# QuadClaude delegation log`)
    L.push(`Generated: ${stamp}`)
    L.push('')
    const tot = events.reduce(
      (a, e) => ({
        n: a.n + 1,
        ok: a.ok + (e.exit === 0 ? 1 : 0),
        checked: a.checked + (e.check ? 1 : 0),
        checkPass: a.checkPass + (e.check && e.check.exit === 0 ? 1 : 0),
        ins: a.ins + (e.insertions || 0),
        cold: a.cold + (e.coldStartRetries || 0),
        dur: a.dur + (e.durationSec || 0),
      }),
      { n: 0, ok: 0, checked: 0, checkPass: 0, ins: 0, cold: 0, dur: 0 },
    )
    L.push(`## Totals`)
    L.push(`- Delegations: ${tot.n}`)
    L.push(`- Succeeded (exit 0): ${tot.ok}/${tot.n}`)
    L.push(`- Ground-truth checks passed: ${tot.checkPass}/${tot.checked}`)
    L.push(`- Lines delegated: ${tot.ins}`)
    L.push(`- Cold-start retries: ${tot.cold}`)
    L.push(`- Avg duration: ${tot.n ? Math.round(tot.dur / tot.n) : 0}s`)
    L.push('')
    L.push(`## Per project`)
    for (const s of summaries) {
      const cr = s.checked ? `${Math.round(100 * (s.checkPassed / s.checked))}% (${s.checkPassed}/${s.checked})` : 'n/a'
      L.push(`- **${s.projectName}** — ${s.delegations} delegations, ${s.succeeded} ok, check-pass ${cr}, ${s.insertions} lines, ${s.filesTouched} files, ${s.coldStartRetries} cold retries`)
    }
    L.push('')
    L.push(`## Events (most recent first)`)
    for (const e of events) {
      const ck = e.check ? (e.check.exit === 0 ? 'check:PASS' : `check:FAIL(${e.check.exit})`) : 'check:none'
      L.push('')
      L.push(`### ${e.ts} · ${e.task} · ${e.route}`)
      L.push(`project=${e.project} pane=${e.pane} exit=${e.exit} ${ck} +${e.insertions}/-${e.deletions} files=[${e.files}] cold=${e.coldStartRetries} dur=${e.durationSec}s git=${e.gitMode}`)
      if (e.promptPreview) L.push(`prompt: ${e.promptPreview}`)
      if (e.outputPreview) L.push(`output: ${e.outputPreview}`)
    }
    L.push('')
    L.push(`## Raw events (JSON, one per line)`)
    L.push('```json')
    for (const e of events) L.push(JSON.stringify(e))
    L.push('```')
    return L.join('\n')
  }

  // Maintenance: rotate the raw log if oversized and prune stale projects. Safe to call
  // on every startup — it's a no-op when the log is small and nothing is stale.
  maintain(): void {
    try {
      this.rotateIfNeeded()
      this.pruneStale()
    } catch (error) {
      logger.error('delegation', 'maintenance failed', error instanceof Error ? error.message : String(error))
    }
  }

  private rotateIfNeeded(): void {
    let size = 0
    try {
      size = fs.statSync(EVENTS_PATH).size
    } catch {
      return // no events file yet
    }
    if (size <= MAX_EVENTS_BYTES) return
    const events = readEvents()
    const store = readSummaryStore()
    foldEventsInto(store, events)
    writeSummaryStore(store)
    // Keep the most recent slice as a `.recent` tail for the live feed/debugging, then
    // truncate the working file so it stays bounded. Totals already live in summary.json.
    try {
      fs.renameSync(EVENTS_PATH, EVENTS_PATH + '.1')
    } catch {
      /* ignore */
    }
    logger.info('delegation', 'Rotated events.jsonl into summary.json', `${events.length} events folded`)
  }

  private pruneStale(): void {
    const store = readSummaryStore()
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString()
    let pruned = 0
    for (const [key, s] of Object.entries(store.projects)) {
      if (s.lastAt && s.lastAt < cutoff) {
        delete store.projects[key]
        pruned++
      }
    }
    if (pruned > 0) {
      writeSummaryStore(store)
      logger.info('delegation', 'Pruned stale project summaries', `${pruned} removed (>${RETENTION_DAYS}d)`)
    }
  }

  // Live tail: poll events.jsonl for newly-appended delegation events and hand each to
  // `cb`. Polling (not fs.watch) because it's reliable cross-platform and the data is
  // low-frequency. We start at the current end of file so app startup never replays
  // history as "new" delegations (which would spuriously trigger the worker-feed prompt).
  startWatching(cb: (e: DelegationEvent) => void): () => void {
    let offset = 0
    let partial = ''
    try {
      offset = fs.statSync(EVENTS_PATH).size
    } catch {
      offset = 0 // file not created yet — start from 0 when it appears
    }
    const tick = () => {
      let size: number
      try {
        size = fs.statSync(EVENTS_PATH).size
      } catch {
        return // no file yet
      }
      if (size < offset) {
        // File shrank (rotation/clear) — resync to the new end, don't replay.
        offset = size
        partial = ''
        return
      }
      if (size === offset) return
      let chunk = ''
      try {
        const fd = fs.openSync(EVENTS_PATH, 'r')
        const buf = Buffer.alloc(size - offset)
        fs.readSync(fd, buf, 0, buf.length, offset)
        fs.closeSync(fd)
        chunk = buf.toString('utf8')
      } catch {
        return
      }
      offset = size
      const text = partial + chunk
      const lines = text.split('\n')
      partial = lines.pop() ?? '' // last item is an incomplete line (no trailing \n yet)
      for (const line of lines) {
        const t = line.trim()
        if (!t) continue
        try {
          const e = JSON.parse(t)
          if (e && e.type === 'delegation' && typeof e.project === 'string') cb(e as DelegationEvent)
        } catch {
          /* skip malformed */
        }
      }
    }
    const interval = setInterval(tick, 1500)
    return () => clearInterval(interval)
  }

  // Explicit user action from Settings: wipe all delegation telemetry.
  clearAll(): void {
    for (const p of [EVENTS_PATH, EVENTS_PATH + '.1', SUMMARY_PATH]) {
      try {
        fs.rmSync(p)
      } catch {
        /* already gone */
      }
    }
    logger.info('delegation', 'Cleared all delegation telemetry')
  }
}

export const delegationLog = new DelegationLog()
