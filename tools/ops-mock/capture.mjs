// Replay real Claude transcripts through the REAL OpsService and dump the
// resulting snapshot sequences as JSON samples.
//
// Why replay rather than record live: the board's emptiness is the question, and
// you cannot answer it by watching whatever happens to be running right now. A
// sample has to be a chosen window — the busiest ninety seconds of a real
// session, a forky one, a quiet one — so the renderers can be judged on the data
// they will actually have to survive.
//
// Faithfulness matters more than convenience here, so this drives the shipping
// code path, not a reimplementation of it:
//
//   • HOME is pointed at a sandbox before anything imports, because the
//     transcript tailer resolves ~/.claude/projects at module load. The replay
//     writes a growing prefix of the real transcript into that sandbox, so the
//     tailer does its real tail-read against a file that looks exactly like the
//     one it reads in production.
//   • Date.now is driven by a virtual clock, so every TTL, dwell and staleness
//     rule in the service fires on the transcript's own timeline.
//   • Snapshots come from OpsService.build(), the same method the live tick uses.
//
// Usage:  node tools/ops-mock/capture.mjs [--out FILE] [--secs 90] [--fps 1]
// Writes: tools/ops-mock/samples.json

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { createServer } from 'vite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const REAL_HOME = os.homedir()
const PROJECTS = path.join(REAL_HOME, '.claude', 'projects')

const args = process.argv.slice(2)
const argOf = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const OUT = argOf('--out', path.join(HERE, 'samples.json'))
const WINDOW_SECS = Number(argOf('--secs', '90'))
const FPS = Number(argOf('--fps', '1'))
const TICK_MS = Math.round(1000 / FPS)

// ---------------------------------------------------------------- transcripts

const tsOf = (d) => {
  const t = d && (d.timestamp || d.ts)
  const n = t ? Date.parse(t) : 0
  return Number.isFinite(n) ? n : 0
}

function readRecords(file) {
  const out = []
  // Big transcripts are read in full once; the replay slices from memory after.
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const d = JSON.parse(line)
      const at = tsOf(d)
      if (at) out.push({ at, line, d })
    } catch { /* partial or non-JSON line */ }
  }
  out.sort((a, b) => a.at - b.at)
  return out
}

// How many tool calls a record starts — the density signal used to pick windows.
function toolStarts(d) {
  const c = d?.message?.content
  if (!Array.isArray(c)) return 0
  return c.filter((b) => b && b.type === 'tool_use').length
}

// Same rule the tailer applies (isUserPrompt): only prompts a person stacked
// count. Scoring on raw queue-operations would happily pick a window full of
// observed_from_primary_session chatter and then report the lane as empty.
const MACHINE_QUEUE_TAGS =
  /^<\/?(observed_from_primary_session|task-notification|system-reminder|local-command-stdout|local-command-stderr|command-name|command-message|command-args)\b/
const isQueue = (d) => {
  if (d?.type !== 'queue-operation') return false
  if ((d.operation ?? d.op) !== 'enqueue') return false
  const txt = typeof d.content === 'string' ? d.content.replace(/\s+/g, ' ').trim() : ''
  return !!txt && !MACHINE_QUEUE_TAGS.test(txt)
}

