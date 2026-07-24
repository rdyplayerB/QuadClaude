import { app, BrowserWindow, ipcMain, Menu, shell, powerMonitor, dialog, clipboard, nativeImage } from 'electron'
import liquidGlass from 'electron-liquid-glass'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { PtyManager } from './pty'
import { UsagePoller } from './usage'
import { WorkspaceManager } from './workspace'
import { RouterManager } from './router'
import { delegationLog } from './delegationLog'
import { accountStore } from './accountStore'
import { logger } from './logger'
import { IPC_CHANNELS, MenuAction, RouterProviderInput, portIsolationEnv, DEFAULT_ACCOUNT_MODEL } from '../shared/types'
import { loopbackStatus, ensureLoopbackAliases } from './loopback'
import { installStatuslineScript } from './statusline'
import {
  initPluginHost, getPluginMenuItems, listPlugins, togglePlugin, setPluginSetting,
  openPlugin, receiveWorkspaceSnapshot, emitPtyExit, shutdownPlugins,
} from './pluginHost'
import { WorkspaceSnapshot } from '../shared/plugins'
import {
  startPerfMonitor,
  stopPerfMonitor,
  setupPerfHandlers,
  addMarker,
  revealPerfLogs,
  requestRendererFlush,
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
              credits: 'The ADHD workspace for Claude Code\n\nCrafted by ビルド studio · https://birudo.studio',
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
          label: 'Always Show Prompt Bar',
          accelerator: 'CmdOrCtrl+P',
          type: 'checkbox',
          checked: true,
          click: (menuItem) => {
            sendMenuAction('toggle-prompt-bar')
            // Menu item checked state toggles automatically
          }
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
        {
          label: 'Duo Layout',
          accelerator: 'CmdOrCtrl+4',
          click: () => sendMenuAction('layout-duo')
        },
        {
          label: 'Solo Layout',
          accelerator: 'CmdOrCtrl+5',
          click: () => sendMenuAction('layout-solo')
        },
        { type: 'separator' },
        {
          label: 'Toggle PiP Strip',
          accelerator: 'CmdOrCtrl+B',
          click: () => sendMenuAction('toggle-pip')
        },
        {
          label: 'Cycle Pane Into View',
          accelerator: 'Ctrl+Tab',
          click: () => sendMenuAction('cycle-pane')
        },
        { type: 'separator' },
        // Cmd +/- targets whichever surface is frontmost — Activity Console,
        // else the delegation dashboard, else the terminals (see App.tsx).
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
        // The app's own UI text (toolbar, pane headers, Settings), separate
        // from terminal font so each can be sized for how it's read.
        {
          label: 'Increase UI Size',
          accelerator: 'CmdOrCtrl+Shift+Plus',
          click: () => sendMenuAction('increase-ui')
        },
        {
          label: 'Decrease UI Size',
          accelerator: 'CmdOrCtrl+Shift+-',
          click: () => sendMenuAction('decrease-ui')
        },
        {
          label: 'Reset UI Size',
          accelerator: 'CmdOrCtrl+Shift+0',
          click: () => sendMenuAction('reset-ui')
        },
        { type: 'separator' },
        // Plugin-contributed items (e.g. Activity Console). Generic — any
        // enabled window-kind plugin with a menu entry appears here.
        ...getPluginMenuItems(),
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
      label: 'Performance',
      submenu: [
        {
          label: 'Mark Slowdown Now',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => {
            requestRendererFlush()
            addMarker('user-reported-slowdown')
          }
        },
        {
          label: 'Add Marker',
          click: () => {
            requestRendererFlush()
            addMarker('manual-marker')
          }
        },
        {
          label: 'Dump Pane Diagnostics',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => sendMenuAction('dump-diagnostics')
        },
        { type: 'separator' },
        {
          label: 'Reveal Performance Logs',
          click: () => revealPerfLogs()
        }
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
  // PTY creation
  ipcMain.handle(IPC_CHANNELS.PTY_CREATE, async (_, paneId: number, cwd?: string, env?: Record<string, string>) => {
    logger.info('pty', `Creating PTY for pane ${paneId}`, cwd ? `cwd: ${cwd}` : 'using default cwd')
    try {
      // Inject per-pane port-isolation env (HOST/PORT) so dev servers don't collide,
      // and QC_PANE so a `qcdelegate` run inside this pane stamps its telemetry with the
      // originating pane id (lets the app attribute delegations to the right session).
      const prefs = workspaceManager?.load().preferences
      const iso = portIsolationEnv(paneId, prefs?.portIsolation)
      // Surface the delegation toggle into the pane's shell so a Claude session can detect
      // delegation mode from its environment (mirrors the ~/.quadclaude/delegation-active file).
      const delegationOn = !!prefs?.delegation?.enabled && !!delegationModelRoute()
      const delegationEnv = delegationOn
        ? { QC_DELEGATION: '1', QC_DELEGATION_MODEL: delegationModelRoute() }
        : { QC_DELEGATION: '' }
      // Per-pane Claude account: the renderer passes the bound account id as a non-secret
      // env HINT (QC_ACCOUNT_ID). We decrypt that account's long-lived subscription token
      // and inject it as CLAUDE_CODE_OAUTH_TOKEN so `claude` authenticates as that account,
      // overriding the shared Keychain login. We also blank ANTHROPIC_API_KEY for this pane
      // — it outranks the OAuth token in precedence, so a stray global API key would
      // silently switch the pane to metered billing. QC_ACCOUNT_LABEL feeds the statusline.
      // The hint itself is stripped so it never lingers in the pane env.
      let accountEnv: Record<string, string> = {}
      // Prefer the env HINT from launchAgent (timing-safe right after picking an account,
      // before the debounced workspace save lands). On a COLD pane spawn (e.g. app restart)
      // there's no hint, so fall back to the pane's PERSISTED binding — the workspace is
      // already loaded then, so it's safe. This is what makes the binding survive a restart
      // instead of silently falling back to the global /login.
      const accountId = env?.QC_ACCOUNT_ID || workspaceManager?.load().panes.find((p) => p.id === paneId)?.claudeAccountId
      const baseEnv = { ...(env || {}) }
      delete baseEnv.QC_ACCOUNT_ID
      if (accountId) {
        const token = accountStore.getToken(accountId)
        const label = accountStore.getLabel(accountId)
        if (token) {
          accountEnv = {
            CLAUDE_CODE_OAUTH_TOKEN: token,
            ANTHROPIC_API_KEY: '',
            QC_ACCOUNT_LABEL: label || '',
            // Keep the account id in the pane's env so the status line can stamp this
            // account's identity fingerprint (acct-usage-<id>.json) as it renders.
            QC_ACCOUNT_ID: accountId,
            // Point the statusline at THIS account's usage cache (per-account session +
            // weekly numbers) instead of the global login's.
            QC_USAGE_CACHE: path.join(app.getPath('home'), '.claude', `.statusline-usage-${accountId}`),
          }
          // Pin the model for this account (a fresh token session otherwise starts on
          // Sonnet). Default to Opus 4.8 1M; the sentinel 'default' opts out of pinning.
          const model = accountStore.getModel(accountId) ?? DEFAULT_ACCOUNT_MODEL
          if (model && model !== 'default') accountEnv.ANTHROPIC_MODEL = model
        } else {
          logger.warn('accounts', `Pane ${paneId} bound to account ${accountId} but no token available — using global login`)
        }
      }
      const mergedEnv = { ...baseEnv, ...iso, QC_PANE: String(paneId), ...delegationEnv, ...accountEnv }
      const result = await ptyManager?.createPty(paneId, cwd, mergedEnv)
      if (result) {
        logger.info('pty', `PTY created successfully for pane ${paneId}`)
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
      syncDelegationActive() // keep the delegation status file current when the toggle changes
      logger.info('workspace', 'Workspace saved')
    } catch (error) {
      logger.error('workspace', 'Failed to save workspace', error instanceof Error ? error.message : String(error))
    }
  })

  // Model router (claude-code-router) — write ccr config so a pane can run the real
  // Claude Code TUI against any non-Anthropic model.
  ipcMain.handle(IPC_CHANNELS.ROUTER_STATUS, async () => {
    return routerManager.status()
  })

  ipcMain.handle(IPC_CHANNELS.ROUTER_SAVE_PROVIDER, async (_, input: RouterProviderInput) => {
    return routerManager.saveProvider(input)
  })

  ipcMain.handle(IPC_CHANNELS.ROUTER_DELETE_PROVIDER, async (_, name: string) => {
    routerManager.deleteProvider(name)
  })

  ipcMain.handle(IPC_CHANNELS.ROUTER_TEST, async (_, input: RouterProviderInput) => {
    return routerManager.testConnection(input)
  })

  ipcMain.handle(IPC_CHANNELS.ROUTER_SET_DELEGATION, async (_, route: string) => {
    return routerManager.setDelegation(route)
  })

  ipcMain.handle(IPC_CHANNELS.ROUTER_DELEGATION_STATUS, async () => {
    return routerManager.delegationStatus()
  })

  ipcMain.handle(IPC_CHANNELS.ROUTER_CLEAR_DELEGATION, async () => {
    routerManager.clearDelegation()
    return routerManager.delegationStatus()
  })

  // Delegation telemetry — per-project rollups, raw events, export, and a wipe action.
  ipcMain.handle(IPC_CHANNELS.DELEGATION_SUMMARIES, async () => {
    return delegationLog.getSummaries()
  })

  ipcMain.handle(IPC_CHANNELS.DELEGATION_EVENTS, async () => {
    return delegationLog.getEvents()
  })

  ipcMain.handle(IPC_CHANNELS.DELEGATION_DECISIONS, async () => {
    return delegationLog.getDecisions()
  })

  ipcMain.handle(IPC_CHANNELS.DELEGATION_INSIGHTS, async () => {
    return delegationLog.getInsights()
  })

  ipcMain.handle(IPC_CHANNELS.DELEGATION_FULL_PROMPT, async (_, ts: string, task: string) => {
    return delegationLog.getFullPrompt(ts, task)
  })

  ipcMain.handle(IPC_CHANNELS.DELEGATION_CLEAR, async () => {
    delegationLog.clearAll()
    return delegationLog.getSummaries()
  })

  // Record the real outcome of a delegated task (ship/revert/edit) into the durable eval
  // memory via `qceval verdict`, so calibration learns how often the eval was right.
  ipcMain.handle(IPC_CHANNELS.DELEGATION_VERDICT, async (_, task: string, verdict: string) => {
    if (!['ship', 'revert', 'edit'].includes(verdict) || !task || task === 'untagged') return false
    return new Promise<boolean>((resolve) => {
      // Run through a login shell so the user's PATH (node + ~/.local/bin) resolves; task and
      // verdict go as positional args ($1/$2) to avoid any shell injection.
      execFile('/bin/zsh', ['-lc', 'qceval verdict "$1" "$2"', 'qcverdict', task, verdict], { timeout: 8000 }, (err) => resolve(!err))
    })
  })

  // Clipboard write from main — reliable even when the renderer isn't focused (the
  // renderer's navigator.clipboard.writeText silently fails without focus/user-gesture).
  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_WRITE_TEXT, async (_, text: string) => {
    clipboard.writeText(text)
    return true
  })

  // Per-pane Claude accounts. The renderer only ever receives metadata (label/email/hasToken)
  // — the token is write-only from the renderer's side and never returned.
  ipcMain.handle(IPC_CHANNELS.CLAUDE_ACCOUNTS_LIST, async () => accountStore.list())
  ipcMain.handle(IPC_CHANNELS.CLAUDE_ACCOUNTS_SAVE, async (_, input: { id?: string; label: string; email?: string; model?: string; token?: string }) => {
    try {
      const accounts = accountStore.save(input)
      // When a token was provided, resolve which account it REALLY is so the UI can flag a
      // wrong/swapped token immediately. Find the (possibly new) record by matching input.
      if (input.token) {
        const saved = accounts.find((a) => a.id === input.id) || accounts.find((a) => a.label === input.label.trim())
        if (saved) { const v = await accountStore.verify(saved.id); return { ok: true, accounts: v.accounts } }
      }
      return { ok: true, accounts }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), accounts: accountStore.list() }
    }
  })
  ipcMain.handle(IPC_CHANNELS.CLAUDE_ACCOUNTS_DELETE, async (_, id: string) => accountStore.delete(id))
  ipcMain.handle(IPC_CHANNELS.CLAUDE_ACCOUNTS_VERIFY, async (_, id: string) => accountStore.verify(id))

  // --- Generic plugin system ---
  ipcMain.handle(IPC_CHANNELS.PLUGIN_LIST, async () => listPlugins())
  ipcMain.handle(IPC_CHANNELS.PLUGIN_TOGGLE, async (_, id: string, enabled: boolean) => { const d = togglePlugin(id, enabled); persistPluginPrefs(); return d })
  ipcMain.handle(IPC_CHANNELS.PLUGIN_SET_SETTING, async (_, id: string, key: string, value: unknown) => { const d = setPluginSetting(id, key, value); persistPluginPrefs(); return d })
  ipcMain.on(IPC_CHANNELS.PLUGIN_OPEN, (_, id: string) => openPlugin(id))
  // Renderer pushes a compact live workspace snapshot for plugins that observe
  // pane state (fire-and-forget; the host no-ops if nothing subscribes).
  ipcMain.on(IPC_CHANNELS.PLUGIN_WORKSPACE_SNAPSHOT, (_, snap: WorkspaceSnapshot) => {
    try { receiveWorkspaceSnapshot(snap) } catch (e) { logger.warn('pluginHost', 'bad workspace snapshot', String(e)) }
  })

  // Build the shareable report; if `save` is requested, write it via a save dialog.
  // Always returns the report text so the renderer can also copy it to the clipboard.
  ipcMain.handle(IPC_CHANNELS.DELEGATION_EXPORT, async (_, save: boolean) => {
    const text = delegationLog.buildReport()
    if (!save) return { text, path: null, canceled: false }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export delegation log',
      defaultPath: path.join(app.getPath('downloads'), `delegation-log-${stamp}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All Files', extensions: ['*'] }],
    })
    if (result.canceled || !result.filePath) return { text, path: null, canceled: true }
    fs.writeFileSync(result.filePath, text, 'utf8')
    return { text, path: result.filePath, canceled: false }
  })

  // Per-pane port isolation — macOS loopback alias management.
  ipcMain.handle(IPC_CHANNELS.NET_LOOPBACK_STATUS, async () => {
    return loopbackStatus()
  })

  ipcMain.handle(IPC_CHANNELS.NET_ENSURE_LOOPBACK, async () => {
    return ensureLoopbackAliases()
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_HOME, async () => {
    const home = app.getPath('home')
    logger.info('workspace', 'Home directory requested', home)
    return home
  })

  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, async () => {
    return app.getVersion()
  })


  // Per-pane context window usage
  ipcMain.handle(IPC_CHANNELS.PTY_CONTEXT_USAGE, async (_, paneId: number) => {
    return ptyManager?.getContextUsage(paneId) ?? null
  })

  // Detect listening servers for all panes (one shared lsof+ps).
  // Returns a plain object keyed by paneId for easy renderer consumption.
  ipcMain.handle(IPC_CHANNELS.PTY_DETECT_SERVERS, async () => {
    const map = (await ptyManager?.detectServers()) ?? new Map()
    return Object.fromEntries(map)
  })

  // Kill a detected server in a pane
  ipcMain.handle(IPC_CHANNELS.PTY_KILL_SERVER, async (_, paneId: number, pid: number) => {
    return (await ptyManager?.killServer(paneId, pid)) ?? false
  })

  // Paste an image into a pane the way Claude Code expects: put the image
  // bytes on the system clipboard, then send Ctrl+V so Claude Code reads it
  // and shows an [Image #N] attachment instead of a literal file path.
  ipcMain.handle(IPC_CHANNELS.PTY_PASTE_IMAGE, async (_, paneId: number, filePath: string) => {
    try {
      const img = nativeImage.createFromPath(filePath)
      if (img.isEmpty()) return false
      clipboard.writeImage(img)
      ptyManager?.write(paneId, '\x16') // Ctrl+V
      return true
    } catch {
      return false
    }
  })

  // Open a URL (e.g. http://localhost:PORT) in the system default browser
  ipcMain.handle(IPC_CHANNELS.APP_OPEN_EXTERNAL, async (_, url: string) => {
    // Only http(s) — refuse file://, javascript:, etc. to avoid shell-handler abuse
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false
    try {
      await shell.openExternal(url)
      return true
    } catch (error) {
      logger.error('app', 'Failed to open external URL', error instanceof Error ? error.message : String(error))
      return false
    }
  })

  // Diagnostics bridge: let the renderer write structured entries into the same
  // app.log the rest of the app uses (and the Error Log viewer reads). Used for
  // pane-init lifecycle tracking + the blank-pane watchdog. Fire-and-forget
  // (ipcMain.on, not handle) so the renderer never blocks on disk I/O. Inputs
  // are length-capped since they cross the process boundary from the UI.
  ipcMain.on(IPC_CHANNELS.APP_LOG, (_, level: string, category: string, message: string, details?: string) => {
    const cat = typeof category === 'string' ? category.slice(0, 64) : 'renderer'
    const msg = typeof message === 'string' ? message.slice(0, 512) : String(message)
    const det = typeof details === 'string' ? details.slice(0, 2048) : undefined
    if (level === 'error') logger.error(cat, msg, det)
    else if (level === 'warn') logger.warn(cat, msg, det)
    else logger.info(cat, msg, det)
  })

  // Open a markdown file referenced in a pane's output in TextEdit (macOS) / default
  // editor elsewhere. The renderer passes the raw text it matched (e.g. "EO14411/SEO-RUBRIC.md");
  // we resolve it against that pane's live cwd and refuse anything that isn't an existing .md file.
  ipcMain.handle(IPC_CHANNELS.APP_OPEN_IN_EDITOR, async (_, paneId: number, rawPath: string) => {
    if (typeof rawPath !== 'string' || !/\.(md|markdown)$/i.test(rawPath.trim())) return false
    try {
      let candidate = rawPath.trim()
      // Expand a leading ~ to the home directory.
      if (candidate === '~' || candidate.startsWith('~/')) {
        candidate = path.join(os.homedir(), candidate.slice(1))
      }
      // Resolve relative paths against the pane's live cwd (the user may have cd'd).
      if (!path.isAbsolute(candidate)) {
        const cwd = ptyManager?.getCwd(paneId)
        if (!cwd) return false
        candidate = path.resolve(cwd, candidate)
      }
      // Must be an existing regular file ending in .md/.markdown — no dirs, no other types.
      let stat: fs.Stats
      try {
        stat = fs.statSync(candidate)
      } catch {
        return false
      }
      if (!stat.isFile() || !/\.(md|markdown)$/i.test(candidate)) return false

      if (process.platform === 'darwin') {
        await new Promise<void>((resolve, reject) => {
          execFile('/usr/bin/open', ['-a', 'TextEdit', candidate], (err) => (err ? reject(err) : resolve()))
        })
      } else {
        const errMsg = await shell.openPath(candidate)
        if (errMsg) throw new Error(errMsg)
      }
      return true
    } catch (error) {
      logger.error('app', 'Failed to open file in editor', error instanceof Error ? error.message : String(error))
      return false
    }
  })

  // File dialog for background image selection
  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN_IMAGE, async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Background Image',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
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
