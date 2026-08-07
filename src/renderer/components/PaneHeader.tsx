import { DragEvent, memo, useEffect, useState } from 'react'
import { MIN_PANES } from '../../shared/types'
import { folderName } from '../util/paths'
import { useWorkspaceStore } from '../store/workspace'
import { clearTerminal, disposeTerminalForPane, restartShell } from './TerminalPane'
import { FavoritesDropdown } from './FavoritesDropdown'
import { OpenInPaneButton } from './OpenInPaneButton'
import { AgentBadge } from './AgentBadge'
import { LiveFeedButton } from './LiveFeedButton'

// Custom MIME type for pane drag operations
export const PANE_DRAG_TYPE = 'application/x-quadclaude-pane'

interface PaneHeaderProps {
  paneId: number
}

// Unique colors for each terminal's indicator (work well in dark & light modes)
// Exported for the PiP strip's tile mini-headers (PipStrip.tsx). Indexed by a
// pane's POSITION in the panes array, matching this header's convention.
export const PANE_COLORS = [
  '#22d3ee', // Cyan (Terminal 1)
  '#4ade80', // Green (Terminal 2)
  '#fbbf24', // Amber (Terminal 3)
  '#a78bfa', // Purple (Terminal 4)
  '#f472b6', // Pink (Terminal 5)
  '#fb923c', // Orange (Terminal 6)
  '#38bdf8', // Sky (Terminal 7)
  '#34d399', // Emerald (Terminal 8)
  '#f59e0b', // Gold (Terminal 9)
  '#c084fc', // Violet (Terminal 10)
  '#fb7185', // Rose (Terminal 11)
  '#2dd4bf', // Teal (Terminal 12)
]

// Port chips shown before the rest fold into a "+N" pill.
const MAX_SERVER_CHIPS = 2

// Extract folder/repo name from path
export function getFolderName(path: string): string {
  return folderName(path, 'Terminal')
}

