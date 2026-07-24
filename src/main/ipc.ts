import { ipcMain, app, clipboard, dialog, shell, nativeImage, BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { logger } from './logger'
import { accountStore } from './accountStore'
import { delegationLog } from './delegationLog'
import { listPlugins, togglePlugin, setPluginSetting, openPlugin, receiveWorkspaceSnapshot } from './pluginHost'
import { loopbackStatus, ensureLoopbackAliases } from './loopback'
import { IPC_CHANNELS, RouterProviderInput, DEFAULT_ACCOUNT_MODEL, portIsolationEnv } from '../shared/types'
import type { WorkspaceSnapshot } from '../shared/plugins'
import type { PtyManager } from './pty'
import type { WorkspaceManager } from './workspace'
import type { RouterManager } from './router'

// Dependencies threaded in from index.ts. The three managers are created before
// registerIpcHandlers() runs and never reassigned, so they're passed by value
// (nullable-typed to match index.ts, keeping every handler body's `?.` verbatim).
// getMainWindow is a getter because the main window is late-bound — it can be
// recreated after registration, so the two dialog handlers must read it live.
export interface IpcDeps {
  ptyManager: PtyManager | null
  workspaceManager: WorkspaceManager | null
  routerManager: RouterManager
  getMainWindow: () => BrowserWindow | null
  persistPluginPrefs: () => void
  syncDelegationActive: () => void
  delegationModelRoute: () => string
}

// Register every IPC handler (pty, workspace, router, delegation telemetry,
// clipboard, accounts, plugins, net, app/system, dialogs). Moved verbatim out of
// index.ts's setupIPC — the only edits are mainWindow -> getMainWindow() at the
// two dialog sites. Called once during app init, after the managers exist.
export function registerIpcHandlers(deps: IpcDeps): void {
  const { ptyManager, workspaceManager, routerManager, getMainWindow, persistPluginPrefs, syncDelegationActive, delegationModelRoute } = deps
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
    const result = await dialog.showSaveDialog(getMainWindow()!, {
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
    const win = getMainWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
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
