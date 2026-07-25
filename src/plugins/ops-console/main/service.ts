// Live Ops Console data service. Turns real app signals into OpsSnapshots:
//   pane states (renderer push) → agent roster + the blocked column
//   PtyManager bytesOut delta   → per-agent output rate (tok/s)
//   ctx% file + git status      → statusline readouts
//   transcript tail             → STEP CARDS: one per tool call, flowing
//                                 think → act → return, plus subagent spawns
// Card ids are the tool_use ids, so they're stable across ticks and the window
// FLIP-animates real moves rather than recreating nodes. Never throws in a tick.

import { PluginContext, WorkspaceSnapshot } from '../../../shared/plugins'
import { OpsSnapshot, OpsAgent, OpsCard, OpsFeedItem, OpsSubagent, AgentState } from '../types'
import { readTranscript, TranscriptInfo } from './transcript-tailer'

const RETURN_TTL = 20000     // how long a finished step stays on the board
const SUB_DONE_TTL = 60000   // a finished subagent lingers longer — rarer, bigger news
const STALE_STEP_MS = 300000 // an unfinished step older than this is assumed lost

const stateOf = (s: string): AgentState =>
  s === 'claude-active' ? 'active' : s === 'claude-waiting' ? 'waiting' : s === 'claude-idle' ? 'ready' : 'idle'

interface DoneMemo { card: OpsCard; at: number }

export class OpsService {
  private timer: ReturnType<typeof setInterval> | null = null
  private intervalMs = 1000
  private onSnapshot: ((s: OpsSnapshot) => void) | null = null
  private ctx: PluginContext

  private prevBytes = new Map<number, number>()
  private prevBytesAt = 0
  private prevState = new Map<number, AgentState>()
  private feed: OpsFeedItem[] = []
  private feedSeq = 0
  private done: DoneMemo[] = []          // recently-completed cards, per pane, aged out
  // Subagents must outlive the transcript window. We only read the last 256KB,
  // and one big Write can push a spawn out of it while the fork is still
  // running — so once seen, a subagent is remembered here until it reports back.
  private subsByPane = new Map<number, Map<string, OpsSubagent>>()
  private transcriptCache = new Map<string, { info: TranscriptInfo; at: number }>()
  private ctxCache = new Map<number, { v: { contextPct: number; model: string } | null; at: number }>()
  private disposed = false
  private unsubExit: (() => void) | null = null

  constructor(ctx: PluginContext) {
    this.ctx = ctx
    this.intervalMs = Number(ctx.getSetting<number>('pollIntervalMs') ?? 1000) || 1000
  }

  start(onSnapshot: (s: OpsSnapshot) => void) {
    this.onSnapshot = onSnapshot
    this.unsubExit = this.ctx.services.onPtyExit((paneId, code) => this.onExit(paneId, code))
    this.tick() // immediate first paint
    this.timer = setInterval(() => this.tick(), this.intervalMs)
  }

  updateInterval(ms: number) {
    this.intervalMs = ms || 1000
    if (this.timer) { clearInterval(this.timer); this.timer = setInterval(() => this.tick(), this.intervalMs) }
  }

