// Ops Console plugin entry. Renders the console NATIVELY in the main window's
// renderer process (an in-app Shadow-DOM overlay — no separate window, no
// iframe → single-digit MB). Owns the live⇄record producer and streams its
// snapshots + verification overlay to that overlay over IPC. Zero cost when the
// overlay is closed (nothing runs).
import { ipcMain } from 'electron'
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

function push(s: OpsSnapshot) { ctx?.services.sendToUi(IPC_CHANNELS.OPS_INAPP_SNAPSHOT, s) }
function pushVerify(o: VerifyOverlay) { ctx?.services.sendToUi(IPC_CHANNELS.OPS_INAPP_VERIFY, o) }
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
