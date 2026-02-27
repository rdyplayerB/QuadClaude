import { app, BrowserWindow, ipcMain, Menu, shell, powerMonitor } from 'electron'
import path from 'path'
import { PtyManager } from './pty'
import { WorkspaceManager } from './workspace'
import { HistoryManager } from './history'
import { logger } from './logger'
import { IPC_CHANNELS, MenuAction } from '../shared/types'

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
try {
  if (require('electron-squirrel-startup')) {
    app.quit()
  }
} catch {
  // electron-squirrel-startup not installed, skip
}

let mainWindow: BrowserWindow | null = null
let logWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let workspaceManager: WorkspaceManager | null = null
let historyManager: HistoryManager | null = null

// Track paneId → projectId mapping for history capture
const paneProjectIds = new Map<number, string>()
// Buffer PTY output per pane for history (avoids writing every tiny chunk)
const outputBuffers = new Map<number, string>()
let historyFlushTimer: NodeJS.Timeout | null = null

// Strip ANSI escape codes for readable history
function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\[\??[0-9;]*[a-zA-Z]/g, '') // CSI sequences (including DEC private modes like ?2004h)
    .replace(/\x1B\[\?[0-9;]*[hl]/g, '') // Set/reset mode sequences
    .replace(/\x1B\].*?\x07/g, '') // OSC sequences
    .replace(/\x1B\][^\x07]*(?:\x1B\\)?/g, '') // OSC sequences with ST terminator
    .replace(/\x1B[()][AB012]/g, '') // Character set sequences
    .replace(/\x1B[\x20-\x2F]*[\x40-\x7E]/g, '') // Other escape sequences
    .replace(/\x1B[=>]/g, '') // Keypad mode sequences
    .replace(/\r/g, '') // Carriage returns (used in screen redraws)
}

// Clean TUI noise from terminal output for readable history
function cleanTerminalOutput(str: string): string {
  return str
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      if (!trimmed) return true // keep blank lines for now, collapse later
      // Remove lines that are only spinner/progress glyphs
      if (/^[✶✳✢·✽✻⏺▐▛▜▝▘⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷░▒▓█▌▀▄\s]+$/.test(trimmed)) return false
      // Remove lines that are only box-drawing characters
      if (/^[─│╭╮╰╯├┤┬┴┼═║╔╗╚╝╠╣╦╩╬┌┐└┘┊┈╌╎\s]+$/.test(trimmed)) return false
      // Remove common TUI thinking/progress indicators
      if (/^(Running|Cogitating|Thinking|Processing|Generating|Analyzing|Searching|Reading|Writing)…?\s*$/.test(trimmed)) return false
      return true
    })
    .join('\n')
    // Collapse runs of 3+ blank lines into a single blank line
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Flush buffered output to history
function flushOutputHistory() {
  if (!historyManager) return
  for (const [paneId, buffer] of outputBuffers.entries()) {
    if (!buffer.trim()) continue
    // Lazily resolve project ID if not cached
    if (!paneProjectIds.has(paneId)) {
      resolveProjectId(paneId)
    }
    const projectId = paneProjectIds.get(paneId)
    if (!projectId) continue
    const cleaned = cleanTerminalOutput(stripAnsi(buffer))
    if (cleaned) {
      historyManager.appendExchange(projectId, paneId, 'output', cleaned)
    }
  }
  outputBuffers.clear()
}

// Resolve and cache project ID for a pane's working directory
function resolveProjectId(paneId: number): string | null {
  if (!historyManager || !ptyManager) return null
  const cwd = ptyManager.getCwd(paneId)
  if (!cwd) return null
  const projectId = historyManager.getOrCreateProjectId(cwd)
  if (projectId) {
    paneProjectIds.set(paneId, projectId)
  }
  return projectId
}

// Start periodic flush of output buffers to history
function startHistoryCapture() {
  if (historyFlushTimer) return
  historyFlushTimer = setInterval(() => {
    flushOutputHistory()
  }, 5000) // Flush every 5 seconds
}

