// Generic plugin host. Compiled-in ("first-party") plugins register in the
// static REGISTRY below; the host validates manifests, manages enable/disable
// lifecycle, contributes menu items, injects a read-only capability context,
// and distributes the renderer's workspace snapshot + pty-exit stream to any
// plugin that observes them. Deliberately small — v1 non-goals (§4.4): no
// third-party/dynamic loading, no sandbox, no marketplace.
import { MenuItemConstructorOptions } from 'electron'
import { logger } from './logger'
import {
  PluginModule, PluginManifest, PluginDescriptor, PluginContext, PluginServices,
  WorkspaceSnapshot, PtyStatsLite, GitStatusLite, resolvePluginSettings,
} from '../shared/plugins'

// --- static registry (adding a plugin = drop folder + one line here + vite entry) ---
import opsConsole from '../plugins/ops-console'
const REGISTRY: PluginModule[] = [opsConsole]

export interface HostDeps {
  appVersion: string
  homeDir: string
  initialPluginPrefs: Record<string, { enabled: boolean; settings: Record<string, unknown> }> | undefined
  ptyStats(): PtyStatsLite
  getGitStatus(paneId: number): Promise<GitStatusLite | null>
  getContextUsage(paneId: number): Promise<{ contextPct: number; model: string } | null>
  rebuildMenu(): void
  notifyChanged(descriptors: PluginDescriptor[]): void
  sendToUi(channel: string, payload: unknown): void
}

interface Entry {
  mod: PluginModule
  manifest: PluginManifest
  valid: boolean
  enabled: boolean
  active: boolean
  error?: string
  settings: Record<string, unknown>
  settingsCbs: Set<(s: Record<string, unknown>) => void>
}

let deps: HostDeps | null = null
const entries = new Map<string, Entry>()
let latestWs: WorkspaceSnapshot | null = null
const wsSubs = new Set<(s: WorkspaceSnapshot) => void>()
const exitSubs = new Set<(paneId: number, code: number) => void>()

// naive "x.y.z >= a.b.c"
function versionGte(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false }
  return true
}

function validate(mod: PluginModule): { ok: boolean; error?: string } {
  const m = mod.manifest
  if (!m || !m.id || !m.name) return { ok: false, error: 'invalid manifest (missing id/name)' }
  if (entries.has(m.id)) return { ok: false, error: `duplicate plugin id "${m.id}"` }
  if (m.minAppVersion && deps && !versionGte(deps.appVersion, m.minAppVersion)) {
    return { ok: false, error: `requires app ≥ ${m.minAppVersion} (have ${deps.appVersion})` }
  }
  // accelerator conflict: first registrant wins
  if (m.menu?.accelerator) {
    for (const e of entries.values()) if (e.manifest.menu?.accelerator === m.menu.accelerator) {
      return { ok: false, error: `accelerator ${m.menu.accelerator} already used by "${e.manifest.id}"` }
    }
  }
  return { ok: true }
}

function makeContext(e: Entry): PluginContext {
  const services: PluginServices = {
    ptyStats: () => deps!.ptyStats(),
    getGitStatus: (id) => deps!.getGitStatus(id),
    getContextUsage: (id) => deps!.getContextUsage(id),
    latestWorkspaceSnapshot: () => latestWs,
    onWorkspaceSnapshot: (cb) => { wsSubs.add(cb); return () => wsSubs.delete(cb) },
    onPtyExit: (cb) => { exitSubs.add(cb); return () => exitSubs.delete(cb) },
    sendToUi: (channel, payload) => deps!.sendToUi(channel, payload),
  }
  return {
    id: e.manifest.id,
    appVersion: deps!.appVersion,
    homeDir: deps!.homeDir,
    logger: {
      info: (msg, d) => logger.info(`plugin:${e.manifest.id}`, msg, d),
      warn: (msg, d) => logger.warn(`plugin:${e.manifest.id}`, msg, d),
      error: (msg, d) => logger.error(`plugin:${e.manifest.id}`, msg, d),
    },
    getSetting: <T = unknown>(key: string) => e.settings[key] as T | undefined,
    onSettingsChanged: (cb) => { e.settingsCbs.add(cb); return () => e.settingsCbs.delete(cb) },
    services,
  }
}

