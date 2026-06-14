import { useState, useEffect, useCallback, useMemo } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { DelegationProjectSummary, DelegationEvent, RouterDelegationStatus } from '../../shared/types'

interface Props {
  isOpen: boolean
  onClose: () => void
}

function pct(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(n * 100)}%`
}
function rel(ts: string): string {
  const t = Date.parse(ts)
  if (Number.isNaN(t)) return ts
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
function shortRoute(r: string): string {
  // "olares,qwen3-coder:30b" → "qwen3-coder:30b"
  return r.split(',').pop() || r
}

// A big headline metric.
function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-300' : tone === 'bad' ? 'text-red-400' : 'text-[--ui-text-primary]'
  return (
    <div className="glass-control rounded-xl px-4 py-3 flex flex-col gap-0.5 min-w-0">
      <span className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</span>
      <span className="text-[11px] text-[--ui-text-muted] uppercase tracking-wide truncate">{label}</span>
      {sub && <span className="text-[10px] text-[--ui-text-dimmed] truncate">{sub}</span>}
    </div>
  )
}

function Badge({ text, tone }: { text: string; tone: 'good' | 'bad' | 'warn' | 'muted' }) {
  const cls =
    tone === 'good' ? 'bg-emerald-400/15 text-emerald-300' :
    tone === 'bad' ? 'bg-red-400/15 text-red-300' :
    tone === 'warn' ? 'bg-amber-400/15 text-amber-200' :
    'bg-white/5 text-[--ui-text-dimmed]'
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>{text}</span>
}

export function DelegationDashboard({ isOpen, onClose }: Props) {
  const preferences = useWorkspaceStore((s) => s.preferences)
  const updatePreferences = useWorkspaceStore((s) => s.updatePreferences)
  const enabled = !!preferences.delegation?.enabled

  const [status, setStatus] = useState<RouterDelegationStatus | null>(null)
  const [summaries, setSummaries] = useState<DelegationProjectSummary[]>([])
  const [events, setEvents] = useState<DelegationEvent[]>([])
  const [filterProject, setFilterProject] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<'all' | 'issues'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(() => {
    window.electronAPI.delegationSummaries().then(setSummaries).catch(() => {})
    window.electronAPI.delegationEvents().then(setEvents).catch(() => {}).finally(() => setLoaded(true))
  }, [])

  useEffect(() => {
    if (!isOpen) return
    window.electronAPI.routerDelegationStatus().then(setStatus).catch(() => {})
    refresh()
  }, [isOpen, refresh])

  // Live-update while open.
  useEffect(() => {
    if (!isOpen) return
    return window.electronAPI.onDelegationEvent(() => refresh())
  }, [isOpen, refresh])

  // Esc to close.
  useEffect(() => {
    if (!isOpen) return
    const h = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [isOpen, onClose])

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }

  const totals = useMemo(() => {
    const t = events.reduce(
      (a, e) => ({
        n: a.n + 1,
        ok: a.ok + (e.exit === 0 ? 1 : 0),
        checked: a.checked + (e.check ? 1 : 0),
        checkPass: a.checkPass + (e.check && e.check.exit === 0 ? 1 : 0),
        ins: a.ins + (e.insertions || 0),
        files: a.files + (e.files ? e.files.split(';').filter(Boolean).length : 0),
        cold: a.cold + (e.coldStartRetries || 0),
        dur: a.dur + (e.durationSec || 0),
      }),
      { n: 0, ok: 0, checked: 0, checkPass: 0, ins: 0, files: 0, cold: 0, dur: 0 },
    )
    return t
  }, [events])

  const checkRate = totals.checked ? totals.checkPass / totals.checked : null
  // "Issues" = the worker errored OR its ground-truth check failed — the rows worth
  // studying to improve delegation.
  const isIssue = (e: DelegationEvent) => e.exit !== 0 || (!!e.check && e.check.exit !== 0)
  const issueCount = events.filter(isIssue).length
  const shownEvents = events
    .filter((e) => (filterProject ? e.project === filterProject : true))
    .filter((e) => (outcome === 'issues' ? isIssue(e) : true))

  const copyLog = async () => {
    setBusy(true)
    try {
      const { text } = await window.electronAPI.delegationExport(false)
      await window.electronAPI.clipboardWriteText(text)
      flash('Log copied to clipboard — paste it back to Claude')
    } catch {
      flash('Copy failed')
    } finally {
      setBusy(false)
    }
  }
  const saveLog = async () => {
    setBusy(true)
    try {
      const { path, canceled } = await window.electronAPI.delegationExport(true)
      if (!canceled && path) flash(`Saved to ${path}`)
    } catch {
      flash('Save failed')
    } finally {
      setBusy(false)
    }
  }
  const clearAll = async () => {
    setSummaries(await window.electronAPI.delegationClear())
    setEvents([])
    setConfirmClear(false)
    flash('Telemetry cleared')
  }

  if (!isOpen) return null
  const capable = !!status?.route && status.onPath

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="glass-elevated glass-border rounded-2xl shadow-2xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden backdrop-blur-xl" role="dialog" aria-modal="true" aria-label="Delegation dashboard">
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-3 border-b glass-border shrink-0 gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-semibold text-[--ui-text-primary]">Delegation</h2>
              <button
                onClick={() => updatePreferences({ delegation: { ...preferences.delegation, enabled: !enabled } })}
                className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] transition-all ${enabled ? 'bg-emerald-400/15 text-emerald-300' : 'glass-control text-[--ui-text-muted]'}`}
                title="Toggle delegation"
              >
                <span className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-emerald-400' : 'bg-[--ui-text-dimmed]'}`} />
                {enabled ? 'Enabled' : 'Disabled'}
              </button>
              {enabled && (
                capable
                  ? <span className="text-[11px] text-[--ui-text-dimmed] truncate">→ <span className="font-mono text-[--ui-text-secondary]">{shortRoute(status!.route)}</span></span>
                  : <span className="text-[11px] text-amber-300 truncate">No model set — configure one in Settings → Models</span>
              )}
            </div>
            <p className="text-[11px] text-[--ui-text-dimmed] mt-0.5">Every task Claude hands to a local model — what changed, and whether it worked.</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={refresh} className="px-2.5 py-1.5 text-xs rounded-lg glass-control text-[--ui-text-secondary] hover:text-[--ui-text-primary]" title="Refresh">Refresh</button>
            <button onClick={copyLog} disabled={busy || !events.length} className="px-2.5 py-1.5 text-xs rounded-lg glass-control text-[--ui-text-secondary] hover:text-[--ui-text-primary] disabled:opacity-40" title="Copy the full log to clipboard">Copy log</button>
            <button onClick={saveLog} disabled={busy || !events.length} className="px-2.5 py-1.5 text-xs rounded-lg bg-[--accent] text-white hover:opacity-90 disabled:opacity-40" title="Save the full log to a file">Export</button>
            <button onClick={onClose} className="ml-1 p-1.5 text-[--ui-text-muted] hover:text-[--ui-text-primary] rounded-lg" aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" /></svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
          {!loaded ? (
            <div className="text-center text-[--ui-text-dimmed] py-20 text-sm">Loading…</div>
          ) : events.length === 0 ? (
            <div className="text-center text-[--ui-text-dimmed] py-20">
              <p className="text-sm mb-1">No delegations recorded yet.</p>
              <p className="text-[12px]">When Claude runs <span className="font-mono">qcdelegate</span> or <span className="font-mono">qwen</span> in a pane, each call is logged here — what was delegated, what changed, and whether it worked.</p>
            </div>
          ) : (
            <>
              {/* KPIs */}
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5">
                <Kpi label="Delegations" value={String(totals.n)} sub={`${totals.ok} succeeded`} />
                <Kpi label="Check pass" value={pct(checkRate)} sub={`${totals.checkPass}/${totals.checked} checked`} tone={checkRate == null ? undefined : checkRate >= 0.8 ? 'good' : checkRate >= 0.5 ? 'warn' : 'bad'} />
                <Kpi label="Lines" value={totals.ins.toLocaleString()} sub="delegated" />
                <Kpi label="Files" value={String(totals.files)} sub="touched" />
                <Kpi label="Cold starts" value={String(totals.cold)} sub="warm-up retries" tone={totals.cold > 0 ? 'warn' : undefined} />
                <Kpi label="Avg time" value={`${totals.n ? Math.round(totals.dur / totals.n) : 0}s`} sub="per call" />
              </div>

              {/* Per-project */}
              <div>
                <div className="text-[11px] text-[--ui-text-muted] uppercase tracking-wide mb-2">Projects</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {summaries.map((s) => {
                    const active = filterProject === s.project
                    const worked = s.checked ? s.checkRate : s.successRate
                    return (
                      <button
                        key={s.project}
                        onClick={() => setFilterProject(active ? null : s.project)}
                        className={`text-left glass-control rounded-lg px-3 py-2 transition-all ${active ? 'ring-1 ring-[--accent]' : 'hover:bg-[--ui-bg-active]/40'}`}
                        title={s.project}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm text-[--ui-text-primary] truncate">{s.projectName}</span>
                          <span className="text-[10px] text-[--ui-text-dimmed] shrink-0" title={s.lastAt ? new Date(s.lastAt).toLocaleString() : ''}>{s.lastAt ? rel(s.lastAt) : ''}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-[11px] text-[--ui-text-dimmed]">
                          <span>{s.delegations} calls</span>
                          <span>· {pct(worked)} {s.checked ? 'check' : 'ok'}</span>
                          <span>· {s.insertions.toLocaleString()} lines</span>
                          {s.coldStartRetries > 0 && <span>· {s.coldStartRetries} cold</span>}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Timeline */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[--ui-text-muted] uppercase tracking-wide">
                      Calls {filterProject && <span className="text-[--accent] normal-case">· filtered</span>}
                    </span>
                    <div className="flex items-center glass-control rounded-md p-0.5 text-[10px]">
                      {(['all', 'issues'] as const).map((o) => (
                        <button
                          key={o}
                          onClick={() => setOutcome(o)}
                          className={`px-2 py-0.5 rounded transition-all ${outcome === o ? 'glass-control-active text-[--ui-text-primary]' : 'text-[--ui-text-muted] hover:text-[--ui-text-secondary]'}`}
                        >
                          {o === 'all' ? 'All' : `Issues${issueCount ? ` (${issueCount})` : ''}`}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {filterProject && <button onClick={() => setFilterProject(null)} className="text-[11px] text-[--ui-text-muted] hover:text-[--ui-text-primary]">Clear filter</button>}
                    {confirmClear ? (
                      <span className="flex items-center gap-2 text-[11px]">
                        <span className="text-[--ui-text-dimmed]">Clear all?</span>
                        <button onClick={clearAll} className="text-red-400 hover:underline">Yes</button>
                        <button onClick={() => setConfirmClear(false)} className="text-[--ui-text-muted] hover:underline">No</button>
                      </span>
                    ) : (
                      <button onClick={() => setConfirmClear(true)} className="text-[11px] text-[--ui-text-muted] hover:text-red-400">Clear telemetry</button>
                    )}
                  </div>
                </div>
                <div className="space-y-1">
                  {shownEvents.length === 0 && (
                    <div className="text-[11px] text-[--ui-text-dimmed] py-6 text-center">
                      {outcome === 'issues' ? 'No issues — every delegation here succeeded ✓' : 'No calls for this filter.'}
                    </div>
                  )}
                  {shownEvents.map((e) => {
                    const key = e.ts + e.task + e.project
                    const isOpenRow = expanded === key
                    const checkTone = e.check ? (e.check.exit === 0 ? 'good' : 'bad') : 'muted'
                    return (
                      <div key={key} className="glass-control rounded-lg overflow-hidden">
                        <button onClick={() => setExpanded(isOpenRow ? null : key)} className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-[--ui-bg-active]/40 transition-colors">
                          <span className="text-[10px] text-[--ui-text-dimmed] w-16 shrink-0" title={new Date(e.ts).toLocaleString()}>{rel(e.ts)}</span>
                          <span className="text-xs text-[--ui-text-primary] truncate flex-1 min-w-0">{e.task === 'untagged' ? <span className="text-[--ui-text-dimmed]">untagged</span> : e.task}</span>
                          <span className="text-[10px] font-mono text-[--ui-text-dimmed] hidden sm:inline">{shortRoute(e.route)}</span>
                          {e.exit === 0 ? <Badge text="ok" tone="good" /> : <Badge text={`exit ${e.exit}`} tone="bad" />}
                          {e.check && <Badge text={e.check.exit === 0 ? 'check ✓' : 'check ✕'} tone={checkTone} />}
                          {e.coldStartRetries > 0 && <Badge text={`cold ${e.coldStartRetries}`} tone="warn" />}
                          <span className="text-[10px] text-[--ui-text-dimmed] w-10 text-right shrink-0 tabular-nums">{e.durationSec}s</span>
                          <span className="text-[10px] text-[--ui-text-dimmed] w-16 text-right shrink-0 tabular-nums">+{e.insertions}/-{e.deletions}</span>
                        </button>
                        {isOpenRow && (
                          <div className="px-3 pb-3 pt-1 space-y-2 text-[11px] border-t glass-border">
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[--ui-text-dimmed]">
                              <span>project: <span className="text-[--ui-text-secondary]">{e.project}</span></span>
                              <span>pane: {e.pane || '—'}</span>
                              <span>route: <span className="font-mono">{e.route}</span></span>
                              <span>duration: {e.durationSec}s</span>
                              <span>git: {e.gitMode}</span>
                              {e.check && <span>check: <span className="font-mono">{e.check.command}</span> → exit {e.check.exit}</span>}
                            </div>
                            {e.files && <div className="text-[--ui-text-dimmed]">files: <span className="font-mono text-[--ui-text-secondary]">{e.files.split(';').filter(Boolean).join('  ')}</span></div>}
                            {e.promptPreview && (
                              <div>
                                <div className="text-[10px] uppercase tracking-wide text-[--ui-text-muted] mb-0.5">Prompt</div>
                                <pre className="whitespace-pre-wrap font-mono text-[10px] text-[--ui-text-secondary] bg-black/20 rounded p-2 max-h-32 overflow-y-auto">{e.promptPreview}</pre>
                              </div>
                            )}
                            {e.outputPreview && (
                              <div>
                                <div className="text-[10px] uppercase tracking-wide text-[--ui-text-muted] mb-0.5">Worker output (tail)</div>
                                <pre className="whitespace-pre-wrap font-mono text-[10px] text-[--ui-text-secondary] bg-black/20 rounded p-2 max-h-40 overflow-y-auto">{e.outputPreview}</pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        {toast && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-2 rounded-lg bg-[--ui-bg-elevated] border border-[#444] text-xs text-[--ui-text-primary] shadow-lg max-w-[80%] truncate">
            {toast}
          </div>
        )}
      </div>
    </div>
  )
}
