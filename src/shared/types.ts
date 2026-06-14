// Layout types - all show 4 terminals (true to "QuadClaude" name)
export type LayoutMode = 'grid' | 'focus' | 'focus-right'

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
export type PaneState = 'shell' | 'claude-active' | 'claude-waiting'

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
  // Pane pairing (orchestrator ⇄ worker). Both panes in a pair share pairId and
  // pairColor; pairRole distinguishes who drives vs who grinds. Persisted.
  pairId?: string
  pairRole?: 'orchestrator' | 'worker'
  pairColor?: string // stored hue (from PAIR_RING_COLORS) so rings survive restarts
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
}

export interface HotkeyBindings {
  focusTerminal1: string
  focusTerminal2: string
  focusTerminal3: string
  focusTerminal4: string
  layoutGrid: string
  layoutFocus: string
  layoutFocusRight: string
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
  // Configurable agents a pane can launch. Seeded with the built-in Claude profile.
  agentProfiles?: AgentProfile[]
  // Global fallback agent when a pane has no agentId assigned yet
  defaultAgentId?: string
  // Per-pane network isolation so dev servers in different panes don't fight over ports
  portIsolation?: PortIsolation
  // Delegation workflow: master switch + how the worker feed window is offered
  delegation?: DelegationPrefs
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
  DELEGATION_CLEAR: 'delegation:clear',
  DELEGATION_EXPORT: 'delegation:export',
  // Pushed (main → renderer) when a new delegation event lands in events.jsonl
  DELEGATION_EVENT: 'delegation:event',
  // Write text to the system clipboard from main (reliable regardless of window focus)
  CLIPBOARD_WRITE_TEXT: 'clipboard:write-text',
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
  | 'focus-pane-1'
  | 'focus-pane-2'
  | 'focus-pane-3'
  | 'focus-pane-4'
  | 'toggle-theme'
  | 'increase-font'
  | 'decrease-font'
  | 'open-settings'
  | 'toggle-prompt-bar'
