import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS, WorkspaceState, MenuAction, GitStatus, UsageData, ContextUsage, ServerInfo, RouterProviderInput, RouterStatus, RouterSaveResult, RouterTestResult, RouterDelegationStatus, LoopbackStatus, DelegationProjectSummary, DelegationEvent, DelegationDecision, DelegationInsights, ClaudeAccount } from '../shared/types'
import { PluginDescriptor, WorkspaceSnapshot } from '../shared/plugins'

// Every pane registers its OWN terminal:output + pty:exit listener (each filters
// by paneId), so with up to MAX_PANES (12) panes — plus brief overlap while a
// pane remounts — the count legitimately exceeds Node's default 10-listener
// warning threshold. These aren't leaks (each is removed on unmount), so raise
// the cap to a comfortable ceiling instead of letting the false "possible memory
// leak" warning spam the console.
ipcRenderer.setMaxListeners(64)

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

  // Open a markdown file (resolved against the pane's cwd) in TextEdit
  openInEditor: (paneId: number, filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_IN_EDITOR, paneId, filePath) as Promise<boolean>,

  // Write a structured diagnostic entry into the main app.log (fire-and-forget)
  logDiag: (level: 'info' | 'warn' | 'error', category: string, message: string, details?: string) =>
    ipcRenderer.send(IPC_CHANNELS.APP_LOG, level, category, message, details),

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
  loopbackStatus: () =>
    ipcRenderer.invoke(IPC_CHANNELS.NET_LOOPBACK_STATUS) as Promise<LoopbackStatus>,
  ensureLoopback: () =>
    ipcRenderer.invoke(IPC_CHANNELS.NET_ENSURE_LOOPBACK) as Promise<LoopbackStatus>,
  delegationSummaries: () =>
    ipcRenderer.invoke(IPC_CHANNELS.DELEGATION_SUMMARIES) as Promise<DelegationProjectSummary[]>,
  delegationEvents: () =>
    ipcRenderer.invoke(IPC_CHANNELS.DELEGATION_EVENTS) as Promise<DelegationEvent[]>,
  delegationDecisions: () =>
    ipcRenderer.invoke(IPC_CHANNELS.DELEGATION_DECISIONS) as Promise<DelegationDecision[]>,
  delegationInsights: () =>
    ipcRenderer.invoke(IPC_CHANNELS.DELEGATION_INSIGHTS) as Promise<DelegationInsights>,
  delegationFullPrompt: (ts: string, task: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DELEGATION_FULL_PROMPT, ts, task) as Promise<string | null>,
  delegationClear: () =>
    ipcRenderer.invoke(IPC_CHANNELS.DELEGATION_CLEAR) as Promise<DelegationProjectSummary[]>,
  delegationVerdict: (task: string, verdict: 'ship' | 'revert' | 'edit') =>
    ipcRenderer.invoke(IPC_CHANNELS.DELEGATION_VERDICT, task, verdict) as Promise<boolean>,
  delegationExport: (save: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.DELEGATION_EXPORT, save) as Promise<{ text: string; path: string | null; canceled: boolean }>,
  clipboardWriteText: (text: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_WRITE_TEXT, text) as Promise<boolean>,

  // Per-pane Claude accounts (token is write-only from the renderer; never returned)
  claudeAccountsList: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_ACCOUNTS_LIST) as Promise<ClaudeAccount[]>,
  claudeAccountsSave: (input: { id?: string; label: string; email?: string; model?: string; token?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_ACCOUNTS_SAVE, input) as Promise<{ ok: boolean; error?: string; accounts: ClaudeAccount[] }>,
  claudeAccountsDelete: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_ACCOUNTS_DELETE, id) as Promise<ClaudeAccount[]>,
  claudeAccountsVerify: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_ACCOUNTS_VERIFY, id) as Promise<{ accounts: ClaudeAccount[]; status: 'ok' | 'needs_pane' }>,

  // Generic plugin system (Settings → Plugins tab)
  listPlugins: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_LIST) as Promise<PluginDescriptor[]>,
  togglePlugin: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_TOGGLE, id, enabled) as Promise<PluginDescriptor[]>,
  setPluginSetting: (id: string, key: string, value: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_SET_SETTING, id, key, value) as Promise<PluginDescriptor[]>,
  openPlugin: (id: string) => ipcRenderer.send(IPC_CHANNELS.PLUGIN_OPEN, id),
  onPluginChanged: (callback: (descriptors: PluginDescriptor[]) => void) => {
    const handler = (_: Electron.IpcRendererEvent, d: PluginDescriptor[]) => callback(d)
    ipcRenderer.on(IPC_CHANNELS.PLUGIN_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGIN_CHANGED, handler)
  },
  // Compact live workspace snapshot for plugins that observe pane state.
  pushWorkspaceSnapshot: (snap: WorkspaceSnapshot) =>
    ipcRenderer.send(IPC_CHANNELS.PLUGIN_WORKSPACE_SNAPSHOT, snap),
  // Verification: emit one event per real pane state transition (ground truth).
  pushOpsTransition: (evt: { seq: number; paneId: number; from: string; to: string; t0: number }) =>
    ipcRenderer.send(IPC_CHANNELS.OPS_VERIFY_TRANSITION, evt),
  // In-app Activity Console overlay bridge (native, this window's process)
  onOpsInappSnapshot: (cb: (snap: unknown) => void) => {
    const h = (_: unknown, s: unknown) => cb(s); ipcRenderer.on(IPC_CHANNELS.OPS_INAPP_SNAPSHOT, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.OPS_INAPP_SNAPSHOT, h)
  },
  onOpsInappVerify: (cb: (o: unknown) => void) => {
    const h = (_: unknown, o: unknown) => cb(o); ipcRenderer.on(IPC_CHANNELS.OPS_INAPP_VERIFY, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.OPS_INAPP_VERIFY, h)
  },
  onOpsInappShow: (cb: (show: boolean) => void) => {
    const h = (_: unknown, v: boolean) => cb(v); ipcRenderer.on(IPC_CHANNELS.OPS_INAPP_SHOW, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.OPS_INAPP_SHOW, h)
  },
  opsSetRecord: (on: boolean) => ipcRenderer.send('ops:set-record', on),
  opsReportMove: (m: unknown) => ipcRenderer.send('ops:verify-move', m),
  opsClose: () => ipcRenderer.send(IPC_CHANNELS.OPS_CLOSE),
  onDelegationEvent: (callback: (event: DelegationEvent) => void) => {
    const handler = (_: unknown, event: DelegationEvent) => callback(event)
    ipcRenderer.on(IPC_CHANNELS.DELEGATION_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DELEGATION_EVENT, handler)
  },

  // File utilities
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // Performance monitoring
  reportPerf: (data: unknown) => ipcRenderer.send('perf:report', data),
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
      openInEditor: (paneId: number, filePath: string) => Promise<boolean>
      logDiag: (level: 'info' | 'warn' | 'error', category: string, message: string, details?: string) => void
      routerStatus: () => Promise<RouterStatus>
      routerSaveProvider: (input: RouterProviderInput) => Promise<RouterSaveResult>
      routerDeleteProvider: (name: string) => Promise<void>
      routerTest: (input: RouterProviderInput) => Promise<RouterTestResult>
      routerSetDelegation: (route: string) => Promise<RouterDelegationStatus>
      routerDelegationStatus: () => Promise<RouterDelegationStatus>
      routerClearDelegation: () => Promise<RouterDelegationStatus>
      loopbackStatus: () => Promise<LoopbackStatus>
      ensureLoopback: () => Promise<LoopbackStatus>
      delegationSummaries: () => Promise<DelegationProjectSummary[]>
      delegationEvents: () => Promise<DelegationEvent[]>
      delegationDecisions: () => Promise<DelegationDecision[]>
      delegationInsights: () => Promise<DelegationInsights>
      delegationFullPrompt: (ts: string, task: string) => Promise<string | null>
      delegationClear: () => Promise<DelegationProjectSummary[]>
      delegationVerdict: (task: string, verdict: 'ship' | 'revert' | 'edit') => Promise<boolean>
      delegationExport: (save: boolean) => Promise<{ text: string; path: string | null; canceled: boolean }>
      clipboardWriteText: (text: string) => Promise<boolean>
      claudeAccountsList: () => Promise<ClaudeAccount[]>
      claudeAccountsSave: (input: { id?: string; label: string; email?: string; model?: string; token?: string }) => Promise<{ ok: boolean; error?: string; accounts: ClaudeAccount[] }>
      claudeAccountsDelete: (id: string) => Promise<ClaudeAccount[]>
      claudeAccountsVerify: (id: string) => Promise<{ accounts: ClaudeAccount[]; status: 'ok' | 'needs_pane' }>
      listPlugins: () => Promise<PluginDescriptor[]>
      togglePlugin: (id: string, enabled: boolean) => Promise<PluginDescriptor[]>
      setPluginSetting: (id: string, key: string, value: unknown) => Promise<PluginDescriptor[]>
      openPlugin: (id: string) => void
      onPluginChanged: (callback: (descriptors: PluginDescriptor[]) => void) => () => void
      pushWorkspaceSnapshot: (snap: WorkspaceSnapshot) => void
      pushOpsTransition: (evt: { seq: number; paneId: number; from: string; to: string; t0: number }) => void
      onOpsInappSnapshot: (cb: (snap: unknown) => void) => () => void
      onOpsInappVerify: (cb: (o: unknown) => void) => () => void
      onOpsInappShow: (cb: (show: boolean) => void) => () => void
      opsSetRecord: (on: boolean) => void
      opsReportMove: (m: unknown) => void
      opsClose: () => void
      onDelegationEvent: (callback: (event: DelegationEvent) => void) => () => void
      getPathForFile: (file: File) => string
      reportPerf: (data: unknown) => void
      onPerfFlush: (callback: () => void) => () => void
    }
  }
}
