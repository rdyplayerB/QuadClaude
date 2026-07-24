// Ops Console plugin entry. Renders the console NATIVELY in the main window's
// renderer process (an in-app Shadow-DOM overlay — no separate window, no
// iframe → single-digit MB). Owns the live⇄record producer and streams its
// snapshots + verification overlay to that overlay over IPC. Zero cost when the
// overlay is closed (nothing runs).
import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'path'
import manifest from './plugin.json'
import { PluginContext, PluginManifest, PluginModule } from '../../shared/plugins'
import { IPC_CHANNELS } from '../../shared/types'
import { OpsService } from './main/service'
import { RecordScript } from './main/record'
import { VerificationTracker } from './main/verify'
import { OpsSnapshot, VerifyTransition, VerifyMove, VerifyOverlay } from './types'

const RECORD_BEAT_MS = 2200

let ctx: PluginContext | null = null
let visible = false
let service: OpsService | null = null
let record: RecordScript | null = null
let recordTimer: ReturnType<typeof setInterval> | null = null
let recordBeat = 0
let recording = false
let verify: VerificationTracker | null = null
const handlers: Array<{ ch: string; fn: (...a: unknown[]) => void }> = []
let unsubSettings: (() => void) | null = null

// The console lives on exactly one surface at a time: the in-app overlay, or a
// popped-out window. Frames go to whichever is currently hosting it.
let opsWindow: BrowserWindow | null = null
let poppingIn = false

function toSurface(channel: string, payload: unknown) {
  if (opsWindow && !opsWindow.isDestroyed()) opsWindow.webContents.send(channel, payload)
  else ctx?.services.sendToUi(channel, payload)
}
function push(s: OpsSnapshot) { toSurface(IPC_CHANNELS.OPS_INAPP_SNAPSHOT, s) }
function pushVerify(o: VerifyOverlay) { toSurface(IPC_CHANNELS.OPS_INAPP_VERIFY, o) }

// Destroy the popped-out window and forget it. destroy() rather than close()
// because only destroy tears the renderer process down right away — that
// process is the ~100MB a second window costs, and reclaiming it is the whole
// point of "pop back in". `poppingIn` tells the 'closed' handler this teardown
// was ours, so it doesn't also close the console.
function destroyOpsWindow() {
  const w = opsWindow
  opsWindow = null
  if (!w || w.isDestroyed()) return
  poppingIn = true
  try { w.destroy() } finally { poppingIn = false }
}

function popOut() {
  if (opsWindow && !opsWindow.isDestroyed()) { opsWindow.focus(); return }
  const wasVisible = visible
  visible = true
  // Hand the console off: clear the in-app overlay before the window appears.
  ctx?.services.sendToUi(IPC_CHANNELS.OPS_INAPP_SHOW, false)

  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 720, minHeight: 480,
    title: 'Activity Console',
    backgroundColor: '#0e1013',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 12 },
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  })
  opsWindow = win
  win.once('ready-to-show', () => win.show())
  const isDev = process.env.QC_FORCE_PROD === '1' ? false : (process.env.NODE_ENV === 'development' || !app.isPackaged)
  if (isDev) win.loadURL('http://localhost:5173/ops.html').catch(() => { /* dev server down */ })
  else win.loadFile(path.join(__dirname, '../renderer/ops.html')).catch((e) => ctx?.logger.warn('ops window load failed', String(e)))

  win.on('closed', () => {
    opsWindow = null
    if (poppingIn) return // our own teardown (pop-in / close) — already handled
    closeConsole()        // user closed the window → the console is closed
  })

  if (!wasVisible) startProducer()
  syncVerify()
}

function popIn() {
  destroyOpsWindow()
  visible = true
  ctx?.services.sendToUi(IPC_CHANNELS.OPS_INAPP_SHOW, true)
  syncVerify()
}
function verifyWanted(): boolean { return !!ctx?.getSetting<boolean>('verificationMode') }
function syncVerify() {
  if (!verify) return
  if (verifyWanted() && visible) verify.start(); else verify.stop()
}

function startLive() { stopProducers(); if (!ctx) return; service = new OpsService(ctx); service.start(push) }
function startRecord() {
  stopProducers(); record = new RecordScript(); recordBeat = 0
  push(record.snapshot(recordBeat, Math.random(), true))
  recordTimer = setInterval(() => { recordBeat++; if (record) push(record.snapshot(recordBeat, Math.random(), true)) }, RECORD_BEAT_MS)
}
function stopProducers() {
  if (service) { service.stop(); service = null }
  if (recordTimer) { clearInterval(recordTimer); recordTimer = null }
  record = null
}
function startProducer() { if (recording) startRecord(); else startLive() }
function setRecording(on: boolean) { recording = on; if (visible) startProducer() }

function openConsole() {
  // Already open in its own window — just bring that forward rather than also
  // painting the in-app overlay (which would show the console twice).
  if (opsWindow && !opsWindow.isDestroyed()) { opsWindow.show(); opsWindow.focus(); return }
  const wasVisible = visible
  visible = true
  // Always (re)assert the show signal. The renderer may have missed an earlier
  // push (startup race) or the flag may have drifted — never let a stale
  // `visible` wedge the menu/top-bar button into a silent no-op.
  ctx?.services.sendToUi(IPC_CHANNELS.OPS_INAPP_SHOW, true)
  if (!wasVisible) startProducer()
  syncVerify()
}
function closeConsole() {
  destroyOpsWindow() // no-op when the console is in-app
  stopProducers()
  visible = false
  ctx?.services.sendToUi(IPC_CHANNELS.OPS_INAPP_SHOW, false)
  syncVerify() // visible is now false → stops the verification tracker
}

function on(ch: string, fn: (...a: unknown[]) => void) { ipcMain.on(ch, fn); handlers.push({ ch, fn }) }

const plugin: PluginModule = {
  manifest: manifest as PluginManifest,

  activate(context: PluginContext) {
    ctx = context
    verify = new VerificationTracker(context.logger, pushVerify)
    on(IPC_CHANNELS.OPS_VERIFY_TRANSITION, (_e, t) => verify?.onTransition(t as VerifyTransition))
    on('ops:verify-move', (_e, m) => verify?.onMove(m as VerifyMove))
    on('ops:set-record', (_e, val) => setRecording(!!val))
    on(IPC_CHANNELS.OPS_CLOSE, () => closeConsole())
    on(IPC_CHANNELS.OPS_POPOUT, () => popOut())
    on(IPC_CHANNELS.OPS_POPIN, () => popIn())
    // Renderer asks for current visibility on mount (recovers a dropped startup
    // push). The popped-out window also calls this, but it is always showing —
    // answering it would tell the MAIN window to render a second copy.
    on('ops:request-state', () => {
      if (opsWindow && !opsWindow.isDestroyed()) return
      ctx?.services.sendToUi(IPC_CHANNELS.OPS_INAPP_SHOW, visible)
    })
    unsubSettings = context.onSettingsChanged(() => {
      const ms = Number(context.getSetting<number>('pollIntervalMs') ?? 1000) || 1000
      if (service) service.updateInterval(ms)
      syncVerify()
    })
    if (context.getSetting<boolean>('openAtLaunch')) this.open!()
    context.logger.info('Ops Console activated')
  },

  open() { openConsole() },

  deactivate() {
    closeConsole()
    if (verify) { verify.stop(); verify = null }
    for (const h of handlers) ipcMain.removeListener(h.ch, h.fn)
    handlers.length = 0
    if (unsubSettings) { unsubSettings(); unsubSettings = null }
    ctx?.logger.info('Ops Console deactivated')
    ctx = null
  },
}

export default plugin
