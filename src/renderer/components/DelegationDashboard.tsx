import { useState, useEffect, useCallback, useMemo } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { DelegationProjectSummary, DelegationEvent, DelegationDecision, DelegationInsights, RouterDelegationStatus } from '../../shared/types'

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

// A big headline metric. Pass onClick to make it an actionable button (e.g. jump to a
// filtered view) — a count you can't act on is just decoration.
function Kpi({ label, value, sub, tone, onClick }: { label: string; value: string; sub?: string; tone?: 'good' | 'warn' | 'bad'; onClick?: () => void }) {
  const color = tone === 'good' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-300' : tone === 'bad' ? 'text-red-400' : 'text-[--ui-text-primary]'
  const inner = (
    <>
      <span className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</span>
      <span className="text-[11px] text-[--ui-text-muted] uppercase tracking-wide truncate">{label}</span>
      {sub && <span className="text-[10px] text-[--ui-text-dimmed] truncate">{sub}</span>}
    </>
  )
  const base = 'glass-control rounded-xl px-4 py-3 flex flex-col gap-0.5 min-w-0'
  return onClick
    ? <button onClick={onClick} className={`${base} text-left hover:bg-[--ui-bg-active]/40 hover:ring-1 hover:ring-[--accent]/40 transition-all cursor-pointer`}>{inner}</button>
    : <div className={base}>{inner}</div>
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
  const [decisions, setDecisions] = useState<DelegationDecision[]>([])
  const [insights, setInsights] = useState<DelegationInsights | null>(null)
  const [filterProject, setFilterProject] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<'all' | 'issues'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [expandedDecision, setExpandedDecision] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(() => {
    window.electronAPI.delegationSummaries().then(setSummaries).catch(() => {})
    window.electronAPI.delegationDecisions().then(setDecisions).catch(() => {})
    window.electronAPI.delegationInsights().then(setInsights).catch(() => {})
    window.electronAPI.delegationEvents().then(setEvents).catch(() => {}).finally(() => setLoaded(true))
  }, [])

  // Record your real outcome for a delegated task (ship/revert/edit) → qceval verdict →
  // durable eval memory → calibration. The dashboard then shows which calls you've judged.
  const recordVerdict = useCallback(async (task: string, verdict: 'ship' | 'revert' | 'edit') => {
    if (!task || task === 'untagged') { flash('This call has no QC_TASK tag to record a verdict against.'); return }
    const ok = await window.electronAPI.delegationVerdict(task, verdict).catch(() => false)
    flash(ok ? `Recorded "${verdict}" for ${task}` : 'Could not record verdict (is qceval installed?)')
    if (ok) refresh()
  }, [refresh])

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
  // Effectiveness-first headline metrics (the questions that drive "delegate more/less?").
  const delegateN = decisions.filter((d) => d.verdict === 'delegate').length
  const delegRate = decisions.length ? delegateN / decisions.length : null
  const trust = insights?.calibration?.evalTrustworthiness ?? null
  const judged = insights?.calibration?.humanLabeled ?? 0
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
      <div className="glass-elevated glass-border rounded-2xl shadow-2xl w-[94vw] max-w-[1800px] h-[92vh] flex flex-col overflow-hidden backdrop-blur-xl" role="dialog" aria-modal="true" aria-label="Delegation dashboard">
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
        <div className="flex-1 min-h-0 flex flex-col p-4 gap-3">
          {!loaded ? (
            <div className="text-center text-[--ui-text-dimmed] py-20 text-sm">Loading…</div>
          ) : events.length === 0 && decisions.length === 0 ? (
            <div className="text-center text-[--ui-text-dimmed] py-20">
              <p className="text-sm mb-1">No delegations recorded yet.</p>
              <p className="text-[12px]">When Claude runs <span className="font-mono">qcdelegate</span> or <span className="font-mono">qwen</span> in a pane, each call is logged here — what was delegated, what changed, and whether it worked.</p>
            </div>
          ) : (
            <>
              {/* KPIs */}
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5 shrink-0">
                <Kpi label="Delegations" value={String(totals.n)} sub={`${totals.ok} ran clean`} />
                <Kpi label="Worked" value={pct(checkRate)} sub={`${totals.checkPass}/${totals.checked} with a check`} tone={checkRate == null ? undefined : checkRate >= 0.8 ? 'good' : checkRate >= 0.5 ? 'warn' : 'bad'} />
                <Kpi label="Delegate rate" value={delegRate == null ? '—' : pct(delegRate)} sub={`${delegateN} of ${decisions.length} units`} />
                <Kpi label="Eval trust" value={trust == null ? '—' : `${trust}%`} sub={judged ? `${judged} judged` : 'mark outcomes to start'} tone={trust == null ? undefined : trust >= 80 ? 'good' : 'warn'} />
                <Kpi label="Issues" value={String(issueCount)} sub={issueCount > 0 ? 'click to review →' : 'none'} tone={issueCount > 0 ? 'bad' : 'good'} onClick={issueCount > 0 ? () => {
                  setFilterProject(null)
                  setOutcome('issues')
                  const first = events.find(isIssue) // jump straight into the problem call's detail
                  if (first) setExpanded(first.ts + first.task + first.project)
                } : undefined} />
                <Kpi label="Avg time" value={`${totals.n ? Math.round(totals.dur / totals.n) : 0}s`} sub="per call" />
              </div>

              {/* Demoted volume context — informative, not a headline. */}
              <div className="text-[10px] text-[--ui-text-dimmed] shrink-0 -mt-1">
                {totals.ins.toLocaleString()} lines · {totals.files} files touched{totals.cold > 0 ? ` · ${totals.cold} cold starts` : ''}{insights ? ` · ${insights.totalOutcomes} in eval memory` : ''}
              </div>

              {/* WHAT TO DELEGATE — per-task-class success + recommendation, distilled from the
                  eval memory. The optimization view: where qwen is reliable vs where to keep. */}
              {insights && insights.byClass.length > 0 && (
                <div className="shrink-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[11px] text-[--ui-text-muted] uppercase tracking-wide">What to delegate</span>
                    <span className="text-[10px] text-[--ui-text-dimmed]">by task class{insights.firstTryRate != null ? ` · ${pct(insights.firstTryRate)} first-try` : ''}</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                    {insights.byClass.map((c) => (
                      <div key={c.taskClass} className="glass-control rounded-lg px-3 py-2 flex flex-col gap-1.5 min-w-0" title={`${c.passed}/${c.checked} checked passed · ${c.firstTry} first-try · ${c.n} total`}>
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-xs font-medium text-[--ui-text-primary] capitalize truncate">{c.taskClass}</span>
                          <span className={`text-base font-semibold tabular-nums ${c.tone === 'good' ? 'text-emerald-400' : c.tone === 'bad' ? 'text-red-400' : c.tone === 'warn' ? 'text-amber-300' : 'text-[--ui-text-dimmed]'}`}>{c.passRate == null ? '—' : pct(c.passRate)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-1">
                          <Badge text={c.recommendation} tone={c.tone} />
                          <span className="text-[10px] text-[--ui-text-dimmed] shrink-0">n={c.n}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Main: fixed-height panels — each scrolls independently, so filtering
                  a project or browsing decisions never reflows the layout. */}
              <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1.25fr_1fr] gap-3 overflow-y-auto lg:overflow-hidden">
                {/* LEFT — Decisions (own scroll; click a row for full detail) */}
                <div className="min-h-0 flex flex-col glass-control rounded-xl overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 border-b glass-border shrink-0">
                    <span className="text-[11px] text-[--ui-text-muted] uppercase tracking-wide">Decisions</span>
                    <span className="text-[10px] text-[--ui-text-dimmed]">
                      {decisions.filter((d) => d.verdict === 'keep').length} kept · {decisions.filter((d) => d.verdict === 'delegate').length} delegated
                    </span>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
                    {decisions.length === 0 && <div className="text-[11px] text-[--ui-text-dimmed] py-6 text-center">No keep/delegate decisions logged yet.</div>}
                    {decisions.slice(0, 100).map((d, i) => {
                      const dkey = d.ts + d.group + i
                      const dOpen = expandedDecision === dkey
                      return (
                        <div key={dkey} className="glass-control rounded-lg overflow-hidden">
                          <button onClick={() => setExpandedDecision(dOpen ? null : dkey)} className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-[--ui-bg-active]/40 transition-colors">
                            <span className="text-[10px] text-[--ui-text-dimmed] w-12 shrink-0" title={new Date(d.ts).toLocaleString()}>{rel(d.ts)}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 ${d.verdict === 'keep' ? 'bg-sky-400/15 text-sky-300' : 'bg-orange-400/15 text-orange-300'}`}>{d.verdict === 'keep' ? 'KEEP' : 'DELEGATE'}</span>
                            <span className="text-xs text-[--ui-text-primary] truncate shrink-0 max-w-[42%]" title={d.group}>{d.group}</span>
                            <span className="text-[11px] text-[--ui-text-dimmed] truncate flex-1 min-w-0">{d.reason}</span>
                            <svg width="9" height="9" viewBox="0 0 10 10" className={`shrink-0 text-[--ui-text-dimmed] transition-transform ${dOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 3.5L5 6.5L8 3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          </button>
                          {dOpen && (
                            <div className="px-3 pb-3 pt-1 space-y-2 text-[11px] border-t glass-border">
                              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[--ui-text-dimmed]">
                                <span>when: {new Date(d.ts).toLocaleString()}</span>
                                {d.project && <span>project: <span className="text-[--ui-text-secondary]">{d.project}</span></span>}
                                {d.pane && <span>pane: {d.pane}</span>}
                                {d.check && <span>check: <span className="font-mono text-[--ui-text-secondary]">{d.check}</span></span>}
                              </div>
                              <div>
                                <div className="text-[10px] uppercase tracking-wide text-[--ui-text-muted] mb-0.5">Reason</div>
                                <p className="text-[--ui-text-secondary] leading-relaxed">{d.reason}</p>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* RIGHT — Projects (top, capped) + Calls (fills rest) */}
                <div className="min-h-0 flex flex-col gap-3">

                {/* Projects — capped height; scrolls if there are many */}
                <div className="shrink-0 max-h-[38%] flex flex-col glass-control rounded-xl overflow-hidden">
                  <div className="px-3 py-2 border-b glass-border shrink-0 text-[11px] text-[--ui-text-muted] uppercase tracking-wide">Projects</div>
                  <div className="flex-1 min-h-0 overflow-y-auto p-2">
                    <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-2">
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
                </div>

                {/* Calls — fills the rest; scrolls. Filtering never resizes the panel. */}
                <div className="flex-1 min-h-0 flex flex-col glass-control rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between gap-2 px-3 py-2 border-b glass-border shrink-0">
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
                  <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
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
                          {e.humanVerdict && <Badge text={e.humanVerdict} tone={e.humanVerdict === 'ship' ? 'good' : e.humanVerdict === 'revert' ? 'bad' : 'warn'} />}
                        </button>
                        {isOpenRow && (
                          <div className="px-3 pb-3 pt-1 space-y-2 text-[11px] border-t glass-border">
                            {/* Your verdict — feeds eval calibration (how often the check/judge was actually right) */}
                            <div className="flex items-center flex-wrap gap-2">
                              <span className="text-[10px] uppercase tracking-wide text-[--ui-text-muted]">Your outcome</span>
                              {([['ship', 'Shipped ✓'], ['revert', 'Reverted ↩'], ['edit', 'Edited ✎']] as const).map(([v, label]) => (
                                <button
                                  key={v}
                                  onClick={(ev) => { ev.stopPropagation(); recordVerdict(e.task, v) }}
                                  disabled={e.task === 'untagged'}
                                  className={`px-2 py-0.5 rounded text-[10px] transition-all disabled:opacity-40 ${e.humanVerdict === v ? 'bg-[--accent] text-white' : 'glass-control text-[--ui-text-secondary] hover:text-[--ui-text-primary]'}`}
                                  title={e.task === 'untagged' ? 'No QC_TASK tag to record against' : `Mark this delegation as ${v}`}
                                >
                                  {label}
                                </button>
                              ))}
                              <span className="text-[10px] text-[--ui-text-dimmed]">— did the delegated change stick? (trains the eval)</span>
                            </div>
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
