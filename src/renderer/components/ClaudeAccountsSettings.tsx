import { useState, useEffect, useCallback } from 'react'
import { ClaudeAccount, DEFAULT_ACCOUNT_MODEL } from '../../shared/types'

// Models a pane can pin per account. A fresh token session otherwise starts on Sonnet, so
// we default to Opus 4.8 1M. 'default' opts out of pinning (Claude Code's own default).
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M context)' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'default', label: 'Claude Code default' },
]

// Manage saved Claude subscription accounts. Each account stores a label and a long-lived
// CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), encrypted by the main process. A pane
// can then be bound to an account (via its agent badge) to authenticate as that account —
// letting two panes run two different Max subscriptions side-by-side.
export function ClaudeAccountsSettings() {
  const [accounts, setAccounts] = useState<ClaudeAccount[]>([])
  const [label, setLabel] = useState('')
  const [email, setEmail] = useState('')
  const [model, setModel] = useState(DEFAULT_ACCOUNT_MODEL)
  const [token, setToken] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const reload = useCallback(() => {
    window.electronAPI.claudeAccountsList().then(setAccounts).catch(() => {})
  }, [])
  useEffect(() => { reload() }, [reload])

  const resetForm = () => { setLabel(''); setEmail(''); setModel(DEFAULT_ACCOUNT_MODEL); setToken(''); setEditingId(null); setErr(null) }

  const save = async () => {
    if (!label.trim()) { setErr('Give the account a label (e.g. "Work").'); return }
    if (!editingId && !token.trim()) { setErr('Paste the token from `claude setup-token`.'); return }
    setBusy(true); setErr(null)
    const res = await window.electronAPI.claudeAccountsSave({
      id: editingId || undefined,
      label: label.trim(),
      email: email.trim() || undefined,
      model,
      token: token.trim() || undefined,
    }).catch(() => ({ ok: false, error: 'Save failed', accounts }))
    setBusy(false)
    if (!res.ok) { setErr(res.error || 'Save failed'); return }
    setAccounts(res.accounts)
    resetForm()
  }

  const startEdit = (a: ClaudeAccount) => {
    setEditingId(a.id); setLabel(a.label); setEmail(a.email || ''); setModel(a.model || DEFAULT_ACCOUNT_MODEL); setToken(''); setErr(null)
  }

  // Inline model change from a list row — saves immediately (no token touched).
  const changeModel = async (a: ClaudeAccount, newModel: string) => {
    const res = await window.electronAPI.claudeAccountsSave({ id: a.id, label: a.label, email: a.email, model: newModel }).catch(() => null)
    if (res?.ok) setAccounts(res.accounts)
  }

  const del = async (id: string) => {
    setAccounts(await window.electronAPI.claudeAccountsDelete(id).catch(() => accounts))
    setConfirmDelete(null)
    if (editingId === id) resetForm()
  }

  const [verifyMsg, setVerifyMsg] = useState<{ id: string; text: string } | null>(null)
  const verify = async (id: string) => {
    setVerifyMsg(null)
    const res = await window.electronAPI.claudeAccountsVerify(id).catch(() => null)
    if (!res) return
    setAccounts(res.accounts)
    if (res.status === 'needs_pane') setVerifyMsg({ id, text: 'Still no identity — make sure a pane is launched on this account and has rendered.' })
  }

  // A captured account is a DUPLICATE if another account's pane resolved to the same weekly
  // reset (the per-account fingerprint) — i.e. two slots, one real subscription.
  const dupResets = (() => {
    const counts = new Map<number, number>()
    for (const a of accounts) {
      const r = a.verifiedUsage?.weeklyResetEpoch
      if (r) counts.set(r, (counts.get(r) || 0) + 1)
    }
    return counts
  })()
  const fmtReset = (epoch: number) => {
    if (!epoch) return 'unknown'
    return new Date(epoch * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-[--ui-text-primary]">Claude accounts</h3>
        <p className="text-[12px] text-[--ui-text-dimmed] mt-1 leading-relaxed">
          Bind a terminal pane to a specific Claude subscription so two panes can run two different accounts
          at once. Add an account here, then pick it from a pane&apos;s agent menu (the caret next to the
          model name). Tokens are stored encrypted on this Mac and never leave it.
        </p>
      </div>

      {/* How to get a token */}
      <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-3 text-[12px] text-[--ui-text-secondary] leading-relaxed">
        <div className="font-medium text-[--ui-text-primary] mb-1">How to get a token</div>
        <ol className="list-decimal ml-4 space-y-1">
          <li>In any terminal, sign into the account you want: <code className="font-mono text-[--ui-text-primary]">claude</code> → <code className="font-mono text-[--ui-text-primary]">/login</code>.</li>
          <li>Run <code className="font-mono text-[--ui-text-primary]">claude setup-token</code> — it prints a long-lived token (requires a Pro/Max plan).</li>
          <li>Copy that token and paste it below. Repeat for your other account.</li>
        </ol>
      </div>

      {/* Existing accounts */}
      {accounts.length > 0 && (
        <div className="space-y-1.5">
          {accounts.map((a) => {
            const vu = a.verifiedUsage
            const isDup = !!vu && (dupResets.get(vu.weeklyResetEpoch) || 0) > 1
            return (
            <div key={a.id} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${isDup ? 'border-red-400/40 bg-red-400/[0.05]' : 'border-white/10'}`}>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-[--ui-text-primary] font-medium truncate">{a.label}</div>
                <div className="text-[11px] text-[--ui-text-dimmed] truncate">
                  {a.hasToken
                    ? <span className="text-emerald-300/90">token saved ✓</span>
                    : <span className="text-amber-300">no token — add one</span>}
                </div>
                {/* Identity fingerprint: which account this token actually reaches, captured
                    by a bound pane's status line (no API poll). */}
                {a.hasToken && (
                  <div className="text-[11px] mt-0.5 truncate">
                    {vu ? (
                      isDup ? (
                        <span className="text-red-300">⚠️ same account as another slot (both reset {fmtReset(vu.weeklyResetEpoch)}) — one token is wrong. Replace it.</span>
                      ) : (
                        <span className="text-emerald-300/90">✓ reaches account: weekly {vu.weeklyPct}% · resets {fmtReset(vu.weeklyResetEpoch)} <button onClick={() => verify(a.id)} className="text-[--ui-text-dimmed] hover:text-[--ui-text-primary] ml-1">↻</button></span>
                      )
                    ) : (
                      <span className="text-[--ui-text-dimmed]">identity not captured — launch this account on a pane, then <button onClick={() => verify(a.id)} className="text-[--accent] hover:underline">refresh</button></span>
                    )}
                    {verifyMsg?.id === a.id && <span className="text-amber-300 ml-2">{verifyMsg.text}</span>}
                  </div>
                )}
              </div>
              <select
                value={a.model || DEFAULT_ACCOUNT_MODEL}
                onChange={(e) => changeModel(a, e.target.value)}
                className="shrink-0 bg-black/30 border border-white/10 rounded px-1.5 py-1 text-[11px] text-[--ui-text-secondary] focus:outline-none focus:border-[--accent]/50"
                title="Model this account's panes launch with"
              >
                {MODEL_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <button onClick={() => startEdit(a)} className="text-[11px] text-[--ui-text-secondary] hover:text-[--ui-text-primary] shrink-0">Edit</button>
              {confirmDelete === a.id ? (
                <span className="flex items-center gap-1.5 text-[11px] shrink-0">
                  <button onClick={() => del(a.id)} className="text-red-400 hover:underline">Delete</button>
                  <button onClick={() => setConfirmDelete(null)} className="text-[--ui-text-muted] hover:underline">Cancel</button>
                </span>
              ) : (
                <button onClick={() => setConfirmDelete(a.id)} className="text-[11px] text-[--ui-text-muted] hover:text-red-400 shrink-0">Remove</button>
              )}
            </div>
            )
          })}
        </div>
      )}

      {/* Add / edit form */}
      <div className="rounded-lg border border-white/10 px-3.5 py-3 space-y-2.5">
        <div className="text-[12px] font-medium text-[--ui-text-primary]">{editingId ? 'Edit account' : 'Add an account'}</div>
        <div className="flex gap-2">
          <input
            value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Work)"
            className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-[13px] text-[--ui-text-primary] placeholder:text-[--ui-text-dimmed] focus:outline-none focus:border-[--accent]/50"
          />
          <input
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email (optional)"
            className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-[13px] text-[--ui-text-primary] placeholder:text-[--ui-text-dimmed] focus:outline-none focus:border-[--accent]/50"
          />
        </div>
        <input
          value={token} onChange={(e) => setToken(e.target.value)} type="password"
          placeholder={editingId ? 'Paste a new token to replace it (leave blank to keep)' : 'Paste token from `claude setup-token`'}
          className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-[13px] font-mono text-[--ui-text-primary] placeholder:text-[--ui-text-dimmed] placeholder:font-sans focus:outline-none focus:border-[--accent]/50"
        />
        <label className="flex items-center gap-2 text-[12px] text-[--ui-text-secondary]">
          <span className="shrink-0">Model</span>
          <select
            value={model} onChange={(e) => setModel(e.target.value)}
            className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-[13px] text-[--ui-text-primary] focus:outline-none focus:border-[--accent]/50"
          >
            {MODEL_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <span className="text-[10px] text-[--ui-text-dimmed] shrink-0">panes on this account launch with this</span>
        </label>
        {err && <div className="text-[11px] text-red-400">{err}</div>}
        <div className="flex items-center gap-2">
          <button onClick={save} disabled={busy} className="px-3 py-1.5 text-[12px] rounded-lg bg-[--accent] text-white hover:opacity-90 disabled:opacity-40">
            {busy ? 'Saving…' : editingId ? 'Save changes' : 'Add account'}
          </button>
          {editingId && <button onClick={resetForm} className="px-3 py-1.5 text-[12px] rounded-lg glass-control text-[--ui-text-secondary] hover:text-[--ui-text-primary]">Cancel</button>}
        </div>
      </div>

      <p className="text-[11px] text-[--ui-text-dimmed] leading-relaxed">
        Note: a pane bound to an account ignores the global <code className="font-mono">/login</code> and uses that account&apos;s token (subscription billing, not metered API). Running two of your own Max subscriptions this way is supported by the official CLI; tokens last ~1 year, then regenerate with <code className="font-mono">claude setup-token</code>.
      </p>
    </div>
  )
}