function activate(e: Entry) {
  if (e.active || !e.valid) return
  try {
    e.mod.activate(makeContext(e))
    e.active = true
    e.error = undefined
    logger.info('pluginHost', `activated "${e.manifest.id}"`)
  } catch (err) {
    e.error = err instanceof Error ? err.message : String(err)
    logger.error('pluginHost', `activate failed "${e.manifest.id}"`, e.error)
  }
}
function deactivate(e: Entry) {
  if (!e.active) return
  try { e.mod.deactivate() } catch (err) { logger.error('pluginHost', `deactivate failed "${e.manifest.id}"`, String(err)) }
  e.active = false
}

export function initPluginHost(d: HostDeps): void {
  deps = d
  for (const mod of REGISTRY) {
    const v = validate(mod)
    const saved = d.initialPluginPrefs?.[mod.manifest?.id ?? '']
    const settings = mod.manifest ? resolvePluginSettings(mod.manifest, saved?.settings) : {}
    const e: Entry = {
      mod, manifest: mod.manifest, valid: v.ok, error: v.ok ? undefined : v.error,
      enabled: saved?.enabled ?? false, active: false, settings, settingsCbs: new Set(),
    }
    if (mod.manifest?.id) entries.set(mod.manifest.id, e)
    if (!v.ok) logger.warn('pluginHost', `plugin rejected: ${v.error}`)
  }
  for (const e of entries.values()) if (e.enabled) activate(e)
  logger.info('pluginHost', `initialized (${entries.size} plugin(s), ${[...entries.values()].filter((e) => e.active).length} active)`)
}

export function getPluginMenuItems(): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  for (const e of entries.values()) {
    if (!e.valid || !e.enabled || !e.manifest.menu) continue
    items.push({
      label: e.manifest.menu.label,
      accelerator: e.manifest.menu.accelerator,
      click: () => openPlugin(e.manifest.id),
    })
  }
  return items
}

export function listPlugins(): PluginDescriptor[] {
  return [...entries.values()].map((e) => ({
    manifest: e.manifest,
    enabled: e.enabled,
    status: !e.valid || e.error ? 'error' : e.active ? 'running' : 'off',
    error: e.error,
    settings: e.settings,
  }))
}

export function togglePlugin(id: string, enabled: boolean): PluginDescriptor[] {
  const e = entries.get(id)
  if (e && e.valid) { e.enabled = enabled; if (enabled) activate(e); else deactivate(e); deps?.rebuildMenu() }
  const d = listPlugins(); deps?.notifyChanged(d); return d
}

export function setPluginSetting(id: string, key: string, value: unknown): PluginDescriptor[] {
  const e = entries.get(id)
  if (e) {
    e.settings = { ...e.settings, [key]: value }
    for (const cb of e.settingsCbs) { try { cb(e.settings) } catch { /* ignore */ } }
  }
  const d = listPlugins(); deps?.notifyChanged(d); return d
}

// Dismiss every plugin's UI without deactivating it. Called when the app window
// goes away: a plugin's "is my UI showing" flag lives in the main process and
// would otherwise survive the window, so the next window would come back with
// the plugin's UI already on top of the app.
export function closeAllPluginUi(): void {
  for (const e of entries.values()) {
    if (!e.active || !e.mod.close) continue
    try { e.mod.close() } catch (err) { logger.error('pluginHost', `close failed "${e.manifest.id}"`, String(err)) }
  }
}

export function openPlugin(id: string): void {
  const e = entries.get(id)
  if (e && e.active && e.mod.open) { try { e.mod.open() } catch (err) { logger.error('pluginHost', `open failed "${id}"`, String(err)) } }
}

// renderer → main: latest workspace snapshot (distribute to observers)
export function receiveWorkspaceSnapshot(snap: WorkspaceSnapshot): void {
  latestWs = snap
  for (const cb of wsSubs) { try { cb(snap) } catch { /* ignore */ } }
}
// index.ts pipes PtyManager exits here
export function emitPtyExit(paneId: number, code: number): void {
  for (const cb of exitSubs) { try { cb(paneId, code) } catch { /* ignore */ } }
}
export function shutdownPlugins(): void {
  for (const e of entries.values()) deactivate(e)
}
