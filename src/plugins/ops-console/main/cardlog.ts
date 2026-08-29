// Card-pipeline telemetry.
//
// The console had no observability into its own card stream: app.log carries
// four lines from this plugin (three of them lifecycle), and ops-verify.jsonl
// only checks whether the RENDERER moved a card — it says nothing about what the
// service handed it. So "the lanes look empty" and "cards flicker" were both
// unanswerable from data.
//
// This records what each tick actually produced, one JSON object per line, to
// ~/.quadclaude/ops-cards.jsonl. Two questions it is built to answer:
//
//   occupancy — how often is each lane non-empty, and how many cards is the
//               board really drawing? (Is the board empty, or is it broken?)
//   churn     — how often does a card id leave the snapshot and come back? A
//               card that returns within a second or two is the flicker: from
//               the renderer's side that read as a card dying and a new one
//               being born, which is what made it visibly bounce.
//
// Off by default (the `cardLogging` setting). Sampling once a second forever
// would grow without bound, so writes are capped and the file self-truncates.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { OpsSnapshot, CardColumn } from '../types'

const FILE = path.join(os.homedir(), '.quadclaude', 'ops-cards.jsonl')
// Roughly 12h of 1Hz ticks. Past this the file is truncated rather than rotated:
// this is a diagnostic you turn on for a session, not an archive.
const MAX_BYTES = 24 * 1024 * 1024
// A card that reappears after longer than this is a legitimately new piece of
// work reusing an id, not a flicker.
const CHURN_WINDOW_MS = 5000

const LANES: CardColumn[] = ['queued', 'think', 'act', 'return', 'landed', 'blocked']

export class CardLog {
  private enabled = false
  private lastIds = new Set<string>()
  // id → when it was last seen leaving, for detecting a return.
  private goneAt = new Map<string, number>()
  private ticks = 0
  private laneHits: Record<string, number> = {}
  private churns = 0
  private wrote = 0
  private failed = false

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) {
      this.ticks = 0
      this.laneHits = {}
      this.churns = 0
      this.lastIds = new Set()
      this.goneAt.clear()
      this.append({ type: 'start', ts: Date.now() })
    } else {
      this.flushSummary()
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** Record one built snapshot. Cheap enough to call every tick. */
  record(s: OpsSnapshot): void {
    if (!this.enabled || this.failed) return
    const now = s.ts || Date.now()
    this.ticks++

    const byLane: Record<string, number> = {}
    for (const l of LANES) byLane[l] = 0
    for (const c of s.cards) byLane[c.col] = (byLane[c.col] ?? 0) + 1
    for (const l of LANES) if (byLane[l] > 0) this.laneHits[l] = (this.laneHits[l] ?? 0) + 1

    const ids = new Set(s.cards.map((c) => c.id))

    // Returns: present now, absent last tick, and seen leaving recently.
    const returned: string[] = []
    for (const id of ids) {
      if (this.lastIds.has(id)) continue
      const gone = this.goneAt.get(id)
      if (gone != null && now - gone <= CHURN_WINDOW_MS) {
        returned.push(id)
        this.churns++
      }
      this.goneAt.delete(id)
    }
    // Departures: present last tick, absent now.
    let left = 0
    for (const id of this.lastIds) {
      if (ids.has(id)) continue
      this.goneAt.set(id, now)
      left++
    }
    // Keep the departure map from growing across a long session.
    if (this.goneAt.size > 400) {
      for (const [id, t] of this.goneAt) if (now - t > CHURN_WINDOW_MS) this.goneAt.delete(id)
    }

    this.append({
      type: 'tick',
      ts: now,
      panes: s.paneCount,
      agents: s.agents.length,
      active: s.agents.filter((a) => a.state === 'active').length,
      cards: s.cards.length,
      lanes: byLane,
      // Steps that reached a card, by pane — the join between "the transcript
      // had work" and "the board drew it".
      born: [...ids].filter((id) => !this.lastIds.has(id)).length - returned.length,
      left,
      returned: returned.length,
      // Ids are the actionable part: the same one recurring is the flicker.
      returnedIds: returned.slice(0, 6),
    })

    this.lastIds = ids
  }

  /** Occupancy + churn rates for the session so far. */
  summary(): Record<string, unknown> {
    const pct = (n: number) => (this.ticks ? Math.round((n / this.ticks) * 1000) / 10 : 0)
    const occupancy: Record<string, number> = {}
    for (const l of LANES) occupancy[l] = pct(this.laneHits[l] ?? 0)
    return {
      ticks: this.ticks,
      occupancyPct: occupancy,
      churnReturns: this.churns,
      churnPerMin: this.ticks ? Math.round((this.churns / this.ticks) * 60 * 10) / 10 : 0,
      file: FILE,
    }
  }

  private flushSummary(): void {
    if (!this.ticks) return
    this.append({ type: 'summary', ts: Date.now(), ...this.summary() })
  }

  private append(row: Record<string, unknown>): void {
    if (this.failed) return
    try {
      if (this.wrote > MAX_BYTES) {
        fs.writeFileSync(FILE, '')
        this.wrote = 0
      }
      const line = JSON.stringify(row) + '\n'
      this.wrote += line.length
      fs.mkdirSync(path.dirname(FILE), { recursive: true })
      fs.appendFileSync(FILE, line)
    } catch {
      // A diagnostic must never take the console down with it.
      this.failed = true
    }
  }
}
