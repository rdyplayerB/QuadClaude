import { useEffect, useState, useCallback } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import type { PluginDescriptor, PluginSettingSchema } from '../../shared/plugins'

// Generic Settings → Plugins tab. Renders one row per discovered plugin from
// its manifest — knows nothing about any specific plugin. Runtime lifecycle
// lives in the main-process PluginHost; this UI drives it over IPC and mirrors
// the resulting state into workspace preferences so it persists across restarts.
export function PluginsSettings() {
  const [plugins, setPlugins] = useState<PluginDescriptor[]>([])
  const updatePreferences = useWorkspaceStore((s) => s.updatePreferences)
  const savedPlugins = useWorkspaceStore((s) => s.preferences.plugins)

  // Persist the current descriptor set into preferences.plugins (one writer).
  const persist = useCallback((descriptors: PluginDescriptor[]) => {
    const map: Record<string, { enabled: boolean; settings: Record<string, unknown> }> = { ...(savedPlugins ?? {}) }
    for (const d of descriptors) map[d.manifest.id] = { enabled: d.enabled, settings: d.settings }
    updatePreferences({ plugins: map })
  }, [savedPlugins, updatePreferences])

  useEffect(() => {
    let unsub: (() => void) | undefined
    window.electronAPI.listPlugins().then(setPlugins).catch(() => {})
    unsub = window.electronAPI.onPluginChanged((d: PluginDescriptor[]) => setPlugins(d))
    return () => { if (unsub) unsub() }
  }, [])

  const toggle = async (id: string, enabled: boolean) => {
    const d = await window.electronAPI.togglePlugin(id, enabled)
    setPlugins(d); persist(d)
  }
  const setSetting = async (id: string, key: string, value: unknown) => {
    const d = await window.electronAPI.setPluginSetting(id, key, value)
    setPlugins(d); persist(d)
  }

  const statusPill = (d: PluginDescriptor) => {
    const map = {
      running: { c: 'text-[--success] bg-[--success-soft]', t: 'running' },
      off: { c: 'text-[--ui-text-muted] bg-white/[0.06]', t: 'off' },
      error: { c: 'text-[--danger] bg-[--danger-soft]', t: 'error' },
    } as const
    const s = map[d.status]
    return <span className={`text-meta px-2 py-0.5 rounded-full ${s.c}`}>{s.t}</span>
  }

  return (
    <div className="space-y-3">
      <p className="text-heading text-[--ui-text-secondary]">
        Plugins are compartmentalized — disabling one closes its windows and stops its background work, and never affects your terminals.
      </p>
      {plugins.length === 0 && <p className="text-body text-[--ui-text-dimmed]">No plugins installed.</p>}
      {plugins.map((d) => (
        <div key={d.manifest.id} className="glass-control rounded-xl p-3.5">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-body font-medium text-[--ui-text-primary]">{d.manifest.name}</span>
                <span className="text-meta font-mono text-[--ui-text-dimmed]">v{d.manifest.version}</span>
                {statusPill(d)}
              </div>
              <p className="text-body text-[--ui-text-secondary] mt-1">{d.manifest.description}</p>
              {d.error && <p className="text-body text-[--danger] mt-1">⚠ {d.error}</p>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {d.enabled && d.manifest.kind === 'window' && (
                <button
                  onClick={() => window.electronAPI.openPlugin(d.manifest.id)}
                  className="px-2.5 py-1 text-body rounded-lg glass-control text-[--ui-text-secondary] hover:text-[--ui-text-primary]"
                >Open</button>
              )}
              <button
                role="switch"
                aria-checked={d.enabled}
                onClick={() => toggle(d.manifest.id, !d.enabled)}
                disabled={d.status === 'error' && !d.enabled}
                className={`relative w-10 h-[22px] rounded-full transition-colors disabled:opacity-40 ${d.enabled ? 'bg-[--accent]' : 'bg-white/[0.12]'}`}
              >
                <span className={`absolute top-[3px] w-4 h-4 rounded-full bg-white transition-all ${d.enabled ? 'left-[21px]' : 'left-[3px]'}`} />
              </button>
            </div>
          </div>

          {d.enabled && d.manifest.settings.length > 0 && (
            <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-2">
              {d.manifest.settings.map((s: PluginSettingSchema) => (
                <div key={s.key} className="flex items-center justify-between gap-3">
                  <span className="text-body text-[--ui-text-secondary]">{s.label}</span>
                  {s.type === 'boolean' && (
                    <button
                      role="switch"
                      aria-checked={Boolean(d.settings[s.key])}
                      onClick={() => setSetting(d.manifest.id, s.key, !d.settings[s.key])}
                      className={`relative w-9 h-5 rounded-full transition-colors ${d.settings[s.key] ? 'bg-[--accent]' : 'bg-white/[0.12]'}`}
                    >
                      <span className={`absolute top-[3px] w-3.5 h-3.5 rounded-full bg-white transition-all ${d.settings[s.key] ? 'left-[19px]' : 'left-[3px]'}`} />
                    </button>
                  )}
                  {s.type === 'select' && (
                    <select
                      value={String(d.settings[s.key])}
                      onChange={(e) => {
                        const raw = e.target.value
                        const opt = s.options.find((o) => String(o) === raw)
                        setSetting(d.manifest.id, s.key, opt ?? raw)
                      }}
                      className="glass-control rounded-lg px-2 py-1 text-body text-[--ui-text-secondary]"
                    >
                      {s.options.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                    </select>
                  )}
                  {s.type === 'string' && (
                    <input
                      type="text"
                      value={String(d.settings[s.key] ?? '')}
                      onChange={(e) => setSetting(d.manifest.id, s.key, e.target.value)}
                      className="glass-control rounded-lg px-2 py-1 text-body text-[--ui-text-secondary] w-40"
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
