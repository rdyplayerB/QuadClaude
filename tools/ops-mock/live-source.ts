// Live data source for the Activity Console design harness.
//
// The harness runs the REAL OpsService against a FAKE PluginContext, so what
// you iterate on is the shipping code path — not a copy that drifts from it.
// Everything the service needs comes from the app in production; here it comes
// from disk instead:
//
//   app (production)                     harness (this file)
//   ─────────────────────────────────    ────────────────────────────────────
//   renderer pushes a pane snapshot  →   newest ~/.claude/projects sessions
//   PtyManager bytesOut deltas       →   unavailable (0 — meters use the real
//                                        token series, which IS on disk)
//   pane state from the PTY          →   inferred from transcript recency
//   getContextUsage (spawns pgrep)   →   unavailable (0 = unknown, as shipped)
//
// The two inferred signals are called out in the harness banner. Everything
// else — cards, tokens, durations, feed — is the same real data the app shows.

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import type {
  PluginContext, PluginServices, WorkspaceSnapshot, PaneSnapshot, GitStatusLite,
} from '../../src/shared/plugins'
import { readTranscript } from '../../src/plugins/ops-console/main/transcript-tailer'

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
// A session whose transcript grew this recently is treated as generating.
const ACTIVE_MS = 20000

interface LiveSession { cwd: string; mtimeMs: number }

function newestJsonl(dir: string): { file: string; mtimeMs: number } | null {
  let best: { file: string; mtimeMs: number } | null = null
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue
    try {
      const m = fs.statSync(path.join(dir, f)).mtimeMs
      if (!best || m > best.mtimeMs) best = { file: path.join(dir, f), mtimeMs: m }
    } catch { /* ignore */ }
  }
  return best
}

// Claude's dir slug replaces every "/" with "-", which is lossy for paths that
// contain a dash. The transcript records carry the real cwd, so read it rather
// than trying to reverse the slug.
function cwdOf(file: string): string {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(16 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const d = JSON.parse(line) as Record<string, unknown>
        if (typeof d.cwd === 'string' && d.cwd) return d.cwd
      } catch { /* partial last line */ }
    }
  } finally {
    fs.closeSync(fd)
  }
  return ''
}

/** The N most recently active Claude sessions on this machine. */
export function discoverSessions(limit = 4): LiveSession[] {
  let dirs: string[] = []
  try { dirs = fs.readdirSync(PROJECTS_DIR) } catch { return [] }
  const found: LiveSession[] = []
  for (const d of dirs) {
    const full = path.join(PROJECTS_DIR, d)
    try {
      if (!fs.statSync(full).isDirectory()) continue
      const newest = newestJsonl(full)
      if (!newest) continue
      const cwd = cwdOf(newest.file)
      if (cwd) found.push({ cwd, mtimeMs: newest.mtimeMs })
    } catch { /* unreadable session dir */ }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
}

// Pane state without a PTY. Recency says "generating"; an unanswered question
// says "blocked" — the transcript records an AskUserQuestion tool_use whose
// tool_result never arrives, which is exactly what waiting looks like.
function inferState(s: LiveSession): PaneSnapshot['state'] {
  const t = readTranscript(s.cwd)
  const open = t.steps.filter((x) => !x.endedAt)
  if (open.some((x) => x.name === 'AskUserQuestion')) return 'claude-waiting'
  if (Date.now() - s.mtimeMs < ACTIVE_MS) return 'claude-active'
  return t.found ? 'claude-idle' : 'shell'
}

export function buildWorkspaceSnapshot(limit = 4): WorkspaceSnapshot {
  const sessions = discoverSessions(limit)
  const panes: PaneSnapshot[] = sessions.map((s, i) => ({
    id: i,
    pos: i,
    folder: path.basename(s.cwd) || 'session',
    proj: path.basename(path.dirname(s.cwd)) || '',
    cwd: s.cwd,
    state: inferState(s),
    account: '',
    model: '',
  }))
  return { activePaneId: panes.length ? panes[0].id : 0, panes }
}

function gitStatus(cwd: string): Promise<GitStatusLite | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'status', '--porcelain=v1', '-b'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve({ isGitRepo: false })
      const lines = stdout.split('\n').filter(Boolean)
      const head = lines[0] || ''
      const branch = /^## ([^.\s]+)/.exec(head)?.[1]
      const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0)
      const behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0)
      resolve({ isGitRepo: true, branch, ahead, behind, dirty: Math.max(0, lines.length - 1) })
    })
  })
}

/**
 * A PluginContext backed by disk instead of by the running app. Narrow by
 * design — the service only ever sees this surface in production either.
 */
export function makeMockContext(
  getSnapshot: () => WorkspaceSnapshot,
  settings: Record<string, unknown> = {},
): PluginContext {
  const services: PluginServices = {
    ptyStats: () => ({ sessions: 0, totalBytesOut: 0, perPaneBytesOut: {} }),
    getGitStatus: async (paneId) => {
      const pane = getSnapshot().panes.find((p) => p.id === paneId)
      return pane ? gitStatus(pane.cwd) : null
    },
    // Context % comes from a live process probe in the app; unknown here, which
    // the console already renders honestly as "—".
    getContextUsage: async () => null,
    latestWorkspaceSnapshot: () => getSnapshot(),
    onWorkspaceSnapshot: () => () => {},
    onPtyExit: () => () => {},
    sendToUi: () => {},
  }
  return {
    id: 'ops-console',
    appVersion: 'harness',
    homeDir: os.homedir(),
    logger: {
      info: (m, d) => console.log('[ops]', m, d ?? ''),
      warn: (m, d) => console.warn('[ops]', m, d ?? ''),
      error: (m, d) => console.error('[ops]', m, d ?? ''),
    },
    getSetting: <T,>(key: string) => settings[key] as T | undefined,
    onSettingsChanged: () => () => {},
    services,
  }
}
