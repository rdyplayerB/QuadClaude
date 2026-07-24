// Live Ops Console data service. Turns real app signals into OpsSnapshots:
//   pane states (renderer push) → agents & card columns
//   PtyManager bytesOut delta   → per-agent output rate (tok/s)
//   ctx% file + git status      → statusline readouts
//   transcript tail             → card titles, files, diffs, questions, todos
// Card ids are STABLE across ticks so the window animates real moves (FLIP)
// rather than recreating nodes. Never throws out of a tick.

import { PluginContext, WorkspaceSnapshot } from '../../../shared/plugins'
import { OpsSnapshot, OpsAgent, OpsCard, OpsFeedItem, AgentState } from '../types'
import { readTranscript, TranscriptInfo } from './transcript-tailer'

const WORDS = ['Churning', 'Cooking', 'Brewing', 'Simmering', 'Sautéing', 'Whisking', 'Percolating', 'Baking', 'Marinating', 'Befuddling']
const TAG_BY_HINT = (folder: string): string => {
  const f = folder.toLowerCase()
  if (/vid|story|render|clip|movie/.test(f)) return 'render'
  if (/doc|paste|blog|site|web|linktree/.test(f)) return 'build'
  if (/quad|claude|tool|cli/.test(f)) return 'dev'
  return 'work'
}

const stateOf = (s: string): AgentState => (s === 'claude-active' ? 'active' : s === 'claude-waiting' ? 'waiting' : 'idle')

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
  private taskStart = new Map<number, number>() // paneId → epoch when its work card started
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
    if (cached && now - cached.at < 3000) return cached.info // throttle disk reads to ~3s
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
      const tag = TAG_BY_HINT(p.folder)
      const file = t.editedFiles[t.editedFiles.length - 1]
      const title = (t.aiTitle || (t.lastPrompt ? t.lastPrompt.split('\n')[0].slice(0, 48) : '') || 'Session').trim()

      if (t.todos.length) {
        // real todos → columns
        t.todos.forEach((todo, i) => {
          const base = { id: `p${p.id}-t${i}`, paneId: p.id, tag, task: todo.content.slice(0, 60) }
          if (todo.status === 'completed') cards.push({ ...base, col: 'done', when: 'done' })
          else if (todo.status === 'in_progress') {
            if (st === 'waiting') cards.push({ ...base, col: 'need', ask: t.lastAssistantText?.slice(0, 110) || 'waiting for input' })
            else cards.push({ ...base, col: 'work', file, add: t.adds, del: t.dels, word: WORDS[i % WORDS.length], tokens: this.tokEst(p.id, ctxPct), elapsedMs: this.elapsed(p.id, st) })
          } else cards.push({ ...base, col: 'queued' })
        })
      } else if (st === 'active') {
        cards.push({ id: `p${p.id}-ep`, paneId: p.id, col: 'work', tag, task: title, file, add: t.adds, del: t.dels, word: WORDS[p.id % WORDS.length], tokens: this.tokEst(p.id, ctxPct), elapsedMs: this.elapsed(p.id, st) })
      } else if (st === 'waiting') {
        cards.push({ id: `p${p.id}-ep`, paneId: p.id, col: 'need', tag, task: title, ask: t.lastAssistantText?.slice(0, 110) || 'waiting for your input' })
      }

      // ---- feed from real state transitions ----
      const prevSt = this.prevState.get(p.id)
      if (prevSt && prevSt !== st) {
        if (st === 'waiting') this.pushFeed(p.id, `<b>${p.folder}</b> is <b class="wait">waiting for input</b>`, (t.lastAssistantText?.slice(0, 90) || '') + ' · claude-active → claude-waiting')
        else if (st === 'active' && prevSt === 'waiting') this.pushFeed(p.id, `<b>${p.folder}</b> resumed <b>${title}</b>`, 'you answered · claude-waiting → claude-active')
        else if (st === 'active' && prevSt === 'idle') this.pushFeed(p.id, `<b>${p.folder}</b> started <b>${title}</b>`, 'shell → claude-active')
        else if (st === 'idle' && prevSt === 'active') {
          this.pushFeed(p.id, `<b>${p.folder}</b> completed <b class="done">${title}</b>`, (file ? `edit ${file} · ` : '') + 'claude-active → shell')
          this.done.push({ card: { id: `p${p.id}-done${now}`, paneId: p.id, col: 'done', tag, task: title, when: 'just now', file }, at: now })
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

  private elapsed(paneId: number, st: AgentState): number {
    if (st !== 'active') { this.taskStart.delete(paneId); return 0 }
    const s = this.taskStart.get(paneId) ?? Date.now()
    if (!this.taskStart.has(paneId)) this.taskStart.set(paneId, s)
    return Date.now() - s
  }
  private tokEst(_paneId: number, ctxPct: number): number {
    // rough k-tokens indicator from context fill (real signal), for display only
    return Math.max(0.5, Math.round(ctxPct * 2) / 10)
  }
}
