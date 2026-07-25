// Record-mode producer: a deterministic, seamless-looping timeline for viral
// clips. Emits the exact OpsSnapshot shape the live service does, so the window
// renders both through one path. Beats are authored so the last wraps to the
// first with no visual jump.
//
// Cards here are STEPS, mirroring live mode: each one is a plausible tool call
// moving think → act → returned. Ids are stable, so the window FLIP-animates the
// column changes between beats instead of recreating nodes. A step absent from a
// beat's map has retired off the board — that churn is the point.

import { OpsSnapshot, OpsCard, OpsFeedItem, OpsSubagent, AgentState, CardColumn } from '../types'

const AG = [
  { paneId: 1, pos: 0, name: 'promovid',     proj: 'projects-quip', model: 'Opus 4.8', account: '@boshiro.one', branch: 'master', dirty: 28, ctx: 27 },
  { paneId: 7, pos: 1, name: 'Vibed',        proj: 'projects-b',    model: 'Opus 4.8', account: '@rdyplayerB',  branch: 'main',   dirty: 0,  ctx: 22 },
  { paneId: 4, pos: 2, name: 'QuadClaude',   proj: 'projects-b',    model: 'Opus 5',   account: '@boshiro.one', branch: 'feat/delegation-dashboard', dirty: 1, ctx: 16 },
  { paneId: 3, pos: 3, name: 'quip-marketing', proj: 'projects-quip', model: 'Sonnet 5', account: '@rdyplayerB', branch: 'main', dirty: 4, ctx: 10 },
  { paneId: 6, pos: 4, name: 'Googledocs',   proj: 'projects-b',    model: 'Opus 4.8', account: '@rdyplayerB',  branch: 'main',   dirty: 0,  ctx: 26 },
  { paneId: 0, pos: 5, name: 'story2vid',    proj: 'projects-burner', model: 'Opus 4.8', account: '@boshiro.one', branch: 'main', dirty: 0, ctx: 75 },
]

type S = {
  id: string; pane: number; tag: string; task: string
  kind?: OpsCard['kind']; sub?: string; think?: string; tokens?: number; err?: boolean; ask?: string
}

// The step pool. Ids stay stable across beats so moves animate.
const BASE: S[] = [
  { id: 's-pv1', pane: 1, tag: 'Bash',      task: 'python3 build_board.py t27', tokens: 978, think: 'Round 7 needs the flavor-text band before the boards can render.' },
  { id: 's-pv2', pane: 1, tag: 'Edit',      task: 'build_board.py', tokens: 412 },
  { id: 's-pv3', pane: 1, tag: 'Read',      task: 'boards_round7.py', tokens: 190 },
  { id: 's-pv4', pane: 1, tag: 'thinking',  task: 'Fourth pass on the storyboard', kind: 'think', think: 'The endcard lands too early — pull the crescendo out by two beats.' },
  { id: 's-qm1', pane: 3, tag: 'WebSearch', task: 'ai marketing ops tool landscape', tokens: 664 },
  { id: 's-qm2', pane: 3, tag: 'Agent',     task: 'Research AI marketing ops landscape and tool gaps', kind: 'subagent', sub: 'tooling-landscape-research' },
  { id: 's-qm3', pane: 3, tag: 'Read',      task: 'plex.css', tokens: 205 },
  { id: 's-qc1', pane: 4, tag: 'Edit',      task: 'service.ts', tokens: 1120, think: 'Step cards need stable ids or the FLIP animation recreates every node.' },
  { id: 's-qc2', pane: 4, tag: 'Bash',      task: 'npx tsc --noEmit', tokens: 88 },
  { id: 's-qc3', pane: 4, tag: 'Grep',      task: 'claude-active', tokens: 143 },
  { id: 's-vb1', pane: 7, tag: 'Write',     task: 'timeline.ts', tokens: 733 },
  { id: 's-vb2', pane: 7, tag: 'Bash',      task: 'npm run dev', tokens: 61, err: true },
  { id: 's-s21', pane: 0, tag: 'Bash',      task: 'ffmpeg -i scene4.mov -c:v prores', tokens: 97 },
  { id: 's-gd1', pane: 6, tag: 'prompt',    task: 'Paste-formatting fixes', ask: 'Overwrite the clipboard on paste, or merge?' },
]

// Per-beat column map. Omitted ids are OFF the board for that beat (retired).
const BEATS: Record<string, CardColumn>[] = [
  { 's-pv1':'act',   's-pv3':'return', 's-qm1':'act',    's-qm2':'act', 's-qc1':'act',    's-vb1':'return', 's-s21':'act',    's-gd1':'blocked' },
  { 's-pv1':'return','s-pv2':'act',    's-qm1':'return', 's-qm2':'act', 's-qc1':'return', 's-qc2':'act',    's-s21':'act',    's-gd1':'blocked' },
  { 's-pv2':'act',   's-pv4':'think',  's-qm2':'act',    's-qm3':'act', 's-qc2':'return', 's-qc3':'act',    's-s21':'return', 's-vb2':'act' },
  { 's-pv2':'return','s-pv4':'think',  's-qm2':'act',    's-qm3':'return', 's-qc3':'return', 's-vb2':'return' },
  { 's-pv4':'act',   's-qm2':'return', 's-qc1':'think',  's-vb1':'act', 's-gd1':'blocked' },
  { 's-pv1':'think', 's-pv4':'return', 's-qc1':'act',    's-vb1':'act', 's-qm1':'act',    's-gd1':'blocked' },
  { 's-pv1':'act',   's-qc1':'act',    's-qm1':'act',    's-vb1':'return', 's-qm3':'think', 's-s21':'act' },
  { 's-pv1':'act',   's-pv3':'return', 's-qm1':'act',    's-qm2':'act', 's-qc1':'act',    's-vb1':'return', 's-s21':'act',    's-gd1':'blocked' },
]

