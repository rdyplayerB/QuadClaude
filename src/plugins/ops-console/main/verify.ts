// Verification tracker — the accuracy + timing correlator for the Ops Console.
// Ground truth = a real pane state transition (renderer, event-driven, t0).
// Visual truth = a card column change reported by the console window (tRender).
// It matches them, classifies (represented / missed / phantom / mismatch),
// measures end-to-end latency (+ a 2-part hop split), and drives three sinks:
//   1. structured JSONL trace  (~/.quadclaude/ops-verify.jsonl)
//   2. app.log summary lines   (via the plugin logger)
//   3. a live overlay          (pushed to the window)
// Entirely gated by the verificationMode setting → zero cost when off, and
// event-driven (a few events / 10s) → cheap when on.
import fs from 'fs'
import path from 'path'
import os from 'os'
import { PluginLogger } from '../../../shared/plugins'
import { VerifyTransition, VerifyMove, VerifyOverlay } from '../types'

const TRACE_PATH = path.join(os.homedir(), '.quadclaude', 'ops-verify.jsonl')
const MATCH_TIMEOUT_MS = 4000 // a transition unmatched this long = missed
// Now that cards are STEPS, a pane state change no longer implies one exact
// column — going active can surface either a composing card or an in-flight
// tool call, depending on which the transcript reveals first. So ground truth
// is a SET of acceptable columns; anything outside it is a real mismatch.
//
// This also bounds what verification can claim: it checks that pane-state edges
// reach the board, not that every individual step lands correctly. Step-level
// accuracy would need the transcript itself as ground truth.
const stateToCols = (s: string): string[] =>
  s === 'claude-active' ? ['think', 'act'] : s === 'claude-waiting' ? ['blocked'] : ['return']
const sameCols = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x))

interface Pending { t: VerifyTransition; tRecv: number; timer: ReturnType<typeof setTimeout>; expectFrom: string[]; expectTo: string[] }

export class VerificationTracker {
  private on = false
  private log: PluginLogger
  private overlayCb: (o: VerifyOverlay) => void
  private pending: Pending[] = []
  private lat: number[] = []
  private n = 0; private represented = 0; private missed = 0; private phantom = 0; private mismatch = 0
  private writeQueue: string[] = []
  private flushing = false

  constructor(log: PluginLogger, overlayCb: (o: VerifyOverlay) => void) {
    this.log = log
    this.overlayCb = overlayCb
  }

  isOn() { return this.on }

  start() {
    if (this.on) return
    this.on = true
    this.reset()
    this.write({ type: 'session-start', ts: Date.now() })
    this.log.info('verification ON — tracing to ' + TRACE_PATH)
    this.pushOverlay()
  }

  stop() {
    if (!this.on) return
    this.on = false
    for (const p of this.pending) clearTimeout(p.timer)
    this.pending = []
    this.write({ type: 'session-end', ts: Date.now(), summary: this.summary() })
    this.log.info(`verification OFF — ${this.n} transitions, ${this.represented} represented, ${this.missed} missed, ${this.phantom} phantom, avg ${this.summary().avgMs ?? '—'}ms`)
    this.pushOverlay()
  }

  private reset() {
    this.pending = []; this.lat = []
    this.n = this.represented = this.missed = this.phantom = this.mismatch = 0
  }

  // ground truth: a real pane state transition
  onTransition(t: VerifyTransition) {
    if (!this.on) return
    this.n++
    const expectFrom = stateToCols(t.from)
    const expectTo = stateToCols(t.to)
    const tRecv = Date.now()
    this.write({ type: 'transition', ts: tRecv, seq: t.seq, paneId: t.paneId, from: t.from, to: t.to, t0: t.t0, recvLagMs: tRecv - t.t0, expect: expectFrom.join('|') + '→' + expectTo.join('|') })
    // shell→shell etc. produce no column move; don't wait on those
    if (sameCols(expectFrom, expectTo)) return
    const timer = setTimeout(() => this.onTimeout(t.seq), MATCH_TIMEOUT_MS)
    this.pending.push({ t, tRecv, timer, expectFrom, expectTo })
    this.pushOverlay()
  }

