// Reads Claude Code session transcripts to enrich Ops Console cards with REAL
// data: the AI-generated session title, the last user prompt, recently edited
// files, the last question when a pane is waiting, and TodoWrite todos when a
// session uses them. Defensive by design — Claude's JSONL format varies and
// files can be huge, so we read only the tail and tolerate every shape.
//
// Slug convention (verified): cwd "/Users/x/projects/foo" → dir
// "~/.claude/projects/-Users-x-projects-foo".

import fs from 'fs'
import path from 'path'
import os from 'os'

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
const TAIL_BYTES = 256 * 1024 // read only the last 256KB of a transcript

export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

// One tool call, paired with its result. This is the unit the board animates.
export interface Step {
  id: string           // tool_use id
  name: string         // tool name
  target: string       // command / file / query — whatever identifies it
  desc?: string        // the model's own sentence about this call (Bash description,
                       // AskUserQuestion's question) — the human voice for the step
  think?: string       // reasoning from the same assistant message
  startedAt: number
  endedAt?: number     // set when the matching tool_result arrives
  tokens?: number      // real output_tokens for the issuing message
  err?: boolean
  spawns?: { name: string; desc: string } // set when this step is an Agent spawn
}
export interface TranscriptInfo {
  found: boolean
  aiTitle?: string
  lastPrompt?: string
  editedFiles: string[]   // basenames, newest last
  adds: number            // cumulative-ish adds seen in the tail
  dels: number
  todos: Todo[]
  lastAssistantText?: string // for the "question" when waiting — and the narration line:
                             // actual thinking blocks are encrypted (measured 0/200 with
                             // text), so Claude's outward prose IS the visible thinking
  lastSaidAt: number         // epoch of the newest assistant text
  lastAction?: string        // newest tool call, e.g. "Edit(service.ts)" — the live "doing X right now"
  steps: Step[]              // newest last, capped — the board's step cards
  lastThinking?: string      // newest reasoning text
  prLink?: string            // newest pr-link record in the tail
  prLabel?: string           // human form: "owner/repo #6"
  queueDepth: number         // prompts stacked behind the current turn (queue-operation)
  queued: string[]           // their text, oldest first — the QUEUED lane's cards
  lastRecordAt: number       // epoch of the newest record; "composing" = active but nothing new
  lastRecordKind: string     // 'assistant' | 'user' | ''
  notifications: string[]    // task-notification texts — how a backgrounded agent reports finishing
  mtimeMs: number
}

const MAX_STEPS = 24 // only the recent tail ever reaches a column

function tsOf(d: Record<string, unknown>): number {
  const t = d.timestamp
  if (typeof t === 'string') { const v = Date.parse(t); if (Number.isFinite(v)) return v }
  return 0
}

// A tool call's most identifying argument, so the card can say what is actually
// happening instead of just that something is.
function actionTarget(input: Record<string, unknown>): string {
  const raw =
    (typeof input.file_path === 'string' && path.basename(input.file_path)) ||
    (typeof input.command === 'string' && input.command) ||
    (typeof input.pattern === 'string' && input.pattern) ||
    (typeof input.description === 'string' && input.description) ||
    (typeof input.url === 'string' && input.url) ||
    ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, 44)
}

function slugForCwd(cwd: string): string {
  // Claude replaces every "/" with "-" (leading slash → leading dash).
  return cwd.replace(/\//g, '-')
}

export function newestTranscript(cwd: string): string | null {
  try {
    const dir = path.join(PROJECTS_DIR, slugForCwd(cwd))
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    if (!files.length) return null
    let best: { f: string; m: number } | null = null
    for (const f of files) {
      try {
        const m = fs.statSync(path.join(dir, f)).mtimeMs
        if (!best || m > best.m) best = { f, m }
      } catch { /* ignore */ }
    }
    return best ? path.join(dir, best.f) : null
  } catch {
    return null
  }
}

function readTail(file: string): { lines: unknown[]; mtimeMs: number } {
  const stat = fs.statSync(file)
  const start = Math.max(0, stat.size - TAIL_BYTES)
  const fd = fs.openSync(file, 'r')
  try {
    const len = stat.size - start
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    let text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1) // drop partial first line
    const lines: unknown[] = []
    for (const raw of text.split('\n')) {
      const s = raw.trim()
      if (!s) continue
      try { lines.push(JSON.parse(s)) } catch { /* skip malformed */ }
    }
    return { lines, mtimeMs: stat.mtimeMs }
  } finally {
    fs.closeSync(fd)
  }
}

