// Record-mode producer: a deterministic, seamless-looping timeline for viral
// clips. Emits the exact OpsSnapshot shape the live service does, so the window
// renders both through one path. Beats are authored so the last wraps to the
// first with no visual jump. Card ids are stable → the window FLIP-animates the
// column changes between beats.

import { OpsSnapshot, OpsCard, OpsFeedItem, AgentState, CardColumn } from '../types'

const AG = [
  { paneId: 1, pos: 0, name: 'promovid',   proj: 'projects-quip', model: 'Opus 4.8', account: '@boshiro.one', branch: 'master', dirty: 28, ctx: 27 },
  { paneId: 7, pos: 1, name: 'Vibed',      proj: 'projects-b',    model: 'Opus 4.8', account: '@rdyplayerB',  branch: 'main',   dirty: 0,  ctx: 22 },
  { paneId: 4, pos: 2, name: 'QuadClaude', proj: 'projects-b',    model: 'Opus 4.8', account: '@boshiro.one', branch: 'feat/delegation-dashboard', dirty: 1, ctx: 0 },
  { paneId: 3, pos: 3, name: 'rdyplayerB', proj: 'projects-b',    model: 'Opus 4.8', account: '@rdyplayerb',  branch: 'main',   dirty: 4,  ctx: 39 },
  { paneId: 6, pos: 4, name: 'Googledocs', proj: 'projects-b',    model: 'Opus 4.8', account: '@rdyplayerB',  branch: 'main',   dirty: 0,  ctx: 26 },
  { paneId: 0, pos: 5, name: 'story2vid',  proj: 'projects-burner', model: 'Opus 4.8', account: '@boshiro.one', branch: 'main', dirty: 0, ctx: 75 },
]
type C = { id: string; pane: number; tag: string; task: string; col?: CardColumn; file?: string; add?: number; del?: number; ask?: string; when?: string; word?: string }

// Base cards (ids stable across beats). Columns are overridden per beat.
const BASE: C[] = [
  { id: 'c-pv1', pane: 1, tag: 'render', task: 'Round-5 endcard boards', file: 'build_board.py', add: 7, del: 0, word: 'Churning' },
  { id: 'c-pv2', pane: 1, tag: 'plan',   task: 'r5 tool retakes' },
  { id: 'c-vb1', pane: 7, tag: 'design', task: 'impact-clay box-logo fix', file: 'impact-clay.html', add: 1, del: 1, word: 'Cooking' },
  { id: 'c-rp1', pane: 3, tag: 'build',  task: 'Site content sections', file: 'index.astro', add: 4, del: 2, word: 'Brewing' },
  { id: 'c-s21', pane: 0, tag: 'render', task: 'Render scene 4 / 9', file: 'timeline.ts', add: 1, del: 3, word: 'Befuddling' },
  { id: 'c-s22', pane: 0, tag: 'render', task: 'Scene 5 encode' },
  { id: 'c-gd1', pane: 6, tag: 'review', task: 'Paste-formatting fixes', ask: 'Overwrite the clipboard on paste, or merge?' },
  { id: 'c-vb0', pane: 7, tag: 'design', task: 'Gallery-6 finish tune', when: '2m ago' },
  { id: 'c-pv0', pane: 1, tag: 'render', task: 'Round-4 boards', when: '31m ago' },
  { id: 'c-s20', pane: 0, tag: 'render', task: 'Scene 3 encode', when: '44m ago' },
]

