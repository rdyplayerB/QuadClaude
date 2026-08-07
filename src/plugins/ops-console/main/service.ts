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
import { readTranscript, newestTranscript, TranscriptInfo } from './transcript-tailer'
import { TokenMeter } from './token-meter'
import { CardLog } from './cardlog'

const RETURN_TTL = 20000     // how long a finished step stays on the board
const SUB_DONE_TTL = 60000   // a finished subagent lingers longer — rarer, bigger news
const STALE_STEP_MS = 300000 // an unfinished step older than this is assumed lost
// An unreported fork on a pane that has sat NON-active this long is presumed
// finished with its notification missed — a real fork's completion re-activates
// the parent, so "parent idle + fork still 'running'" cannot persist honestly.
// Observed live before this guard: subagent cards showing running for 394 MINUTES
// on a READY pane, inflating the "tasks working" KPI with phantoms.
const SUB_STALE_MS = 600000
// A step that returns in under a poll window would otherwise be born already
// finished and never visibly travel. It holds its ACTING slot this long, marked
// `spent` the instant the real work ended — persistence is stretched, never the
// facts. Measured: this is what lifts hops-per-card from 0.16 to 0.63.
const MIN_DWELL_MS = 3000
const LANDED_TTL = 150000  // an outcome is worth keeping on screen

// How long a pane must stay quiet before the board accepts the turn is over.
// Generous on purpose: it only has to exceed Claude's natural thinking pauses,
// and the cost of being late is a card lingering a few seconds, while the cost
// of being early is a phantom turn in the feed.
const IDLE_DWELL_MS = 30_000

const stateOf = (s: string): AgentState =>
  s === 'claude-active' ? 'active' : s === 'claude-waiting' ? 'waiting' : s === 'claude-idle' ? 'ready' : 'idle'

