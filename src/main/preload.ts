import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS, WorkspaceState, MenuAction, GitStatus, UsageData, ContextUsage, ServerInfo, RouterProviderInput, RouterStatus, RouterSaveResult, RouterTestResult, RouterDelegationStatus } from '../shared/types'

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // PTY operations
  createPty: (paneId: number, cwd?: string, env?: Record<string, string>) =>
    ipcRenderer.invoke(IPC_CHANNELS.PTY_CREATE, paneId, cwd, env),

  killPty: (paneId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.PTY_KILL, paneId),

  getCwd: (paneId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.PTY_CWD, paneId),

  getGitStatus: (paneId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.PTY_GIT_STATUS, paneId) as Promise<GitStatus | null>,

  isClaudeRunning: (paneId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.PTY_IS_CLAUDE_RUNNING, paneId) as Promise<boolean>,

  // Terminal I/O
  sendInput: (paneId: number, data: string) =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_INPUT, paneId, data),

  resizeTerminal: (paneId: number, cols: number, rows: number) =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_RESIZE, paneId, cols, rows),

  onTerminalOutput: (callback: (paneId: number, data: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, paneId: number, data: string) => {
      callback(paneId, data)
    }
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_OUTPUT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_OUTPUT, handler)
  },

  onPtyExit: (callback: (paneId: number, exitCode: number) => void) => {
    const handler = (_: Electron.IpcRendererEvent, paneId: number, exitCode: number) => {
      callback(paneId, exitCode)
    }
    ipcRenderer.on(IPC_CHANNELS.PTY_EXIT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_EXIT, handler)
  },

  // Workspace
  loadWorkspace: () =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LOAD) as Promise<WorkspaceState>,

  saveWorkspace: (state: Partial<WorkspaceState>) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SAVE, state),

  getHomeDir: () =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_HOME) as Promise<string>,

  // Menu actions
  onMenuAction: (callback: (action: MenuAction) => void) => {
    const handler = (_: Electron.IpcRendererEvent, action: MenuAction) => {
      callback(action)
    }
    ipcRenderer.on(IPC_CHANNELS.APP_MENU_ACTION, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_MENU_ACTION, handler)
  },

  // System events
  onSystemResume: (callback: () => void) => {
    const handler = () => {
      callback()
    }
    ipcRenderer.on(IPC_CHANNELS.SYSTEM_RESUME, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SYSTEM_RESUME, handler)
  },

  // App info
  getAppVersion: () =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION) as Promise<string>,

  // Usage tracking
  onUsageUpdate: (callback: (data: UsageData) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: UsageData) => { callback(data) }
    ipcRenderer.on(IPC_CHANNELS.USAGE_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.USAGE_UPDATE, handler)
  },
  fetchUsage: () =>
    ipcRenderer.invoke(IPC_CHANNELS.USAGE_FETCH) as Promise<UsageData | null>,

  // Context usage per pane
  getContextUsage: (paneId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.PTY_CONTEXT_USAGE, paneId) as Promise<ContextUsage | null>,

  // Local server detection / kill
  detectServers: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PTY_DETECT_SERVERS) as Promise<Record<number, ServerInfo[]>>,
  killServer: (paneId: number, pid: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.PTY_KILL_SERVER, paneId, pid) as Promise<boolean>,

  // Drop an image -> clipboard + Ctrl+V so Claude Code attaches it as [Image #N]
  pasteImage: (paneId: number, filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PTY_PASTE_IMAGE, paneId, filePath) as Promise<boolean>,

  // File dialogs
  openImageDialog: () =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_IMAGE) as Promise<string | null>,

  // Open a URL in the system default browser
  openExternal: (url: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL, url) as Promise<boolean>,

  // Model router (run any model as the real Claude Code TUI)
  routerStatus: () =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTER_STATUS) as Promise<RouterStatus>,
  routerSaveProvider: (input: RouterProviderInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTER_SAVE_PROVIDER, input) as Promise<RouterSaveResult>,
  routerDeleteProvider: (name: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTER_DELETE_PROVIDER, name) as Promise<void>,
  routerTest: (input: RouterProviderInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTER_TEST, input) as Promise<RouterTestResult>,
  routerSetDelegation: (route: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTER_SET_DELEGATION, route) as Promise<RouterDelegationStatus>,
  routerDelegationStatus: () =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTER_DELEGATION_STATUS) as Promise<RouterDelegationStatus>,
  routerClearDelegation: () =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTER_CLEAR_DELEGATION) as Promise<RouterDelegationStatus>,

  // File utilities
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // Performance monitoring
  reportPerf: (data: unknown) => ipcRenderer.send('perf:report', data),
  markPerf: (label: string) => ipcRenderer.send('perf:marker', label),
  getPerfStatus: () => ipcRenderer.invoke('perf:status'),
  onPerfFlush: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('perf:flush', handler)
    return () => ipcRenderer.removeListener('perf:flush', handler)
  },
})

// Type declaration for the renderer
declare global {
  interface Window {
    electronAPI: {
      createPty: (paneId: number, cwd?: string, env?: Record<string, string>) => Promise<boolean>
      killPty: (paneId: number) => Promise<void>
      getCwd: (paneId: number) => Promise<string | null>
      getGitStatus: (paneId: number) => Promise<GitStatus | null>
      isClaudeRunning: (paneId: number) => Promise<boolean>
      sendInput: (paneId: number, data: string) => void
      resizeTerminal: (paneId: number, cols: number, rows: number) => void
      onTerminalOutput: (callback: (paneId: number, data: string) => void) => () => void
      onPtyExit: (callback: (paneId: number, exitCode: number) => void) => () => void
      loadWorkspace: () => Promise<WorkspaceState>
      saveWorkspace: (state: Partial<WorkspaceState>) => Promise<void>
      getHomeDir: () => Promise<string>
      onMenuAction: (callback: (action: MenuAction) => void) => () => void
      onSystemResume: (callback: () => void) => () => void
      getAppVersion: () => Promise<string>
      onUsageUpdate: (callback: (data: UsageData) => void) => () => void
      fetchUsage: () => Promise<UsageData | null>
      getContextUsage: (paneId: number) => Promise<ContextUsage | null>
      detectServers: () => Promise<Record<number, ServerInfo[]>>
      killServer: (paneId: number, pid: number) => Promise<boolean>
      pasteImage: (paneId: number, filePath: string) => Promise<boolean>
      openImageDialog: () => Promise<string | null>
      openExternal: (url: string) => Promise<boolean>
      routerStatus: () => Promise<RouterStatus>
      routerSaveProvider: (input: RouterProviderInput) => Promise<RouterSaveResult>
      routerDeleteProvider: (name: string) => Promise<void>
      routerTest: (input: RouterProviderInput) => Promise<RouterTestResult>
      routerSetDelegation: (route: string) => Promise<RouterDelegationStatus>
      routerDelegationStatus: () => Promise<RouterDelegationStatus>
      routerClearDelegation: () => Promise<RouterDelegationStatus>
      getPathForFile: (file: File) => string
      reportPerf: (data: unknown) => void
      markPerf: (label: string) => void
      getPerfStatus: () => Promise<{ running: boolean; logFile: string | null; logDir: string }>
      onPerfFlush: (callback: () => void) => () => void
    }
  }
}