// Pick a WINDOW_SECS stretch. Which stretch depends on what the sample is meant
// to exercise, and choosing wrong is how a lane looks dead when it isn't:
//
//   dense — most tool calls. The board at full tilt.
//   queue — most queue-operations. You only stack prompts while typing ahead,
//           which is a different moment from peak tool traffic; sampling on
//           density alone reports QUEUED as permanently empty when it is not.
//   turn  — activity followed by quiet. The service only believes a pane went
//           idle after IDLE_DWELL_MS (30s), and LANDED is minted on that
//           transition, so an outcome can only appear in a window that contains
//           a real turn boundary. A window of pure work never shows one.
function pickWindow(recs, secs, mode) {
  const span = secs * 1000
  let best = null
  for (let i = 0; i < recs.length; i++) {
    const end = recs[i].at + span
    let calls = 0, queues = 0, j = i
    for (; j < recs.length && recs[j].at <= end; j++) {
      calls += toolStarts(recs[j].d)
      if (isQueue(recs[j].d)) queues++
    }
    let score
    if (mode === 'queue') score = queues * 100 + calls
    else if (mode === 'turn') {
      // Work early, then a gap wide enough for the pane to settle to ready.
      let gap = 0
      for (let k = i + 1; k < j; k++) gap = Math.max(gap, recs[k].at - recs[k - 1].at)
      score = gap >= 40000 && calls > 0 ? calls * 10 + Math.min(gap, 60000) / 1000 : -1
    } else score = calls
    if (score > 0 && (!best || score > best.score)) best = { score, calls, queues, from: i, to: j, t0: recs[i].at }
  }
  return best
}

function pickSources(limit) {
  const dirs = []
  for (const slug of fs.readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, slug)
    let stat
    try { stat = fs.statSync(dir) } catch { continue }
    if (!stat.isDirectory()) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const p = path.join(dir, f)
      try {
        const s = fs.statSync(p)
        // Big enough to hold a busy stretch, small enough to parse quickly.
        if (s.size > 300 * 1024 && s.size < 40 * 1024 * 1024) dirs.push({ file: p, slug, size: s.size, mtime: s.mtimeMs })
      } catch { /* ignore */ }
    }
  }
  dirs.sort((a, b) => b.mtime - a.mtime)
  // One per project, newest first, so the samples are different sessions rather
  // than several slices of the same one.
  const seen = new Set()
  const out = []
  for (const d of dirs) {
    if (seen.has(d.slug)) continue
    seen.add(d.slug)
    out.push(d)
    if (out.length >= limit) break
  }
  return out
}

// ------------------------------------------------------------------- sandbox

// The tailer resolves ~/.claude/projects at import time, so HOME must be
// rewritten before Vite loads any of the plugin's modules.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-ops-capture-'))
process.env.HOME = SANDBOX

