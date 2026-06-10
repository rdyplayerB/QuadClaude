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
// can be added up to MAX_PANES, after which the grid cells get too small to
// be useful at typical window sizes.
export const MIN_PANES = 4
export const MAX_PANES = 6

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
// multiple pairs across a 6-pane grid stay visually distinct. Hex so the
// renderer can apply them directly (border/box-shadow) without extra CSS vars.
export const PAIR_RING_COLORS = ['#2dd4bf', '#a78bfa', '#fbbf24'] as const

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
} as const

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
