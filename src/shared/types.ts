// Layout modes. grid/focus/focus-right show every pane; duo shows two panes
// side-by-side and solo shows one fullscreen — in those two, the remaining
// panes live in the floating PiP strip. NOTE: 'split' and 'fullscreen' are
// dead names from removed layouts (migrations coerce them to 'grid') — never
// reuse them for new modes.
export type LayoutMode = 'grid' | 'focus' | 'focus-right' | 'duo' | 'solo'

// Corner the PiP strip is snapped to (drag the strip header to move it).
export type PipCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

// Git status for pane header
export interface GitStatus {
  isGitRepo: boolean
  branch?: string
  ahead?: number
  behind?: number
  dirty?: number
}

// Saved prompt for prompt library
export interface SavedPrompt {
  id: string
  name: string
  text: string
  createdAt: number
}

// Pane state
// 'claude-active'  — Claude is generating (the PTY is streaming its spinner)
// 'claude-idle'    — Claude is running but its turn is over; awaiting instruction
// 'claude-waiting' — Claude is blocked on a prompt (permission / decision menu)
// 'shell'          — no Claude process in this pane
export type PaneState = 'shell' | 'claude-active' | 'claude-idle' | 'claude-waiting'

// Pane count bounds. The app is "QuadClaude" so 4 is the floor; extra panes
// can be added up to MAX_PANES. 12 is a practical ceiling — beyond a 4x3 grid
// the cells get too small to be useful even on large displays.
export const MIN_PANES = 4
export const MAX_PANES = 12

// Focus-layout splitter: fraction of the width given to the column of small
// panes. The default IS the minimum (small panes at their tightest); the user
// can only drag to make them bigger (shrinking the large focus pane).
export const FOCUS_SMALL_RATIO_DEFAULT = 0.25
export const FOCUS_SMALL_RATIO_MIN = 0.25
export const FOCUS_SMALL_RATIO_MAX = 0.45

// Duo-layout divider: fraction of the width given to the LEFT pane.
export const DUO_RATIO_DEFAULT = 0.5
export const DUO_RATIO_MIN = 0.2
export const DUO_RATIO_MAX = 0.8

// Virtual layout width of a hidden pane rendered as a PiP tile. The pane is
// laid out at this real width (so its PTY keeps ~76-80 cols and output doesn't
// reflow badly on promote) and then transform:scale'd down to tile size.
// offsetWidth ignores transforms, so every fit path sees a nonzero size — the
// beta CanvasAddon's 0×0 blank-render bug can never trigger for PiP tiles.
export const PIP_VW = 640

// A local server (listening TCP port) running in a pane's process tree
export interface ServerInfo {
  pid: number
  port: number
  command: string
}

// A launchable agent: just a command + a bag of env vars typed/spawned into a
// terminal. QuadClaude never speaks any API itself — all provider/auth/format
// differences live inside the CLI tool the command runs (claude, opencode, ...).
export interface AgentProfile {
  id: string
  name: string
  command: string // bare executable + args, e.g. "claude" or "opencode"
  env?: Record<string, string> // free-form; injected at PTY spawn, never echoed
  builtin?: 'claude' // discriminator for Claude-only UI/behavior
}

export const CLAUDE_PROFILE_ID = 'claude'

