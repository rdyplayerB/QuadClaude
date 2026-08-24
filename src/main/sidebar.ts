// Sidebar data: the two things the pane list needs that the renderer's store
// cannot answer.
//
// 1. What a pane WAS DOING. That lives in Claude's transcript, not in our store,
//    so it comes from main/transcript.ts. Read on demand — the sidebar polls
//    only while it is open, so a closed sidebar costs nothing.
// 2. Which projects Claude has worked in. ~/.claude/projects already has one
//    directory per project with an mtime, so recents need no bookkeeping of our
//    own and include work done outside QuadClaude.
import fs from 'fs'
import path from 'path'
import os from 'os'
import { PaneDigest, RecentProject } from '../shared/types'
import { readTranscript, newestTranscript } from './transcript'

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

// One transcript tail per pane. Cached briefly because the sidebar polls every
// ~3s while several panes can share a cwd (two panes in the same repo read the
// same file), and a tail is 256KB of page-cached I/O either way.
const cache = new Map<string, { at: number; digest: PaneDigest }>()
const CACHE_MS = 1500

// The session title lives at the TOP of a transcript (measured: 0-4% of the
// file), while readTranscript deliberately reads only the last 256KB. For a
// long-running session — the ones you most need to identify — the title is
// therefore nowhere near the tail and comes back empty: QuadClaude's own
// transcript is 4MB with its title at 2%, promovid's is 19MB. So read the title
// from the head, separately, and cache it: a session's title does not change.
const HEAD_SCAN = 64 * 1024
const titleCache = new Map<string, { at: number; title?: string }>()
const TITLE_CACHE_MS = 60_000

function titleFromHead(cwd: string): string | undefined {
  const hit = titleCache.get(cwd)
  const now = Date.now()
  if (hit && now - hit.at < TITLE_CACHE_MS) return hit.title
  let title: string | undefined
  try {
    const file = newestTranscript(cwd)
    if (file) {
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(HEAD_SCAN)
      const n = fs.readSync(fd, buf, 0, HEAD_SCAN, 0)
      fs.closeSync(fd)
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        if (!line.includes('"ai-title"')) continue
        try {
          const j = JSON.parse(line)
          if (j && typeof j.aiTitle === 'string' && j.aiTitle) { title = j.aiTitle; break }
        } catch { /* truncated line at the read boundary */ }
      }
    }
  } catch { /* no transcript, or unreadable — no title */ }
  titleCache.set(cwd, { at: now, title })
  return title
}

export function paneDigest(cwd: string): PaneDigest {
  const hit = cache.get(cwd)
  const now = Date.now()
  if (hit && now - hit.at < CACHE_MS) return hit.digest
  let digest: PaneDigest = { queueDepth: 0 }
  try {
    const t = readTranscript(cwd)
    if (t.found) {
      const last = t.steps.length ? t.steps[t.steps.length - 1] : undefined
      digest = {
        title: t.aiTitle || titleFromHead(cwd),
        lastAction: last ? (last.desc || `${last.name}(${last.target})`) : undefined,
        // A failed newest step means the pane is stuck, not working — that is a
        // different thing from "waiting on you" and the sidebar sorts on it.
        errored: !!(last && last.err),
        queueDepth: t.queueDepth || 0,
        waitingOn: t.lastAssistantText,
      }
    }
  } catch {
    /* a pane with no transcript is normal (a bare shell) — empty digest */
  }
  cache.set(cwd, { at: now, digest })
  return digest
}

// Recovering a project's real path from its slug directory.
//
// The slug replaces every "/" with "-", so it CANNOT be reversed by string
// surgery: "-Users-brentoshiro--claude-mem-observer-sessions" is really
// /Users/brentoshiro/.claude-mem/observer-sessions, and a path that itself
// contains "-" is ambiguous. An earlier attempt tested candidate prefixes for
// existence and "recovered" 112/112 slugs by collapsing nearly all of them to
// /Users/brentoshiro — an existing prefix is not the answer.
//
// The transcripts themselves record the answer: every session's JSONL carries a
// `cwd` field. So read it instead of guessing, and drop a project whose path we
// cannot establish rather than offering a wrong one to open.
const HEAD_BYTES = 64 * 1024

function cwdFromTranscripts(dir: string): string | null {
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch { return null }
  // Newest first: an old transcript can predate a directory move.
  const sorted = files
    .map((f) => { try { return { f, at: fs.statSync(path.join(dir, f)).mtimeMs } } catch { return { f, at: 0 } } })
    .sort((a, b) => b.at - a.at)
  for (const { f } of sorted.slice(0, 3)) {
    try {
      const fd = fs.openSync(path.join(dir, f), 'r')
      const buf = Buffer.alloc(HEAD_BYTES)
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0)
      fs.closeSync(fd)
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        if (!line || line[0] !== '{') continue
        try {
          const j = JSON.parse(line)
          if (j && typeof j.cwd === 'string' && j.cwd) return j.cwd
        } catch { /* a truncated final line is expected — keep scanning */ }
      }
    } catch { /* unreadable transcript — try the next one */ }
  }
  return null
}

export function recentProjects(limit = 40): RecentProject[] {
  let slugs: Array<{ dir: string; at: number }>
  try {
    slugs = fs.readdirSync(PROJECTS_DIR)
      .map((slug) => {
        try {
          const full = path.join(PROJECTS_DIR, slug)
          const st = fs.statSync(full)
          return st.isDirectory() ? { dir: full, at: st.mtimeMs } : null
        } catch { return null }
      })
      .filter((r): r is { dir: string; at: number } => r !== null)
      .sort((a, b) => b.at - a.at)
  } catch {
    return [] // no ~/.claude/projects yet — a first run, not an error
  }
  // Resolve cwd only for the ones we are about to show: the sort is free from
  // stat, the transcript read is not.
  const out: RecentProject[] = []
  const seen = new Set<string>()
  for (const { dir, at } of slugs) {
    if (out.length >= limit) break
    const cwd = cwdFromTranscripts(dir)
    if (!cwd || seen.has(cwd)) continue
    if (!fs.existsSync(cwd)) continue // moved or deleted since — nothing to open
    seen.add(cwd)
    out.push({ path: cwd, name: path.basename(cwd) || cwd, at })
  }
  return out
}
