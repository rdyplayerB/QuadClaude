import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspaceStore } from '../store/workspace'
import { launchAgent, resolvePaneProfile } from './TerminalPane'

interface AgentBadgeProps {
  paneId: number
}

// The always-visible model identity for a pane. Doubles as the launcher:
// the label shows which agent the pane runs (Claude / Qwen / Codex / ...),
// clicking it launches that agent, and the caret switches the assigned agent.
export const AgentBadge = memo(function AgentBadge({ paneId }: AgentBadgeProps) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const pane = useWorkspaceStore((s) => s.panes.find((p) => p.id === paneId))
  const agentProfiles = useWorkspaceStore((s) => s.preferences.agentProfiles)
  const defaultAgentId = useWorkspaceStore((s) => s.preferences.defaultAgentId)
  const setPaneAgent = useWorkspaceStore((s) => s.setPaneAgent)
  const pairPanes = useWorkspaceStore((s) => s.pairPanes)
  const unpairPane = useWorkspaceStore((s) => s.unpairPane)
  const swapPairRoles = useWorkspaceStore((s) => s.swapPairRoles)

  // Snapshot of pairing candidates, captured when entering "pair with" mode so
  // this badge doesn't have to subscribe to the whole panes array.
  const [pairMode, setPairMode] = useState(false)
  const [pairTargets, setPairTargets] = useState<Array<{ id: number; label: string }>>([])

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
        setPairMode(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const profiles = agentProfiles ?? []
  const paneProfile = resolvePaneProfile(pane, { agentProfiles, defaultAgentId })
  // Running detection only exists for Claude (main-process process grep); other
  // agents stay in 'shell' state, so the badge just shows their identity.
  const claudeRunning =
    paneProfile.builtin === 'claude' &&
    (pane?.state === 'claude-active' || pane?.state === 'claude-waiting')

  const launch = useCallback(() => {
    if (!pane) return
    launchAgent(paneId, paneProfile, pane.workingDirectory)
  }, [pane, paneId, paneProfile])

  const pick = useCallback(
    (id: string) => {
      if (!pane) return
      setPaneAgent(paneId, id)
      const profile = (agentProfiles ?? []).find((p) => p.id === id)
      if (profile) launchAgent(paneId, profile, pane.workingDirectory)
      setOpen(false)
    },
    [pane, paneId, agentProfiles, setPaneAgent],
  )

  const enterPairMode = useCallback(() => {
    const others = useWorkspaceStore.getState().panes.filter((p) => p.id !== paneId)
    setPairTargets(others.map((p) => ({ id: p.id, label: p.label })))
    setPairMode(true)
  }, [paneId])

  const doPair = useCallback(
    (workerId: number) => {
      pairPanes(paneId, workerId) // this pane is the orchestrator
      setPairMode(false)
      setOpen(false)
    },
    [paneId, pairPanes],
  )

  const closeMenu = useCallback(() => {
    setOpen(false)
    setPairMode(false)
  }, [])

  const getPosition = () => {
    if (!buttonRef.current) return { top: 0, left: 0 }
    const rect = buttonRef.current.getBoundingClientRect()
    return { top: rect.bottom + 4, left: rect.right - 200 }
  }

  if (!pane) return null

  return (
    <div className="flex items-center rounded hover:bg-[--ui-bg-active]/40 transition-colors">
      {/* Launch / identity */}
      <button
        onClick={launch}
        disabled={claudeRunning}
        className={`flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded-l transition-colors ${
          claudeRunning
            ? 'opacity-50 cursor-default text-[--ui-text-dimmed]'
            : 'text-[--ui-text-dimmed] hover:text-[--ui-text-primary]'
        }`}
        title={
          claudeRunning
            ? `${paneProfile.name} is running in this pane`
            : `Launch ${paneProfile.name}`
        }
      >
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${claudeRunning ? 'animate-pulse' : ''}`}
          style={{ backgroundColor: claudeRunning ? 'var(--git-green)' : 'var(--ui-text-dimmed)' }}
        />
        <span className="text-[10px] leading-none max-w-[110px] truncate">
          {claudeRunning ? 'Running' : paneProfile.name}
        </span>
      </button>
      {/* Switch agent */}
      <button
        ref={buttonRef}
        onClick={() => (open ? closeMenu() : setOpen(true))}
        className="px-0.5 py-0.5 rounded-r text-[--ui-text-dimmed] hover:text-[--ui-text-primary] transition-colors"
        title="Switch agent"
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 3.5L5 6.5L8 3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          className="fixed z-50 w-[200px] bg-[--ui-bg-elevated] border border-[#444] rounded-md shadow-lg overflow-hidden"
          style={getPosition()}
        >
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-[--ui-text-muted]">
            Launch agent
          </div>
          <div className="max-h-[240px] overflow-y-auto">
            {profiles.map((p) => {
              const isCurrent = p.id === paneProfile.id
              return (
                <button
                  key={p.id}
                  onClick={() => pick(p.id)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-[--ui-bg-active]/50 transition-colors"
                  title={p.command}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: isCurrent ? 'var(--git-green)' : 'var(--ui-text-dimmed)' }}
                  />
                  <span className="truncate flex-1 text-[--ui-text-primary]">{p.name}</span>
                  {isCurrent && <span className="text-[9px] text-[--ui-text-muted]">current</span>}
                </button>
              )
            })}
          </div>

          {/* Pairing */}
          <div className="border-t border-[#444]" />
          {pane.pairId ? (
            <div className="py-1">
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[--ui-text-muted]">
                Paired · {pane.pairRole}
              </div>
              <button
                onClick={() => {
                  swapPairRoles(paneId)
                }}
                className="w-full px-3 py-1.5 text-xs text-left hover:bg-[--ui-bg-active]/50 text-[--ui-text-primary]"
              >
                Swap roles
              </button>
              <button
                onClick={() => {
                  unpairPane(paneId)
                  closeMenu()
                }}
                className="w-full px-3 py-1.5 text-xs text-left hover:bg-[--ui-bg-active]/50 text-[--ui-text-primary]"
              >
                Unpair
              </button>
            </div>
          ) : pairMode ? (
            <div className="py-1 max-h-[160px] overflow-y-auto">
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[--ui-text-muted]">
                Pair as orchestrator with…
              </div>
              {pairTargets.length === 0 ? (
                <div className="px-3 py-1.5 text-xs text-[--ui-text-dimmed]">No other panes</div>
              ) : (
                pairTargets.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => doPair(t.id)}
                    className="w-full px-3 py-1.5 text-xs text-left hover:bg-[--ui-bg-active]/50 text-[--ui-text-primary] truncate"
                  >
                    {t.label}
                  </button>
                ))
              )}
            </div>
          ) : (
            <button
              onClick={enterPairMode}
              className="w-full px-3 py-1.5 text-xs text-left hover:bg-[--ui-bg-active]/50 text-[--ui-text-primary] flex items-center gap-2"
            >
              <span aria-hidden>🔗</span> Pair with…
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
})
