import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { PaneConfig, PaneDigest, RecentProject, MAX_PANES, SIDEBAR_W_MIN, SIDEBAR_W_MAX } from '../../shared/types'
import { PANE_COLORS, getFolderName } from './PaneHeader'
import { focusTerminal, launchAgent, resolvePaneProfile } from './TerminalPane'
import { splitServers } from '../util/ports'
import { classifyPane, since, Bucket } from '../util/paneTriage'

// The pane list. With nine or more windows open, the grid stops answering two
// questions: which one is this, and what was it doing? The headers can only ever
// show the first, and only while you scan them.
//
// So this is a TRIAGE list, not an inventory: panes are grouped by whether they
// need you, and a pane that needs you is pinned to the top of the list no matter
// where it sits in the grid. Each row carries the session's own title, which is
// the thing you actually remember a window by ("the Burner Pay help center one"),
// not its folder name.

const POLL_MS = 3000       // digests are read only while this is open
const CTX_POLL_MS = 5000   // context% moves slowly; no reason to ask as often

interface Row {
  pane: PaneConfig
  digest?: PaneDigest
  ctx?: { contextPct: number; model: string }
  bucket: Bucket
  reason?: string // why it's in NEEDS YOU — shown instead of elapsed
}

const SECTIONS: Array<{ key: Bucket; label: string }> = [
  { key: 'needs', label: 'needs you' },
  { key: 'working', label: 'working' },
  { key: 'idle', label: 'idle' },
]