export const PaneHeader = memo(function PaneHeader({ paneId }: PaneHeaderProps) {
  // Atomic selectors so this header only re-renders for its own pane's
  // changes, not every other pane's state/git/cwd churn.
  const pane = useWorkspaceStore((s) => s.panes.find((p) => p.id === paneId))
  const paneIndex = useWorkspaceStore((s) => s.panes.findIndex((p) => p.id === paneId))
  const isActive = useWorkspaceStore((s) => s.activePaneId === paneId)
  const setActivePaneId = useWorkspaceStore((s) => s.setActivePaneId)
  const removePane = useWorkspaceStore((s) => s.removePane)
  const paneCount = useWorkspaceStore((s) => s.panes.length)
  // Four windows is the floor, not a fixed set of four windows. Any pane can be
  // closed while we're above MIN_PANES; at exactly four, nobody gets a ✕. Since
  // panes live in an array, closing an early slot shifts the next extra up into
  // it — that's how an extra window "takes over" a permanent slot. (removePane
  // enforces the same floor independently, so a stale click can't undercut it.)
  const canClose = paneCount > MIN_PANES

  // Closing a pane that's mid-job is the one unrecoverable misclick here, so a
  // live pane arms first and closes on the second click. Auto-disarms so a
  // stray click doesn't leave the button primed.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  // Disarm the moment closing stops being possible. Otherwise arming a pane and
  // then dropping to the floor (another pane closes) leaves `armed` set, and if
  // the count rises again inside the 3s window the button comes back already
  // primed — one click from killing a live session the user never armed.
  useEffect(() => {
    if (!canClose) setArmed(false)
  }, [canClose])

  const paneColor = PANE_COLORS[paneIndex % PANE_COLORS.length]

  if (!pane) return null

  const servers = pane.servers ?? []
  // A pane running three dev servers renders three "Port NNNN | Stop" chips, which
  // is wider than a third-of-screen header — the overflow used to push Close off
  // the clipped right edge. Past two, the rest collapse into a "+N" you can hover.
  const shownServers = servers.slice(0, MAX_SERVER_CHIPS)
  const hiddenServers = servers.slice(MAX_SERVER_CHIPS)
  const openPort = (port: number) => {
    window.electronAPI.openExternal(`http://localhost:${port}`)
  }

  // A bare shell has nothing to lose, so it closes on one click; anything
  // running Claude has to be armed first.
  const isLive = pane.state !== 'shell'
  // Dropping to the floor while a pane sits armed would leave a red "Close?"
  // on a button that can no longer do anything.
  const showArmed = armed && canClose

  // Close a pane: drop it from the layout, then tear down its PTY and xterm
  // instance so the slot id can be reused by a future add.
  const closePane = () => {
    if (isLive && !armed) {
      setArmed(true)
      return
    }
    const removed = removePane(paneId)
    if (removed === null) return
    window.electronAPI.killPty(removed)
    disposeTerminalForPane(removed)
  }

  // Display name is the folder/repo name from working directory
  const displayName = getFolderName(pane.workingDirectory)

  // Drag handlers for pane reordering
  const handleDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(PANE_DRAG_TYPE, paneId.toString())
    e.dataTransfer.effectAllowed = 'move'
    // Make the dragged pane the active pane
    setActivePaneId(paneId)
  }

  return (
    <div
      className="pane-header glass-pane-header overflow-hidden flex items-center font-mono text-body titlebar-no-drag transition-colors h-8"
      style={{
        borderBottom: `1px solid ${isActive ? paneColor + '40' : 'rgba(255,255,255,0.06)'}`,
      }}
    >
      {/* Draggable zone */}
      <div
        draggable
        onDragStart={handleDragStart}
        className="flex-1 flex items-center gap-1.5 px-2.5 cursor-grab active:cursor-grabbing overflow-hidden h-full"
      >
        {/* Display name (auto from folder) */}
        <span
          className={`truncate select-none ${isActive ? 'text-[--ui-text-primary]' : 'text-[--ui-text-muted]'}`}
          title={pane.workingDirectory}
        >
          {displayName}
        </span>
      </div>

      {/* Git status + action buttons */}
      <div
        className="flex items-center gap-1.5 pr-2 min-w-0"
        style={{ cursor: 'default' }}
        onMouseDown={(e) => e.stopPropagation()}
        // The pane container's onClick focuses the terminal, and a click on a
        // header button bubbles up to it. That focus steal blurs the button —
        // which silently un-armed Close, so a live pane could never be shut:
        // click one armed it, the bubble disarmed it, forever. Header controls
        // are their own surface; clicks here don't reach the pane.
        onClick={(e) => e.stopPropagation()}
        onDragStart={(e) => e.preventDefault()}
        draggable={false}
      >
        {/* Status that varies with the session — ports, branch. This is the part
            that gives up space when the header is tight, so the buttons below
            never get pushed out of a clipped header. */}
        <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
        {servers.length > 0 && (
          <div className="flex items-center gap-1.5 font-mono text-meta leading-none min-w-0">
            {shownServers.map((s) => (
              <div
                key={s.pid}
                className="flex items-center gap-0.5 rounded bg-[--git-orange]/10 text-[--git-orange] px-1.5 py-1 shrink-0"
              >
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: 'var(--git-orange)', boxShadow: '0 0 5px var(--git-orange)' }}
                />
                <button
                  onClick={() => openPort(s.port)}
                  className="underline decoration-[--git-orange]/40 hover:decoration-[--git-orange] transition-colors"
                  title={`Open http://localhost:${s.port} in browser`}
                >
                  Port {s.port}
                </button>
                <span className="text-[--git-orange]/30 mx-0.5">|</span>
                <button
                  onClick={async () => {
                    await window.electronAPI.killServer(paneId, s.pid)
                    const remaining = servers.filter((x) => x.pid !== s.pid)
                    useWorkspaceStore.getState().setPaneServers(paneId, remaining)
                  }}
                  className="text-[--git-orange]/60 hover:text-[--git-orange] transition-colors"
                  title={`Stop ${s.command} (pid ${s.pid})`}
                >
                  Stop
                </button>
              </div>
            ))}
            {hiddenServers.length > 0 && (
              <span
                className="rounded bg-[--git-orange]/10 text-[--git-orange] px-1.5 py-1 shrink-0"
                title={hiddenServers.map((s) => `Port ${s.port} — ${s.command} (pid ${s.pid})`).join('\n')}
              >
                +{hiddenServers.length}
              </span>
            )}
          </div>
        )}

        {/* Git status - compact inline */}
        {pane.gitStatus?.isGitRepo && (
          <div className="flex items-center gap-1.5 font-mono text-meta mr-1 min-w-0">
            <span className="flex items-center gap-1">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="text-[--git-green]">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
              </svg>
              <span className="pane-ctl-label text-[--git-green] truncate">{pane.gitStatus.branch}</span>
            </span>
            {(pane.gitStatus.ahead ?? 0) > 0 && (
              <span className="text-[--git-cyan]">↑{pane.gitStatus.ahead}</span>
            )}
            {(pane.gitStatus.behind ?? 0) > 0 && (
              <span className="text-[--git-yellow]">↓{pane.gitStatus.behind}</span>
            )}
            {(pane.gitStatus.dirty ?? 0) > 0 && (
              <span className="text-[--git-orange] shrink-0">●{pane.gitStatus.dirty}</span>
            )}
          </div>
        )}
        </div>

        {/* Actions. Pinned: whatever else has to give, Stop/Clear/Close stay
            reachable — a header too crowded to close was the bug. */}
        <div className="flex items-center gap-1.5 shrink-0">
        <FavoritesDropdown paneId={paneId} currentDirectory={pane.workingDirectory} />
        <OpenInPaneButton paneId={paneId} />
        {pane.pairId && (
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-meta leading-none capitalize shrink-0"
            style={{ color: pane.pairColor, backgroundColor: `${pane.pairColor}1a` }}
            title={`Paired (${pane.pairRole}) — manage in the agent menu`}
          >
            <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="shrink-0">
              <path d="M5.8 8.2l2.4-2.4M5.9 3.9l.8-.8a2.3 2.3 0 013.2 3.2l-.8.8M8.1 10.1l-.8.8a2.3 2.3 0 01-3.2-3.2l.8-.8" />
            </svg>
            {pane.pairRole}
          </span>
        )}
        {/* Live delegation feed: one-click on any idle pane. If other panes run Claude,
            a small menu scopes the feed to one session (or all). */}
        <LiveFeedButton paneId={paneId} />
        <AgentBadge paneId={paneId} />
        <button
          onClick={() => restartShell(paneId, pane.workingDirectory)}
          className="flex items-center gap-1 px-1 py-0.5 text-[--ui-text-dimmed] hover:text-[--danger] transition-colors rounded"
          title="Stop — kill the running process and reset the shell (recovers a locked pane)"
        >
          <svg width="11" height="11" viewBox="0 0 14 14" fill="currentColor">
            <rect x="3" y="3" width="8" height="8" rx="1.5" />
          </svg>
          <span className="pane-ctl-label text-meta leading-none">Stop</span>
        </button>
        <button
          onClick={() => clearTerminal(paneId)}
          className="flex items-center gap-1 px-1 py-0.5 text-[--ui-text-dimmed] hover:text-[--ui-text-primary] transition-colors rounded"
          title="Clear (Cmd+K)"
        >
          {/* Eraser — visually distinct from the Close (✕) so the icon-only
              header (narrow panes) doesn't read as two close buttons. */}
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 13.5h7" />
            <path d="M9.5 13.5 13.5 9.5a1.3 1.3 0 0 0 0-1.8L9.8 4a1.3 1.3 0 0 0-1.8 0l-5 5a1.3 1.3 0 0 0 0 1.8l2.7 2.7H9.5Z" />
          </svg>
          <span className="pane-ctl-label text-meta leading-none">Clear</span>
        </button>
        {/* Close button — always rendered so the affordance doesn't blink out of
            every header at once when the count reaches the floor. At exactly
            four it sits disabled and says why. */}
        <button
          onClick={closePane}
          onBlur={() => setArmed(false)}
          disabled={!canClose}
          className={`flex items-center gap-1 px-1 py-0.5 transition-colors rounded ${
            !canClose
              ? 'text-[--ui-text-dimmed] opacity-30 cursor-default'
              : showArmed
                ? 'text-[--danger]'
                : 'text-[--ui-text-dimmed] hover:text-[--danger]'
          }`}
          title={
            !canClose
              ? `QuadClaude always keeps ${MIN_PANES} windows — add another to close this one`
              : showArmed
                ? 'Click again to close — this pane has a live session'
                : isLive
                  ? 'Close terminal (has a live session — takes two clicks)'
                  : 'Close terminal'
          }
          aria-label="Close terminal"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round"/>
          </svg>
          {showArmed && <span className="pane-ctl-label text-meta leading-none">Close?</span>}
        </button>
        </div>
      </div>
    </div>
  )
})
