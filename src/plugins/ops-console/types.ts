// Ops Console data contract — main service produces OpsSnapshot; the window
// renderer consumes it and animates the diff between consecutive snapshots.
// Snapshot-only design (no separate event stream): the renderer derives "what
// moved" by comparing card ids/columns, which keeps the IPC surface tiny and
// makes live mode and record mode render through the identical path.

// 'active' = generating · 'ready' = Claude up, turn over, awaiting instruction
// 'waiting' = blocked on a prompt · 'idle' = no agent in the pane
export type AgentState = 'active' | 'waiting' | 'ready' | 'idle'
// A card is one unit of work CARRIED across lanes — the same card is handed
// from lane to lane rather than destroyed and recreated, so what you watch is
// one thing travelling. Every column change is a record in the transcript:
//   queued  — a prompt stacked behind the current turn (queue-operation)
//   think   — the agent is composing (output streaming, no tool call in flight)
//   act     — a tool_use was issued; the composing card BECOMES this card,
//             because that streaming message is what emitted the tool_use
//   return  — its tool_result landed (paired by tool_use id)
//   landed  — the outcome kept: a finished turn, a PR, a commit
//   blocked — the pane is sitting on a permission / decision prompt (an ALARM;
//             rendered as a thin rail, since empty is the healthy state)
export type CardColumn = 'queued' | 'think' | 'act' | 'return' | 'landed' | 'blocked'

export interface OpsAgent {
  paneId: number
  pos: number          // index in panes[] → identity color index (PANE_COLORS)
  name: string         // folder name
  proj: string         // parent dir label
  state: AgentState
  model: string
  account: string      // e.g. "@boshiro.one"
  branch?: string
  dirty?: number
  ahead?: number
  ctxPct: number       // 0 = unknown
  tps: number          // live output rate, tokens/sec (0 when not active)
  subagents?: OpsSubagent[] // forks this agent has running, shown nested in the rail
  tokens?: TokenTotals      // exact session totals, deduped
  tokPerMin?: number        // REAL output tokens/min (not a bytes proxy)
  outSeries?: number[]      // real output tokens per 2s bucket, newest last — the meter's actual data
  queued?: number           // prompts stacked behind the current turn (queue-operation)
}

export interface OpsCard {
  id: string           // tool_use id for steps — stable, so the renderer FLIPs real moves
  paneId: number
  col: CardColumn
  tag: string          // tool name ("Bash", "Edit") or "thinking" / "subagent"
  task: string         // the target: command, file, query, description
  kind?: 'step' | 'think' | 'subagent'
  sub?: string         // subagent name — set means this card is NOT the main agent
  think?: string       // real reasoning snippet from the same assistant message
  startedAt?: number   // epoch ms; the renderer ticks the live duration off this
  durMs?: number       // real tool_use → tool_result elapsed, once returned
  tokens?: number      // REAL output_tokens of the message that issued this step
  err?: boolean        // tool_result came back is_error
  ask?: string         // prompt text while blocked
  when?: string        // retirement label
  spent?: boolean      // the real work ended, but the card is still serving its
                       // minimum visible dwell — marked, never hidden
}

// A forked/backgrounded subagent, from the parent's Agent tool_use record.
// Exact per-session token accounting. Deduped by message.id — the transcript
// records one API response several times as it streams, so a naive sum runs ~2.5x
// high. Validated against ccusage; see main/token-meter.ts.
export interface TokenTotals {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  total: number
}

export interface OpsSubagent {
  id: string
  name: string         // e.g. "tooling-landscape-research"
  desc: string         // the description passed at spawn
  spawnedAt: number
  done: boolean
}

export interface OpsFeedItem {
  id: string
  paneId: number
  main: string         // may contain <b>…</b>
  sub?: string
  ageSec: number       // seconds since it happened (renderer formats)
  incident?: boolean
}

export interface OpsSnapshot {
  ts: number
  recordMode: boolean
  paneCount: number
  agents: OpsAgent[]
  cards: OpsCard[]
  feed: OpsFeedItem[]  // newest first
}

// WorkspaceSnapshot (the renderer → main pane push) is the generic shape in
// shared/plugins.ts, reused here so the service can enrich it.
export type { WorkspaceSnapshot, PaneSnapshot } from '../../shared/plugins'

// --- Verification (accuracy + timing tracking) ---------------------------
// One real pane state transition, timestamped at the moment the store flips
// (ground truth). Emitted event-driven from the renderer when verify is on.
export interface VerifyTransition { seq: number; paneId: number; from: string; to: string; t0: number }
// A card column change observed in the console window (the visual truth).
export interface VerifyMove { cardId: string; paneId: number; fromCol: CardColumn | 'none'; toCol: CardColumn | 'none'; tRender: number; builtAt: number }
// Live overlay stats the window shows while verifying.
export interface VerifyOverlay {
  on: boolean
  n: number            // transitions seen
  represented: number  // matched to a viz move
  missed: number       // no viz move (aliased/dropped)
  phantom: number      // viz move with no real transition
  mismatch: number     // matched pane but wrong column
  lastMs: number | null
  avgMs: number | null
  p95Ms: number | null
}