// Per-beat column map: cardId → column. Authored to loop cleanly (beat 8 == beat 0).
const BEATS: Record<string, CardColumn>[] = [
  { 'c-pv1':'work','c-pv2':'queued','c-vb1':'work','c-rp1':'work','c-s21':'work','c-s22':'queued','c-gd1':'need','c-vb0':'done','c-pv0':'done','c-s20':'done' }, // 0 initial
  { 'c-pv1':'work','c-pv2':'queued','c-vb1':'work','c-rp1':'work','c-s21':'work','c-s22':'queued','c-gd1':'work','c-vb0':'done','c-pv0':'done','c-s20':'done' }, // 1 googledocs answered → work
  { 'c-pv1':'work','c-pv2':'queued','c-vb1':'work','c-rp1':'work','c-s21':'done','c-s22':'queued','c-gd1':'work','c-vb0':'done','c-pv0':'done','c-s20':'done' }, // 2 story2vid scene4 done
  { 'c-pv1':'work','c-pv2':'queued','c-vb1':'work','c-rp1':'work','c-s21':'done','c-s22':'work','c-gd1':'work','c-vb0':'done','c-pv0':'done','c-s20':'done' }, // 3 story2vid scene5 → work
  { 'c-pv1':'done','c-pv2':'queued','c-vb1':'work','c-rp1':'work','c-s21':'done','c-s22':'work','c-gd1':'work','c-vb0':'done','c-pv0':'done','c-s20':'done' }, // 4 promovid boards done
  { 'c-pv1':'done','c-pv2':'work','c-vb1':'need','c-rp1':'work','c-s21':'done','c-s22':'work','c-gd1':'work','c-vb0':'done','c-pv0':'done','c-s20':'done' }, // 5 promovid r5→work, vibed asks
  { 'c-pv1':'done','c-pv2':'work','c-vb1':'need','c-rp1':'done','c-s21':'done','c-s22':'work','c-gd1':'done','c-vb0':'done','c-pv0':'done','c-s20':'done' }, // 6 rdyplayerB done, gd done
  { 'c-pv1':'work','c-pv2':'work','c-vb1':'work','c-rp1':'work','c-s21':'work','c-s22':'work','c-gd1':'need','c-vb0':'done','c-pv0':'done','c-s20':'done' }, // 7 recovery burst (vibed answered, all busy), gd re-asks → back toward 0
]
// Feed line to prepend when entering each beat.
const BEAT_FEED: (OpsFeedItem | null)[] = [
  null,
  { id: '', paneId: 6, main: '<b>Googledocs</b> resumed <b>Paste-formatting fixes</b>', sub: 'you answered · claude-waiting → claude-active', ageSec: 0 },
  { id: '', paneId: 0, main: '<b>story2vid</b> finished <b class="done">scene 4/9</b>', sub: 'timeline.ts · claude-active → shell', ageSec: 0 },
  { id: '', paneId: 0, main: '<b>story2vid</b> started <b>Scene 5 encode</b>', sub: 'shell → claude-active', ageSec: 0 },
  { id: '', paneId: 1, main: '<b>promovid</b> completed <b class="done">Round-5 endcard boards</b>', sub: 'edit build_board.py · +7', ageSec: 0 },
  { id: '', paneId: 7, main: '<b>Vibed</b> is <b class="wait">waiting for input</b>', sub: '“restart the Vibed server on :8080?” · claude-active → claude-waiting', ageSec: 0 },
  { id: '', paneId: 3, main: '<b>rdyplayerB</b> completed <b class="done">Site content sections</b>', sub: '6 commits ahead · migrating to rdyplayerB.xyz', ageSec: 0 },
  { id: '', paneId: 7, main: '<b>Vibed</b> restarted the server', sub: 'live at 127.0.0.1:8080/vibed-v9.html', ageSec: 0 },
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
    const cards: OpsCard[] = BASE.map((c) => {
      const col = map[c.id] || 'queued'
      const card: OpsCard = { id: c.id, paneId: c.pane, col, tag: c.tag, task: c.task }
      if (col === 'work') { card.file = c.file; card.add = c.add; card.del = c.del; card.word = c.word || 'Cooking'; card.tokens = 1 + Math.round(jitter * 30) / 10; card.elapsedMs = 1000 + b * 4000 }
      if (col === 'need') card.ask = c.ask || 'waiting for input'
      if (col === 'done') card.when = c.when || 'just now'
      return card
    })
    // agent state derives from its card presence
    const agents = AG.map((a) => {
      const mine = cards.filter((c) => c.paneId === a.paneId)
      let state: AgentState = 'idle'
      if (mine.some((c) => c.col === 'need')) state = 'waiting'
      else if (mine.some((c) => c.col === 'work')) state = 'active'
      const tps = state === 'active' ? 45 + Math.round(jitter * 95) : 0
      return { paneId: a.paneId, pos: a.pos, name: a.name, proj: a.proj, state, model: a.model, account: a.account, branch: a.branch, dirty: a.dirty, ahead: 0, ctxPct: a.ctx, tps }
    })
    if (newFeedForBeat) {
      const f = BEAT_FEED[b]
      if (f) { this.feed.unshift({ ...f, id: `rf${++this.seq}`, ageSec: 0 }); if (this.feed.length > 14) this.feed.length = 14 }
      for (const f2 of this.feed) f2.ageSec += 2
    }
    return { ts: Date.now(), recordMode: true, paneCount: AG.length, agents, cards, feed: this.feed.slice() }
  }
}