// Stop history capture and flush remaining data
function stopHistoryCapture() {
  if (historyFlushTimer) {
    clearInterval(historyFlushTimer)
    historyFlushTimer = null
  }
  flushOutputHistory()
}

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

function openLogViewer() {
  if (logWindow) {
    logWindow.focus()
    return
  }

  logWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: 'QuadClaude Error Log',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  const logs = logger.getLogsAsText()
  const logFilePath = logger.getLogFilePath()

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Error Log</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'SF Mono', Menlo, Monaco, 'Courier New', monospace;
      font-size: 12px;
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 20px;
      line-height: 1.5;
    }
    h1 {
      font-size: 16px;
      color: #fff;
      margin-bottom: 8px;
      font-weight: 500;
    }
    .log-path {
      font-size: 11px;
      color: #808080;
      margin-bottom: 16px;
      word-break: break-all;
    }
    .toolbar {
      margin-bottom: 16px;
      display: flex;
      gap: 8px;
    }
    button {
      background: #3c3c3c;
      border: 1px solid #555;
      color: #d4d4d4;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      border-radius: 4px;
    }
    button:hover { background: #4c4c4c; }
    pre {
      background: #252526;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      padding: 16px;
      overflow: auto;
      max-height: calc(100vh - 140px);
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .error { color: #f48771; }
    .warn { color: #cca700; }
    .info { color: #75beff; }
    .empty {
      color: #808080;
      font-style: italic;
    }
  </style>
</head>
<body>
  <h1>Application Error Log</h1>
  <div class="log-path">Log file: ${logFilePath}</div>
  <div class="toolbar">
    <button onclick="location.reload()">Refresh</button>
    <button onclick="copyLogs()">Copy to Clipboard</button>
  </div>
  <pre id="logs">${logs ? escapeHtml(logs) : '<span class="empty">No log entries yet.</span>'}</pre>
  <script>
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    function copyLogs() {
      const logsText = document.getElementById('logs').textContent;
      navigator.clipboard.writeText(logsText).then(() => {
        alert('Logs copied to clipboard');
      });
    }
    // Highlight log levels
    const pre = document.getElementById('logs');
    pre.innerHTML = pre.innerHTML
      .replace(/\\[!ERROR\\]/g, '<span class="error">[!ERROR]</span>')
      .replace(/\\[\\?WARN\\]/g, '<span class="warn">[?WARN]</span>')
      .replace(/\\[ INFO\\]/g, '<span class="info">[ INFO]</span>');
  </script>
</body>
</html>
  `.trim()

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  logWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  logWindow.on('closed', () => {
    logWindow = null
  })

  logger.info('app', 'Log viewer opened')
}

function createWindow() {
  logger.info('window', 'Creating main window')

  // Load saved window bounds or use defaults
  const savedBounds = workspaceManager?.getWindowBounds()
  logger.info('window', 'Window bounds', savedBounds ? `${savedBounds.width}x${savedBounds.height} at (${savedBounds.x}, ${savedBounds.y})` : 'Using defaults (1400x900)')

  const preloadPath = path.join(__dirname, 'preload.js')
  logger.info('window', 'Preload script path', preloadPath)

  try {
    mainWindow = new BrowserWindow({
      width: savedBounds?.width ?? 1400,
      height: savedBounds?.height ?? 900,
      x: savedBounds?.x,
      y: savedBounds?.y,
      minWidth: 800,
      minHeight: 600,
      backgroundColor: '#1e1e1e',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 15, y: 15 },
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: preloadPath,
        zoomFactor: 1.0,
      },
    })
    logger.info('window', 'BrowserWindow created successfully')
  } catch (error) {
    logger.error('window', 'Failed to create BrowserWindow', error instanceof Error ? error.message : String(error))
    throw error
  }

  // Load the app
  if (isDev) {
    const devUrl = 'http://localhost:5173'
    logger.info('window', 'Loading dev URL', devUrl)
    mainWindow.loadURL(devUrl).catch(err => {
      logger.error('window', 'Failed to load dev URL', err.message)
    })
    mainWindow.webContents.openDevTools()
  } else {
    const htmlPath = path.join(__dirname, '../renderer/index.html')
    logger.info('window', 'Loading production HTML', htmlPath)
    mainWindow.loadFile(htmlPath).catch(err => {
      logger.error('window', 'Failed to load HTML file', err.message)
    })
  }

  // Listen for renderer errors
  mainWindow.webContents.on('did-fail-load', (_, errorCode, errorDescription) => {
    logger.error('renderer', 'Page failed to load', `Code: ${errorCode}, Description: ${errorDescription}`)
  })

  mainWindow.webContents.on('render-process-gone', (_, details) => {
    logger.error('renderer', 'Render process crashed', `Reason: ${details.reason}, Exit code: ${details.exitCode}`)
  })

  mainWindow.webContents.on('unresponsive', () => {
    logger.warn('renderer', 'Renderer became unresponsive')
  })

  mainWindow.webContents.on('responsive', () => {
    logger.info('renderer', 'Renderer is responsive again')
  })

  mainWindow.webContents.on('did-finish-load', () => {
    logger.info('renderer', 'Page finished loading')
    // Ensure zoom is exactly 1.0 to prevent scaling differences
    mainWindow?.webContents.setZoomFactor(1.0)
  })

  // Block browser-like refresh shortcuts to prevent losing terminal state
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Block Cmd+R, Ctrl+R, F5, Cmd+Shift+R, Ctrl+Shift+R
    const keyLower = input.key.toLowerCase()
    const isRefresh =
      (keyLower === 'r' && (input.meta || input.control)) ||
      input.key === 'F5'

    if (isRefresh) {
      event.preventDefault()
      logger.info('window', 'Blocked refresh shortcut', `key: ${input.key}, meta: ${input.meta}, ctrl: ${input.control}, shift: ${input.shift}`)
    }
  })

  // Block programmatic navigation/reloads (e.g., from external links or scripts)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // In production, only allow navigating to the app's own URL
    // In dev, allow the dev server URL
    const currentUrl = mainWindow?.webContents.getURL() || ''
    const allowedOrigin = isDev ? 'http://localhost:5173' : 'file://'

    if (!url.startsWith(allowedOrigin)) {
      event.preventDefault()
      logger.warn('window', 'Blocked navigation attempt', url)
    }
  })

  // Save window bounds on resize/move
  mainWindow.on('resize', saveWindowBounds)
  mainWindow.on('move', saveWindowBounds)

  mainWindow.on('closed', () => {
    logger.info('window', 'Main window closed')
    mainWindow = null
  })

  // Create application menu
  createApplicationMenu()
}

function saveWindowBounds() {
  if (mainWindow && workspaceManager) {
    const bounds = mainWindow.getBounds()
    workspaceManager.saveWindowBounds(bounds)
  }
}

function createApplicationMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        {
          label: 'About QuadClaude',
          click: () => {
            app.setAboutPanelOptions({
              applicationName: 'QuadClaude',
              applicationVersion: app.getVersion(),
              version: 'Build ' + new Date().toISOString().split('T')[0],
              copyright: '© 2024-2026 rdyplayerB',
              credits: 'Crafted by ビルド studio\nhttps://birudo.studio',
            })
            app.showAboutPanel()
          }
        },
        { type: 'separator' },
        {
          label: 'Settings...',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendMenuAction('open-settings')
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        // Explicitly register refresh shortcuts to block Electron's default reload behavior
        // These must be enabled for the accelerator to be "claimed" and prevent default
        {
          label: 'Reload (Disabled)',
          accelerator: 'CmdOrCtrl+R',
          visible: false,
          click: () => {
            // Intentionally do nothing - blocks page refresh
            logger.info('window', 'Blocked Cmd+R from menu')
          }
        },
        {
          label: 'Force Reload (Disabled)',
          accelerator: 'CmdOrCtrl+Shift+R',
          visible: false,
          click: () => {
            // Intentionally do nothing - blocks force refresh
            logger.info('window', 'Blocked Cmd+Shift+R from menu')
          }
        },
        {
          label: 'Reload F5 (Disabled)',
          accelerator: 'F5',
          visible: false,
          click: () => {
            // Intentionally do nothing - blocks F5 refresh
            logger.info('window', 'Blocked F5 from menu')
          }
        },
        {
          label: 'Prompt Palette',
          accelerator: 'CmdOrCtrl+P',
          click: () => sendMenuAction('open-command-palette')
        },
        { type: 'separator' },
        {
          label: 'Grid Layout',
          accelerator: 'CmdOrCtrl+1',
          click: () => sendMenuAction('layout-grid')
        },
        {
          label: 'Focus Left Layout',
          accelerator: 'CmdOrCtrl+2',
          click: () => sendMenuAction('layout-focus')
        },
        {
          label: 'Focus Right Layout',
          accelerator: 'CmdOrCtrl+3',
          click: () => sendMenuAction('layout-focus-right')
        },
        { type: 'separator' },
        {
          label: 'Increase Font Size',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => sendMenuAction('increase-font')
        },
        {
          label: 'Decrease Font Size',
          accelerator: 'CmdOrCtrl+-',
          click: () => sendMenuAction('decrease-font')
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'Focus Terminal 1',
          accelerator: 'CmdOrCtrl+Shift+1',
          click: () => sendMenuAction('focus-pane-1')
        },
        {
          label: 'Focus Terminal 2',
          accelerator: 'CmdOrCtrl+Shift+2',
          click: () => sendMenuAction('focus-pane-2')
        },
        {
          label: 'Focus Terminal 3',
          accelerator: 'CmdOrCtrl+Shift+3',
          click: () => sendMenuAction('focus-pane-3')
        },
        {
          label: 'Focus Terminal 4',
          accelerator: 'CmdOrCtrl+Shift+4',
          click: () => sendMenuAction('focus-pane-4')
        },
        { type: 'separator' },
        {
          label: 'Clear Terminal',
          accelerator: 'CmdOrCtrl+K',
          click: () => sendMenuAction('clear-pane')
        },
        {
          label: 'Launch Claude',
          accelerator: 'CmdOrCtrl+L',
          click: () => sendMenuAction('launch-claude')
        },
        { type: 'separator' },
        {
          label: 'Reset Current Pane',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => sendMenuAction('reset-pane')
        }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'View Error Log...',
          click: () => openLogViewer()
        },
        {
          label: 'Open Log File in Finder',
          click: async () => {
            const logPath = logger.getLogFilePath()
            logger.info('app', 'Opening log file location', logPath)
            await shell.showItemInFolder(logPath)
          }
        },
        { type: 'separator' },
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://github.com/rdyplayerB/QuadClaude')
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function sendMenuAction(action: MenuAction) {
  mainWindow?.webContents.send(IPC_CHANNELS.APP_MENU_ACTION, action)
}

// Setup IPC handlers
function setupIPC() {
  // PTY creation
  ipcMain.handle(IPC_CHANNELS.PTY_CREATE, async (_, paneId: number, cwd?: string) => {
    logger.info('pty', `Creating PTY for pane ${paneId}`, cwd ? `cwd: ${cwd}` : 'using default cwd')
    try {
      const result = await ptyManager?.createPty(paneId, cwd)
      if (result) {
        logger.info('pty', `PTY created successfully for pane ${paneId}`)
        // Resolve project ID for history tracking
        const projectId = resolveProjectId(paneId)
        if (projectId) {
          logger.info('history', `Pane ${paneId} mapped to project ${projectId}`)
        }
      } else {
        logger.error('pty', `Failed to create PTY for pane ${paneId}`)
      }
      return result
    } catch (error) {
      logger.error('pty', `Exception creating PTY for pane ${paneId}`, error instanceof Error ? error.message : String(error))
      return false
    }
  })

  // PTY kill
  ipcMain.handle(IPC_CHANNELS.PTY_KILL, async (_, paneId: number) => {
    logger.info('pty', `Killing PTY for pane ${paneId}`)
    ptyManager?.killPty(paneId)
  })

  // Terminal input
  ipcMain.on(IPC_CHANNELS.TERMINAL_INPUT, (_, paneId: number, data: string) => {
    ptyManager?.write(paneId, data)
    // Capture input for history (only meaningful text, not single keystrokes)
    if (historyManager && (data.includes('\r') || data.includes('\n'))) {
      const cleaned = stripAnsi(data).replace(/[\r\n]+/g, '\n').trim()
      if (cleaned.length > 1) {
        // Resolve project ID lazily
        if (!paneProjectIds.has(paneId)) {
          resolveProjectId(paneId)
        }
        const projectId = paneProjectIds.get(paneId)
        if (projectId) {
          historyManager.appendExchange(projectId, paneId, 'input', cleaned)
        }
      }
    }
  })

  // Terminal resize
  ipcMain.on(IPC_CHANNELS.TERMINAL_RESIZE, (_, paneId: number, cols: number, rows: number) => {
    ptyManager?.resize(paneId, cols, rows)
  })

  // Get current working directory
  ipcMain.handle(IPC_CHANNELS.PTY_CWD, async (_, paneId: number) => {
    return ptyManager?.getCwd(paneId)
  })

  // Get git status
  ipcMain.handle(IPC_CHANNELS.PTY_GIT_STATUS, async (_, paneId: number) => {
    return ptyManager?.getGitStatus(paneId)
  })

  // Check if Claude process is running in PTY
  ipcMain.handle(IPC_CHANNELS.PTY_IS_CLAUDE_RUNNING, async (_, paneId: number) => {
    return ptyManager?.isClaudeRunning(paneId) ?? false
  })

  // Workspace operations
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LOAD, async () => {
    logger.info('workspace', 'Loading workspace state')
    try {
      const state = workspaceManager?.load()
      logger.info('workspace', 'Workspace loaded successfully', state ? `Layout: ${state.layout}, Panes: ${state.panes?.length || 0}` : 'No state')
      return state
    } catch (error) {
      logger.error('workspace', 'Failed to load workspace', error instanceof Error ? error.message : String(error))
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SAVE, async (_, state) => {
    try {
      workspaceManager?.save(state)
      logger.info('workspace', 'Workspace saved')
    } catch (error) {
      logger.error('workspace', 'Failed to save workspace', error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_HOME, async () => {
    const home = app.getPath('home')
    logger.info('workspace', 'Home directory requested', home)
    return home
  })

  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, async () => {
    return app.getVersion()
  })

  // History operations
  ipcMain.handle(IPC_CHANNELS.HISTORY_GET_PROJECT_ID, async (_, projectPath: string) => {
    return historyManager?.getOrCreateProjectId(projectPath)
  })

  ipcMain.on(IPC_CHANNELS.HISTORY_APPEND, (_, projectId: string, paneId: number, type: 'input' | 'output', content: string) => {
    historyManager?.appendExchange(projectId, paneId, type, content)
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_GET_SESSIONS, async (_, projectId: string) => {
    return historyManager?.getSessions(projectId) || []
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_GET_DAY, async (_, projectId: string, date: string) => {
    return historyManager?.getDayContent(projectId, date) || ''
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_GET_DAY_EXCHANGES, async (_, projectId: string, date: string) => {
    return historyManager?.getDayExchanges(projectId, date) || []
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_DELETE_DAY, async (_, projectId: string, date: string) => {
    return historyManager?.deleteDay(projectId, date) || false
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_SEARCH, async (_, projectId: string, query: string, limit?: number) => {
    return historyManager?.search(projectId, query, limit) || []
  })
}

// App lifecycle
app.whenReady().then(() => {
  logger.info('app', 'App ready, starting initialization')
  logger.info('app', 'App version', app.getVersion())
  logger.info('app', 'Electron version', process.versions.electron)
  logger.info('app', 'Chrome version', process.versions.chrome)
  logger.info('app', 'Node version', process.versions.node)
  logger.info('app', 'Platform', `${process.platform} ${process.arch}`)
  logger.info('app', 'User data path', app.getPath('userData'))
  logger.info('app', 'Is packaged', String(app.isPackaged))

  try {
    logger.info('workspace', 'Initializing WorkspaceManager')
    workspaceManager = new WorkspaceManager()
    logger.info('workspace', 'WorkspaceManager initialized')
  } catch (error) {
    logger.error('workspace', 'Failed to initialize WorkspaceManager', error instanceof Error ? error.message : String(error))
  }

  try {
    logger.info('history', 'Initializing HistoryManager')
    historyManager = new HistoryManager()
    logger.info('history', 'HistoryManager initialized')
  } catch (error) {
    logger.error('history', 'Failed to initialize HistoryManager', error instanceof Error ? error.message : String(error))
  }

  try {
    logger.info('pty', 'Initializing PtyManager')
    ptyManager = new PtyManager((paneId, data) => {
      mainWindow?.webContents.send(IPC_CHANNELS.TERMINAL_OUTPUT, paneId, data)
      // Buffer output for history capture
      if (historyManager) {
        const existing = outputBuffers.get(paneId) || ''
        outputBuffers.set(paneId, existing + data)
      }
    }, (paneId, exitCode) => {
      logger.info('pty', `PTY exited for pane ${paneId}`, `Exit code: ${exitCode}`)
      mainWindow?.webContents.send(IPC_CHANNELS.PTY_EXIT, paneId, exitCode)
    })
    logger.info('pty', 'PtyManager initialized')
    // Start history output capture
    startHistoryCapture()
    logger.info('history', 'History capture started')
  } catch (error) {
    logger.error('pty', 'Failed to initialize PtyManager', error instanceof Error ? error.message : String(error))
  }

  logger.info('ipc', 'Setting up IPC handlers')
  setupIPC()
  logger.info('ipc', 'IPC handlers registered')

  createWindow()

  app.on('activate', () => {
    logger.info('app', 'App activated')
    if (BrowserWindow.getAllWindows().length === 0) {
      logger.info('app', 'No windows open, creating new window')
      createWindow()
    }
  })

  // Listen for system resume (wake from sleep)
  powerMonitor.on('resume', () => {
    logger.info('app', 'System resumed from sleep')
    mainWindow?.webContents.send(IPC_CHANNELS.SYSTEM_RESUME)
  })
})

app.on('window-all-closed', () => {
  logger.info('app', 'All windows closed')

  // Save current working directories BEFORE killing PTYs
  if (ptyManager && workspaceManager) {
    const cwds = ptyManager.getAllCwds()
    workspaceManager.updatePaneCwds(cwds)
  }

  ptyManager?.killAll()
  if (process.platform !== 'darwin') {
    logger.info('app', 'Quitting app (non-macOS)')
    app.quit()
  }
})

app.on('before-quit', () => {
  logger.info('app', 'App is quitting')
  // Save CWDs before killing PTYs (important when Cmd+Q is used)
  if (ptyManager && workspaceManager) {
    const cwds = ptyManager.getAllCwds()
    if (cwds.size > 0) {
      workspaceManager.updatePaneCwds(cwds)
      logger.info('app', 'Saved CWDs on quit', `${cwds.size} pane(s)`)
    }
  }
  // Flush captured output and shut down history
  stopHistoryCapture()
  historyManager?.shutdown()
  ptyManager?.killAll()
})

// Catch uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('app', 'Uncaught exception', error.stack || error.message)
})

process.on('unhandledRejection', (reason) => {
  logger.error('app', 'Unhandled promise rejection', String(reason))
})