const CWD = path.join(SANDBOX, 'work')
fs.mkdirSync(CWD, { recursive: true })
const slugForCwd = (cwd) => cwd.replace(/\//g, '-')
const SANDBOX_DIR = path.join(SANDBOX, '.claude', 'projects', slugForCwd(CWD))
fs.mkdirSync(SANDBOX_DIR, { recursive: true })
const SANDBOX_FILE = path.join(SANDBOX_DIR, 'replay.jsonl')

// --------------------------------------------------------------------- replay

async function main() {
  const server = await createServer({
    configFile: false,
    root: REPO,
    logLevel: 'error',
    server: { middlewareMode: true },
  })

  const svcMod = await server.ssrLoadModule('/src/plugins/ops-console/main/service.ts')

  const sources = pickSources(10)
  if (!sources.length) {
    console.error('no transcripts large enough in ' + PROJECTS)
    process.exit(1)
  }

  // Every lane gets a window chosen to exercise it, so an empty lane in the
  // result means the lane is empty — not that the sampler looked elsewhere.
  const MODES = ['dense', 'dense', 'queue', 'queue', 'turn', 'turn']
  const realNow = Date.now
  const samples = []
  let mi = 0

  for (const src of sources) {
    if (mi >= MODES.length) break
    const mode = MODES[mi]
    const name = src.slug.replace(/^-Users-[^-]+-projects?-?b?-?/, '').replace(/^-+/, '') || src.slug
    process.stdout.write(`· ${name} [${mode}] … `)
    let recs
    try { recs = readRecords(src.file) } catch { console.log('unreadable'); continue }
    if (recs.length < 40) { console.log('too short'); continue }

    const win = pickWindow(recs, WINDOW_SECS, mode)
    if (!win || win.calls === 0) { console.log(`no ${mode} window`); continue }
    mi++

    // Everything before the window is pre-written, so the tail the service reads
    // has the same shape it would mid-session (history behind, work arriving).
    const head = recs.slice(Math.max(0, win.from - 400), win.from)
    fs.writeFileSync(SANDBOX_FILE, head.map((r) => r.line).join('\n') + (head.length ? '\n' : ''))

    const frames = []
    let cursor = win.from
    let virtual = win.t0

    // Pane state must come from the data, not be pinned. The first pass pinned
    // it to claude-active, which made LANDED and BLOCKED structurally impossible
    // and then read as "those lanes are dead". Derive it the way the app's own
    // detector effectively does: recent transcript growth = generating, a long
    // gap = parked at the prompt.
    const lastRecordBefore = (t) => {
      let at = 0
      for (let k = Math.max(0, win.from - 400); k < recs.length && recs[k].at <= t; k++) at = recs[k].at
      return at
    }
    const stateAt = (t) => (t - lastRecordBefore(t) < 12000 ? 'claude-active' : 'claude-idle')

    // A fresh service per sample: carriers, TTL state and the feed must not leak
    // between samples or the second one starts mid-story.
    const ctx = makeReplayContext(CWD, () => virtual, stateAt)
    const svc = new svcMod.OpsService(ctx)

    const endAt = win.t0 + WINDOW_SECS * 1000
    try {
      Date.now = () => virtual
      while (virtual <= endAt) {
        // Append every record the transcript produced before this instant.
        let chunk = ''
        while (cursor < recs.length && recs[cursor].at <= virtual) chunk += recs[cursor++].line + '\n'
        if (chunk) fs.appendFileSync(SANDBOX_FILE, chunk)
        // The service caches transcript reads for 1.5s of ITS clock, which the
        // virtual clock advances past on every tick, so each tick re-reads.
        const snap = await svc.build()
        frames.push(snap)
        virtual += TICK_MS
      }
    } finally {
      Date.now = realNow
    }

    const cards = frames.reduce((n, f) => n + f.cards.length, 0)
    const lanes = {}
    for (const f of frames) for (const l of new Set(f.cards.map((c) => c.col))) lanes[l] = (lanes[l] ?? 0) + 1
    samples.push({
      id: name,
      label: name,
      mode,
      source: path.basename(src.file),
      windowSecs: WINDOW_SECS,
      tickMs: TICK_MS,
      toolCalls: win.calls,
      queueOps: win.queues ?? 0,
      frames,
    })
    console.log(
      `${frames.length}f · ${win.calls} calls · ${win.queues ?? 0} queue · ` +
      `${(cards / frames.length).toFixed(1)} cards/f · lanes ${Object.keys(lanes).join(',') || 'none'}`,
    )
  }

  fs.writeFileSync(OUT, JSON.stringify({ capturedAt: new Date(realNow()).toISOString(), samples }, null, 0))
  console.log(`\nwrote ${samples.length} samples → ${OUT}`)
  await server.close()
  fs.rmSync(SANDBOX, { recursive: true, force: true })
  process.exit(0)
}

function makeReplayContext(cwd, nowFn, stateAt) {
  const panes = [{ id: 0, pos: 0, cwd, folder: path.basename(cwd), proj: 'replay', state: 'claude-active' }]
  const snapshot = { panes, activePaneId: 0 }
  const latest = () => {
    panes[0].state = stateAt ? stateAt(nowFn()) : 'claude-active'
    return snapshot
  }
  return {
    id: 'ops-console',
    appVersion: 'capture',
    homeDir: process.env.HOME,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    getSetting: (k) => (k === 'pollIntervalMs' ? TICK_MS : undefined),
    onSettingsChanged: () => () => {},
    services: {
      ptyStats: () => ({ sessions: 1, totalBytesOut: 0, perPaneBytesOut: { 0: 0 } }),
      getGitStatus: async () => null,
      getContextUsage: async () => null,
      latestWorkspaceSnapshot: latest,
      onWorkspaceSnapshot: () => () => {},
      onPtyExit: () => () => {},
      sendToUi: () => {},
      now: nowFn,
    },
  }
}

main().catch((e) => {
  console.error(e)
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(1)
})