// Feed rows are innerHTML (they carry <b> emphasis), so every value read out of
// a transcript — a prompt, Claude's prose — has to be escaped on the way in or
// a stray "<" silently eats the rest of the line.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A turn's result in Claude's own words: its closing message IS the outcome.
// Markdown furniture is stripped so the card reads as a sentence rather than as
// source. Nothing is summarized or invented — only trimmed.
function outcomeLine(text: string | undefined, max = 140): string {
  if (!text) return ''
  const s = text
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code blocks
    .replace(/`([^`]*)`/g, '$1')              // inline code
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // links → their label
    .replace(/^#{1,6}\s+/gm, '')              // headings
    .replace(/^\s*[-*•]\s+/gm, '')            // bullets
    .replace(/[*_>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  // Prefer a whole first sentence when it is a readable length.
  const m = s.match(/^(.{30,}?[.!?])(\s|$)/)
  const line = m && m[1].length <= max ? m[1] : s
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line
}

const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

// `sig` identifies WHAT landed, so a pane that flaps active↔ready while doing
// one piece of work refreshes its outcome card instead of stacking copies.
interface DoneMemo { card: OpsCard; at: number; sig?: string }

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
  private lastPr = new Map<number, string>()      // last pr-link surfaced per pane
  // Hand-off state. A composing card is allocated a carrier id; the next tool
  // call the pane issues INHERITS that id, so the renderer FLIPs one card from
  // THINKING to ACTING instead of destroying one and creating another. Real
  // causality: the streaming message that was composing is what emitted the
  // tool_use. `stepCard` remembers the assignment so the card keeps its identity
  // through RETURNED and, if it ends the turn, into LANDED.
  private carrier = new Map<number, string>()          // paneId -> unclaimed carrier id
  private stepCard = new Map<string, string>()         // tool_use id -> card id
  // Where the turn in flight began, so its outcome can be MEASURED (elapsed,
  // diff) rather than described in the same words as the prompt that started it.
  private turnStart = new Map<number, { at: number; adds: number; dels: number; said: number }>()
  // The pane's own busy detector calls a turn over after 3s of output silence
  // (TerminalPane's OUTPUT_QUIET_MS) — right for a status badge, wrong for turn
  // accounting, because Claude routinely goes quiet for longer than that while
  // thinking between tool calls. Left alone, the board watched one turn flap
  // active → ready → active every ~10s and announced a "new turn" each time.
  //
  // So the console keeps its OWN settled view: going busy (or blocked) is
  // believed at once, but going idle has to hold. The pane badge stays snappy;
  // only the board's idea of a turn is damped.
  private settledState = new Map<number, AgentState>()
  private idleSince = new Map<number, number>()
  // The prompt the last announced turn was for, so the same one is never
  // announced twice however the state moves underneath it.
  private lastTurnTitle = new Map<number, string>()
  private carrierSeq = 0
  private tokenMeter = new TokenMeter()
  private transcriptCache = new Map<string, { info: TranscriptInfo; at: number }>()
  private ctxCache = new Map<number, { v: { contextPct: number; model: string } | null; at: number }>()
  private disposed = false
  private unsubExit: (() => void) | null = null

  // Believe 'active'/'waiting' immediately; make 'ready'/'idle' prove itself by
  // holding for IDLE_DWELL_MS. Anything shorter is Claude thinking, not a turn
  // ending. Returns the state the board should use.
  private settle(paneId: number, raw: AgentState, now: number): AgentState {
    const prev = this.settledState.get(paneId)
    if (prev === undefined || raw === 'active' || raw === 'waiting') {
      this.settledState.set(paneId, raw)
      this.idleSince.delete(paneId)
      return raw
    }
    if (raw === prev) { this.idleSince.delete(paneId); return raw }
    const since = this.idleSince.get(paneId)
    if (since === undefined) { this.idleSince.set(paneId, now); return prev }
    if (now - since < IDLE_DWELL_MS) return prev
    this.idleSince.delete(paneId)
    this.settledState.set(paneId, raw)
    return raw
  }

  private cardLog = new CardLog()

  constructor(ctx: PluginContext) {
    this.ctx = ctx
    this.intervalMs = Number(ctx.getSetting<number>('pollIntervalMs') ?? 1000) || 1000
    this.cardLog.setEnabled(!!ctx.getSetting<boolean>('cardLogging'))
  }

  start(onSnapshot: (s: OpsSnapshot) => void) {
    this.onSnapshot = onSnapshot
    this.unsubExit = this.ctx.services.onPtyExit((paneId, code) => this.onExit(paneId, code))
    this.tick() // immediate first paint
    this.timer = setInterval(() => this.tick(), this.intervalMs)
  }

  /** Toggled live from the plugin's settings, so a session can be traced without a restart. */
  setCardLogging(on: boolean) {
    this.cardLog.setEnabled(on)
    if (!on) this.ctx.logger.info('card logging stopped', JSON.stringify(this.cardLog.summary()))
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
    // Writes the session's occupancy + churn totals as the last line of the trace.
    if (this.cardLog.isEnabled()) {
      this.ctx.logger.info('card logging summary', JSON.stringify(this.cardLog.summary()))
      this.cardLog.setEnabled(false)
    }
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
    // One piece of work can flip a pane active↔ready several times. Restating
    // the identical sentence is noise, not history — refresh the row instead.
    const top = this.feed[0]
    if (top && top.paneId === paneId && top.main === main) {
      top.ageSec = 0
      if (sub) top.sub = sub
      return
    }
    this.feed.unshift({ id: `f${++this.feedSeq}`, paneId, main, sub, ageSec: 0, incident })
    if (this.feed.length > 16) this.feed.length = 16
  }

  private onExit(paneId: number, code: number) {
    if (this.disposed) return
    // The process is gone, so the settled view and the announced turn are stale.
    // Clearing them means a respawned pane's first turn is announced normally
    // instead of being swallowed as "same prompt as last time".
    this.settledState.delete(paneId)
    this.idleSince.delete(paneId)
    this.lastTurnTitle.delete(paneId)
    if (code !== 0) this.pushFeed(paneId, `pane <b>#${paneId}</b> process exited (code ${code}) — respawning`, 'shell recovered', true)
  }

  private async tick() {
    if (this.disposed || !this.onSnapshot) return
    try {
      const snap = await this.build()
      // build() awaits git/context lookups, so the console can be closed while
      // it is in flight — re-check rather than calling a callback that stop()
      // has already cleared.
      if (this.disposed || !this.onSnapshot) return
      // age the feed by wall time
      const ageStep = this.intervalMs / 1000
      for (const f of this.feed) f.ageSec += ageStep
      this.cardLog.record(snap)
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
      const st = this.settle(p.id, stateOf(p.state), now)
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

      // Exact, deduped session tokens — and a REAL output rate to go with them.
      // `tps` stays a terminal-throughput figure (bytes/4) and only drives the
      // sparkline's smoothness; it is never shown as a token count.
      const tfile = newestTranscript(p.cwd)
      const tokens = tfile ? this.tokenMeter.read(tfile) : undefined
      const tokPerMin = tfile ? this.tokenMeter.rate(tfile) : 0

      // ---- cards from transcript + state ----
      const t = this.transcriptFor(p.cwd)

      agents.push({
        paneId: p.id, pos: p.pos, name: p.folder, proj: p.proj, state: st,
        model, account: p.account, branch, dirty, ahead, ctxPct, tps, tokens, tokPerMin,
        outSeries: tfile ? this.tokenMeter.series(tfile) : undefined,
        queued: t.queueDepth || undefined,
      })
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
        // Missed-notification guard — see SUB_STALE_MS.
        if (!sub.done && st !== 'active' && now - sub.spawnedAt > SUB_STALE_MS) known.delete(sub.id)
      }
      const subs = [...known.values()]
      // The rail carries the full set so its chip can count them honestly; the
      // board card is what names them one by one.
      if (subs.length) agents[agents.length - 1].subagents = subs
      if (subs.length) {
        // ONE card for all of a parent's forks. A spawn is not a step that
        // "returns" — the Agent call answers instantly while the fork keeps
        // running — so the group lives in ACTING until every fork is back.
        // Per-fork cards were honest but unreadable: one parent with eight
        // forks filled the whole lane with boxes differing only in a noun.
        const running = subs.filter((s) => !s.done)
        const oldest = subs.reduce((m, s) => Math.min(m, s.spawnedAt), now)
        cards.push({
          id: `subs-${p.id}`, paneId: p.id, col: running.length ? 'act' : 'return', kind: 'subagent',
          tag: `${subs.length} fork${subs.length > 1 ? 's' : ''}`, task: '', sub: subs[0].name,
          startedAt: oldest,
          forks: subs.map((s) => ({ id: s.id, label: s.desc || s.name, startedAt: s.spawnedAt, done: s.done })),
        })
      }

      for (const s of t.steps) {
        if (s.spawns) continue // handled above, with its own lifecycle
        // Human voice first: the model's own sentence about the call, falling
        // back to the raw argument. The tag chip still names the tool, so the
        // system identity is never lost — only the headline becomes readable.
        const say = s.desc || s.target || s.name
        // Decide whether this step still belongs on the board BEFORE touching
        // the carrier. The transcript window keeps handing us steps that
        // finished long ago; if one of those claims the carrier on its way to
        // being dropped, it takes the composing card's identity with it — and
        // since it claims again every tick, the THINKING card was rebuilt under
        // a new id once a second and visibly flickered in place.
        const expired = !!s.endedAt && now - s.endedAt > RETURN_TTL
        const stale = !s.endedAt && !(st === 'active' && now - s.startedAt < STALE_STEP_MS)
        if (expired || stale) { this.stepCard.delete(s.id); continue }
        // Claim the pane's carrier the first time we see this step, so the card
        // that was composing becomes the call it produced.
        let cardId = this.stepCard.get(s.id)
        if (!cardId) {
          const c = this.carrier.get(p.id)
          if (c) { cardId = c; this.carrier.delete(p.id) } else { cardId = s.id }
          this.stepCard.set(s.id, cardId)
        }
        if (s.endedAt) {
          // Minimum dwell: still ACTING, but visibly spent.
          if (now - s.startedAt < MIN_DWELL_MS) {
            cards.push({
              id: cardId, paneId: p.id, col: 'act', kind: 'step', tag: s.name, task: say,
              think: s.think, startedAt: s.startedAt, durMs: s.endedAt - s.startedAt,
              tokens: s.tokens, err: s.err, spent: true,
            })
            continue
          }
          cards.push({
            id: cardId, paneId: p.id, col: 'return', kind: 'step', tag: s.name, task: say,
            think: s.think, startedAt: s.startedAt, durMs: s.endedAt - s.startedAt, tokens: s.tokens, err: s.err,
          })
        } else {
          cards.push({
            id: cardId, paneId: p.id, col: 'act', kind: 'step', tag: s.name, task: say,
            think: s.think, startedAt: s.startedAt, tokens: s.tokens,
          })
        }
      }

      // ---- QUEUED: prompts stacked behind the turn in flight ----
      for (let qi = 0; qi < t.queued.length && qi < 4; qi++) {
        cards.push({
          id: `p${p.id}-q${qi}`, paneId: p.id, col: 'queued', kind: 'step', tag: 'queued',
          task: t.queued[qi], startedAt: now,
        })
      }

      // Composing: the pane is streaming output but has no tool call in flight —
      // i.e. Claude is writing its next message. Real, and it is the THINKING column.
      const inFlight = t.steps.some((s) => !s.endedAt && !s.spawns)
      // Allocate a carrier for this composing stretch; the next tool call takes it.
      if (st === 'active' && !inFlight && !this.carrier.has(p.id)) {
        this.carrier.set(p.id, `p${p.id}-c${++this.carrierSeq}`)
      }
      if (st === 'active' && !inFlight) {
        // Real thinking blocks are encrypted (measured: 0/200 with text), so the
        // narration line is Claude's newest outward prose — what it just said is
        // the only visible form of what it is thinking about.
        // Headline what it is SAYING, not the prompt — LANDED, BLOCKED and the
        // feed were all printing that same sentence, so the board read as one
        // string copied across five lanes.
        const composing = outcomeLine(t.lastAssistantText, 110)
        const reasoning = t.lastThinking?.replace(/\s+/g, ' ').slice(0, 150)
        cards.push({
          id: this.carrier.get(p.id) || `p${p.id}-think`, paneId: p.id, col: 'think', kind: 'think', tag: 'thinking',
          task: composing || title,
          // The reasoning line only earns its space when it isn't the headline.
          think: composing ? reasoning : (reasoning || t.lastAssistantText?.replace(/\s+/g, ' ').slice(0, 150)),
          re: composing ? title : undefined,
          startedAt: t.lastRecordAt || now,
        })
      }
      if (st === 'waiting') {
        cards.push({
          id: `p${p.id}-blocked`, paneId: p.id, col: 'blocked', kind: 'step', tag: 'prompt',
          task: title, ask: t.lastAssistantText?.slice(0, 110) || 'waiting for your input',
        })
      }

      // A PR opened is the rarest, biggest card on the board — milestone-lived.
      if (t.prLink && this.lastPr.get(p.id) !== t.prLink) {
        const seen = this.lastPr.has(p.id) // first sight of an old link ≠ news
        this.lastPr.set(p.id, t.prLink)
        if (seen) {
          const label = t.prLabel || t.prLink.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)
          this.pushFeed(p.id, `<b>${p.folder}</b> opened <b class="done">${label}</b>`, t.prLink.slice(0, 80))
          this.done.push({ card: { id: `p${p.id}-pr-${now}`, paneId: p.id, col: 'landed', kind: 'step', tag: 'PR', task: label, when: 'just now' }, at: now })
        }
      }

      // ---- feed from real state transitions ----
      const prevSt = this.prevState.get(p.id)
      if (prevSt && prevSt !== st) {
        if (st === 'active') this.turnStart.set(p.id, { at: now, adds: t.adds, dels: t.dels, said: t.lastSaidAt })
        if (st === 'waiting') this.pushFeed(p.id, `<b>${p.folder}</b> is <b class="wait">waiting for input</b>`, (t.lastAssistantText?.slice(0, 90) || '') + ' · blocked on a prompt')
        else if (st === 'active' && prevSt === 'waiting') this.pushFeed(p.id, `<b>${p.folder}</b> resumed <b>${esc(title)}</b>`, 'you answered · back to work')
        else if (st === 'active' && this.lastTurnTitle.get(p.id) !== title) {
          // Guard the announcement on the PROMPT, not just the state edge. A
          // turn that dips idle and comes back is the same turn; without this
          // the feed filled with "started <same thing> · new turn" every time
          // Claude paused to think.
          this.lastTurnTitle.set(p.id, title)
          this.pushFeed(p.id, `<b>${p.folder}</b> started <b>${esc(title)}</b>`, prevSt === 'ready' ? 'new turn' : 'shell → claude')
        }
        else if (prevSt === 'active') {
          // The turn ended: Claude either parked at its prompt ('ready') or the
          // process exited ('idle').
          const start = this.turnStart.get(p.id)
          this.turnStart.delete(p.id)
          const since = start?.at ?? 0
          // A pane drops out of 'active' for a beat mid-task too. Only a stretch
          // that actually produced something — new prose, or a tool call — is an
          // outcome; the rest were phantom "turns" restating the same prompt.
          const spoke = t.lastSaidAt > (start?.said ?? 0)
          const stepped = t.steps.some((s) => s.startedAt >= since)
          if (spoke || stepped) {
            // The RESULT, in Claude's own words. The prompt is what every other
            // lane already shows; repeating it here said nothing new.
            const outcome = outcomeLine(t.lastAssistantText) ||
              (t.editedFiles.length ? `edited ${t.editedFiles.slice(-3).join(', ')}` : '') || title
            const adds = Math.max(0, t.adds - (start?.adds ?? t.adds))
            const dels = Math.max(0, t.dels - (start?.dels ?? t.dels))
            const stat = [since ? fmtDur(now - since) : '', adds || dels ? `+${adds}/−${dels}` : '']
              .filter(Boolean).join(' · ')
            this.pushFeed(p.id, `<b>${p.folder}</b> finished <b class="done">${esc(outcome.slice(0, 90))}</b>`,
              (file ? `edit ${file} · ` : '') + (st === 'ready' ? 'awaiting your instruction' : 'session ended'))
            // Carry the step that ended the turn into LANDED rather than minting
            // a fresh card — the work becomes its own outcome, one more real hop.
            const mine = cards.filter((c) => c.paneId === p.id && c.col === 'return' && c.kind === 'step')
            const carryId = mine.length ? mine[mine.length - 1].id : `p${p.id}-turn${now}`
            const sig = `${p.id}|${outcome}`
            const prior = this.done.find((d) => d.sig === sig)
            if (prior) {
              // Same result restated — refresh the card already on the board.
              prior.at = now
              prior.card.stat = stat
            } else {
              this.done.push({
                sig, at: now,
                card: { id: carryId, paneId: p.id, col: 'landed', kind: 'step', tag: 'turn', task: outcome, re: title, stat },
              })
            }
          }
        }
      }
      this.prevState.set(p.id, st)
    }

    // A step whose card retired normally is deleted above, but one that scrolled
    // out of the 256KB tail window never gets that chance. Bound the map by
    // dropping the oldest assignments — Map iterates in insertion order.
    if (this.stepCard.size > 400) {
      const drop = this.stepCard.size - 200
      let i = 0
      for (const k of this.stepCard.keys()) { if (i++ >= drop) break; this.stepCard.delete(k) }
    }

    // recently-done cards (from active→idle), keep ~150s, cap 5
    this.done = this.done.filter((d) => now - d.at < LANDED_TTL).slice(-5)
    for (const d of this.done) {
      if (cards.some((c) => c.id === d.card.id)) continue
      // "just now" used to be baked in at push time and never aged, so a card
      // still claimed it two minutes later. Read it off the clock instead.
      const age = Math.round((now - d.at) / 1000)
      d.card.when = age < 10 ? 'just now' : age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`
      cards.push(d.card)
    }

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
