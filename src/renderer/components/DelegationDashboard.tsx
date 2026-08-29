import { useState, useEffect, useCallback, useMemo } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { DelegationProjectSummary, DelegationEvent, DelegationDecision, DelegationInsights, ShadowVerdict, RouterDelegationStatus } from '../../shared/types'

interface Props {
  isOpen: boolean
  onClose: () => void
  scale?: number // font/layout zoom (Cmd +/- while open); 1 = default
  onScaleChange?: (n: number) => void
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
function projectName(p: string): string {
  return p.split('/').pop() || p
}

// Link a DELEGATE decision to the qcdelegate Call it produced. qcdecide (intent) and
// qcdelegate (execution) share no key, so we join on project + pane + time: the call runs
// in the same pane within a few minutes of the decision. Returns the nearest such call.
function matchDelegationCall(d: DelegationDecision, events: DelegationEvent[]): DelegationEvent | null {
  if (d.verdict !== 'delegate') return null
  const dt = Date.parse(d.ts)
  if (Number.isNaN(dt)) return null
  const cands = events.filter(
    (e) => e.project === d.project && (e.pane || '') === (d.pane || '') && Math.abs(Date.parse(e.ts) - dt) <= 15 * 60 * 1000,
  )
  if (!cands.length) return null
  cands.sort((a, b) => Math.abs(Date.parse(a.ts) - dt) - Math.abs(Date.parse(b.ts) - dt))
  return cands[0]
}

// How a shadow (qcshadow) verdict reads in the ledger. Green = your KEEP was validated
// (qwen fell short); amber = actionable (qwen matched → you may be over-cautious).
function shadowChrome(s: ShadowVerdict): { text: string; note: string; tone: 'over' | 'earned' | 'mute' } {
  switch (s.couldMatch) {
    case 'yes': return { text: '▲ qwen MATCHED', note: 'passed the same check — consider delegating this class', tone: 'over' }
    case 'likely': return { text: '△ qwen likely matched', note: `adversarial judge said ${s.judgeVerdict} (no objective check)`, tone: 'over' }
    case 'no': return { text: '✓ qwen fell short', note: `KEEP justified${s.judgeVerdict && s.judgeVerdict !== 'unknown' ? ` · judge ${s.judgeVerdict}` : ''}`, tone: 'earned' }
    default: return { text: '• inconclusive', note: 'qwen ran but no objective signal to compare', tone: 'mute' }
  }
}

// Key phrases in the headline verdict. Rendered as plain text (no highlight/underline) —
// the serif headline already carries the emphasis.
function Hi({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

export function DelegationDashboard({ isOpen, onClose, scale = 1, onScaleChange }: Props) {
  const preferences = useWorkspaceStore((s) => s.preferences)
  const updatePreferences = useWorkspaceStore((s) => s.updatePreferences)
  const enabled = !!preferences.delegation?.enabled

  const [status, setStatus] = useState<RouterDelegationStatus | null>(null)
  const [summaries, setSummaries] = useState<DelegationProjectSummary[]>([])
  const [events, setEvents] = useState<DelegationEvent[]>([])
  const [decisions, setDecisions] = useState<DelegationDecision[]>([])
  const [insights, setInsights] = useState<DelegationInsights | null>(null)
  const [view, setView] = useState<'briefing' | 'decisions'>('briefing')
  const [filterProject, setFilterProject] = useState<string | null>(null)
  const [decFilter, setDecFilter] = useState<'all' | 'kept' | 'delegated' | 'shadow' | 'issues'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [fullPrompt, setFullPrompt] = useState<{ title: string; text: string } | null>(null)
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

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }

  // Record your real outcome for a delegated task (ship/revert/edit) → qceval verdict →
  // durable eval memory → calibration. The dashboard then shows which calls you've judged.
  const recordVerdict = useCallback(async (task: string, verdict: 'ship' | 'revert' | 'edit') => {
    if (!task || task === 'untagged') { flash('This call has no QC_TASK tag to record a verdict against.'); return }
    const ok = await window.electronAPI.delegationVerdict(task, verdict).catch(() => false)
    flash(ok ? `Recorded "${verdict}" for ${task}` : 'Could not record verdict (is qceval installed?)')
    if (ok) refresh()
  }, [refresh])

  // Load the FULL prompt for a delegation (lazy — only fetched on click) into a popup.
  const openFullPrompt = useCallback(async (ts: string, task: string, label: string) => {
    const text = await window.electronAPI.delegationFullPrompt(ts, task).catch(() => null)
    if (text) setFullPrompt({ title: label, text })
    else flash('Full prompt not stored for this call (delegated before this feature, or ran outside a pane).')
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

  // Esc closes the full-prompt popup first, then the dashboard.
  useEffect(() => {
    if (!isOpen) return
    const h = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (fullPrompt) setFullPrompt(null)
      else onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [isOpen, onClose, fullPrompt])

  const totals = useMemo(() => events.reduce(
    (a, e) => ({
      n: a.n + 1,
      ok: a.ok + (e.exit === 0 ? 1 : 0),
      checked: a.checked + (e.check ? 1 : 0),
      checkPass: a.checkPass + (e.check && e.check.exit === 0 ? 1 : 0),
      ins: a.ins + (e.insertions || 0),
      files: a.files + (e.files ? e.files.split(';').filter(Boolean).length : 0),
      dur: a.dur + (e.durationSec || 0),
    }),
    { n: 0, ok: 0, checked: 0, checkPass: 0, ins: 0, files: 0, dur: 0 },
  ), [events])

  const checkRate = totals.checked ? totals.checkPass / totals.checked : null
  const keptN = decisions.filter((d) => d.verdict === 'keep').length
  const delegateN = decisions.filter((d) => d.verdict === 'delegate').length
  const keptPct = decisions.length ? keptN / decisions.length : null
  const trust = insights?.calibration?.evalTrustworthiness ?? null
  const judged = insights?.calibration?.humanLabeled ?? 0
  const shadow = insights?.shadow ?? null
  const shadowTestedN = decisions.filter((d) => d.shadow).length

  const isIssue = (e: DelegationEvent) => e.exit !== 0 || (!!e.check && e.check.exit !== 0)
  const issueCount = events.filter(isIssue).length

  // Per-project activity for the rail — a UNION of decisions (qcdecide) AND calls
  // (qcdelegate), so a project with only keep/delegate decisions still appears.
  const projectList = useMemo(() => {
    const m = new Map<string, { project: string; name: string; decisions: number; delegated: number; calls: number; overCautious: number; lastAt: number }>()
    const touch = (proj: string) => {
      let e = m.get(proj)
      if (!e) { e = { project: proj, name: projectName(proj), decisions: 0, delegated: 0, calls: 0, overCautious: 0, lastAt: 0 }; m.set(proj, e) }
      return e
    }
    for (const d of decisions) {
      if (!d.project) continue
      const e = touch(d.project)
      e.decisions++
      if (d.verdict === 'delegate') e.delegated++
      if (d.shadow && (d.shadow.couldMatch === 'yes' || d.shadow.couldMatch === 'likely')) e.overCautious++
      const t = Date.parse(d.ts); if (!Number.isNaN(t) && t > e.lastAt) e.lastAt = t
    }
    for (const s of summaries) {
      const e = touch(s.project)
      e.calls = s.delegations
      const t = s.lastAt ? Date.parse(s.lastAt) : 0; if (!Number.isNaN(t) && t > e.lastAt) e.lastAt = t
    }
    return [...m.values()].sort((a, b) => b.lastAt - a.lastAt)
  }, [decisions, summaries])

  // Unified ledger: every DECISION (keep/delegate), each delegate joined to its Call, PLUS
  // any Calls with no matching decision (qwen-direct or pre-decision runs) so nothing is
  // lost. Filtered by project + the active chip.
  type Row =
    | { kind: 'decision'; key: string; ts: string; decision: DelegationDecision; call: DelegationEvent | null }
    | { kind: 'call'; key: string; ts: string; call: DelegationEvent }
  const ledger = useMemo<Row[]>(() => {
    const matched = new Set<string>()
    const decRows: Row[] = decisions.map((d, i) => {
      const call = matchDelegationCall(d, events)
      if (call) matched.add(call.ts + call.task + call.project)
      return { kind: 'decision', key: 'd' + d.ts + d.group + i, ts: d.ts, decision: d, call }
    })
    const callRows: Row[] = events
      .filter((e) => !matched.has(e.ts + e.task + e.project))
      .map((e) => ({ kind: 'call', key: 'c' + e.ts + e.task + e.project, ts: e.ts, call: e }))
    return [...decRows, ...callRows].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
  }, [decisions, events])

  const rowProject = (r: Row) => (r.kind === 'decision' ? r.decision.project : r.call.project)
  const rowIsIssue = (r: Row) => (r.kind === 'decision' ? !!r.call && isIssue(r.call) : isIssue(r.call))
  const shownRows = ledger
    .filter((r) => (filterProject ? rowProject(r) === filterProject : true))
    .filter((r) => {
      switch (decFilter) {
        case 'kept': return r.kind === 'decision' && r.decision.verdict === 'keep'
        case 'delegated': return r.kind === 'call' || (r.kind === 'decision' && r.decision.verdict === 'delegate')
        case 'shadow': return r.kind === 'decision' && !!r.decision.shadow
        case 'issues': return rowIsIssue(r)
        default: return true
      }
    })

  const filterCounts = useMemo(() => {
    const inProj = (r: Row) => (filterProject ? rowProject(r) === filterProject : true)
    const rows = ledger.filter(inProj)
    return {
      all: rows.length,
      kept: rows.filter((r) => r.kind === 'decision' && r.decision.verdict === 'keep').length,
      delegated: rows.filter((r) => r.kind === 'call' || (r.kind === 'decision' && r.decision.verdict === 'delegate')).length,
      shadow: rows.filter((r) => r.kind === 'decision' && !!r.decision.shadow).length,
      issues: rows.filter(rowIsIssue).length,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledger, filterProject])

  const copyLog = async () => {
    setBusy(true)
    try {
      const { text } = await window.electronAPI.delegationExport(false)
      await window.electronAPI.clipboardWriteText(text)
      flash('Log copied to clipboard — paste it back to Claude')
    } catch { flash('Copy failed') } finally { setBusy(false) }
  }
  const saveLog = async () => {
    setBusy(true)
    try {
      const { path, canceled } = await window.electronAPI.delegationExport(true)
      if (!canceled && path) flash(`Saved to ${path}`)
    } catch { flash('Save failed') } finally { setBusy(false) }
  }
  const clearAll = async () => {
    setSummaries(await window.electronAPI.delegationClear())
    setEvents([])
    setConfirmClear(false)
    flash('Telemetry cleared')
  }

  const goAllDecisions = (chip: typeof decFilter = 'all', project: string | null = null) => {
    setDecFilter(chip)
    setFilterProject(project)
    setView('decisions')
  }

  if (!isOpen) return null
  const capable = !!status?.route && status.onPath

  // ---- the computed headline verdict (analyst voice, driven entirely by the data) ----
  const overClasses = shadow ? shadow.byClass.filter((c) => c.matched > 0).map((c) => c.taskClass) : []
  function Verdict() {
    if (!decisions.length) {
      return <>No keep/delegate decisions logged yet. When a delegation-mode session runs <span className="font-mono text-[--ui-text-secondary]">qcdecide</span>, each call lands here and this becomes a read on where you delegate well.</>
    }
    if (shadow && shadow.total > 0 && shadow.matched > 0) {
      return <>You kept <Hi>{pct(keptPct)} of {decisions.length} units</Hi> — mostly defensible. But qwen <Hi>matched {shadow.matched} of {shadow.total} you shadow-tested</Hi>{overClasses.length ? <> — you may be over-cautious on <Hi>{overClasses.join(', ')}</Hi></> : null}.</>
    }
    if (shadow && shadow.total > 0) {
      return <>You kept <Hi>{pct(keptPct)} of {decisions.length} units</Hi>, and on all <Hi>{shadow.total} you shadow-tested</Hi>, qwen fell short. Your caution is earned — keep handling this work yourself.</>
    }
    return <>You kept <Hi>{pct(keptPct)} of {decisions.length} units</Hi> and delegated {delegateN}. Whether the kept work <em>needed</em> you is still unproven — shadow-test a few with <span className="font-mono text-[--ui-text-secondary]">qcshadow</span> to grade them.</>
  }

  // Evidence rows: per task class, blend the eval pass-rate with the shadow match signal.
  const evidence = (() => {
    const map = new Map<string, { taskClass: string; passRate: number | null; n: number; recommendation: string; tone: string; tested: number; matched: number }>()
    for (const c of insights?.byClass ?? []) map.set(c.taskClass, { taskClass: c.taskClass, passRate: c.passRate, n: c.n, recommendation: c.recommendation, tone: c.tone, tested: 0, matched: 0 })
    for (const c of shadow?.byClass ?? []) {
      const e = map.get(c.taskClass) ?? { taskClass: c.taskClass, passRate: null, n: 0, recommendation: '', tone: 'muted', tested: 0, matched: 0 }
      e.tested = c.tested; e.matched = c.matched
      map.set(c.taskClass, e)
    }
    return [...map.values()].sort((a, b) => (b.tested + b.n) - (a.tested + a.n)).slice(0, 8)
  })()

  // The expanded body of a Call — verdict recording + metadata + prompt/output. Shared by
  // delegate-decision rows and orphan-call rows so Issues review & verdicts never get lost.
  const CallDetail = ({ e }: { e: DelegationEvent }) => (
    <div className="px-4 pb-4 pt-1 space-y-2 text-body border-t glass-border">
      {(e.exit !== 0 || (e.check && e.check.exit !== 0)) && (
        <div className="text-meta text-[--warning]/90 flex items-start gap-1.5">
          <span aria-hidden>⚠</span>
          <span>{e.check && e.check.exit !== 0 ? "This check failed — the delegated code didn't pass." : 'The worker errored.'} Nothing to fix here — just record what you ultimately did with it, so the evaluator learns whether the check was right.</span>
        </div>
      )}
      <div className="flex items-center flex-wrap gap-2">
        <span className="text-meta uppercase tracking-wide text-[--ui-text-muted]">Your outcome</span>
        {([['ship', 'Shipped ✓', 'Shipped — you kept it in your codebase as-is'], ['revert', 'Reverted ↩', "Reverted — you threw it away / didn't use it"], ['edit', 'Edited ✎', 'Edited — you kept it but had to fix it yourself']] as const).map(([v, label, help]) => (
          <button key={v} onClick={(ev) => { ev.stopPropagation(); recordVerdict(e.task, v) }} disabled={e.task === 'untagged'}
            className={`px-2 py-0.5 rounded text-meta transition-all disabled:opacity-40 ${e.humanVerdict === v ? 'bg-[--accent] text-white' : 'glass-control text-[--ui-text-secondary] hover:text-[--ui-text-primary]'}`}
            title={e.task === 'untagged' ? 'No QC_TASK tag to record against' : help}>{label}</button>
        ))}
        <span className="text-meta text-[--ui-text-dimmed]">— did the delegated change stick?</span>
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
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-meta uppercase tracking-wide text-[--ui-text-muted]">Prompt <span className="normal-case text-[--ui-text-dimmed]">(preview)</span></span>
            <button onClick={(ev) => { ev.stopPropagation(); openFullPrompt(e.ts, e.task, e.task) }} className="text-meta text-[--accent] hover:underline">View full ↗</button>
          </div>
          <pre className="whitespace-pre-wrap font-mono text-meta text-[--ui-text-secondary] bg-black/20 rounded p-2 max-h-32 overflow-y-auto">{e.promptPreview}</pre>
        </div>
      )}
      {e.outputPreview && (
        <div>
          <div className="text-meta uppercase tracking-wide text-[--ui-text-muted] mb-0.5">Worker output (tail)</div>
          <pre className="whitespace-pre-wrap font-mono text-meta text-[--ui-text-secondary] bg-black/20 rounded p-2 max-h-40 overflow-y-auto">{e.outputPreview}</pre>
        </div>
      )}
    </div>
  )

  // The inline shadow band shown under a shadow-tested KEEP decision.
  const ShadowBand = ({ s }: { s: ShadowVerdict }) => {
    const c = shadowChrome(s)
    const color = c.tone === 'over' ? 'text-[--warning]' : c.tone === 'earned' ? 'text-[--success]' : 'text-[--ui-text-dimmed]'
    return (
      <div className="mt-2 inline-flex items-center gap-2.5 text-body bg-[--surface-2] border glass-border rounded-lg px-2.5 py-1.5">
        <span className="text-meta font-mono uppercase tracking-[0.1em] text-[--ui-text-dimmed]">shadow</span>
        <span className={`font-semibold ${color}`}>{c.text}</span>
        <span className="text-[--ui-text-dimmed]">— {c.note}</span>
      </div>
    )
  }

  // --ui-scale is pinned to 1 on the backdrop: the dashboard carries its own
  // zoom (further down), so the chrome zoom must not compound with it.
  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6" style={{ '--ui-scale': 1 } as React.CSSProperties} role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`glass-modal glass-border rounded-xl shadow-2xl w-[95vw] max-w-[1760px] ${view === 'decisions' ? 'h-[90vh]' : 'h-auto max-h-[90vh]'} flex flex-col overflow-hidden backdrop-blur-xl`} role="dialog" aria-modal="true" aria-label="Delegation dashboard">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-3.5 border-b glass-border shrink-0 gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h2 className="text-title font-semibold text-[--ui-text-primary] tracking-tight">Delegation</h2>
              <button
                onClick={() => updatePreferences({ delegation: { ...preferences.delegation, enabled: !enabled } })}
                className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-body transition-all ${enabled ? 'bg-[--success-soft] text-[--success]' : 'glass-control text-[--ui-text-muted]'}`}
                title="Toggle delegation">
                <span className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-[--success]' : 'bg-[--ui-text-dimmed]'}`} />
                {enabled ? 'Enabled' : 'Disabled'}
              </button>
              {enabled && (capable
                ? <span className="text-body text-[--ui-text-dimmed] truncate">→ <span className="font-mono text-[--ui-text-secondary]">{shortRoute(status!.route)}</span></span>
                : <span className="text-body text-[--warning] truncate">No model set — configure one in Settings → Models</span>)}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Zoom — also bound to Cmd +/- while the dashboard is open. */}
            {onScaleChange && (
              <div className="flex items-center glass-control rounded-lg overflow-hidden mr-0.5" title="Dashboard zoom (Cmd +/−). Click % to reset.">
                <button onClick={() => onScaleChange(scale - 0.1)} className="px-2 py-1.5 text-body text-[--ui-text-secondary] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active]/40" aria-label="Zoom out">−</button>
                <button onClick={() => onScaleChange(1)} className="px-1.5 py-1.5 text-body tabular-nums text-[--ui-text-dimmed] hover:text-[--ui-text-primary] min-w-[40px]">{Math.round(scale * 100)}%</button>
                <button onClick={() => onScaleChange(scale + 0.1)} className="px-2 py-1.5 text-body text-[--ui-text-secondary] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active]/40" aria-label="Zoom in">+</button>
              </div>
            )}
            <button onClick={refresh} className="px-2.5 py-1.5 text-body rounded-lg glass-control text-[--ui-text-secondary] hover:text-[--ui-text-primary]" title="Refresh">Refresh</button>
            <button onClick={copyLog} disabled={busy || !events.length} className="px-2.5 py-1.5 text-body rounded-lg glass-control text-[--ui-text-secondary] hover:text-[--ui-text-primary] disabled:opacity-40" title="Copy the full log to clipboard">Copy log</button>
            <button onClick={saveLog} disabled={busy || !events.length} className="px-2.5 py-1.5 text-body rounded-lg bg-[--accent] text-white hover:opacity-90 disabled:opacity-40" title="Save the full log to a file">Export</button>
            <button onClick={onClose} className="ml-1 p-1.5 text-[--ui-text-muted] hover:text-[--ui-text-primary] rounded-lg" aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" /></svg>
            </button>
          </div>
        </div>

        {/* Body. For decisions we need a bounded (flex-1 min-h-0) column so the ledger
            scrolls inside a fixed-height modal; for the short briefing we let it be natural
            height so the modal sizes to its content and there's no empty void. The CSS zoom
            scales all body content (text + layout) for the Cmd +/- font control — applied
            here, not on the card, so the header chrome and popups stay at native size. */}
        <div className={view === 'decisions' ? 'flex-1 min-h-0 flex flex-col' : 'flex flex-col'} style={{ zoom: scale }}>
          {!loaded ? (
            <div className="text-center text-[--ui-text-dimmed] py-20 text-body">Loading…</div>
          ) : events.length === 0 && decisions.length === 0 ? (
            <div className="text-center text-[--ui-text-dimmed] py-20 px-8">
              <p className="text-body mb-1">No delegations recorded yet.</p>
              <p className="text-body">When Claude runs <span className="font-mono">qcdelegate</span> or logs a <span className="font-mono">qcdecide</span> decision in a pane, it lands here — what was delegated, what changed, and whether qwen could match what you kept.</p>
            </div>
          ) : view === 'briefing' ? (
            /* ============================ BRIEFING ============================ */
            // Natural height (modal sizes to it) but cap + scroll on short windows.
            <div className="overflow-y-auto px-14 py-12 max-h-[calc(90vh-58px)]">
              <div className="max-w-[1480px] w-full mx-auto">
                <div className="font-mono text-body tracking-[0.16em] uppercase text-[--ui-text-dimmed] mb-4">
                  Delegation · analyst view{enabled && capable ? ` · ${shortRoute(status!.route)}` : ''}{decisions.length ? ` · updated ${rel(decisions[0].ts)}` : ''}
                </div>

                <h3 className="font-mono text-display leading-[1.45] font-medium tracking-tight text-[--ui-text-primary]">
                  <Verdict />
                </h3>
                <div className="text-body text-[--ui-text-dimmed] mt-3">
                  Based on {decisions.length} decision{decisions.length === 1 ? '' : 's'} · {delegateN} delegated · {shadowTestedN} shadow-tested{issueCount ? <> · <button onClick={() => goAllDecisions('issues')} className="text-[--danger]/90 hover:underline">{issueCount} issue{issueCount === 1 ? '' : 's'}</button></> : ''}
                </div>

                {/* demoted stat strip */}
                <div className="flex flex-wrap items-stretch gap-2.5 mt-6">
                  {[
                    { k: 'Delegate rate', v: keptPct == null ? '—' : pct(1 - keptPct), s: `${delegateN}/${decisions.length} units` },
                    { k: 'Worked', v: pct(checkRate), s: `${totals.checkPass}/${totals.checked} checked`, tone: checkRate == null ? '' : checkRate >= 0.8 ? 'good' : checkRate >= 0.5 ? 'warn' : 'bad' },
                    { k: 'Eval trust', v: trust == null ? '—' : `${trust}%`, s: judged ? `${judged} judged` : 'mark outcomes' },
                    { k: 'Avg time', v: `${totals.n ? Math.round(totals.dur / totals.n) : 0}s`, s: 'per call' },
                  ].map((m) => (
                    <div key={m.k} className="glass-control rounded-xl px-4 py-2.5 min-w-[130px] flex-1">
                      <div className={`text-display font-semibold tabular-nums tracking-tight ${m.tone === 'good' ? 'text-[--success]' : m.tone === 'warn' ? 'text-[--warning]' : m.tone === 'bad' ? 'text-[--danger]' : 'text-[--ui-text-primary]'}`}>{m.v}</div>
                      <div className="text-meta uppercase tracking-wide text-[--ui-text-muted] mt-0.5">{m.k}</div>
                      <div className="text-meta text-[--ui-text-dimmed]">{m.s}</div>
                    </div>
                  ))}
                </div>

                {/* evidence — per class */}
                {evidence.length > 0 && (
                  <div className="mt-8">
                    <div className="font-mono text-body tracking-[0.14em] uppercase text-[--ui-text-dimmed] flex items-center gap-3 mb-3">
                      evidence — by task class
                      <span className="h-px flex-1 bg-[--border]" />
                      <span className="normal-case tracking-normal text-[--ui-text-dimmed] cursor-help" title={"Per task class (every delegation/shadow is auto-classified by its files):\n• Shadow X/Y — of kept units you re-tested with qcshadow, how many qwen could have matched.\n• Pass-rate — of delegations that ran a ground-truth check, how many passed.\nThe recommendation blends both: a class where qwen matches your kept work is one to delegate more; a class where it falls short is one to keep."}>ⓘ</span>
                    </div>
                    <div className="space-y-px">
                      {evidence.map((c) => {
                        const hasShadow = c.tested > 0
                        const over = hasShadow && c.matched > 0
                        const rec = over ? '→ try delegating these' : hasShadow ? '→ keep (qwen fell short)' : c.recommendation ? `→ ${c.recommendation.toLowerCase()}` : '→ no signal yet'
                        const recColor = over ? 'text-[--success]' : hasShadow ? 'text-[--ui-text-muted]' : c.tone === 'good' ? 'text-[--success]' : c.tone === 'bad' ? 'text-[--ui-text-muted]' : 'text-[--ui-text-dimmed]'
                        return (
                          <div key={c.taskClass} className="grid grid-cols-[160px_260px_1fr] gap-6 items-center py-3 border-b border-white/[0.05]">
                            <span className="text-title font-medium capitalize text-[--ui-text-primary]">{c.taskClass}</span>
                            <span className="font-mono text-body text-[--ui-text-dimmed]">
                              {hasShadow
                                ? <>shadow <span className="text-[--success]">{c.matched}</span>/{c.tested} matched</>
                                : c.passRate != null ? <>{pct(c.passRate)} pass · n={c.n}</> : <>n={c.n} · no check</>}
                            </span>
                            <span className={`text-heading ${recColor}`}>{rec}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* over-cautious callout (only when shadow proves it) */}
                {shadow && shadow.matched > 0 && (
                  <button onClick={() => goAllDecisions('shadow')} className="mt-6 w-full text-left rounded-xl border border-[--warning-line] bg-[--warning-soft] px-4 py-3 hover:bg-[--warning-soft] transition-colors">
                    <div className="text-heading text-[--warning]">
                      <span className="font-semibold">{shadow.matched} kept unit{shadow.matched === 1 ? '' : 's'}</span> could have been delegated — qwen matched {shadow.matched === 1 ? 'it' : 'them'} on the same check.
                    </div>
                    <div className="text-body text-[--warning]/70 mt-0.5">Review the shadow-tested decisions →</div>
                  </button>
                )}

                <div className="mt-8 flex items-center gap-4 text-heading">
                  <button onClick={() => goAllDecisions('all')} className="text-[--accent] hover:underline font-medium">See all {decisions.length} decisions →</button>
                  <span className="text-[--ui-text-dimmed]">{totals.ins.toLocaleString()} lines · {totals.files} files touched{insights ? ` · ${insights.totalOutcomes} in eval memory` : ''}</span>
                </div>
              </div>
            </div>
          ) : (
            /* ========================= ALL DECISIONS ========================= */
            <div className="flex-1 min-h-0 flex flex-col px-6 py-4">
              <div className="flex items-baseline gap-3 shrink-0">
                <button onClick={() => setView('briefing')} className="text-body text-[--accent] hover:underline">‹ briefing</button>
                <h3 className="font-mono text-title font-medium tracking-tight text-[--ui-text-primary]">All decisions</h3>
                <span className="text-body text-[--ui-text-dimmed]">{decisions.length} decisions · {delegateN} delegated · {shadowTestedN} shadow-tested</span>
              </div>

              {/* filter chips */}
              <div className="flex items-center gap-1.5 mt-3 mb-3 shrink-0 flex-wrap">
                {([['all', 'All'], ['kept', 'Kept'], ['delegated', 'Delegated'], ['shadow', 'Shadow-tested'], ['issues', 'Issues']] as const).map(([f, label]) => (
                  <button key={f} onClick={() => setDecFilter(f)}
                    className={`font-mono text-body px-2.5 py-1 rounded-full border transition-all ${decFilter === f ? 'border-[--accent]/50 bg-[--accent]/10 text-[--ui-text-primary]' : 'glass-border text-[--ui-text-dimmed] hover:text-[--ui-text-secondary]'} ${f === 'issues' && filterCounts.issues > 0 ? 'text-[--danger]/90' : ''}`}>
                    {label} <span className="text-[--ui-text-dimmed]">{filterCounts[f]}</span>
                  </button>
                ))}
                <div className="ml-auto flex items-center gap-3">
                  {confirmClear ? (
                    <span className="flex items-center gap-2 text-body">
                      <span className="text-[--ui-text-dimmed]">Clear all telemetry?</span>
                      <button onClick={clearAll} className="text-[--danger] hover:underline">Yes</button>
                      <button onClick={() => setConfirmClear(false)} className="text-[--ui-text-muted] hover:underline">No</button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmClear(true)} className="text-body text-[--ui-text-muted] hover:text-[--danger]">Clear telemetry</button>
                  )}
                </div>
              </div>

              <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[210px_1fr] gap-5 overflow-hidden">
                {/* projects rail */}
                <div className="min-h-0 min-w-0 hidden lg:flex flex-col border-r glass-border pr-4">
                  <div className="font-mono text-meta tracking-[0.14em] uppercase text-[--ui-text-dimmed] mb-2 shrink-0">Projects</div>
                  <div className="flex-1 min-h-0 overflow-y-auto space-y-0.5 pr-1">
                    <button onClick={() => setFilterProject(null)} className={`w-full text-left px-2.5 py-1.5 rounded-lg text-body transition-colors ${!filterProject ? 'bg-[--accent]/15 text-[--ui-text-primary]' : 'text-[--ui-text-dimmed] hover:bg-white/[0.04]'}`}>All projects</button>
                    {projectList.map((p) => {
                      const active = filterProject === p.project
                      return (
                        <button key={p.project} onClick={() => setFilterProject(active ? null : p.project)} title={p.project}
                          className={`w-full text-left px-2.5 py-1.5 rounded-lg transition-colors ${active ? 'bg-[--accent]/15' : 'hover:bg-white/[0.04]'}`}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-heading text-[--ui-text-primary] font-medium truncate">{p.name}</span>
                            <span className="text-meta text-[--ui-text-dimmed] shrink-0">{p.lastAt ? rel(new Date(p.lastAt).toISOString()) : ''}</span>
                          </div>
                          <div className="text-body text-[--ui-text-dimmed] mt-0.5">{p.decisions} decision{p.decisions === 1 ? '' : 's'}{p.delegated > 0 ? ` · ${p.delegated} delegated` : ''}</div>
                          {p.overCautious > 0 && <span className="inline-block mt-1 text-meta text-[--warning] border border-[--warning-line] rounded px-1.5 py-px">{p.overCautious} over-cautious</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* ledger */}
                <div className="min-h-0 min-w-0 overflow-y-auto pr-1">
                  {shownRows.length === 0 && (
                    <div className="text-body text-[--ui-text-dimmed] py-10 text-center">
                      {decFilter === 'issues' ? 'No issues — every delegation here succeeded ✓' : decFilter === 'shadow' ? 'No shadow-tested decisions yet. Run qcshadow on a kept unit to grade it.' : 'Nothing for this filter.'}
                    </div>
                  )}
                  {shownRows.slice(0, 200).map((r) => {
                    const open = expanded === r.key
                    const d = r.kind === 'decision' ? r.decision : null
                    const call: DelegationEvent | null = r.kind === 'decision' ? r.call : r.call
                    const isDelegate = r.kind === 'call' || (d != null && d.verdict === 'delegate')
                    const title = r.kind === 'decision' ? r.decision.group : (r.call.task === 'untagged' ? 'untagged delegation' : r.call.task)
                    const expandable = !!call || (d != null && d.verdict === 'delegate')
                    return (
                      <div key={r.key} className="border-b border-white/[0.05]">
                        <div className={`grid grid-cols-[48px_70px_1fr] gap-3.5 py-3 ${expandable ? 'cursor-pointer' : ''}`} onClick={() => expandable && setExpanded(open ? null : r.key)}>
                          <span className="font-mono text-body text-[--ui-text-dimmed] pt-0.5" title={new Date(r.ts).toLocaleString()}>{rel(r.ts)}</span>
                          <span className={`self-start font-mono text-meta tracking-wide px-2 py-0.5 rounded text-center ${isDelegate ? 'bg-[--accent-soft] text-[--accent] border border-[--accent-line]' : 'bg-white/[0.06] text-[--ui-text-muted] border border-white/10'}`}>{isDelegate ? 'DELEGATE' : 'KEEP'}</span>
                          <div className="min-w-0">
                            <div className="text-body text-[--ui-text-primary] font-medium tracking-tight">{title}</div>
                            {d && d.reason && <div className="text-heading text-[--text-2] leading-relaxed mt-1 max-w-[1100px]">{d.reason}</div>}
                            {/* delegate metadata line */}
                            {call && (
                              <div className="flex flex-wrap gap-x-3.5 gap-y-1 mt-2 font-mono text-body text-[--ui-text-dimmed]">
                                <span>{shortRoute(call.route)}</span>
                                <span>{call.durationSec}s</span>
                                <span><span className="text-[--success]/80">+{call.insertions}</span>/<span className="text-[--danger]/80">-{call.deletions}</span></span>
                                {call.check
                                  ? <span className={call.check.exit === 0 ? 'text-[--success]' : 'text-[--danger]'}>{call.check.exit === 0 ? '✓ check passed' : '✕ check failed'}</span>
                                  : call.exit !== 0 ? <span className="text-[--danger]">exit {call.exit}</span> : null}
                                {call.humanVerdict && <span className="text-[--ui-text-secondary]">eval: {call.humanVerdict}</span>}
                              </div>
                            )}
                            {d && d.verdict === 'delegate' && !call && <div className="mt-1.5 text-body text-[--ui-text-dimmed]">Call not linked yet — ran outside a pane or hasn't completed.</div>}
                            {/* shadow verdict band on a KEEP */}
                            {d && d.shadow && <ShadowBand s={d.shadow} />}
                          </div>
                        </div>
                        {open && call && <CallDetail e={call} />}
                        {open && !call && d && (
                          <div className="px-4 pb-4 pt-0 text-body text-[--ui-text-dimmed] space-y-1">
                            <div>when: {new Date(d.ts).toLocaleString()} · project: <span className="text-[--ui-text-secondary]">{d.project}</span>{d.pane ? ` · pane: ${d.pane}` : ''}</div>
                            {d.check && <div>gate: <span className="font-mono text-[--ui-text-secondary]">{d.check}</span></div>}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {toast && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-2 rounded-lg bg-[--ui-bg-elevated] border border-[--border] text-body text-[--ui-text-primary] shadow-lg max-w-[80%] truncate">{toast}</div>
        )}

        {/* Full-prompt popup */}
        {fullPrompt && (
          <div className="absolute inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6" role="presentation" onClick={(e) => e.target === e.currentTarget && setFullPrompt(null)}>
            <div className="glass-modal glass-border rounded-xl shadow-2xl w-[80vw] max-w-[1100px] max-h-[85vh] flex flex-col overflow-hidden" role="dialog" aria-modal="true">
              <div className="flex items-center justify-between gap-3 px-4 py-3 border-b glass-border shrink-0">
                <span className="text-body font-medium text-[--ui-text-primary] truncate">Full prompt · <span className="font-mono text-[--ui-text-secondary]">{fullPrompt.title}</span></span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-meta text-[--ui-text-dimmed] mr-1">{fullPrompt.text.length.toLocaleString()} chars</span>
                  <button onClick={() => { window.electronAPI.clipboardWriteText(fullPrompt.text); flash('Prompt copied') }} className="px-2.5 py-1 text-body rounded-lg glass-control text-[--ui-text-secondary] hover:text-[--ui-text-primary]">Copy</button>
                  <button onClick={() => setFullPrompt(null)} className="p-1.5 text-[--ui-text-muted] hover:text-[--ui-text-primary] rounded-lg" aria-label="Close">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" /></svg>
                  </button>
                </div>
              </div>
              <pre className="flex-1 min-h-0 overflow-auto p-4 whitespace-pre-wrap font-mono text-body leading-relaxed text-[--ui-text-secondary]">{fullPrompt.text}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
