import { useState, useEffect, useCallback } from 'react'
import { ClaudeAccount } from '../../shared/types'

// Manage saved Claude subscription accounts. Each account stores a label and a long-lived
// CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), encrypted by the main process. A pane
// can then be bound to an account (via its agent badge) to authenticate as that account —
// letting two panes run two different Max subscriptions side-by-side.
export function ClaudeAccountsSettings() {
  const [accounts, setAccounts] = useState<ClaudeAccount[]>([])
  const [label, setLabel] = useState('')
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const reload = useCallback(() => {
    window.electronAPI.claudeAccountsList().then(setAccounts).catch(() => {})
  }, [])
  useEffect(() => { reload() }, [reload])

  const resetForm = () => { setLabel(''); setEmail(''); setToken(''); setEditingId(null); setErr(null) }

  const save = async () => {
    if (!label.trim()) { setErr('Give the account a label (e.g. "Work").'); return }
    if (!editingId && !token.trim()) { setErr('Paste the token from `claude setup-token`.'); return }
    setBusy(true); setErr(null)
    const res = await window.electronAPI.claudeAccountsSave({
      id: editingId || undefined,
      label: label.trim(),
      email: email.trim() || undefined,
      token: token.trim() || undefined,
    }).catch(() => ({ ok: false, error: 'Save failed', accounts }))
    setBusy(false)
    if (!res.ok) { setErr(res.error || 'Save failed'); return }
    setAccounts(res.accounts)
    resetForm()
  }

  const startEdit = (a: ClaudeAccount) => {
    setEditingId(a.id); setLabel(a.label); setEmail(a.email || ''); setToken(''); setErr(null)
  }

  const del = async (id: string) => {
    setAccounts(await window.electronAPI.claudeAccountsDelete(id).catch(() => accounts))
    setConfirmDelete(null)
    if (editingId === id) resetForm()
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
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center gap-3 rounded-lg border border-white/10 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-[--ui-text-primary] font-medium truncate">{a.label}</div>
                <div className="text-[11px] text-[--ui-text-dimmed] truncate">
                  {a.email || 'no email set'} · {a.hasToken
                    ? <span className="text-emerald-300/90">token saved ✓</span>
                    : <span className="text-amber-300">no token — add one</span>}
                </div>
              </div>
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
          ))}
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
