// Layout types - all show 4 terminals (true to "QuadClaude" name)
export type LayoutMode = 'grid' | 'focus'

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
export type PaneState = 'shell' | 'claude-active'

// Individual pane configuration
export interface PaneConfig {
  id: number
  label: string
  workingDirectory: string
  state: PaneState
  gitStatus?: GitStatus // Git status for pane header
}

// Workspace state (persisted)
export interface WorkspaceState {
  layout: LayoutMode
  focusPaneId: number // Which pane is focused in focus layout
  activePaneId: number // Which pane currently has input focus
  panes: PaneConfig[]
  preferences: WorkspacePreferences
  windowBounds?: WindowBounds
}

export interface HotkeyBindings {
  focusTerminal1: string
  focusTerminal2: string
  focusTerminal3: string
  focusTerminal4: string
  layoutGrid: string
  layoutFocus: string
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
}

// All available layouts
export const ALL_LAYOUTS: LayoutMode[] = ['grid', 'focus']

export interface WorkspacePreferences {
  theme: 'dark' | 'light' | 'system'
  fontSize: number
  hotkeys: HotkeyBindings
  savedPrompts: SavedPrompt[]
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
  TERMINAL_READY: 'terminal:ready',

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
  APP_QUIT: 'app:quit',
  APP_MENU_ACTION: 'app:menu-action',

  // System
  SYSTEM_RESUME: 'system:resume',

  // App info
  APP_GET_VERSION: 'app:get-version',
} as const

// Menu actions
export type MenuAction =
  | 'reset-pane'
  | 'clear-pane'
  | 'launch-claude'
  | 'layout-grid'
  | 'layout-focus'
  | 'focus-pane-1'
  | 'focus-pane-2'
  | 'focus-pane-3'
  | 'focus-pane-4'
  | 'toggle-theme'
  | 'increase-font'
  | 'decrease-font'
  | 'open-settings'
