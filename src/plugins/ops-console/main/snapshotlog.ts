// Board recording — the capture half of the console's DVR.
//
// cardlog.ts answers "how full were the lanes and how much did they churn", but
// it stores only counts, so a recorded session can never be played back: you
// cannot rebuild a board from the number of cards that were on it. This records
// the board itself.
//
// A full OpsSnapshot every second is far too much to keep — the cards barely
// change between ticks, and most ticks differ by one field on one card. So a
// full frame is written only occasionally, and every tick in between stores just
// the difference: cards added, cards gone, and the specific fields that moved.
// Replay rebuilds each frame by starting at the last full one and applying
// deltas forward, which is why keyframes have to exist at all — without them a
// reader would have to replay from the beginning of the session to show you the
// last minute of it.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { OpsSnapshot, OpsCard, OpsAgent } from '../types'

const FILE = path.join(os.homedir(), '.quadclaude', 'ops-dvr.jsonl')
// A full frame this often. Lower = faster seeking but a bigger file; at 1Hz this
// caps the replay work for any single frame at one minute of deltas.
const KEYFRAME_EVERY = 60
// Recording is something you switch on for a session, not an archive. Past this
// the file restarts rather than rotating.
const MAX_BYTES = 48 * 1024 * 1024

// Fields worth diffing on a card. Deliberately not every field: `startedAt` is
// fixed at birth and the live duration is derived from it at render time, so
// there is nothing per-tick to store for it.
const CARD_FIELDS: (keyof OpsCard)[] = [
  'col', 'tag', 'task', 'kind', 'sub', 'think', 'durMs', 'tokens', 'err', 'ask', 'when', 'startedAt', 'paneId',
]

function cardDiff(prev: OpsCard, next: OpsCard): Partial<OpsCard> | null {
  const out: Record<string, unknown> = {}
  let changed = false
  for (const f of CARD_FIELDS) {
    if (prev[f] !== next[f]) { out[f] = next[f]; changed = true }
  }
  if (!changed) return null
  out.id = next.id
  return out as Partial<OpsCard>
}

export class SnapshotLog {
  private enabled = false
  private ticks = 0
  private sinceKey = 0
  private prevCards = new Map<string, OpsCard>()
  private prevAgents = ''
  private failed = false
  private frames = 0

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) {
      this.ticks = 0
      this.frames = 0
      this.sinceKey = 0
      this.prevCards.clear()
      this.prevAgents = ''
      this.failed = false
      // A fresh recording starts a fresh file: replaying two sessions spliced
      // together would show cards teleporting between unrelated states.
      try { fs.writeFileSync(FILE, '') } catch { /* handled on first append */ }
      this.append({ type: 'start', ts: Date.now() })
    } else {
      this.append({ type: 'stop', ts: Date.now(), frames: this.frames })
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  record(s: OpsSnapshot): void {
    if (!this.enabled || this.failed) return
    this.ticks++

    const agentsJson = JSON.stringify(s.agents)
    const agentsChanged = agentsJson !== this.prevAgents

    if (this.sinceKey <= 0) {
      this.append({
        type: 'key',
        ts: s.ts || Date.now(),
        paneCount: s.paneCount,
        agents: s.agents,
        cards: s.cards,
      })
      this.sinceKey = KEYFRAME_EVERY
    } else {
      const added: OpsCard[] = []
      const updated: Partial<OpsCard>[] = []
      const seen = new Set<string>()
      for (const c of s.cards) {
        seen.add(c.id)
        const prev = this.prevCards.get(c.id)
        if (!prev) { added.push(c); continue }
        const d = cardDiff(prev, c)
        if (d) updated.push(d)
      }
      const removed: string[] = []
      for (const id of this.prevCards.keys()) if (!seen.has(id)) removed.push(id)

      // A tick where nothing moved still needs a row: replay uses row count as
      // its clock, and skipping silent ticks would compress time on playback.
      const row: Record<string, unknown> = { type: 'd', ts: s.ts || Date.now() }
      if (added.length) row.a = added
      if (removed.length) row.r = removed
      if (updated.length) row.u = updated
      if (agentsChanged) row.ag = s.agents
      if (s.paneCount !== undefined) row.pc = s.paneCount
      this.append(row)
      this.sinceKey--
    }

    this.prevAgents = agentsJson
    this.prevCards = new Map(s.cards.map((c) => [c.id, c]))
    this.frames++
  }

  summary(): Record<string, unknown> {
    return { frames: this.frames, ticks: this.ticks, file: FILE }
  }

  private append(obj: Record<string, unknown>): void {
    if (this.failed) return
    try {
      // Cheap guard: only stat occasionally rather than on every line.
      if (this.frames % 200 === 0) {
        try {
          if (fs.statSync(FILE).size > MAX_BYTES) fs.writeFileSync(FILE, '')
        } catch { /* file may not exist yet */ }
      }
      fs.appendFileSync(FILE, JSON.stringify(obj) + '\n')
    } catch {
      // One failed write disables recording rather than throwing on every tick
      // inside the service's poll loop.
      this.failed = true
    }
  }
}

export interface DvrFrame {
  ts: number
  paneCount: number
  agents: OpsAgent[]
  cards: OpsCard[]
}

/**
 * Rebuild every recorded frame by replaying deltas forward from each keyframe.
 * Returns at most `maxFrames`, evenly sampled — a long session holds more frames
 * than any scrubber can address, and reconstruction has to happen in order
 * regardless of which ones are ultimately kept.
 */
export function loadDvr(maxFrames = 1200): DvrFrame[] {
  let raw: string
  try {
    raw = fs.readFileSync(FILE, 'utf-8')
  } catch {
    return []
  }

  const frames: DvrFrame[] = []
  let cards = new Map<string, OpsCard>()
  let agents: OpsAgent[] = []
  let paneCount = 0

  for (const line of raw.split('\n')) {
    if (!line) continue
    let d: Record<string, unknown>
    try { d = JSON.parse(line) } catch { continue }

    if (d.type === 'key') {
      cards = new Map((d.cards as OpsCard[]).map((c) => [c.id, c]))
      agents = (d.agents as OpsAgent[]) ?? []
      paneCount = Number(d.paneCount ?? 0)
    } else if (d.type === 'd') {
      for (const c of (d.a as OpsCard[]) ?? []) cards.set(c.id, c)
      for (const id of (d.r as string[]) ?? []) cards.delete(id)
      for (const u of (d.u as Partial<OpsCard>[]) ?? []) {
        const prev = cards.get(u.id as string)
        if (prev) cards.set(u.id as string, { ...prev, ...u })
      }
      if (d.ag) agents = d.ag as OpsAgent[]
      if (d.pc !== undefined) paneCount = Number(d.pc)
    } else {
      continue // start/stop markers carry no board state
    }

    frames.push({
      ts: Number(d.ts ?? 0),
      paneCount,
      agents,
      cards: [...cards.values()],
    })
  }

  if (frames.length <= maxFrames) return frames
  const stride = frames.length / maxFrames
  const out: DvrFrame[] = []
  for (let i = 0; i < maxFrames; i++) out.push(frames[Math.floor(i * stride)])
  return out
}