function textOf(content: unknown): string {
  // content can be a string, or an array of blocks with {type:'text', text}
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (b && typeof b === 'object') {
        const bb = b as Record<string, unknown>
        if (bb.type === 'text' && typeof bb.text === 'string') parts.push(bb.text)
      }
    }
    return parts.join(' ')
  }
  return ''
}

// Read + parse one pane's newest session transcript tail. Never throws.
export function readTranscript(cwd: string): TranscriptInfo {
  const empty: TranscriptInfo = { found: false, editedFiles: [], adds: 0, dels: 0, todos: [], steps: [], lastRecordAt: 0, lastRecordKind: '', notifications: [], mtimeMs: 0, lastSaidAt: 0, queueDepth: 0, queued: [] }
  try {
    const file = newestTranscript(cwd)
    if (!file) return empty
    const { lines, mtimeMs } = readTail(file)
    const info: TranscriptInfo = { found: true, editedFiles: [], adds: 0, dels: 0, todos: [], steps: [], lastRecordAt: 0, lastRecordKind: '', notifications: [], mtimeMs, lastSaidAt: 0, queueDepth: 0, queued: [] }
    const byId = new Map<string, Step>()

    for (const l of lines) {
      if (!l || typeof l !== 'object') continue
      const d = l as Record<string, unknown>
      const type = d.type
      if (type === 'assistant' || type === 'user') {
        const at = tsOf(d)
        if (at > info.lastRecordAt) { info.lastRecordAt = at; info.lastRecordKind = String(type) }
      }

      // tool_result closes the step its tool_use opened — the pairing is exact.
      if (type === 'user' && d.message && typeof d.message === 'object') {
        const content = (d.message as Record<string, unknown>).content
        if (Array.isArray(content)) {
          for (const b of content) {
            if (!b || typeof b !== 'object') continue
            const bb = b as Record<string, unknown>
            if (bb.type === 'tool_result' && typeof bb.tool_use_id === 'string') {
              const step = byId.get(bb.tool_use_id)
              if (step) { step.endedAt = tsOf(d) || Date.now(); step.err = bb.is_error === true }
            }
          }
        }
        // A backgrounded agent reports back as a task-notification user message —
        // the only completion signal the parent transcript ever sees.
        const utext = textOf(content)
        if (utext.includes('task-notification')) info.notifications.push(utext.slice(0, 400))
      }

      if (type === 'ai-title' && d.aiTitle && typeof d.aiTitle === 'string') info.aiTitle = d.aiTitle
      if (type === 'last-prompt' && d.lastPrompt && typeof d.lastPrompt === 'string') info.lastPrompt = d.lastPrompt
      // pr-link is a per-turn STATE record (the same PR restated every turn,
      // 54× in one observed hour) — the last value wins; newness is the
      // service's job, by comparing URLs across ticks.
      if (type === 'pr-link') {
        const u = d.prUrl ?? d.url
        if (typeof u === 'string' && u) {
          info.prLink = u
          const repo = typeof d.prRepository === 'string' ? d.prRepository : ''
          const num = Number(d.prNumber)
          info.prLabel = (repo + (Number.isFinite(num) && num > 0 ? ` #${num}` : '')).trim() || undefined
        }
      }
      // Prompts stacked behind the current turn. Tail-window arithmetic — an
      // enqueue whose dequeue scrolled out would overcount, so floor at 0.
      if (type === 'queue-operation') {
        const op = String(d.operation ?? d.op ?? '')
        const txt = typeof d.content === 'string' ? d.content.replace(/\s+/g, ' ').trim() : ''
        if (op === 'enqueue') { info.queueDepth++; if (txt) info.queued.push(txt.slice(0, 90)) }
        else if (op === 'dequeue' || op === 'remove') {
          info.queueDepth = Math.max(0, info.queueDepth - 1)
          info.queued.shift()
        } else if (op === 'popAll') { info.queueDepth = 0; info.queued = [] }
      }

      // file-history-delta carries insertion/deletion counts
      if (type === 'file-history-delta') {
        const del = (d.delta ?? d) as Record<string, unknown>
        const a = Number(del.insertions ?? del.adds ?? 0)
        const r = Number(del.deletions ?? del.dels ?? 0)
        if (Number.isFinite(a)) info.adds += a
        if (Number.isFinite(r)) info.dels += r
      }

      // assistant messages: tool_use (Edit/Write) + last text (for questions)
      const msg = d.message
      if (type === 'assistant' && msg && typeof msg === 'object') {
        const content = (msg as Record<string, unknown>).content
        const usage = (msg as Record<string, unknown>).usage as Record<string, unknown> | undefined
        const outTok = Number(usage?.output_tokens ?? 0)
        const at = tsOf(d) || Date.now()
        // Reasoning from this message rides along with the steps it issued.
        let think = ''
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b && typeof b === 'object') {
              const bb = b as Record<string, unknown>
              if (bb.type === 'thinking' && typeof bb.thinking === 'string') think = bb.thinking
            }
          }
        }
        if (think.trim()) info.lastThinking = think.trim()
        if (Array.isArray(content)) {
          for (const b of content) {
            if (!b || typeof b !== 'object') continue
            const bb = b as Record<string, unknown>
            if (bb.type === 'tool_use') {
              const name = bb.name
              const input = (bb.input ?? {}) as Record<string, unknown>
              if (typeof name === 'string' && name) {
                const target = actionTarget(input)
                info.lastAction = target ? `${name}(${target})` : name
                // The model's own sentence about the call. Bash carries one on
                // effectively every call (227/227 measured in a live window);
                // for a question the question itself is the human line.
                let desc = typeof input.description === 'string' ? input.description.replace(/\s+/g, ' ').trim().slice(0, 90) : ''
                if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
                  const q0 = input.questions[0] as Record<string, unknown> | undefined
                  if (q0 && typeof q0.question === 'string') desc = q0.question.slice(0, 90)
                }
                if (typeof bb.id === 'string') {
                  const step: Step = {
                    id: bb.id,
                    name,
                    target,
                    desc: desc || undefined,
                    think: think.trim() ? think.trim().replace(/\s+/g, ' ').slice(0, 150) : undefined,
                    startedAt: at,
                    tokens: Number.isFinite(outTok) && outTok > 0 ? outTok : undefined,
                  }
                  // An Agent call spawns a subagent — carry its identity.
                  if (name === 'Agent') {
                    const sname = typeof input.name === 'string' ? input.name : ''
                    const sdesc = typeof input.description === 'string' ? input.description : ''
                    if (sname || sdesc) step.spawns = { name: sname || 'subagent', desc: sdesc }
                  }
                  byId.set(bb.id, step)
                  info.steps.push(step)
                  if (info.steps.length > MAX_STEPS) info.steps.shift()
                }
              }
              if ((name === 'Edit' || name === 'Write' || name === 'MultiEdit') && typeof input.file_path === 'string') {
                const base = path.basename(input.file_path)
                info.editedFiles = info.editedFiles.filter((f) => f !== base)
                info.editedFiles.push(base)
                if (info.editedFiles.length > 6) info.editedFiles.shift()
              }
              if (name === 'TodoWrite' && Array.isArray(input.todos)) {
                info.todos = (input.todos as unknown[])
                  .filter((t) => t && typeof t === 'object')
                  .map((t) => {
                    const tt = t as Record<string, unknown>
                    return {
                      content: String(tt.content ?? tt.activeForm ?? ''),
                      status: (tt.status as Todo['status']) ?? 'pending',
                      activeForm: typeof tt.activeForm === 'string' ? tt.activeForm : undefined,
                    }
                  })
                  .filter((t) => t.content)
              }
            }
          }
        }
        const txt = textOf(content).trim()
        if (txt) { info.lastAssistantText = txt; info.lastSaidAt = tsOf(d) || info.lastSaidAt }
      }
    }
    return info
  } catch {
    return empty
  }
}
