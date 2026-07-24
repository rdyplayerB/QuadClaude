import { memo, useCallback } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { sendToTerminal } from './TerminalPane'
import { PortalMenu, useAnchoredMenu } from './ui/PortalMenu'
import { folderName } from '../util/paths'

interface LiveFeedButtonProps {
  paneId: number
}

// The shell command that tails a feed into this pane. scope === undefined → the global
// delegation log (all sessions); a pane id → that orchestrator's per-session feed file
// (written by qcdelegate/qcdecide when QC_PANE matches), so multiple feeds can each track
// their own Claude session.
function feedCmd(scope?: number): string {
  if (scope === undefined) {
    return 'clear; mkdir -p ~/.quadclaude && touch ~/.quadclaude/delegation.log && tail -F ~/.quadclaude/delegation.log\n'
  }
  return `clear; mkdir -p ~/.quadclaude/feed && touch ~/.quadclaude/feed/${scope}.log && tail -F ~/.quadclaude/feed/${scope}.log\n`
}

// One-click live delegation feed for any idle pane. If other panes are running Claude,
// a small menu lets you scope the feed to one of them (or "All"); otherwise it opens the
// global feed in a single click. Hidden while THIS pane runs Claude, so we never type
// into a live session.
export const LiveFeedButton = memo(function LiveFeedButton({ paneId }: LiveFeedButtonProps) {
  const pane = useWorkspaceStore((s) => s.panes.find((p) => p.id === paneId))
  // Candidate orchestrators: other panes currently running a Claude session. Carry both
  // the project name (folder) and the "Terminal N" label so the menu shows both.
  const candidates = useWorkspaceStore((s) =>
    s.panes
      .filter((p) => p.id !== paneId && (p.state === 'claude-active' || p.state === 'claude-waiting'))
      .map((p) => ({ id: p.id, name: folderName(p.workingDirectory), term: p.label })),
  )
  const scopeLabel = useWorkspaceStore((s) => {
    if (pane?.liveFeedScope === undefined) return 'All'
    const o = s.panes.find((p) => p.id === pane.liveFeedScope)
    if (!o) return `Terminal ${(pane.liveFeedScope ?? 0) + 1}`
    return folderName(o.workingDirectory) || o.label
  })
  const setPaneLiveFeed = useWorkspaceStore((s) => s.setPaneLiveFeed)

  const menu = useAnchoredMenu({ width: 200 })

  const start = useCallback(
    (scope?: number) => {
      setPaneLiveFeed(paneId, true, scope)
      sendToTerminal(paneId, feedCmd(scope))
      menu.close()
    },
    [paneId, setPaneLiveFeed, menu],
  )

  const stop = useCallback(() => {
    sendToTerminal(paneId, '\x03') // Ctrl-C ends the `tail -F`
    setPaneLiveFeed(paneId, false)
  }, [paneId, setPaneLiveFeed])

  const onButton = useCallback(() => {
    // One-click global feed when there's nothing to scope to; otherwise open the picker.
    if (candidates.length === 0) start(undefined)
    else menu.toggle()
  }, [candidates.length, start, menu])

  if (!pane) return null

  // Active feed → badge with the current scope + a stop affordance.
  if (pane.liveFeed) {
    return (
      <button
        onClick={stop}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-meta leading-none shrink-0 text-[--git-cyan] bg-[--git-cyan]/10 hover:bg-[--git-cyan]/20 transition-colors"
        title={`Live delegation feed (${scopeLabel}) — click to stop`}
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <circle cx="7" cy="7" r="1.3" fill="currentColor" stroke="none" />
          <path d="M4.3 9.7a3.8 3.8 0 010-5.4M9.7 4.3a3.8 3.8 0 010 5.4M2.7 11.3a6 6 0 010-8.6M11.3 2.7a6 6 0 010 8.6" />
        </svg>
        <span className="pane-ctl-label max-w-[90px] truncate">Live feed · {scopeLabel}</span>
        <span className="opacity-60">×</span>
      </button>
    )
  }

  // Only offer to start on an idle shell pane (never type into a running Claude session).
  if (pane.state !== 'shell') return null

  return (
    <>
      <button
        ref={menu.triggerRef}
        onClick={onButton}
        className="flex items-center gap-1 px-1 py-0.5 text-[--ui-text-dimmed] hover:text-[--git-cyan] transition-colors rounded"
        title="Open the live delegation feed here — keep/delegate decisions + worker output. Pick which Claude session to follow, or all."
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <circle cx="7" cy="7" r="1.3" fill="currentColor" stroke="none" />
          <path d="M4.3 9.7a3.8 3.8 0 010-5.4M9.7 4.3a3.8 3.8 0 010 5.4M2.7 11.3a6 6 0 010-8.6M11.3 2.7a6 6 0 010 8.6" />
        </svg>
        <span className="pane-ctl-label text-meta leading-none">Live feed</span>
        {candidates.length > 0 && (
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 3.5L5 6.5L8 3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <PortalMenu menu={menu}>
          <div className="px-3 py-1.5 text-meta uppercase tracking-wide text-[--ui-text-muted]">
            Follow which session?
          </div>
          <button
            onClick={() => start(undefined)}
            className="w-full px-3 py-1.5 text-body text-left hover:bg-[--ui-bg-active]/50 text-[--ui-text-primary] flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" className="shrink-0">
              <circle cx="7" cy="7" r="5.4" />
              <path d="M1.6 7h10.8M7 1.6c1.7 1.5 2.7 3.4 2.7 5.4S8.7 10.9 7 12.4C5.3 10.9 4.3 9 4.3 7S5.3 3.1 7 1.6z" />
            </svg> All delegations
          </button>
          <div className="border-t border-[--border]" />
          <div className="max-h-[180px] overflow-y-auto">
            {candidates.map((c) => (
              <button
                key={c.id}
                onClick={() => start(c.id)}
                className="w-full px-3 py-1.5 text-body text-left hover:bg-[--ui-bg-active]/50 text-[--ui-text-primary] flex items-center gap-2"
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-[--git-green] animate-pulse" />
                <span className="truncate flex-1">{c.name || c.term}</span>
                {c.name && (
                  <span className="text-meta text-[--ui-text-muted] shrink-0">{c.term}</span>
                )}
              </button>
            ))}
          </div>
      </PortalMenu>
    </>
  )
})
