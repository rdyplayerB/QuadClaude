import { DragEvent, memo } from 'react'
import { MIN_PANES } from '../../shared/types'
import { useWorkspaceStore } from '../store/workspace'
import { clearTerminal, disposeTerminalForPane, restartShell } from './TerminalPane'
import { FavoritesDropdown } from './FavoritesDropdown'
import { OpenInPaneButton } from './OpenInPaneButton'
import { AgentBadge } from './AgentBadge'

// Custom MIME type for pane drag operations
export const PANE_DRAG_TYPE = 'application/x-quadclaude-pane'

interface PaneHeaderProps {
  paneId: number
}

// Unique colors for each terminal's indicator (work well in dark & light modes)
const PANE_COLORS = [
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

// Extract folder/repo name from path
function getFolderName(path: string): string {
  if (!path) return 'Terminal'
  const parts = path.split('/')
  const name = parts[parts.length - 1] || parts[parts.length - 2]
  // If it's home directory, show ~
  if (path.match(/^\/Users\/[^/]+\/?$/)) {
    return '~'
  }
  return name || 'Terminal'
}

export const PaneHeader = memo(function PaneHeader({ paneId }: PaneHeaderProps) {
  // Atomic selectors so this header only re-renders for its own pane's
  // changes, not every other pane's state/git/cwd churn.
  const pane = useWorkspaceStore((s) => s.panes.find((p) => p.id === paneId))
  const paneIndex = useWorkspaceStore((s) => s.panes.findIndex((p) => p.id === paneId))
  const isActive = useWorkspaceStore((s) => s.activePaneId === paneId)
  const setActivePaneId = useWorkspaceStore((s) => s.setActivePaneId)
  const removePane = useWorkspaceStore((s) => s.removePane)
  // The original four panes (slots 0-3) are permanent; only extras (slot 4+)
  // can be closed, and the store floor keeps the count from dropping below 4.
  const canClose = paneIndex >= MIN_PANES

  const paneColor = PANE_COLORS[paneIndex % PANE_COLORS.length]

  if (!pane) return null

  const servers = pane.servers ?? []
  const openPort = (port: number) => {
    window.electronAPI.openExternal(`http://localhost:${port}`)
  }

  // Close an extra pane: drop it from the layout, then tear down its PTY and
  // xterm instance so the slot id can be reused by a future add.
  const closePane = () => {
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
      className="pane-header glass-pane-header overflow-hidden flex items-center font-mono text-[12px] titlebar-no-drag transition-colors h-8"
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
        className="flex items-center gap-1.5 pr-2 shrink-0"
        style={{ cursor: 'default' }}
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={(e) => e.preventDefault()}
        draggable={false}
      >
        {servers.length > 0 && (
          <div className="flex items-center gap-1.5 font-mono text-[10px] leading-none">
            {servers.map((s) => (
              <div
                key={s.pid}
                className="flex items-center gap-0.5 rounded bg-[--git-orange]/10 text-[--git-orange] px-1.5 py-1"
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
          </div>
        )}

        {/* Git status - compact inline */}
        {pane.gitStatus?.isGitRepo && (
          <div className="flex items-center gap-1.5 font-mono text-[10px] mr-1">
            <span className="flex items-center gap-1">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="text-[--git-green]">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
              </svg>
              <span className="text-[--git-green]">{pane.gitStatus.branch}</span>
            </span>
            {(pane.gitStatus.ahead ?? 0) > 0 && (
              <span className="text-[--git-cyan]">↑{pane.gitStatus.ahead}</span>
            )}
            {(pane.gitStatus.behind ?? 0) > 0 && (
              <span className="text-[--git-yellow]">↓{pane.gitStatus.behind}</span>
            )}
            {(pane.gitStatus.dirty ?? 0) > 0 && (
              <span className="text-[--git-orange]">●{pane.gitStatus.dirty}</span>
            )}
          </div>
        )}
        <FavoritesDropdown paneId={paneId} currentDirectory={pane.workingDirectory} />
        <OpenInPaneButton paneId={paneId} />
        {pane.pairId && (
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] leading-none capitalize shrink-0"
            style={{ color: pane.pairColor, backgroundColor: `${pane.pairColor}1a` }}
            title={`Paired (${pane.pairRole}) — manage in the agent menu`}
          >
            <span aria-hidden>🔗</span>
            {pane.pairRole}
          </span>
        )}
        <AgentBadge paneId={paneId} />
        <button
          onClick={() => restartShell(paneId, pane.workingDirectory)}
          className="flex items-center gap-1 px-1 py-0.5 text-[--ui-text-dimmed] hover:text-red-400 transition-colors rounded"
          title="Stop — kill the running process and reset the shell (recovers a locked pane)"
        >
          <svg width="11" height="11" viewBox="0 0 14 14" fill="currentColor">
            <rect x="3" y="3" width="8" height="8" rx="1.5" />
          </svg>
          <span className="text-[10px] leading-none">Stop</span>
        </button>
        <button
          onClick={() => clearTerminal(paneId)}
          className="flex items-center gap-1 px-1 py-0.5 text-[--ui-text-dimmed] hover:text-[--ui-text-primary] transition-colors rounded"
          title="Clear (Cmd+K)"
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l8 8M11 3l-8 8" strokeLinecap="round"/>
          </svg>
          <span className="text-[10px] leading-none">Clear</span>
        </button>
        {/* Close button — only on extra panes (slot 5+); the original four
            are permanent. */}
        {canClose && (
          <button
            onClick={closePane}
            className="flex items-center px-1 py-0.5 text-[--ui-text-dimmed] hover:text-red-400 transition-colors rounded"
            title="Close terminal"
            aria-label="Close terminal"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round"/>
            </svg>
          </button>
        )}
      </div>
    </div>
  )
})
