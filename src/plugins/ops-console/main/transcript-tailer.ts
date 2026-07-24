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
export interface TranscriptInfo {
  found: boolean
  aiTitle?: string
  lastPrompt?: string
  editedFiles: string[]   // basenames, newest last
  adds: number            // cumulative-ish adds seen in the tail
  dels: number
  todos: Todo[]
  lastAssistantText?: string // for the "question" when waiting
  mtimeMs: number
}

function slugForCwd(cwd: string): string {
  // Claude replaces every "/" with "-" (leading slash → leading dash).
  return cwd.replace(/\//g, '-')
}

function newestTranscript(cwd: string): string | null {
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
  const empty: TranscriptInfo = { found: false, editedFiles: [], adds: 0, dels: 0, todos: [], mtimeMs: 0 }
  try {
    const file = newestTranscript(cwd)
    if (!file) return empty
    const { lines, mtimeMs } = readTail(file)
    const info: TranscriptInfo = { found: true, editedFiles: [], adds: 0, dels: 0, todos: [], mtimeMs }

    for (const l of lines) {
      if (!l || typeof l !== 'object') continue
      const d = l as Record<string, unknown>
      const type = d.type

      if (type === 'ai-title' && d.aiTitle && typeof d.aiTitle === 'string') info.aiTitle = d.aiTitle
      if (type === 'last-prompt' && d.lastPrompt && typeof d.lastPrompt === 'string') info.lastPrompt = d.lastPrompt

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
        if (Array.isArray(content)) {
          for (const b of content) {
            if (!b || typeof b !== 'object') continue
            const bb = b as Record<string, unknown>
            if (bb.type === 'tool_use') {
              const name = bb.name
              const input = (bb.input ?? {}) as Record<string, unknown>
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
        if (txt) info.lastAssistantText = txt
      }
    }
    return info
  } catch {
    return empty
  }
}
