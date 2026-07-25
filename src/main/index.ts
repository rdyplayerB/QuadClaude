import { app, BrowserWindow, shell, powerMonitor, clipboard } from 'electron'
import liquidGlass from 'electron-liquid-glass'
import fs from 'fs'
import path from 'path'
import { PtyManager } from './pty'
import { UsagePoller } from './usage'
import { WorkspaceManager } from './workspace'
import { RouterManager } from './router'
import { delegationLog } from './delegationLog'
import { logger } from './logger'
import { IPC_CHANNELS, MenuAction } from '../shared/types'
import { installStatuslineScript } from './statusline'
import { buildApplicationMenu } from './menu'
import { registerIpcHandlers } from './ipc'
import {
  initPluginHost, listPlugins, emitPtyExit, shutdownPlugins, closeAllPluginUi,
} from './pluginHost'
import {
  startPerfMonitor,
  stopPerfMonitor,
  setupPerfHandlers,
} from './perfMonitor'

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
try {
  if (require('electron-squirrel-startup')) {
    app.quit()
  }
} catch {
  // electron-squirrel-startup not installed, skip
}

let mainWindow: BrowserWindow | null = null

// Send to the renderer only if the window AND its webContents are still alive. node-pty
// (and other async sources) can emit one more event after the window/webContents has been
// destroyed on quit/reload; `mainWindow?.` guards null but NOT a destroyed-but-non-null
// webContents, which throws "Object has been destroyed". This guards both.
function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}
let stopDelegationWatch: (() => void) | null = null