// A saved Claude subscription account the user can bind a pane to. Lets two panes run two
// DIFFERENT Max subscriptions side-by-side by injecting each account's long-lived
// CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) into that pane's env at spawn — which
// takes precedence over the shared macOS Keychain login. The TOKEN ITSELF is never stored
// here (or in workspace.json); only this non-secret metadata is. The token lives encrypted
// via Electron safeStorage (OS-Keychain-backed) in the main process — see accountStore.ts.
export interface ClaudeAccount {
  id: string
  label: string // user-facing name, e.g. "Work" / "Personal"
  email?: string // optional, for display/disambiguation only
  hasToken?: boolean // whether an encrypted token is on file (set by main, never persisted with a value)
  // Model to pin for panes using this account (injected as ANTHROPIC_MODEL). A fresh
  // token-auth session otherwise starts on Claude Code's default (Sonnet). Defaults to
  // Opus 4.8 1M-context; the sentinel 'default' means "don't pin — use Claude Code's default".
  model?: string
  // A usage fingerprint of the account a bound pane's token ACTUALLY reaches — captured by
  // the status line from Claude Code's own per-session data (no API poll, no rate limit).
  // The weekly reset is the stable per-account id; two accounts sharing it = same underlying
  // subscription (a wrong/swapped token). Absent until a pane bound to this account renders.
  verifiedUsage?: {
    weeklyPct: number
    weeklyResetEpoch: number // unix seconds; the stable per-account identifier
    fiveHourPct: number
    at: number // unix seconds when captured
  }
}

// The model a pane gets when no per-account model is set. Opus 4.8, 1M-context variant.
export const DEFAULT_ACCOUNT_MODEL = 'claude-opus-4-8[1m]'

// Ring hues for paired panes. Each active pair claims the first free color, so
// multiple pairs across the grid stay visually distinct. Sized for up to six
// pairs (MAX_PANES / 2). Hex so the renderer can apply them directly
// (border/box-shadow) without extra CSS vars.
export const PAIR_RING_COLORS = [
  '#2dd4bf',
  '#a78bfa',
  '#fbbf24',
  '#f472b6',
  '#38bdf8',
  '#fb923c',
] as const

// Seeded so the built-in Claude path is identical to today.
export const DEFAULT_AGENT_PROFILES: AgentProfile[] = [
  { id: CLAUDE_PROFILE_ID, name: 'Claude Code', command: 'claude', builtin: 'claude' },
]

// Individual pane configuration
export interface PaneConfig {
  id: number
  label: string
  workingDirectory: string
  state: PaneState
  gitStatus?: GitStatus // Git status for pane header
  servers?: ServerInfo[] // Transient: detected listening servers (not persisted)
  agentId?: string // Which agent profile THIS pane runs; falls back to defaultAgentId
  claudeAccountId?: string // Which saved Claude account THIS pane authenticates as; undefined = the global /login account
  // Pane pairing (orchestrator ⇄ worker). Both panes in a pair share pairId and
  // pairColor; pairRole distinguishes who drives vs who grinds. Persisted.
  pairId?: string
  pairRole?: 'orchestrator' | 'worker'
  pairColor?: string // stored hue (from PAIR_RING_COLORS) so rings survive restarts
  // Live-feed panes tail the delegation feed to show delegation activity. Standalone (not
  // tied to a 1:1 pair) so you can open several. Transient: cleared on load since the
  // underlying `tail` process doesn't survive an app restart.
  liveFeed?: boolean
  // Which orchestrator this feed follows: a pane id scopes it to that Claude session's
  // delegations (tails ~/.quadclaude/feed/<id>.log); undefined = all delegations (global log).
  liveFeedScope?: number
}

// Workspace state (persisted)
export interface WorkspaceState {
  layout: LayoutMode
  focusPaneId: number // Which pane is focused in focus layout
  activePaneId: number // Which pane currently has input focus
  panes: PaneConfig[]
  preferences: WorkspacePreferences
  windowBounds?: WindowBounds
  // Splitter position for focus / focus-right layouts (width fraction of the
  // small-panes column). Persisted so it survives layout switches.
  focusSmallRatio?: number
  // Duo-layout divider position (width fraction of the left pane).
  duoRatio?: number
  // Floating PiP strip (duo/solo layouts): snapped corner, collapsed-to-pill
  // state, and whether it's shown at all (Cmd+B toggles).
  pipCorner?: PipCorner
  pipCollapsed?: boolean
  pipVisible?: boolean
}

export interface HotkeyBindings {
  focusTerminal1: string
  focusTerminal2: string
  focusTerminal3: string
  focusTerminal4: string
  layoutGrid: string
  layoutFocus: string
  layoutFocusRight: string
  layoutDuo: string
  layoutSolo: string
  togglePip: string
  cyclePane: string
}

