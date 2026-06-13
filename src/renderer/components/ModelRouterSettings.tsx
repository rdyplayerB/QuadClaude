import { memo, useEffect, useState, useCallback } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { AgentProfile, RouterStatus, RouterProviderInput } from '../../shared/types'

// "Run any model as Claude Code." This is NOT a generic agent — it stands up the
// real `claude` TUI pointed at a non-Anthropic model via claude-code-router, so the
// pane looks and behaves 100% like Claude Code. The wizard writes ccr's local config
// (main process) AND auto-creates the launchable AgentProfile (`ccr code`).

// Router-backed profiles are the ones we launch through ccr. We tag them by command
// so they can be listed/managed separately from hand-rolled agent profiles.
export const ROUTER_PANE_COMMAND = 'ccr code'

type Preset = {
  label: string
  baseUrl: string
  transformer?: string
  modelPlaceholder: string
  keyUrl?: string // where to get a key
}

// OpenAI-compatible providers ccr can drive. Base URLs are the chat/completions
// endpoints ccr expects. "Custom" leaves everything blank.
const PRESETS: Preset[] = [
  {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    transformer: 'openrouter',
    modelPlaceholder: 'deepseek/deepseek-chat',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/chat/completions',
    transformer: 'deepseek',
    modelPlaceholder: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    label: 'OpenAI-compatible',
    baseUrl: '',
    modelPlaceholder: 'your-model-id',
  },
  { label: 'Custom', baseUrl: '', modelPlaceholder: '' },
]

interface FormState {
  preset: string
  label: string
  baseUrl: string
  apiKey: string
  model: string
  transformer?: string
}

function genId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 'router-' + Math.abs(Math.floor(performance.now() * 1000)).toString(36)
  }
}

function emptyForm(): FormState {
  return { preset: 'OpenRouter', label: '', baseUrl: PRESETS[0].baseUrl, apiKey: '', model: '', transformer: PRESETS[0].transformer }
}