  stop() {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.unsubExit) this.unsubExit()
    this.onSnapshot = null
  }

  private async ctxFor(paneId: number): Promise<{ contextPct: number; model: string } | null> {
    const cached = this.ctxCache.get(paneId)
    const now = Date.now()
    if (cached && now - cached.at < 5000) return cached.v
    let v: { contextPct: number; model: string } | null = null
    try { v = await this.ctx.services.getContextUsage(paneId) } catch { /* ignore */ }
    this.ctxCache.set(paneId, { v, at: now })
    return v
  }

  private transcriptFor(cwd: string): TranscriptInfo {
    const cached = this.transcriptCache.get(cwd)
    const now = Date.now()
    // 1.5s, not 3s: a tool that returns in under a poll window would otherwise
    // jump straight to RETURNED, never visibly passing through ACTING. The cost
    // is re-parsing a 256KB tail per pane at this cadence — page-cached, but the
    // knob to turn if the console ever shows up in a CPU profile.
    if (cached && now - cached.at < 1500) return cached.info
    const info = readTranscript(cwd)
    this.transcriptCache.set(cwd, { info, at: now })
    return info
  }

  private pushFeed(paneId: number, main: string, sub?: string, incident?: boolean) {
    this.feed.unshift({ id: `f${++this.feedSeq}`, paneId, main, sub, ageSec: 0, incident })
    if (this.feed.length > 16) this.feed.length = 16
  }

  private onExit(paneId: number, code: number) {
    if (this.disposed) return
    if (code !== 0) this.pushFeed(paneId, `pane <b>#${paneId}</b> process exited (code ${code}) — respawning`, 'shell recovered', true)
  }

  private async tick() {
    if (this.disposed || !this.onSnapshot) return
    try {
      const snap = await this.build()
      // age the feed by wall time
      const ageStep = this.intervalMs / 1000
      for (const f of this.feed) f.ageSec += ageStep
      this.onSnapshot(snap)
    } catch (e) {
      this.ctx.logger.warn('ops tick failed', String(e))
    }
  }

  private async build(): Promise<OpsSnapshot> {
    const ws: WorkspaceSnapshot | null = this.ctx.services.latestWorkspaceSnapshot()
    const now = Date.now()
    const stats = this.ctx.services.ptyStats()
    const dtSec = this.prevBytesAt ? Math.max(0.25, (now - this.prevBytesAt) / 1000) : 1
    this.prevBytesAt = now

    const panes = ws?.panes ?? []
    const agents: OpsAgent[] = []
    const cards: OpsCard[] = []

    for (const p of panes) {
      const st = stateOf(p.state)
      // output rate: bytes delta / dt / ~4 bytes-per-token, clamp to a realistic range
      const cur = Number(stats.perPaneBytesOut?.[String(p.id)] ?? 0)
      const prev = this.prevBytes.get(p.id) ?? cur
      this.prevBytes.set(p.id, cur)
      const bytesPerSec = Math.max(0, (cur - prev) / dtSec)
      const tps = st === 'active' ? Math.min(200, Math.round(bytesPerSec / 4)) : 0

      // git + ctx (main-only signals); tolerate failures
      let branch: string | undefined, dirty: number | undefined, ahead: number | undefined, ctxPct = 0, model = p.model
      try {
        const g = await this.ctx.services.getGitStatus(p.id)
        if (g?.isGitRepo) { branch = g.branch; dirty = g.dirty; ahead = g.ahead }
      } catch { /* ignore */ }
      const c = await this.ctxFor(p.id) // cached ~5s (getContextUsage spawns pgrep)
      if (c) { ctxPct = Math.round(c.contextPct); if (c.model) model = c.model }

      agents.push({
        paneId: p.id, pos: p.pos, name: p.folder, proj: p.proj, state: st,
        model, account: p.account, branch, dirty, ahead, ctxPct, tps,
      })

      // ---- cards from transcript + state ----
      const t = this.transcriptFor(p.cwd)
      const file = t.editedFiles[t.editedFiles.length - 1]
      // The session's ai-title is written once, early, and never revised — it
      // pins the card to the FIRST thing you asked hours ago. The last prompt is
      // the instruction actually in flight, so it leads and ai-title backstops it.
      const prompt = t.lastPrompt ? t.lastPrompt.replace(/\[Image #\d+\]\s*/g, '').split('\n')[0].trim() : ''
      const title = (prompt.slice(0, 60) || t.aiTitle || 'Session').trim()

      // ---- STEP CARDS: one per real tool call, flowing think → act → return --
      let known = this.subsByPane.get(p.id)
      if (!known) { known = new Map(); this.subsByPane.set(p.id, known) }
      for (const s of t.steps) {
        if (!s.spawns) continue
        if (!known.has(s.id)) known.set(s.id, { id: s.id, name: s.spawns.name, desc: s.spawns.desc, spawnedAt: s.startedAt, done: false })
      }
      // A fork reports back as a task-notification naming it — the only
      // completion signal the parent transcript ever carries.
      for (const sub of known.values()) {
        if (!sub.done && t.notifications.some((n) => n.includes(sub.name))) sub.done = true
        if (sub.done && now - sub.spawnedAt > SUB_DONE_TTL) known.delete(sub.id)
      }
      const subs = [...known.values()]
      if (subs.length) agents[agents.length - 1].subagents = subs.slice(-4)
      for (const sub of subs) {
        // A spawn is not a step that "returns" — the Agent call answers instantly
        // while the fork keeps running, so it gets its own longer-lived card.
        cards.push({
          id: `sub-${sub.id}`, paneId: p.id, col: sub.done ? 'return' : 'act', kind: 'subagent',
          tag: 'subagent', task: sub.desc || sub.name, sub: sub.name, startedAt: sub.spawnedAt,
        })
      }

      for (const s of t.steps) {
        if (s.spawns) continue // handled above, with its own lifecycle
        if (s.endedAt) {
          if (now - s.endedAt > RETURN_TTL) continue // retired off the board
          cards.push({
            id: s.id, paneId: p.id, col: 'return', kind: 'step', tag: s.name, task: s.target || s.name,
            think: s.think, startedAt: s.startedAt, durMs: s.endedAt - s.startedAt, tokens: s.tokens, err: s.err,
          })
        } else if (st === 'active' && now - s.startedAt < STALE_STEP_MS) {
          cards.push({
            id: s.id, paneId: p.id, col: 'act', kind: 'step', tag: s.name, task: s.target || s.name,
            think: s.think, startedAt: s.startedAt, tokens: s.tokens,
          })
        }
      }

      // Composing: the pane is streaming output but has no tool call in flight —
      // i.e. Claude is writing its next message. Real, and it is the THINKING column.
      const inFlight = t.steps.some((s) => !s.endedAt && !s.spawns)
      if (st === 'active' && !inFlight) {
        cards.push({
          id: `p${p.id}-think`, paneId: p.id, col: 'think', kind: 'think', tag: 'thinking',
          task: title, think: t.lastThinking?.slice(0, 150), startedAt: t.lastRecordAt || now,
        })
      }
      if (st === 'waiting') {
        cards.push({
          id: `p${p.id}-blocked`, paneId: p.id, col: 'blocked', kind: 'step', tag: 'prompt',
          task: title, ask: t.lastAssistantText?.slice(0, 110) || 'waiting for your input',
        })
      }

      // ---- feed from real state transitions ----
      const prevSt = this.prevState.get(p.id)
      if (prevSt && prevSt !== st) {
        if (st === 'waiting') this.pushFeed(p.id, `<b>${p.folder}</b> is <b class="wait">waiting for input</b>`, (t.lastAssistantText?.slice(0, 90) || '') + ' · blocked on a prompt')
        else if (st === 'active' && prevSt === 'waiting') this.pushFeed(p.id, `<b>${p.folder}</b> resumed <b>${title}</b>`, 'you answered · back to work')
        else if (st === 'active') this.pushFeed(p.id, `<b>${p.folder}</b> started <b>${title}</b>`, prevSt === 'ready' ? 'new turn' : 'shell → claude')
        else if (prevSt === 'active') {
          // The turn ended: Claude either parked at its prompt ('ready') or the
          // process exited ('idle'). Either way the work card is finished.
          this.pushFeed(p.id, `<b>${p.folder}</b> completed <b class="done">${title}</b>`, (file ? `edit ${file} · ` : '') + (st === 'ready' ? 'awaiting your instruction' : 'session ended'))
          // The finished turn itself earns a card in RETURNED — the one card on
          // the board that summarises a whole turn rather than a single step.
          this.done.push({ card: { id: `p${p.id}-turn${now}`, paneId: p.id, col: 'return', kind: 'step', tag: 'turn', task: title, when: 'just now' }, at: now })
        }
      }
      this.prevState.set(p.id, st)
    }

    // recently-done cards (from active→idle), keep ~90s, cap 4
    this.done = this.done.filter((d) => now - d.at < 90000).slice(-4)
    for (const d of this.done) if (!cards.some((c) => c.id === d.card.id)) cards.push(d.card)

    return {
      ts: now,
      recordMode: false,
      paneCount: panes.length,
      agents,
      cards,
      feed: this.feed.slice(),
    }
  }

}
// Gone with the step rewrite: elapsed() timed a whole turn (steps carry their own
// real start/end), and tokEst() reported contextPct × 0.2 as "tokens" — a number
// that was never a token count. Cards now show the message's real output_tokens.
