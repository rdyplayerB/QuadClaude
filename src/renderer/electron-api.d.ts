// Ambient declaration of the `window.electronAPI` bridge for the renderer.
//
// This lived inside src/main/preload.ts, but the renderer tsconfig only includes
// src/renderer + src/shared — so the augmentation was invisible and every
// `window.electronAPI.*` access produced a phantom TS2339. Living here (under
// src/renderer/**, which IS included and has the DOM lib for `File`) makes the
// whole renderer typecheck green, so `tsc` becomes a real pre-build gate.
//
// preload.ts remains the single implementation (contextBridge.exposeInMainWorld);
// keep this interface in sync when adding a bridge method.
import type {
  GitStatus, WorkspaceState, MenuAction, UsageData, ContextUsage, ServerInfo,
  RouterProviderInput, RouterStatus, RouterSaveResult, RouterTestResult,
  RouterDelegationStatus, LoopbackStatus, DelegationProjectSummary, DelegationEvent,
  DelegationDecision, DelegationInsights, ClaudeAccount,
} from '../shared/types'
import type { PluginDescriptor, WorkspaceSnapshot } from '../shared/plugins'

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
      getContextUsage: (paneId: number) => Promise<ContextUsage | null>
      detectServers: () => Promise<Record<number, ServerInfo[]>>
      killServer: (paneId: number, pid: number) => Promise<boolean>
      pasteImage: (paneId: number, filePath: string) => Promise<boolean>
      openImageDialog: () => Promise<string | null>
      openExternal: (url: string) => Promise<boolean>
      openInEditor: (paneId: number, filePath: string) => Promise<boolean>
      logDiag: (level: 'info' | 'warn' | 'error', category: string, message: string, details?: string) => void
      setGroundOpacity: (groundOpacity: number) => Promise<void>
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
      claudeAccountsSave: (input: { id?: string; label: string; email?: string; model?: string }) => Promise<{ ok: boolean; error?: string; accounts: ClaudeAccount[] }>
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
      opsRequestState: () => void
      opsPopOut: () => void
      opsPopIn: () => void
      onDelegationEvent: (callback: (event: DelegationEvent) => void) => () => void
      getPathForFile: (file: File) => string
      reportPerf: (data: unknown) => void
      onPerfFlush: (callback: () => void) => () => void
    }
  }
}
