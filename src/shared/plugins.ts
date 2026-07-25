// Generic plugin system types — shared by the main-process PluginHost, the
// preload bridge, and the renderer Settings → Plugins tab. Kept separate from
// the app's core types so the plugin surface is self-contained and a plugin
// author only touches its own folder + this contract.

// A single declared setting on a plugin (rendered generically in Settings).
export type PluginSettingSchema =
  | { key: string; type: 'boolean'; default: boolean; label: string }
  | { key: string; type: 'string'; default: string; label: string }
  | { key: string; type: 'select'; options: (string | number)[]; default: string | number; label: string }

// A plugin's manifest (plugin.json), validated by the host at startup.
export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  kind: 'window'
  menu?: { parent: 'View'; label: string; accelerator?: string }
  capabilities: string[]
  settings: PluginSettingSchema[]
  minAppVersion?: string
}

// Runtime status the host reports to the Settings UI.
export type PluginStatus = 'running' | 'off' | 'error'

// One row in the Settings → Plugins tab (manifest + live status + resolved settings).
export interface PluginDescriptor {
  manifest: PluginManifest
  enabled: boolean
  status: PluginStatus
  error?: string
  settings: Record<string, unknown> // resolved: manifest defaults merged with saved values
}

// --- Generic workspace snapshot (renderer → main) ------------------------
// Live pane data that only exists in the renderer store. Pushed to main only
// while at least one plugin with the "read:workspace" capability is enabled.
export interface PaneSnapshot {
  id: number
  pos: number
  folder: string
  proj: string
  cwd: string
  state: 'shell' | 'claude-active' | 'claude-waiting'
  account: string
  model: string
}
export interface WorkspaceSnapshot {
  activePaneId: number
  panes: PaneSnapshot[]
}

// --- Plugin runtime context (host → plugin.activate) ---------------------
export interface PluginLogger {
  info(msg: string, detail?: string): void
  warn(msg: string, detail?: string): void
  error(msg: string, detail?: string): void
}
export interface PtyStatsLite { sessions: number; totalBytesOut: number; perPaneBytesOut: Record<string, number> }
export interface GitStatusLite { isGitRepo: boolean; branch?: string; ahead?: number; behind?: number; dirty?: number }

// App capabilities exposed to plugins. The host builds this from injected deps;
// a plugin only ever sees this narrow, read-only surface (isolation contract).
export interface PluginServices {
  ptyStats(): PtyStatsLite
  getGitStatus(paneId: number): Promise<GitStatusLite | null>
  getContextUsage(paneId: number): Promise<{ contextPct: number; model: string } | null>
  latestWorkspaceSnapshot(): WorkspaceSnapshot | null
  onWorkspaceSnapshot(cb: (s: WorkspaceSnapshot) => void): () => void
  onPtyExit(cb: (paneId: number, code: number) => void): () => void
  sendToUi(channel: string, payload: unknown): void
}
export interface PluginContext {
  id: string
  appVersion: string
  homeDir: string
  logger: PluginLogger
  getSetting<T = unknown>(key: string): T | undefined
  onSettingsChanged(cb: (settings: Record<string, unknown>) => void): () => void
  services: PluginServices
}

// What a compiled-in plugin module exports.
export interface PluginModule {
  manifest: PluginManifest
  activate(ctx: PluginContext): void | Promise<void>
  deactivate(): void | Promise<void>
  open?(): void // for window-kind plugins: focus/create the window
  close?(): void // dismiss any UI; called when the app window goes away
}

// Resolve a plugin's effective settings: manifest defaults merged under saved values.
export function resolvePluginSettings(
  manifest: PluginManifest,
  saved: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const s of manifest.settings) out[s.key] = s.default
  if (saved) for (const k of Object.keys(saved)) if (k in out) out[k] = saved[k]
  return out
}
