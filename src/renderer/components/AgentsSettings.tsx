import { memo, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { AgentProfile, CLAUDE_PROFILE_ID } from '../../shared/types'

// A value is treated as secret (masked) when its KEY looks credential-ish.
const SECRET_KEY = /key|token|secret|password|pass/i

type EnvRow = { key: string; value: string }

// Pure-data presets covering the two real config styles: tools that read their
// own config file (opencode) vs tools driven by env vars (aider). No per-provider
// logic — just starting points the user fills in.
const AGENT_PRESETS: Array<{
  label: string
  name: string
  command: string
  env: EnvRow[]
  note?: string
}> = [
  {
    label: 'opencode',
    name: 'opencode',
    command: 'opencode',
    env: [],
    note: 'opencode is configured via ~/.config/opencode/opencode.json (it ignores env vars). Define your provider + model there, then leave this empty.',
  },
  {
    label: 'aider',
    name: 'aider',
    command: 'aider',
    env: [
      { key: 'OPENAI_API_BASE', value: '' },
      { key: 'OPENAI_API_KEY', value: '' },
    ],
    note: 'aider reads these env vars directly — point OPENAI_API_BASE at your OpenAI-compatible /v1 endpoint (key can be a placeholder for local models).',
  },
  { label: 'Other (custom)', name: '', command: '', env: [] },
]

interface EditorState {
  id?: string // present when editing an existing profile
  name: string
  command: string
  env: EnvRow[]
  note?: string // per-tool setup guidance from the chosen preset (not persisted)
}

function genId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    // Fallback: timestamp-free, index-free uniqueness via random hex
    return 'agent-' + Math.abs(Math.floor(performance.now() * 1000)).toString(36)
  }
}

function envRecordToRows(env?: Record<string, string>): EnvRow[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({ key, value }))
}

function envRowsToRecord(rows: EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { key, value } of rows) {
    const k = key.trim()
    if (k) out[k] = value
  }
  return out
}

// Router-backed "Claude Code · <model>" profiles are created and managed by the
// "Run any model as Claude Code" section; keep them out of this raw-agent list.
const ROUTER_PANE_COMMAND = 'ccr code'

