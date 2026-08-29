import { PaneConfig, PaneDigest } from '../../shared/types'

// The triage rule behind the sidebar's sections. Pure and separate from the
// component so it can be checked without mounting React — it decides what
// "needs you" means, which is the whole point of the list.
export type Bucket = 'needs' | 'working' | 'idle'

// Ordered by how much they outrank each other. "done" is the one the grid cannot
// express at all: a pane that finished while you were in another window looks
// exactly like one still working, so it sits unread indefinitely.
export function classifyPane(p: PaneConfig, d?: PaneDigest): { bucket: Bucket; reason?: string } {
  if (p.state === 'claude-waiting') return { bucket: 'needs', reason: 'asked' }
  if (d?.errored) return { bucket: 'needs', reason: 'failed' }
  // Finished after you last looked at it. Requires a stateSince — on a cold
  // launch nothing has "become" idle yet, so nothing is falsely flagged.
  if (p.state === 'claude-idle' && p.stateSince && (!p.seenAt || p.seenAt < p.stateSince)) {
    return { bucket: 'needs', reason: 'done' }
  }
  if (p.state === 'claude-active') return { bucket: 'working' }
  return { bucket: 'idle' }
}

// Elapsed, in the terse form the pane footers already use.
export function since(ms: number | undefined, now = Date.now()): string {
  if (!ms) return ''
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  return Math.floor(m / 60) + 'h' + (m % 60 ? String(m % 60).padStart(2, '0') : '')
}