const SUBS: Record<number, OpsSubagent[]> = {
  3: [{ id: 's-qm2', name: 'tooling-landscape-research', desc: 'Research AI marketing ops landscape and tool gaps', spawnedAt: 0, done: false }],
}

// Feed line to prepend when entering each beat.
const BEAT_FEED: (OpsFeedItem | null)[] = [
  null,
  { id: '', paneId: 1, main: '<b>promovid</b> returned <b>Bash(build_board.py t27)</b>', sub: '1.3s · exit 0', ageSec: 0 },
  { id: '', paneId: 3, main: '<b>quip-marketing</b> forked <b>tooling-landscape-research</b>', sub: 'subagent · Research AI marketing ops landscape', ageSec: 0 },
  { id: '', paneId: 0, main: '<b>story2vid</b> returned <b class="done">scene 4/9 encode</b>', sub: 'ffmpeg · 41.2s', ageSec: 0 },
  { id: '', paneId: 7, main: '<b>Vibed</b> step <b class="wait">failed</b>', sub: 'npm run dev · port 8080 already in use', ageSec: 0, incident: true },
  { id: '', paneId: 6, main: '<b>Googledocs</b> is <b class="wait">waiting for input</b>', sub: '“Overwrite the clipboard on paste, or merge?”', ageSec: 0 },
  { id: '', paneId: 4, main: '<b>QuadClaude</b> returned <b>Bash(npx tsc --noEmit)</b>', sub: '4.8s · 0 errors', ageSec: 0 },
  { id: '', paneId: 3, main: '<b>tooling-landscape-research</b> reported back', sub: 'subagent finished · 14 tools surveyed', ageSec: 0 },
]

export class RecordScript {
  readonly beatCount = BEATS.length
  private feed: OpsFeedItem[] = []
  private seq = 0

  // Build the deterministic snapshot for a given beat. jitter (0..1) varies
  // meters/tokens for liveliness without affecting card layout.
  snapshot(beat: number, jitter = 0.5, newFeedForBeat = false): OpsSnapshot {
    const b = ((beat % this.beatCount) + this.beatCount) % this.beatCount
    const map = BEATS[b]
    const now = Date.now()
    const cards: OpsCard[] = []
    for (const s of BASE) {
      const col = map[s.id]
      if (!col) continue // retired off the board this beat
      const card: OpsCard = {
        id: s.id, paneId: s.pane, col, tag: s.tag, task: s.task,
        kind: s.kind || 'step', sub: s.sub, think: s.think,
      }
      if (col === 'act' || col === 'think') card.startedAt = now - 1000 - b * 1500
      if (col === 'return') { card.durMs = 400 + b * 260; card.err = s.err; card.when = 'just now' }
      if (col === 'blocked') card.ask = s.ask
      if (s.tokens && col !== 'blocked') card.tokens = s.tokens
      cards.push(card)
    }
    // agent state derives from its card presence
    const agents = AG.map((a) => {
      const mine = cards.filter((c) => c.paneId === a.paneId)
      let state: AgentState = 'idle'
      if (mine.some((c) => c.col === 'blocked')) state = 'waiting'
      else if (mine.some((c) => c.col === 'act' || c.col === 'think')) state = 'active'
      else if (mine.length) state = 'ready'
      const tps = state === 'active' ? 45 + Math.round(jitter * 95) : 0
      const tk = { input: 300 + a.pos * 40, output: 42000 + a.pos * 9000 + b * 800, cacheCreate: 120000, cacheRead: 3100000 + a.pos * 220000, total: 0 }
      tk.total = tk.input + tk.output + tk.cacheCreate + tk.cacheRead
      return {
        paneId: a.paneId, pos: a.pos, name: a.name, proj: a.proj, state, model: a.model, account: a.account,
        branch: a.branch, dirty: a.dirty, ahead: 0, ctxPct: a.ctx, tps,
        tokens: tk,
        tokPerMin: state === 'active' ? 900 + Math.round(jitter * 1400) : 0,
        // Record mode is avowedly synthetic, but the meter still has to move like
        // the real one: bursty, not a smooth wave. Deterministic so the loop seams.
        outSeries: Array.from({ length: 9 }, (_, i) =>
          state === 'active' ? [40, 620, 180, 0, 460, 95, 780, 30, 340][(i + b + a.pos) % 9] : 0),
        subagents: SUBS[a.paneId] ? SUBS[a.paneId].map((x) => ({ ...x, spawnedAt: now - 167000, done: b >= 3 && b <= 5 })) : undefined,
      }
    })
    if (newFeedForBeat) {
      const f = BEAT_FEED[b]
      if (f) { this.feed.unshift({ ...f, id: `rf${++this.seq}`, ageSec: 0 }); if (this.feed.length > 14) this.feed.length = 14 }
      for (const f2 of this.feed) f2.ageSec += 2
    }
    return { ts: now, recordMode: true, paneCount: AG.length, agents, cards, feed: this.feed.slice() }
  }
}