// Use Cmd on Mac, Win on Windows for layout hotkeys
// Use process.platform for Node.js (main process), works in both contexts
const isMac = typeof process !== 'undefined' && process.platform === 'darwin'
const metaKey = isMac ? 'Cmd' : 'Win'

export const DEFAULT_HOTKEYS: HotkeyBindings = {
  focusTerminal1: 'Ctrl+1',
  focusTerminal2: 'Ctrl+2',
  focusTerminal3: 'Ctrl+3',
  focusTerminal4: 'Ctrl+4',
  layoutGrid: `${metaKey}+1`,
  layoutFocus: `${metaKey}+2`,
  layoutFocusRight: `${metaKey}+3`,
  layoutDuo: `${metaKey}+4`,
  layoutSolo: `${metaKey}+5`,
  togglePip: `${metaKey}+B`,
  cyclePane: 'Ctrl+Tab',
}

// Background configuration
export type BackgroundMode = 'unified' | 'per-pane'

export interface BackgroundConfig {
  enabled: boolean
  mode: BackgroundMode
  image: string | null // path to background image (unified mode)
  opacity: number // terminal background opacity (0.5 - 1.0, lower = more background visible)
  paneImages?: Record<number, string | null> // per-pane backgrounds
  customWallpapers?: string[] // user-added wallpaper file paths
}

export const DEFAULT_BACKGROUND: BackgroundConfig = {
  enabled: true,
  mode: 'unified',
  image: 'backgrounds/bg.png',
  opacity: 0.85,
}

export interface WorkspacePreferences {
  theme: 'dark' | 'light' | 'system'
  fontSize: number
  hotkeys: HotkeyBindings
  savedPrompts: SavedPrompt[]
  favoriteDirectories: string[]
  background?: BackgroundConfig
  showPromptBar?: boolean
  // When true, the pane "Claude" button launches `claude --dangerously-skip-permissions`
  dangerouslySkipPermissions?: boolean
  // When false, suppress the chime played when a pane starts waiting on a decision (default: enabled)
  decisionSoundEnabled?: boolean
  // How solid the ground BEHIND the panes is: 1 = the standard glass tint,
  // 0 = fully clear, so the desktop reads straight through the gaps and the
  // panes float on it. Only the ground changes — pane surfaces keep their own
  // opacity so terminal text stays readable at any setting.
  groundOpacity?: number
  // Configurable agents a pane can launch. Seeded with the built-in Claude profile.
  agentProfiles?: AgentProfile[]
  // Global fallback agent when a pane has no agentId assigned yet
  defaultAgentId?: string
  // Per-pane network isolation so dev servers in different panes don't fight over ports
  portIsolation?: PortIsolation
  // Delegation workflow: master switch + how the worker feed window is offered
  delegation?: DelegationPrefs
  // Per-plugin state (enabled + settings), keyed by plugin id. Managed by the
  // generic PluginHost; merged with each plugin's manifest defaults on load.
  plugins?: Record<string, { enabled: boolean; settings: Record<string, unknown> }>
}

// Delegation is opt-in. When enabled and a delegation model is configured, the app
// offers a live "worker" window the first time Claude delegates in a session. The
// approval itself is session-scoped and ephemeral (re-asked each new Claude session),
// so it isn't persisted here — only the master switch is.
export interface DelegationPrefs {
  enabled?: boolean
}

// Strategy for keeping each pane's dev servers from colliding on the same port.
//  - 'off'      : no isolation (default; current behavior)
//  - 'loopback' : each pane binds its own 127.0.0.x IP (same port stays free) — macOS
//                 needs lo0 aliases set up first
//  - 'port'     : each pane gets a distinct base PORT (no privileges needed)
export type PortIsolation = 'off' | 'loopback' | 'port'

// The loopback IP assigned to a pane in 'loopback' mode (127.0.0.2 .. 127.0.0.13).
export function paneLoopbackIp(paneId: number): string {
  return `127.0.0.${2 + paneId}`
}