// Bridge the app's delegation toggle to the Claude running inside a pane: write an
// authoritative status file the orchestrator (and a SessionStart hook) can read, so a
// fresh session auto-detects "delegation is ON" instead of falling back to OFF-by-default.
// Content: the model route when enabled+configured, else "off".
function delegationModelRoute(): string {
  try {
    const raw = fs.readFileSync(path.join(app.getPath('home'), '.quadclaude', 'delegation-model'), 'utf8').trim()
    return raw.replace('-delegate,', ',') // report the user-facing route
  } catch {
    return ''
  }
}
function delegationEnabled(): boolean {
  try {
    return !!workspaceManager?.load().preferences.delegation?.enabled
  } catch {
    return false
  }
}
function syncDelegationActive(): void {
  try {
    const dir = path.join(app.getPath('home'), '.quadclaude')
    fs.mkdirSync(dir, { recursive: true })
    const route = delegationModelRoute()
    const on = delegationEnabled() && !!route
    fs.writeFileSync(path.join(dir, 'delegation-active'), on ? route : 'off', 'utf8')
  } catch (error) {
    logger.error('delegation', 'failed to sync delegation-active', error instanceof Error ? error.message : String(error))
  }
}
let logWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let usagePoller: UsagePoller | null = null
let workspaceManager: WorkspaceManager | null = null
const routerManager = new RouterManager()
const isDev = process.env.QC_FORCE_PROD === '1' ? false : (process.env.NODE_ENV === 'development' || !app.isPackaged)

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
      color: #737375;
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
      background: #252525;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      padding: 16px;
      overflow: auto;
      max-height: calc(100vh - 140px);
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .error { color: #f87171; }
    .warn { color: #fbbf24; }
    .info { color: #22d3ee; }
    .empty {
      color: #737375;
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
      transparent: true,
      hasShadow: true,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 15, y: 12 },
      // Hold until first paint so the Dock animation doesn't expand into a
      // fully-transparent empty rectangle while the renderer is still
      // parsing the bundle. ready-to-show is unreliable with transparent
      // windows, so did-finish-load (below) drives show() instead.
      show: false,
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
    // Reveal the window now that content has painted - avoids the empty
    // transparent flash during the Dock launch animation.
    mainWindow?.show()
    // Push new delegation events to the renderer (drives the live dashboard and the
    // session-scoped worker-feed prompt). Re-armed on every load; the prior watcher
    // is cleared first so a reload doesn't stack pollers.
    stopDelegationWatch?.()
    stopDelegationWatch = delegationLog.startWatching((event) => {
      sendToRenderer(IPC_CHANNELS.DELEGATION_EVENT, event)
    })
    // Ensure zoom is exactly 1.0 to prevent scaling differences
    mainWindow?.webContents.setZoomFactor(1.0)

    // Enable liquid glass effect (macOS Tahoe+)
    try {
      if (mainWindow) {
        mainWindow.setWindowButtonVisibility(true)
        liquidGlass.addView(mainWindow.getNativeWindowHandle(), {
          cornerRadius: 12,
          tintColor: '#20000000',
          opaque: false,
        })
        logger.info('window', 'Liquid glass enabled')
      }
    } catch (err) {
      logger.info('window', 'Liquid glass not available', err instanceof Error ? err.message : String(err))
    }
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

  // Any window.open / target=_blank / popup attempt → hand the URL to the system default
  // browser (a normal tab in the active session) and NEVER spawn a chromeless Electron
  // popup window. Without this, the terminal's link addon and any preview markup open
  // their own bare window instead of the user's real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Save window bounds on resize/move
  mainWindow.on('resize', saveWindowBounds)
  mainWindow.on('move', saveWindowBounds)

  // Returning to the app from another window/app can leave the webContents without
  // keyboard focus — the terminal pane stays selectable but won't accept typing or
  // Ctrl-C until focus is restored. Re-focus the webContents on window focus; the
  // renderer then re-focuses the active terminal's textarea.
  mainWindow.on('focus', () => mainWindow?.webContents.focus())

  mainWindow.on('closed', () => {
    logger.info('window', 'Main window closed')
    mainWindow = null
    // Nothing may outlive the app window. A popped-out Activity Console (or the
    // log viewer) is still a BrowserWindow, so leaving it open means
    // 'window-all-closed' never fires and closing QuadClaude strands a lone
    // console window keeping the whole app alive. Tearing them down here also
    // means the console always comes back in-app on the next launch.
    // Dismiss plugin UI first so its "showing" flag doesn't survive the window
    // and re-open on top of a freshly created one.
    try { closeAllPluginUi() } catch { /* never block teardown */ }
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) { try { w.destroy() } catch { /* already gone */ } }
    }
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
  buildApplicationMenu(sendMenuAction, openLogViewer)
}

function sendMenuAction(action: MenuAction) {
  sendToRenderer(IPC_CHANNELS.APP_MENU_ACTION, action)
}

// Persist plugin enabled-state + settings to the workspace so they survive a
// restart. Called after every toggle/setSetting (rare, user-driven — load()
// here is fine, unlike the debounced pane-save path). Without this, enabling a
// plugin / "open at launch" / verification mode all silently reset on relaunch.
function persistPluginPrefs(): void {
  if (!workspaceManager) return
  const plugins: Record<string, { enabled: boolean; settings: Record<string, unknown> }> = {}
  for (const d of listPlugins()) {
    if (d.manifest?.id) plugins[d.manifest.id] = { enabled: d.enabled, settings: d.settings }
  }
  const preferences = workspaceManager.load().preferences
  workspaceManager.save({ preferences: { ...preferences, plugins } })
}

// Setup IPC handlers
function setupIPC() {
  registerIpcHandlers({
    ptyManager, workspaceManager, routerManager,
    getMainWindow: () => mainWindow,
    persistPluginPrefs, syncDelegationActive, delegationModelRoute,
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

  // Keep delegation telemetry bounded: fold an oversized event log into the cumulative
  // per-project rollup and drop summaries for long-abandoned projects.
  delegationLog.maintain()
  // Publish the current delegation toggle so a Claude session in a pane can detect it.
  syncDelegationActive()

  try {
    logger.info('pty', 'Initializing PtyManager')
    ptyManager = new PtyManager((paneId, data) => {
      sendToRenderer(IPC_CHANNELS.TERMINAL_OUTPUT, paneId, data)
    }, (paneId, exitCode) => {
      logger.info('pty', `PTY exited for pane ${paneId}`, `Exit code: ${exitCode}`)
      sendToRenderer(IPC_CHANNELS.PTY_EXIT, paneId, exitCode)
      emitPtyExit(paneId, exitCode) // feed plugins (Ops Console incident toasts)
    })
    logger.info('pty', 'PtyManager initialized')
  } catch (error) {
    logger.error('pty', 'Failed to initialize PtyManager', error instanceof Error ? error.message : String(error))
  }

  logger.info('ipc', 'Setting up IPC handlers')
  setupIPC()
  logger.info('ipc', 'IPC handlers registered')

  // Performance recording: starts automatically and writes JSONL to
  // <userData>/perf-logs. Analyze later with scripts/analyze-perf.mjs.
  setupPerfHandlers()
  startPerfMonitor(
    () => ptyManager?.getStats() ?? { sessions: 0, totalBytesOut: 0, perPaneBytesOut: {} },
    () => ptyManager?.getPaneDescendants() ?? Promise.resolve([])
  )

  createWindow()

  // Generic plugin host: activates enabled plugins (e.g. the Ops Console) and
  // wires them a read-only capability context. Must run after ptyManager +
  // workspaceManager + createWindow (menu/notify depend on them).
  try {
    initPluginHost({
      appVersion: app.getVersion(),
      homeDir: app.getPath('home'),
      initialPluginPrefs: workspaceManager?.load()?.preferences?.plugins,
      ptyStats: () => ptyManager?.getStats() ?? { sessions: 0, totalBytesOut: 0, perPaneBytesOut: {} },
      getGitStatus: (paneId) => ptyManager?.getGitStatus(paneId) ?? Promise.resolve(null),
      getContextUsage: (paneId) => ptyManager?.getContextUsage(paneId) ?? Promise.resolve(null),
      rebuildMenu: () => createApplicationMenu(),
      notifyChanged: (descriptors) => sendToRenderer(IPC_CHANNELS.PLUGIN_CHANGED, descriptors),
      sendToUi: (channel, payload) => sendToRenderer(channel, payload),
    })
    // Rebuild the menu so any auto-enabled plugin's item appears.
    createApplicationMenu()
  } catch (error) {
    logger.error('pluginHost', 'Failed to init plugin host', error instanceof Error ? error.message : String(error))
  }

  // Start usage polling
  usagePoller = new UsagePoller()
  if (mainWindow) usagePoller.start(mainWindow)

  // Install statusline script for context window tracking. Deferred so the
  // sync FS work (settings.json read/write, /tmp scan + statSync per file)
  // doesn't block the main thread while the renderer is loading its bundle
  // and making its first workspace:load IPC call.
  setImmediate(() => installStatuslineScript())

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
    sendToRenderer(IPC_CHANNELS.SYSTEM_RESUME)
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

let isHardExiting = false
app.on('before-quit', (e) => {
  if (isHardExiting) return
  isHardExiting = true
  logger.info('app', 'App is quitting')
  try { shutdownPlugins() } catch { /* never block quit */ }
  stopPerfMonitor()
  // Save CWDs before killing PTYs (important when Cmd+Q is used) — synchronous.
  if (ptyManager && workspaceManager) {
    const cwds = ptyManager.getAllCwds()
    if (cwds.size > 0) {
      workspaceManager.updatePaneCwds(cwds)
      logger.info('app', 'Saved CWDs on quit', `${cwds.size} pane(s)`)
    }
  }
  ptyManager?.killAll()
  // node-pty's read threads can fire a ThreadSafeFunction callback into a half-finalized
  // V8 environment during Electron's graceful teardown → SIGABRT in pty.node (the recurring
  // CrBrowserMain abort-on-quit). Bypass that teardown entirely: cancel the graceful quit,
  // give the just-killed ptys a tick to release their native handles, then hard-exit so the
  // OS reaps those threads instead of V8 racing them. State is already saved above.
  e.preventDefault()
  setTimeout(() => app.exit(0), 100)
})

// Catch uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('app', 'Uncaught exception', error.stack || error.message)
})

process.on('unhandledRejection', (reason) => {
  logger.error('app', 'Unhandled promise rejection', String(reason))
})