export const Sidebar = memo(function Sidebar() {
  const panes = useWorkspaceStore((s) => s.panes)
  const activePaneId = useWorkspaceStore((s) => s.activePaneId)
  const width = useWorkspaceStore((s) => s.sidebarWidth)
  const setSidebarWidth = useWorkspaceStore((s) => s.setSidebarWidth)
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar)

  const [digests, setDigests] = useState<Record<number, PaneDigest>>({})
  const [ctx, setCtx] = useState<Record<number, { contextPct: number; model: string }>>({})
  const [recents, setRecents] = useState<RecentProject[]>([])
  const [showRecents, setShowRecents] = useState(false)
  // Re-render on a timer so the elapsed times tick without any data changing.
  const [, setTick] = useState(0)

  // Poll only while mounted. The sidebar is unmounted when closed, so a closed
  // sidebar costs exactly nothing — which is the whole reason the digest is read
  // on demand instead of kept warm in the background.
  useEffect(() => {
    let alive = true
    const read = async () => {
      const list = useWorkspaceStore.getState().panes.map((p) => ({ id: p.id, cwd: p.workingDirectory }))
      try {
        const d = await window.electronAPI.sidebarDigests(list)
        if (alive) setDigests(d || {})
      } catch { /* a failed read just leaves the last good rows */ }
    }
    read()
    const t = setInterval(read, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [])

  useEffect(() => {
    let alive = true
    const read = async () => {
      const list = useWorkspaceStore.getState().panes
      const next: Record<number, { contextPct: number; model: string }> = {}
      for (const p of list) {
        try {
          const u = await window.electronAPI.getContextUsage(p.id)
          if (u) next[p.id] = { contextPct: u.contextPct, model: u.model }
        } catch { /* pane without a Claude session has no context */ }
      }
      if (alive) setCtx(next)
    }
    read()
    const t = setInterval(read, CTX_POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [])

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!showRecents || recents.length) return
    window.electronAPI.sidebarRecents(30).then(setRecents).catch(() => {})
  }, [showRecents, recents.length])

  const rows = useMemo<Row[]>(() => panes.map((pane) => {
    const digest = digests[pane.id]
    const { bucket, reason } = classifyPane(pane, digest)
    return { pane, digest, ctx: ctx[pane.id], bucket, reason }
  }), [panes, digests, ctx])

  const grouped = useMemo(() => {
    const g: Record<Bucket, Row[]> = { needs: [], working: [], idle: [] }
    for (const r of rows) g[r.bucket].push(r)
    // Inside a section, keep grid order — the list only reorders across sections,
    // so a pane never jumps around for reasons you can't see.
    return g
  }, [rows])

  // Click focuses in place; double-click blows the pane up to Solo. Kept apart by
  // a timer rather than onDoubleClick alone so the single click still feels instant.
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const focusPane = useCallback((id: number) => {
    useWorkspaceStore.getState().setActivePaneId(id)
    focusTerminal(id)
  }, [])
  const soloPane = useCallback((id: number) => {
    const store = useWorkspaceStore.getState()
    store.setFocusPaneId(id)
    store.setLayout('solo')
    store.setActivePaneId(id)
    focusTerminal(id)
  }, [])
  const onRowClick = useCallback((id: number) => {
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; soloPane(id); return }
    clickTimer.current = setTimeout(() => { clickTimer.current = null; focusPane(id) }, 220)
  }, [focusPane, soloPane])

  // Recents open into a spare shell pane, or a new one if there's room. Never
  // over a pane that's doing something.
  const openRecent = useCallback(async (r: RecentProject) => {
    const store = useWorkspaceStore.getState()
    let target = store.panes.find((p) => p.state === 'shell' && (!p.servers || p.servers.length === 0))?.id
    if (target === undefined && store.panes.length < MAX_PANES) target = store.addPane() ?? undefined
    if (target === undefined) return
    const pane = useWorkspaceStore.getState().panes.find((p) => p.id === target)
    await launchAgent(target, resolvePaneProfile(pane, store.preferences), r.path, r.path)
    useWorkspaceStore.getState().setActivePaneId(target)
    focusTerminal(target)
  }, [])

  // Drag the inner edge to resize. Width is workspace state, so it survives.
  const dragging = useRef(false)
  useEffect(() => {
    const move = (e: MouseEvent) => { if (dragging.current) setSidebarWidth(e.clientX) }
    const up = () => { dragging.current = false }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [setSidebarWidth])

  const needsCount = grouped.needs.length

  // The app window is transparent, so chrome that does not paint its own ground
  // composites straight onto the DESKTOP. This panel first shipped with
  // `bg-[--ui-bg-elevated]/40`, and Tailwind cannot apply an alpha modifier to a
  // bare CSS-variable arbitrary value — the class generated no rule at all, the
  // panel was fully see-through, and near-white primary text landed on whatever
  // window happened to be behind QuadClaude and vanished. The gray secondary
  // lines survived, which is what made it look like a color bug rather than a
  // missing background. Backgrounds here are therefore either inline styles or
  // Tailwind palette colors (bg-white/[0.06]), both of which always compile;
  // token + alpha does not.
  return (
    <div
      className="relative shrink-0 h-full flex flex-col border-r border-[--border] overflow-hidden"
      style={{ width, background: 'var(--glass-bg-header)' }}
    >
      <div className="flex items-center justify-between px-3 h-8 shrink-0 border-b border-[--border]">
        <span className="text-meta tracking-wider text-[--ui-text-muted] uppercase">
          windows <span className="text-[--ui-text-faint]">{panes.length}</span>
          {needsCount > 0 && <span className="ml-2 text-[--git-orange]">{needsCount} need you</span>}
        </span>
        <button
          onClick={toggleSidebar}
          className="text-[--ui-text-faint] hover:text-[--ui-text-primary] transition-colors text-meta"
          title="Hide the pane list (⌘\)"
        >
          ⌫
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {SECTIONS.map(({ key, label }) => {
          const list = grouped[key]
          if (!list.length) return null
          return (
            <div key={key}>
              <div className="sticky top-0 z-10 flex items-center justify-between px-3 py-1 backdrop-blur text-meta uppercase tracking-wider text-[--ui-text-faint]"
                style={{ background: 'var(--surface-4)' }}>
                <span className={key === 'needs' ? 'text-[--git-orange]' : ''}>{label}</span>
                <span>{list.length}</span>
              </div>
              {list.map(({ pane, digest, ctx: usage, reason }) => {
                const idx = panes.findIndex((p) => p.id === pane.id)
                const color = PANE_COLORS[idx % PANE_COLORS.length]
                const isActive = pane.id === activePaneId
                const { primary } = splitServers(pane.servers ?? [])
                const branch = pane.gitStatus?.branch
                // The title is what you remember the window by; when Claude
                // hasn't named the session yet, what it's doing is the next best
                // thing, and a bare shell gets neither.
                const line2 = digest?.title || digest?.lastAction || (pane.state === 'shell' ? 'shell' : '—')
                const meta = [
                  branch ? '⎇ ' + branch : null,
                  usage?.model || null,
                  usage ? usage.contextPct + '%' : null,
                  primary ? ':' + primary.port : null,
                ].filter(Boolean).join(' · ')
                return (
                  <button
                    key={pane.id}
                    onClick={() => onRowClick(pane.id)}
                    className={`w-full text-left px-3 py-1.5 border-l-2 transition-colors ${
                      isActive ? 'bg-white/[0.10]' : 'hover:bg-white/[0.06]'
                    }`}
                    style={{ borderLeftColor: isActive ? color : 'transparent' }}
                    title={`${pane.workingDirectory}\nclick to focus · double-click to solo`}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                      <span className="truncate text-body text-[--ui-text-primary]">{getFolderName(pane.workingDirectory)}</span>
                      <span className={`ml-auto shrink-0 text-meta ${reason ? 'text-[--git-orange]' : 'text-[--ui-text-faint]'}`}>
                        {reason || since(pane.stateSince)}
                      </span>
                    </div>
                    <div className="truncate text-meta text-[--ui-text-secondary] pl-3">{line2}</div>
                    {meta && <div className="truncate text-meta text-[--ui-text-faint] pl-3">{meta}</div>}
                  </button>
                )
              })}
            </div>
          )
        })}

        <div className="border-t border-[--border] mt-1">
          <button
            onClick={() => setShowRecents((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-1 text-meta uppercase tracking-wider text-[--ui-text-faint] hover:text-[--ui-text-secondary] hover:bg-white/[0.04] transition-colors"
            title="Projects Claude has worked in, newest first"
          >
            <span>recent projects</span><span>{showRecents ? '▾' : '▸'}</span>
          </button>
          {showRecents && recents.map((r) => (
            <button
              key={r.path}
              onClick={() => openRecent(r)}
              className="w-full text-left px-3 py-1 hover:bg-white/[0.06] transition-colors"
              title={`${r.path}\nopens in a free pane`}
            >
              <div className="truncate text-meta text-[--ui-text-secondary]">{r.name}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Resize handle on the inner edge */}
      <div
        onMouseDown={() => { dragging.current = true }}
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-white/25"
        title={`Drag to resize (${SIDEBAR_W_MIN}–${SIDEBAR_W_MAX}px)`}
      />
    </div>
  )
})