  // visual truth: a card changed column in the window
  onMove(m: VerifyMove) {
    if (!this.on) return
    // match the oldest pending transition for this pane whose expected columns fit
    const i = this.pending.findIndex((p) => p.t.paneId === m.paneId)
    if (i < 0) {
      // a viz move with no corresponding real transition
      this.phantom++
      this.write({ type: 'phantom', ts: m.tRender, paneId: m.paneId, cardId: m.cardId, move: m.fromCol + '→' + m.toCol })
      this.log.warn(`viz PHANTOM move — pane ${m.paneId} ${m.fromCol}→${m.toCol} with no real transition`)
      this.pushOverlay(); return
    }
    const p = this.pending[i]
    clearTimeout(p.timer)
    this.pending.splice(i, 1)
    const latency = m.tRender - p.t.t0
    const colOk = p.expectTo.includes(m.toCol)
    if (colOk) {
      this.represented++
      this.lat.push(latency)
      // hop split: real change → snapshot built (debounce + poll), then → render
      const buildLag = m.builtAt - p.t.t0
      const renderLag = m.tRender - m.builtAt
      this.write({ type: 'represented', ts: m.tRender, seq: p.t.seq, paneId: m.paneId, from: p.t.from, to: p.t.to, latencyMs: latency, buildLagMs: buildLag, renderLagMs: renderLag, cardId: m.cardId })
      this.log.info(`pane ${m.paneId} ${p.t.from}→${p.t.to} represented in ${latency}ms (build ${buildLag}ms + render ${renderLag}ms)`)
    } else {
      this.mismatch++
      this.write({ type: 'mismatch', ts: m.tRender, seq: p.t.seq, paneId: m.paneId, expected: p.expectTo.join('|'), got: m.toCol, latencyMs: latency })
      this.log.warn(`pane ${m.paneId} MISMATCH — expected column ${p.expectTo.join('|')}, viz showed ${m.toCol}`)
    }
    this.pushOverlay()
  }

  private onTimeout(seq: number) {
    const i = this.pending.findIndex((p) => p.t.seq === seq)
    if (i < 0) return
    const p = this.pending[i]
    this.pending.splice(i, 1)
    this.missed++
    this.write({ type: 'missed', ts: Date.now(), seq: p.t.seq, paneId: p.t.paneId, from: p.t.from, to: p.t.to, expect: p.expectFrom.join('|') + '→' + p.expectTo.join('|'), waitedMs: MATCH_TIMEOUT_MS })
    this.log.warn(`pane ${p.t.paneId} ${p.t.from}→${p.t.to} MISSED — no viz move within ${MATCH_TIMEOUT_MS}ms (aliased or dropped)`)
    this.pushOverlay()
  }

  private summary() {
    const arr = [...this.lat].sort((a, b) => a - b)
    const avg = arr.length ? Math.round(arr.reduce((s, x) => s + x, 0) / arr.length) : null
    const p95 = arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))] : null
    return { n: this.n, represented: this.represented, missed: this.missed, phantom: this.phantom, mismatch: this.mismatch, avgMs: avg, p95Ms: p95 }
  }

  private pushOverlay() {
    const s = this.summary()
    this.overlayCb({
      on: this.on, n: s.n, represented: s.represented, missed: s.missed, phantom: s.phantom, mismatch: s.mismatch,
      lastMs: this.lat.length ? this.lat[this.lat.length - 1] : null, avgMs: s.avgMs, p95Ms: s.p95Ms,
    })
  }

  // async, batched, fire-and-forget JSONL append (never blocks a tick)
  private write(obj: Record<string, unknown>) {
    this.writeQueue.push(JSON.stringify(obj) + '\n')
    if (this.flushing) return
    this.flushing = true
    setTimeout(() => {
      const batch = this.writeQueue.join(''); this.writeQueue = []; this.flushing = false
      try { fs.mkdirSync(path.dirname(TRACE_PATH), { recursive: true }) } catch { /* ignore */ }
      fs.appendFile(TRACE_PATH, batch, () => {})
    }, 250)
  }
}
