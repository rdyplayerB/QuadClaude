import { useState, useEffect, useCallback } from 'react'
import { ClaudeAccount, DEFAULT_ACCOUNT_MODEL, CLAUDE_MODELS } from '../../shared/types'

// Models a pane can pin per account. The list is the app-wide catalog — this
// component used to keep its own copy, which is how it ended up offering
// Opus 4.8 as the newest model. 'default' opts out of pinning entirely.
const MODEL_OPTIONS = CLAUDE_MODELS

// Manage saved Claude subscription accounts. Each account is a profile DIRECTORY
// (~/.quadclaude/profiles/<id>) injected as CLAUDE_CONFIG_DIR at pane spawn, giving it its
// own separate login, history, and sessions. The user binds a pane to an account (via its
// agent badge) and runs /login there once — no tokens or credentials pass through, or are
// stored by, QuadClaude. Two panes can run two different Max subscriptions side-by-side.
export function ClaudeAccountsSettings() {
  const [accounts, setAccounts] = useState<ClaudeAccount[]>([])
  const [label, setLabel] = useState('')
  const [email, setEmail] = useState('')
  const [model, setModel] = useState(DEFAULT_ACCOUNT_MODEL)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const reload = useCallback(() => {
    window.electronAPI.claudeAccountsList().then(setAccounts).catch(() => {})
  }, [])
  useEffect(() => { reload() }, [reload])

  const resetForm = () => { setLabel(''); setEmail(''); setModel(DEFAULT_ACCOUNT_MODEL); setEditingId(null); setErr(null) }

  const save = async () => {
    if (!label.trim()) { setErr('Give the account a label (e.g. "Work").'); return }
    setBusy(true); setErr(null)
    const res = await window.electronAPI.claudeAccountsSave({
      id: editingId || undefined,
      label: label.trim(),
      email: email.trim() || undefined,
      model,
    }).catch(() => ({ ok: false, error: 'Save failed', accounts }))
    setBusy(false)
    if (!res.ok) { setErr(res.error || 'Save failed'); return }
    setAccounts(res.accounts)
    resetForm()
  }

  const startEdit = (a: ClaudeAccount) => {
    setEditingId(a.id); setLabel(a.label); setEmail(a.email || ''); setModel(a.model || DEFAULT_ACCOUNT_MODEL); setErr(null)
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
        <h3 className="text-body font-semibold text-[--ui-text-primary]">Claude accounts</h3>
        <p className="text-body text-[--ui-text-dimmed] mt-1 leading-relaxed">
          Bind a terminal pane to a specific Claude subscription so two panes can run two different accounts
          at once. Add an account here, then pick it from a pane&apos;s agent menu (the caret next to the
          model name). Each account keeps its own separate login and chat history — no tokens or
          credentials are stored by QuadClaude.
        </p>
      </div>

      {/* How it works */}
      <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-3 text-body text-[--ui-text-secondary] leading-relaxed">
        <div className="font-medium text-[--ui-text-primary] mb-1">How it works</div>
        <ol className="list-decimal ml-4 space-y-1">
          <li>Add an account below — just a label, no credentials.</li>
          <li>Pick it from a pane&apos;s agent menu (the caret next to the model name) and launch Claude Code there.</li>
          <li>Run <code className="font-mono text-[--ui-text-primary]">/login</code> once in that pane — the login sticks to this account&apos;s own profile from then on.</li>
        </ol>
      </div>

      {/* Existing accounts */}
      {accounts.length > 0 && (
        <div className="space-y-1.5">
          {accounts.map((a) => {
            const vu = a.verifiedUsage
            const isDup = !!vu && (dupResets.get(vu.weeklyResetEpoch) || 0) > 1
            return (
            <div key={a.id} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${isDup ? 'border-[--danger-line] bg-[--danger-soft]' : 'border-white/10'}`}>
              <div className="min-w-0 flex-1">
                <div className="text-heading text-[--ui-text-primary] font-medium truncate">{a.label}</div>
                <div className="text-body text-[--ui-text-dimmed] truncate">
                  {a.loggedIn
                    ? <span className="text-[--success]/90">logged in ✓</span>
                    : <span className="text-[--warning]">not logged in — launch a pane on this account, then run /login once</span>}
                </div>
                {/* Identity fingerprint: which account this profile's login actually reaches,
                    captured by a bound pane's status line (no API poll). */}
                {a.loggedIn && (
                  <div className="text-body mt-0.5 truncate">
                    {vu ? (
                      isDup ? (
                        <span className="text-[--danger]">⚠️ same account as another slot (both reset {fmtReset(vu.weeklyResetEpoch)}) — one profile is logged into the wrong account. Re-run /login there.</span>
                      ) : (
                        <span className="text-[--success]/90">✓ reaches account: weekly {vu.weeklyPct}% · resets {fmtReset(vu.weeklyResetEpoch)} <button onClick={() => verify(a.id)} className="text-[--ui-text-dimmed] hover:text-[--ui-text-primary] ml-1">↻</button></span>
                      )
                    ) : (
                      <span className="text-[--ui-text-dimmed]">identity not captured — launch this account on a pane, then <button onClick={() => verify(a.id)} className="text-[--accent] hover:underline">refresh</button></span>
                    )}
                    {verifyMsg?.id === a.id && <span className="text-[--warning] ml-2">{verifyMsg.text}</span>}
                  </div>
                )}
              </div>
              <select
                value={a.model || DEFAULT_ACCOUNT_MODEL}
                onChange={(e) => changeModel(a, e.target.value)}
                className="shrink-0 bg-black/30 border border-white/10 rounded px-1.5 py-1 text-body text-[--ui-text-secondary] focus:outline-none focus:border-[--accent]/50"
                title="Model this account's panes launch with"
              >
                {MODEL_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <button onClick={() => startEdit(a)} className="text-body text-[--ui-text-secondary] hover:text-[--ui-text-primary] shrink-0">Edit</button>
              {confirmDelete === a.id ? (
                <span className="flex items-center gap-1.5 text-body shrink-0">
                  <button onClick={() => del(a.id)} className="text-[--danger] hover:underline">Delete</button>
                  <button onClick={() => setConfirmDelete(null)} className="text-[--ui-text-muted] hover:underline">Cancel</button>
                </span>
              ) : (
                <button onClick={() => setConfirmDelete(a.id)} className="text-body text-[--ui-text-muted] hover:text-[--danger] shrink-0">Remove</button>
              )}
            </div>
            )
          })}
        </div>
      )}

      {/* Add / edit form */}
      <div className="rounded-lg border border-white/10 px-3.5 py-3 space-y-2.5">
        <div className="text-body font-medium text-[--ui-text-primary]">{editingId ? 'Edit account' : 'Add an account'}</div>
        <div className="flex gap-2">
          <input
            value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Work)"
            className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-heading text-[--ui-text-primary] placeholder:text-[--ui-text-dimmed] focus:outline-none focus:border-[--accent]/50"
          />
          <input
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email (optional)"
            className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-heading text-[--ui-text-primary] placeholder:text-[--ui-text-dimmed] focus:outline-none focus:border-[--accent]/50"
          />
        </div>
        <label className="flex items-center gap-2 text-body text-[--ui-text-secondary]">
          <span className="shrink-0">Model</span>
          <select
            value={model} onChange={(e) => setModel(e.target.value)}
            className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-heading text-[--ui-text-primary] focus:outline-none focus:border-[--accent]/50"
          >
            {MODEL_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <span className="text-meta text-[--ui-text-dimmed] shrink-0">panes on this account launch with this</span>
        </label>
        {err && <div className="text-body text-[--danger]">{err}</div>}
        <div className="flex items-center gap-2">
          <button onClick={save} disabled={busy} className="px-3 py-1.5 text-body rounded-lg bg-[--accent] text-white hover:opacity-90 disabled:opacity-40">
            {busy ? 'Saving…' : editingId ? 'Save changes' : 'Add account'}
          </button>
          {editingId && <button onClick={resetForm} className="px-3 py-1.5 text-body rounded-lg glass-control text-[--ui-text-secondary] hover:text-[--ui-text-primary]">Cancel</button>}
        </div>
      </div>

      <p className="text-body text-[--ui-text-dimmed] leading-relaxed">
        Note: a pane bound to an account runs in that account&apos;s own profile directory — separate login, history, and sessions (subscription billing, not metered API). Sign in once per account with <code className="font-mono">/login</code>; Claude Code keeps that login fresh itself.
      </p>
    </div>
  )
}