export const ModelRouterSettings = memo(function ModelRouterSettings() {
  const profiles = useWorkspaceStore((s) => s.preferences.agentProfiles ?? [])
  const updatePreferences = useWorkspaceStore((s) => s.updatePreferences)

  const [status, setStatus] = useState<RouterStatus | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [revealKey, setRevealKey] = useState(false)
  const [testState, setTestState] = useState<{ kind: 'idle' | 'testing' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)

  const routerProfiles = profiles.filter((p) => p.command === ROUTER_PANE_COMMAND)

  const refreshStatus = useCallback(() => {
    window.electronAPI.routerStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  const choosePreset = (label: string) => {
    const preset = PRESETS.find((p) => p.label === label) ?? PRESETS[0]
    setForm((f) => ({
      ...f,
      preset: label,
      // Only overwrite the URL/transformer when the preset actually defines them,
      // so switching to Custom doesn't wipe what the user already typed.
      baseUrl: preset.baseUrl || f.baseUrl,
      transformer: preset.transformer,
    }))
  }

  const startAdd = () => {
    setForm(emptyForm())
    setTestState({ kind: 'idle' })
    setRevealKey(false)
    setAdding(true)
  }

  const cancel = () => {
    setAdding(false)
    setTestState({ kind: 'idle' })
  }

  const asInput = (): RouterProviderInput => ({
    label: form.label.trim() || form.model.trim(),
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey,
    model: form.model.trim(),
    transformer: form.transformer,
  })

  const canSubmit = !!form.baseUrl.trim() && !!form.model.trim() && !saving

  const test = async () => {
    setTestState({ kind: 'testing' })
    const res = await window.electronAPI.routerTest(asInput())
    setTestState(res.ok ? { kind: 'ok' } : { kind: 'err', msg: res.error })
  }

  const save = async () => {
    if (!canSubmit) return
    setSaving(true)
    try {
      const res = await window.electronAPI.routerSaveProvider(asInput())
      if (!res.ok) {
        setTestState({ kind: 'err', msg: res.error ?? 'Failed to save.' })
        return
      }
      // Auto-create (or update) the launchable Claude Code profile for this model.
      const displayName = `Claude Code · ${form.label.trim() || form.model.trim()}`
      const existing = routerProfiles.find((p) => p.env?.ANTHROPIC_MODEL === res.route)
      const profile: AgentProfile = {
        id: existing?.id ?? genId(),
        name: displayName,
        command: res.command,
        env: res.env,
      }
      const next = existing
        ? profiles.map((p) => (p.id === existing.id ? profile : p))
        : [...profiles, profile]
      updatePreferences({ agentProfiles: next })
      setAdding(false)
      setTestState({ kind: 'idle' })
      refreshStatus()
    } finally {
      setSaving(false)
    }
  }

  const remove = (profile: AgentProfile) => {
    // Drop the ccr provider too (slug is the part before the comma in ANTHROPIC_MODEL).
    const slug = profile.env?.ANTHROPIC_MODEL?.split(',')[0]
    if (slug) window.electronAPI.routerDeleteProvider(slug).then(refreshStatus)
    updatePreferences({ agentProfiles: profiles.filter((p) => p.id !== profile.id) })
  }

  return (
    <div role="group" aria-labelledby="router-heading" className="mb-6">
      <h3 id="router-heading" className="text-sm font-medium text-[--ui-text-muted] uppercase tracking-wide mb-1">
        Run any model as Claude Code
      </h3>
      <p className="text-[11px] text-[--ui-text-dimmed] mb-3">
        Drive the real Claude Code TUI with a non-Anthropic model. QuadClaude routes it through{' '}
        <span className="font-mono">claude-code-router</span>, so the pane looks and behaves exactly like Claude
        Code — it applies edits instead of dumping code. Bring your own hosted API key.
      </p>

      {/* ccr install state */}
      {status && !status.ccrInstalled && (
        <div className="mb-3 text-[11px] text-[--ui-text-primary] bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
          <span className="font-medium">Router not installed.</span> Run this once in any pane:
          <div className="mt-1 flex items-center gap-2">
            <code className="font-mono text-[10px] bg-black/30 rounded px-1.5 py-0.5">{status.installHint}</code>
            <button
              onClick={() => navigator.clipboard?.writeText(status.installHint)}
              className="text-[10px] text-[--accent] hover:underline"
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {/* Existing router-backed profiles */}
      <div className="space-y-1.5 mb-3">
        {routerProfiles.map((p) => (
          <div key={p.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded glass-control">
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-sm text-[--ui-text-primary] truncate">{p.name}</span>
              <span className="text-[11px] text-[--ui-text-dimmed] truncate font-mono">
                {p.env?.ANTHROPIC_MODEL ?? p.command}
              </span>
            </div>
            <button
              onClick={() => remove(p)}
              className="shrink-0 text-[11px] text-[--ui-text-dimmed] hover:text-red-400 px-1.5 py-0.5"
            >
              Delete
            </button>
          </div>
        ))}
      </div>

      {!adding && (
        <button onClick={startAdd} className="text-xs text-[--accent] hover:underline">
          + Add a model
        </button>
      )}

      {adding && (
        <div className="rounded-md border border-[#444] p-3 space-y-3">
          {/* Preset chips */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-[--ui-text-dimmed] mr-1">Provider:</span>
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => choosePreset(preset.label)}
                className={`text-xs px-2 py-1 rounded glass-control ${
                  form.preset === preset.label ? 'text-[--accent] border border-[--accent]/50' : 'text-[--ui-text-primary]'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-[--ui-text-dimmed]">Display name</label>
            <input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="DeepSeek V3"
              className="bg-[--ui-bg-input] border border-[#444] rounded px-2 py-1 text-sm text-[--ui-text-primary] outline-none focus:border-[--accent]"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-[--ui-text-dimmed]">Base URL (chat/completions endpoint)</label>
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="https://openrouter.ai/api/v1/chat/completions"
              className="bg-[--ui-bg-input] border border-[#444] rounded px-2 py-1 text-xs font-mono text-[--ui-text-primary] outline-none focus:border-[--accent]"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-[--ui-text-dimmed]">Model id</label>
            <input
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder={PRESETS.find((p) => p.label === form.preset)?.modelPlaceholder || 'model-id'}
              className="bg-[--ui-bg-input] border border-[#444] rounded px-2 py-1 text-xs font-mono text-[--ui-text-primary] outline-none focus:border-[--accent]"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-[--ui-text-dimmed]">API key (stored locally, never echoed)</label>
            <div className="flex items-center gap-1.5">
              <input
                type={revealKey ? 'text' : 'password'}
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder="sk-..."
                className="flex-1 bg-[--ui-bg-input] border border-[#444] rounded px-2 py-1 text-xs font-mono text-[--ui-text-primary] outline-none focus:border-[--accent]"
              />
              <button
                onClick={() => setRevealKey((v) => !v)}
                className="shrink-0 text-[10px] text-[--ui-text-dimmed] hover:text-[--ui-text-primary] px-1"
              >
                {revealKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          {/* Test feedback */}
          {testState.kind === 'ok' && <p className="text-[11px] text-emerald-400">✓ Connected — the provider answered.</p>}
          {testState.kind === 'err' && (
            <p className="text-[11px] text-red-400 break-words">✕ {testState.msg || 'Connection failed.'}</p>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={save}
              disabled={!canSubmit}
              className="text-xs px-3 py-1 rounded bg-[--accent] text-white disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save model'}
            </button>
            <button
              onClick={test}
              disabled={!form.baseUrl.trim() || !form.model.trim() || testState.kind === 'testing'}
              className="text-xs px-3 py-1 rounded glass-control text-[--ui-text-primary] disabled:opacity-40"
            >
              {testState.kind === 'testing' ? 'Testing…' : 'Test connection'}
            </button>
            <button onClick={cancel} className="text-xs px-3 py-1 rounded glass-control text-[--ui-text-primary]">
              Cancel
            </button>
          </div>
          <p className="text-[10px] text-[--ui-text-dimmed]">
            Saving writes the model to claude-code-router's local config and creates a launchable “{`Claude Code · …`}”
            agent. Pick it on any pane to run that model as Claude Code.
          </p>
        </div>
      )}
    </div>
  )
})
