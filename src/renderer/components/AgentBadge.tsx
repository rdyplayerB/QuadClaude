import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspaceStore } from '../store/workspace'
import { launchAgent, resolvePaneProfile, sendToTerminal } from './TerminalPane'
import { ClaudeAccount } from '../../shared/types'

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
  const updatePane = useWorkspaceStore((s) => s.updatePane)
  const pairPanes = useWorkspaceStore((s) => s.pairPanes)
  const unpairPane = useWorkspaceStore((s) => s.unpairPane)
  const swapPairRoles = useWorkspaceStore((s) => s.swapPairRoles)

  // Snapshot of pairing candidates, captured when entering "pair with" mode so
  // this badge doesn't have to subscribe to the whole panes array.
  const [pairMode, setPairMode] = useState(false)
  const [pairTargets, setPairTargets] = useState<Array<{ id: number; label: string }>>([])

  // Saved Claude accounts (per-pane multi-account). Loaded lazily when the menu opens; the
  // list only changes via Settings, which the user would have closed before reaching here.
  const [accounts, setAccounts] = useState<ClaudeAccount[]>([])
  useEffect(() => {
    if (!open) return
    window.electronAPI.claudeAccountsList().then(setAccounts).catch(() => {})
  }, [open])

  // Bind this pane to a Claude account (or back to the global login) and respawn so the new
  // account's token takes effect. Only re-launches Claude if Claude was the running agent.
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

  // Launch an agent in this pane, optionally as a specific Claude account. One unified
  // action: a Claude row carries an accountId (or undefined for the global login); a
  // non-Claude agent always passes undefined. Sets both the agent and the account
  // atomically, then respawns so the right token takes effect.
  const launchAs = useCallback(
    (profileId: string, accountId: string | undefined) => {
      if (!pane) return
      updatePane(paneId, { agentId: profileId, claudeAccountId: accountId })
      const profile = (agentProfiles ?? []).find((p) => p.id === profileId)
      if (profile) launchAgent(paneId, profile, pane.workingDirectory)
      setOpen(false)
    },
    [pane, paneId, agentProfiles, updatePane],
  )

  const enterPairMode = useCallback(() => {
    const others = useWorkspaceStore.getState().panes.filter((p) => p.id !== paneId)
    setPairTargets(others.map((p) => ({ id: p.id, label: p.label })))
    setPairMode(true)
  }, [paneId])

  const doPair = useCallback(
    (workerId: number) => {
      pairPanes(paneId, workerId) // this pane is the orchestrator
      // Make the pairing functional: stream the live delegation feed into the worker
      // pane so the worker's output actually shows up there (which is what people
      // expect). Only when it's an idle shell — never type into a running agent.
      const w = useWorkspaceStore.getState().panes.find((p) => p.id === workerId)
      if (w && w.state === 'shell') {
        sendToTerminal(
          workerId,
          'clear; mkdir -p ~/.quadclaude && touch ~/.quadclaude/delegation.log && tail -F ~/.quadclaude/delegation.log\n',
        )
      }
      setPairMode(false)
      setOpen(false)
    },
    [paneId, pairPanes],
  )

  const closeMenu = useCallback(() => {
    setOpen(false)
    setPairMode(false)
  }, [])

  const MENU_W = 230
  const getPosition = () => {
    if (!buttonRef.current) return { top: 0, left: 0 }
    const rect = buttonRef.current.getBoundingClientRect()
    // Right-align under the badge, but clamp into the viewport so a pane near either edge
    // (common with 4–5 panes) never pushes the menu off-screen.
    const left = Math.min(Math.max(8, rect.right - MENU_W), window.innerWidth - MENU_W - 8)
    return { top: rect.bottom + 4, left }
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
        <span className="pane-ctl-label text-meta leading-none max-w-[110px] truncate">
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
          className="fixed z-50 w-[230px] bg-[--ui-bg-elevated] border border-[--border] rounded-md shadow-lg overflow-hidden"
          style={getPosition()}
        >
          <div className="px-3 py-1.5 text-meta uppercase tracking-wide text-[--ui-text-muted]">
            Launch
          </div>
          <div className="max-h-[300px] overflow-y-auto">
            {profiles.flatMap((p) => {
              const isClaude = p.builtin === 'claude'
              // A small row: agent + (for Claude) which account it runs as. Account is shown
              // as a dimmed identity beside "Claude Code" so the menu reads as one list of
              // launchable identities — "Claude Code as boshiro.one" — not two parallel lists.
              const Row = (key: string, accountId: string | undefined, suffix: string | null, current: boolean, disabled: boolean, title: string) => (
                <button
                  key={key}
                  onClick={() => !disabled && launchAs(p.id, accountId)}
                  disabled={disabled}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-body text-left hover:bg-[--ui-bg-active]/50 transition-colors disabled:opacity-40"
                  title={title}
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: current ? 'var(--git-green)' : 'var(--ui-text-dimmed)' }} />
                  <span className="shrink-0 text-[--ui-text-primary]">{p.name}</span>
                  {suffix && <span className="truncate text-[--ui-text-dimmed]">· {suffix}</span>}
                </button>
              )
              // Non-Claude agent, or Claude with no saved accounts → a single plain row.
              if (!isClaude || accounts.length === 0) {
                return [Row(p.id, undefined, null, p.id === paneProfile.id, false, p.command)]
              }
              // Claude with accounts → "global login" row + one row per account, all launching Claude.
              const claudeCurrent = p.id === paneProfile.id
              const rows = [
                Row(`${p.id}:global`, undefined, 'global login', claudeCurrent && !pane.claudeAccountId, false, 'Run Claude Code as the globally signed-in account (claude /login)'),
              ]
              for (const a of accounts) {
                rows.push(Row(
                  `${p.id}:${a.id}`, a.id, a.label,
                  claudeCurrent && pane.claudeAccountId === a.id,
                  !a.hasToken,
                  a.hasToken ? `Run Claude Code as ${a.email || a.label}` : `${a.label} — no token yet (add it in Settings → Accounts)`,
                ))
              }
              return rows
            })}
          </div>

          {/* Pairing */}
          <div className="border-t border-[--border]" />
          {pane.pairId ? (
            <div className="py-1">
              <div className="px-3 py-1 text-meta uppercase tracking-wide text-[--ui-text-muted]">
                Paired · {pane.pairRole}
              </div>
              <button
                onClick={() => {
                  swapPairRoles(paneId)
                }}
                className="w-full px-3 py-1.5 text-body text-left hover:bg-[--ui-bg-active]/50 text-[--ui-text-primary]"
              >
                Swap roles
              </button>
              <button
                onClick={() => {
                  unpairPane(paneId)
                  closeMenu()
                }}
                className="w-full px-3 py-1.5 text-body text-left hover:bg-[--ui-bg-active]/50 text-[--ui-text-primary]"
              >
                Unpair
              </button>
            </div>
          ) : pairMode ? (
            <div className="py-1 max-h-[160px] overflow-y-auto">
              <div className="px-3 py-1 text-meta uppercase tracking-wide text-[--ui-text-muted]">
                Pair as orchestrator with…
              </div>
              {pairTargets.length === 0 ? (
                <div className="px-3 py-1.5 text-body text-[--ui-text-dimmed]">No other panes</div>
              ) : (
                pairTargets.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => doPair(t.id)}
                    className="w-full px-3 py-1.5 text-body text-left hover:bg-[--ui-bg-active]/50 text-[--ui-text-primary] truncate"
                  >
                    {t.label}
                  </button>
                ))
              )}
            </div>
          ) : (
            <button
              onClick={enterPairMode}
              className="w-full px-3 py-1.5 text-body text-left hover:bg-[--ui-bg-active]/50 text-[--ui-text-primary] flex items-center gap-2"
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