// Env injected into a pane's PTY so its servers don't collide with other panes'.
// Frameworks that honor HOST/PORT pick this up automatically; for ones that ignore
// env (e.g. Vite), reference it in the dev script: `vite --host $HOST --port $PORT`.
export function portIsolationEnv(paneId: number, mode: PortIsolation | undefined): Record<string, string> {
  if (mode === 'loopback') {
    const ip = paneLoopbackIp(paneId)
    return { HOST: ip, HOSTNAME: ip }
  }
  if (mode === 'port') {
    return { PORT: String(3000 + paneId * 100) }
  }
  return {}
}

// State of the macOS lo0 loopback aliases required by 'loopback' isolation.
export interface LoopbackStatus {
  supported: boolean // false on non-macOS (range is bindable without aliases)
  configured: number // how many of the expected aliases currently exist
  expected: number // how many we want (one per max pane)
  ready: boolean // all expected aliases present
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

// IPC channel names
export const IPC_CHANNELS = {
  // Terminal I/O
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_RESIZE: 'terminal:resize',
  // PTY management
  PTY_CREATE: 'pty:create',
  PTY_KILL: 'pty:kill',
  PTY_EXIT: 'pty:exit',
  PTY_CWD: 'pty:cwd',
  PTY_GIT_STATUS: 'pty:git-status',
  PTY_IS_CLAUDE_RUNNING: 'pty:is-claude-running',

  // Workspace
  WORKSPACE_SAVE: 'workspace:save',
  WORKSPACE_LOAD: 'workspace:load',
  WORKSPACE_GET_HOME: 'workspace:get-home',

  // App
  APP_MENU_ACTION: 'app:menu-action',

  // System
  SYSTEM_RESUME: 'system:resume',

  // App info
  APP_GET_VERSION: 'app:get-version',

  // Dialog
  DIALOG_OPEN_IMAGE: 'dialog:open-image',

  // Shell — open a URL in the system default browser
  APP_OPEN_EXTERNAL: 'app:open-external',
  // Shell — open a markdown file (resolved against a pane's cwd) in TextEdit
  APP_OPEN_IN_EDITOR: 'app:open-in-editor',
  // Diagnostics — renderer writes a structured entry into the main app.log
  APP_LOG: 'app:log',
  // Window transparency — the CSS ground is only half the picture. A native
  // liquid-glass view backs the whole window, and its default `regular`
  // material frosts and BRIGHTENS whatever is behind it, so clearing the CSS
  // ground alone just exposes a white sheet. The renderer sends the ground
  // opacity here so main can switch that material to `clear` and let the
  // desktop actually read through.
  WINDOW_SET_GROUND_OPACITY: 'window:set-ground-opacity',

  // Usage tracking
  USAGE_UPDATE: 'usage:update',
  USAGE_FETCH: 'usage:fetch',
  PTY_CONTEXT_USAGE: 'pty:context-usage',
  PTY_DETECT_SERVERS: 'pty:detect-servers',
  PTY_KILL_SERVER: 'pty:kill-server',
  PTY_PASTE_IMAGE: 'pty:paste-image',

  // Model router (claude-code-router) — run any model as the real Claude Code TUI
  ROUTER_STATUS: 'router:status',
  ROUTER_SAVE_PROVIDER: 'router:save-provider',
  ROUTER_DELETE_PROVIDER: 'router:delete-provider',
  ROUTER_TEST: 'router:test',
  // Delegation — hand bulk work to a cheaper configured model via a `qcdelegate` CLI
  ROUTER_SET_DELEGATION: 'router:set-delegation',
  ROUTER_DELEGATION_STATUS: 'router:delegation-status',
  ROUTER_CLEAR_DELEGATION: 'router:clear-delegation',
  // Per-pane port isolation — manage macOS lo0 loopback aliases
  NET_LOOPBACK_STATUS: 'net:loopback-status',
  NET_ENSURE_LOOPBACK: 'net:ensure-loopback',
  // Delegation telemetry — per-project rollups of what was delegated and whether it worked
  DELEGATION_SUMMARIES: 'delegation:summaries',
  DELEGATION_EVENTS: 'delegation:events',
  DELEGATION_DECISIONS: 'delegation:decisions',
  DELEGATION_CLEAR: 'delegation:clear',
  DELEGATION_VERDICT: 'delegation:verdict',
  DELEGATION_INSIGHTS: 'delegation:insights',
  DELEGATION_FULL_PROMPT: 'delegation:fullPrompt',
  DELEGATION_EXPORT: 'delegation:export',
  // Pushed (main → renderer) when a new delegation event lands in events.jsonl
  DELEGATION_EVENT: 'delegation:event',
  // Write text to the system clipboard from main (reliable regardless of window focus)
  CLIPBOARD_WRITE_TEXT: 'clipboard:write-text',
  // Per-pane Claude accounts: manage the saved-account list + their encrypted tokens.
  CLAUDE_ACCOUNTS_LIST: 'claude-accounts:list',
  CLAUDE_ACCOUNTS_SAVE: 'claude-accounts:save', // upsert {id?,label,email,token?}
  CLAUDE_ACCOUNTS_DELETE: 'claude-accounts:delete',
  CLAUDE_ACCOUNTS_VERIFY: 'claude-accounts:verify', // fetch a token's real account (id)

  // --- Generic plugin system (PluginHost) ---
  PLUGIN_LIST: 'plugin:list',            // → PluginDescriptor[]
  PLUGIN_TOGGLE: 'plugin:toggle',        // (id, enabled) → PluginDescriptor[]
  PLUGIN_SET_SETTING: 'plugin:set-setting', // (id, key, value) → PluginDescriptor[]
  PLUGIN_OPEN: 'plugin:open',            // (id) — open a window-kind plugin
  PLUGIN_CHANGED: 'plugin:changed',      // main → renderer: descriptors changed (push)
  // Renderer → main: compact live workspace snapshot for plugins that observe
  // pane state (only pushed while at least one such plugin is enabled).
  PLUGIN_WORKSPACE_SNAPSHOT: 'plugin:workspace-snapshot',
  // Verification: renderer → main, one event per real pane state transition
  // (only emitted while the Ops Console's verificationMode setting is on).
  OPS_VERIFY_TRANSITION: 'ops:verify-transition',
  // In-app native overlay (rendered in the main window's renderer, no window):
  OPS_INAPP_SNAPSHOT: 'ops:inapp-snapshot',  // main → main renderer: OpsSnapshot
  OPS_INAPP_VERIFY: 'ops:inapp-verify',      // main → main renderer: VerifyOverlay
  OPS_INAPP_SHOW: 'ops:inapp-show',          // main → main renderer: boolean
  OPS_CLOSE: 'ops:close',                     // main renderer → main: close console
  OPS_POPOUT: 'ops:popout',                   // main renderer → main: move console to its own window
  OPS_POPIN: 'ops:popin',                     // ops window → main: hand console back, destroy that window
} as const

// --- Delegation telemetry ----------------------------------------------------
// One structured event per `qcdelegate` run, appended to ~/.quadclaude/events.jsonl by
// the worker script. This is the machine-readable source of truth for "how much was
// delegated, and did it work?" — distinct from the human-readable delegation.log feed.
export interface DelegationEvent {
  ts: string // ISO-8601 UTC
  type: 'delegation'
  project: string // absolute path of the project (git toplevel, or PWD)
  pane: string // originating pane id (QC_PANE), "" if launched outside a pane
  task: string // QC_TASK tag, or "untagged"
  route: string // "providerSlug,modelId" the worker ran against
  durationSec: number
  exit: number // worker exit code (0 = the claude -p run succeeded)
  promptChars: number
  coldStartRetries: number // how many warm-up retries it took before the model responded
  gitMode: 'repo' | 'shadow' | 'none' // how change-attribution was measured
  insertions: number // lines the worker added (measured by snapshot diff)
  deletions: number // lines the worker removed
  files: string // ";"-joined list of changed file paths (capped)
  check: { command: string; exit: number } | null // ground-truth check result, if QC_CHECK was set
  promptPreview?: string // first ~1000 chars of the task sent to the worker (what was delegated)
  outputPreview?: string // last ~1500 chars of the worker's output (how it responded — for diagnosing)
  humanVerdict?: 'ship' | 'revert' | 'edit' // your recorded real outcome (did the delegated change stick?) — feeds eval calibration
}

// A recorded orchestrator KEEP/DELEGATE decision for one unit of work, emitted by
// `qcdecide`. Gives visibility into what Claude chose NOT to delegate, not just what it did.
export interface DelegationDecision {
  ts: string
  type: 'decision'
  project: string
  pane: string
  group: string // the unit of work being decided (a file, a system, a data file…)
  verdict: 'keep' | 'delegate'
  reason: string
  check: string // the QC_CHECK that will gate it (delegate only); "" otherwise
  shadow?: ShadowVerdict // counterfactual result if this unit was later shadow-tested (qcshadow)
}

// One counterfactual test from `qcshadow`: qwen re-attempted a unit Claude chose to KEEP,
// in an ISOLATED git worktree, and we recorded whether it could have matched. qwen's
// output is never shipped — measurement only. Appended to ~/.quadclaude/eval/shadow.jsonl.
export type ShadowCouldMatch = 'yes' | 'likely' | 'no' | 'inconclusive'
export interface ShadowOutcome {
  ts: string
  type: 'shadow'
  group: string // the kept unit that was re-tested (matches a decision's `group`)
  project: string
  taskClass: string
  qwenExit: number
  check: { command: string; exit: number } | null // objective ground truth, if one was given
  judgeVerdict: string // adversarial judge: SHIP | REVIEW | REJECT | unknown
  couldMatch: ShadowCouldMatch // yes/likely = over-cautious KEEP · no = KEEP justified
}

// The trimmed shadow result attached to a decision row in the ledger.
export interface ShadowVerdict {
  couldMatch: ShadowCouldMatch
  judgeVerdict: string
  checkPassed: boolean | null
  ts: string
}

// "What to delegate" intelligence, distilled from the durable eval memory
// (~/.quadclaude/eval). This is the layer that turns the dashboard from a log into an
// optimization tool: it tells you which kinds of work qwen handles reliably.
export interface DelegationClassStat {
  taskClass: string // data | logic | ui | test | config | docs
  n: number // total delegated units in this class
  checked: number // how many ran a ground-truth check
  passed: number // of checked, how many passed
  firstTry: number // of passed, how many on the first delegation attempt
  passRate: number | null
  recommendation: string // Delegate | Delegate + check | Keep / heavy-verify | Write a check first
  tone: 'good' | 'warn' | 'bad' | 'muted'
}

export interface DelegationInsights {
  byClass: DelegationClassStat[]
  totalOutcomes: number
  checkedCount: number
  successRate: number | null // of checked outcomes, fraction that passed
  firstTryRate: number | null // of passed outcomes, fraction that passed on attempt #1
  calibration: {
    humanLabeled: number // delegations you marked ship/revert/edit
    evalTrustworthiness: number | null // % the check/judge agreed with your verdict
    evalFalsePositives: number // check said pass, you reverted
    evalFalseNegatives: number // check said fail, you shipped
  } | null
  // Counterfactual over-caution signal, rolled up from qcshadow runs (eval/shadow.jsonl):
  // of the units Claude KEPT and we re-tested, how often qwen could have matched. This is
  // what answers "am I keeping work qwen could have done equally well?".
  shadow: {
    total: number
    matched: number // couldMatch yes|likely — qwen could have done it (over-cautious KEEP)
    fellShort: number // couldMatch no — KEEP justified, qwen genuinely fell short
    inconclusive: number // ran but no objective signal to compare
    byClass: Array<{ taskClass: string; tested: number; matched: number }>
  } | null
}

// Per-project rollup the UI reads. Cumulative across the project's whole history.
export interface DelegationProjectSummary {
  project: string
  projectName: string
  delegations: number
  succeeded: number // exit === 0
  failed: number
  checked: number // delegations that ran a QC_CHECK
  checkPassed: number // of those, how many passed (objective "it worked")
  coldStartRetries: number // total warm-up retries across all runs
  insertions: number // total lines delegated (added)
  deletions: number
  filesTouched: number
  firstAt: string
  lastAt: string
  // Derived (filled in on read):
  successRate?: number | null // succeeded / delegations
  checkRate?: number | null // checkPassed / checked — the truest "did delegation work?"
}

// --- Model router (claude-code-router) types ---------------------------------
// QuadClaude writes ccr's local config so a pane can run `claude` against a non-
// Anthropic model with identical look/feel. We never speak the LLM API ourselves.

// What the wizard collects for one bring-your-own model.
export interface RouterProviderInput {
  label: string // friendly display name, e.g. "DeepSeek V3"
  baseUrl: string // full chat/completions endpoint, e.g. https://openrouter.ai/api/v1/chat/completions
  apiKey: string // hosted-provider key; stored in ccr's local config.json (chmod 600)
  model: string // model id at the provider, e.g. deepseek/deepseek-chat
  transformer?: string // optional ccr transformer key (openrouter | deepseek | gemini | ...)
}

export interface RouterStatusProvider {
  name: string // ccr provider slug
  model: string
  baseUrl: string
}

export interface RouterStatus {
  configPath: string
  ccrInstalled: boolean
  installHint: string // e.g. "npm install -g @musistudio/claude-code-router"
  command: string // pane command that launches the real Claude Code TUI ("ccr code")
  providers: RouterStatusProvider[]
}

export interface RouterSaveResult {
  ok: boolean
  route: string // "providerSlug,modelId"
  command: string // pane command, e.g. "ccr code"
  env: Record<string, string> // env to put on the created AgentProfile (ANTHROPIC_MODEL)
  ccrInstalled: boolean
  error?: string
}

export interface RouterTestResult {
  ok: boolean
  error?: string
}

// State of the generic `qcdelegate` worker that hands bulk tasks to a cheaper model.
export interface RouterDelegationStatus {
  command: string // the CLI name an orchestrator calls, e.g. "qcdelegate"
  scriptPath: string // where the generated worker script lives
  scriptExists: boolean
  binDir: string // dir the script is written to (must be on the user's PATH)
  onPath: boolean // is `command` resolvable from the login shell?
  route: string // "providerSlug,modelId" of the delegation model; "" when unset
  logPath: string // delegation feed log
  feedCommand: string // pane command that tails the feed live
}

// Rate limit usage data from Anthropic API
export interface UsageData {
  fiveHour: { utilization: number; resetsAt: string | null }
  weekly: { utilization: number; resetsAt: string | null }
  fetchedAt: number
}

// Per-pane context window usage from statusline
export interface ContextUsage {
  contextPct: number
  model: string
  updatedAt: number
}

// Menu actions
export type MenuAction =
  | 'reset-pane'
  | 'clear-pane'
  | 'launch-claude'
  | 'layout-grid'
  | 'layout-focus'
  | 'layout-focus-right'
  | 'layout-duo'
  | 'layout-solo'
  | 'toggle-pip'
  | 'cycle-pane'
  | 'focus-pane-1'
  | 'focus-pane-2'
  | 'focus-pane-3'
  | 'focus-pane-4'
  | 'toggle-theme'
  | 'increase-font'
  | 'decrease-font'
  // Chrome zoom (Cmd+Shift +/−/0) — the app's own UI text, distinct from the
  // font actions above, which target the frontmost surface's content.
  | 'increase-ui'
  | 'decrease-ui'
  | 'reset-ui'
  | 'open-settings'
  | 'toggle-prompt-bar'
  | 'dump-diagnostics'