export const AgentsSettings = memo(function AgentsSettings() {
  // `profiles` stays the full list so save/remove never drop other entries; the
  // visible list hides router-backed profiles (managed in their own section).
  const profiles = useWorkspaceStore((s) => s.preferences.agentProfiles ?? [])
  const visibleProfiles = profiles.filter((p) => p.command !== ROUTER_PANE_COMMAND)
  const defaultAgentId = useWorkspaceStore((s) => s.preferences.defaultAgentId)
  const updatePreferences = useWorkspaceStore((s) => s.updatePreferences)

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [choosingPreset, setChoosingPreset] = useState(false)
  const [revealed, setRevealed] = useState<Record<number, boolean>>({})

  const startAdd = (preset: (typeof AGENT_PRESETS)[number]) => {
    setChoosingPreset(false)
    setRevealed({})
    setEditor({
      name: preset.name,
      command: preset.command,
      env: preset.env.map((e) => ({ ...e })),
      note: preset.note,
    })
  }

  const startEdit = (p: AgentProfile) => {
    setRevealed({})
    setEditor({ id: p.id, name: p.name, command: p.command, env: envRecordToRows(p.env) })
  }

  const cancel = () => {
    setEditor(null)
    setChoosingPreset(false)
  }

  const save = () => {
    if (!editor) return
    const name = editor.name.trim()
    const command = editor.command.trim()
    if (!name || !command) return
    const env = envRowsToRecord(editor.env)
    const profile: AgentProfile = {
      id: editor.id ?? genId(),
      name,
      command,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    }
    const next = editor.id
      ? profiles.map((p) => (p.id === editor.id ? { ...p, ...profile } : p))
      : [...profiles, profile]
    updatePreferences({ agentProfiles: next })
    setEditor(null)
  }

  const remove = (id: string) => {
    const next = profiles.filter((p) => p.id !== id)
    const updates: Parameters<typeof updatePreferences>[0] = { agentProfiles: next }
    // If the deleted profile was the default, fall back to the Claude builtin.
    if (defaultAgentId === id) updates.defaultAgentId = CLAUDE_PROFILE_ID
    updatePreferences(updates)
  }

  const setDefault = (id: string) => updatePreferences({ defaultAgentId: id })

  const updateEnvRow = (i: number, patch: Partial<EnvRow>) => {
    setEditor((e) =>
      e ? { ...e, env: e.env.map((row, idx) => (idx === i ? { ...row, ...patch } : row)) } : e,
    )
  }
  const addEnvRow = () => setEditor((e) => (e ? { ...e, env: [...e.env, { key: '', value: '' }] } : e))
  const removeEnvRow = (i: number) =>
    setEditor((e) => (e ? { ...e, env: e.env.filter((_, idx) => idx !== i) } : e))

  return (
    <div role="group" aria-labelledby="agents-heading" className="mb-6">
      <h3 id="agents-heading" className="text-sm font-medium text-[--ui-text-muted] uppercase tracking-wide mb-1">
        Agents
      </h3>
      <p className="text-[11px] text-[--ui-text-dimmed] mb-3">
        Each pane can launch any CLI agent. QuadClaude just runs the command with these env vars — the
        tool (claude, opencode, …) handles the API.
      </p>

      {/* Profile list */}
      <div className="space-y-1.5 mb-3">
        {visibleProfiles.map((p) => {
          const isDefault = (defaultAgentId ?? CLAUDE_PROFILE_ID) === p.id
          const isBuiltin = p.builtin === 'claude'
          return (
            <div
              key={p.id}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded glass-control"
            >
              <button
                onClick={() => setDefault(p.id)}
                title={isDefault ? 'Default agent for new panes' : 'Make default'}
                className="shrink-0"
              >
                <svg
                  width="13" height="13" viewBox="0 0 14 14"
                  fill={isDefault ? 'var(--accent)' : 'none'}
                  stroke={isDefault ? 'var(--accent)' : 'currentColor'}
                  strokeWidth="1.2"
                  className={isDefault ? '' : 'text-[--ui-text-dimmed]'}
                >
                  <path d="M7 1.5l1.76 3.57 3.94.57-2.85 2.78.67 3.93L7 10.5l-3.52 1.85.67-3.93L1.3 5.64l3.94-.57L7 1.5z" />
                </svg>
              </button>
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-sm text-[--ui-text-primary] truncate">
                  {p.name}
                  {isBuiltin && <span className="ml-1.5 text-[10px] text-[--ui-text-dimmed]">built-in</span>}
                </span>
                <span className="text-[11px] text-[--ui-text-dimmed] truncate font-mono">{p.command}</span>
              </div>
              {!isBuiltin && (
                <button
                  onClick={() => startEdit(p)}
                  className="shrink-0 text-[11px] text-[--ui-text-dimmed] hover:text-[--ui-text-primary] px-1.5 py-0.5"
                >
                  Edit
                </button>
              )}
              {!isBuiltin && (
                <button
                  onClick={() => remove(p.id)}
                  className="shrink-0 text-[11px] text-[--ui-text-dimmed] hover:text-red-400 px-1.5 py-0.5"
                >
                  Delete
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Add / preset chooser / editor */}
      {!editor && !choosingPreset && (
        <button
          onClick={() => setChoosingPreset(true)}
          className="text-xs text-[--accent] hover:underline"
        >
          + Add agent
        </button>
      )}

      {choosingPreset && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[--ui-text-dimmed]">Start from:</span>
          {AGENT_PRESETS.map((preset) => (
            <button
              key={preset.label}
              onClick={() => startAdd(preset)}
              className="text-xs px-2 py-1 rounded glass-control text-[--ui-text-primary] hover:bg-[--ui-bg-active]/50"
            >
              {preset.label}
            </button>
          ))}
          <button onClick={cancel} className="text-[11px] text-[--ui-text-dimmed] hover:text-[--ui-text-primary]">
            Cancel
          </button>
        </div>
      )}

      {editor && (
        <div className="rounded-md border border-[#444] p-3 space-y-3">
          {editor.note && (
            <p className="text-[11px] text-[--ui-text-primary] bg-[--accent]/10 border border-[--accent]/30 rounded px-2 py-1.5">
              {editor.note}
            </p>
          )}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-[--ui-text-dimmed]">Name</label>
            <input
              value={editor.name}
              onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              placeholder="Qwen Coder"
              className="bg-[--ui-bg-input] border border-[#444] rounded px-2 py-1 text-sm text-[--ui-text-primary] outline-none focus:border-[--accent]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-[--ui-text-dimmed]">Command</label>
            <input
              value={editor.command}
              onChange={(e) => setEditor({ ...editor, command: e.target.value })}
              placeholder="opencode"
              className="bg-[--ui-bg-input] border border-[#444] rounded px-2 py-1 text-sm font-mono text-[--ui-text-primary] outline-none focus:border-[--accent]"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-[--ui-text-dimmed]">
              Environment variables (injected at launch, never echoed)
            </label>
            {editor.env.map((row, i) => {
              const secret = SECRET_KEY.test(row.key)
              const show = revealed[i]
              return (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    value={row.key}
                    onChange={(e) => updateEnvRow(i, { key: e.target.value })}
                    placeholder="OPENAI_BASE_URL"
                    className="w-[42%] bg-[--ui-bg-input] border border-[#444] rounded px-2 py-1 text-xs font-mono text-[--ui-text-primary] outline-none focus:border-[--accent]"
                  />
                  <input
                    type={secret && !show ? 'password' : 'text'}
                    value={row.value}
                    onChange={(e) => updateEnvRow(i, { value: e.target.value })}
                    placeholder="value"
                    className="flex-1 bg-[--ui-bg-input] border border-[#444] rounded px-2 py-1 text-xs font-mono text-[--ui-text-primary] outline-none focus:border-[--accent]"
                  />
                  {secret && (
                    <button
                      onClick={() => setRevealed((r) => ({ ...r, [i]: !r[i] }))}
                      className="shrink-0 text-[10px] text-[--ui-text-dimmed] hover:text-[--ui-text-primary] px-1"
                      title={show ? 'Hide' : 'Reveal'}
                    >
                      {show ? 'Hide' : 'Show'}
                    </button>
                  )}
                  <button
                    onClick={() => removeEnvRow(i)}
                    className="shrink-0 text-[--ui-text-dimmed] hover:text-red-400 px-1"
                    title="Remove"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M2 2l6 6M8 2l-6 6" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              )
            })}
            <button onClick={addEnvRow} className="self-start text-[11px] text-[--accent] hover:underline">
              + Add variable
            </button>
            <p className="text-[10px] text-[--ui-text-dimmed]">
              Verify the exact env vars / config your tool needs (e.g. opencode may use its own config file).
            </p>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={save}
              disabled={!editor.name.trim() || !editor.command.trim()}
              className="text-xs px-3 py-1 rounded bg-[--accent] text-white disabled:opacity-40"
            >
              Save
            </button>
            <button onClick={cancel} className="text-xs px-3 py-1 rounded glass-control text-[--ui-text-primary]">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
})
