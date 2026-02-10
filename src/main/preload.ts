import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, WorkspaceState, MenuAction } from '../shared/types'

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // PTY operations
  createPty: (paneId: number, cwd?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PTY_CREATE, paneId, cwd),

  killPty: (paneId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.PTY_KILL, paneId),

  getCwd: (paneId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.PTY_CWD, paneId),

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
})

// Type declaration for the renderer
declare global {
  interface Window {
    electronAPI: {
      createPty: (paneId: number, cwd?: string) => Promise<boolean>
      killPty: (paneId: number) => Promise<void>
      getCwd: (paneId: number) => Promise<string | null>
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
    }
  }
}
