import { DragEvent, memo } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { clearTerminal, sendToTerminal } from './TerminalPane'
import { FavoritesDropdown } from './FavoritesDropdown'

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
  const skipPermissions = useWorkspaceStore(
    (s) => s.preferences.dangerouslySkipPermissions === true
  )

  const paneColor = PANE_COLORS[paneIndex % PANE_COLORS.length]

  if (!pane) return null
  const claudeRunning = pane.state === 'claude-active' || pane.state === 'claude-waiting'
  const startClaude = () => {
    if (claudeRunning) return
    const cmd = skipPermissions
      ? 'claude --dangerously-skip-permissions\n'
      : 'claude\n'
    sendToTerminal(paneId, cmd)
  }

  const servers = pane.servers ?? []
  const killServers = async () => {
    // Kill every detected server in this pane (process-group kill usually
    // takes the whole dev server + workers down), then clear optimistically.
    for (const s of servers) {
      await window.electronAPI.killServer(paneId, s.pid)
    }
    useWorkspaceStore.getState().setPaneServers(paneId, [])
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

  // State indicators - each pane gets its own unique color
  const stateIndicator = () => {
    if (pane.state === 'claude-waiting') {
      return (
        <span
          className="w-2 h-2 rounded-full animate-pulse"
          style={{ backgroundColor: 'var(--git-orange)', boxShadow: '0 0 6px var(--git-orange)' }}
          title="Claude is waiting for your decision"
        />
      )
    }
    if (pane.state === 'claude-active') {
      return (
        <span
          className="w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ backgroundColor: paneColor }}
          title="Claude Active"
        />
      )
    }
    return null // Don't show indicator for normal shell
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
        {/* State indicator */}
        {stateIndicator()}

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
        {/* Local server badge + kill */}
        {servers.length > 0 && (
          <button
            onClick={killServers}
            title={`Kill server${servers.length > 1 ? 's' : ''}: ${servers
              .map((s) => `${s.command} :${s.port}`)
              .join(', ')}`}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[10px] leading-none text-[--git-orange] hover:bg-[--git-orange]/15 transition-colors"
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: 'var(--git-orange)', boxShadow: '0 0 5px var(--git-orange)' }}
            />
            <span>
              {servers.length <= 2
                ? servers.map((s) => `:${s.port}`).join(' ')
                : `:${servers[0].port} +${servers.length - 1}`}
            </span>
            <svg width="9" height="9" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3l8 8M11 3l-8 8" strokeLinecap="round" />
            </svg>
          </button>
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
        <button
          onClick={startClaude}
          disabled={claudeRunning}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors ${
            claudeRunning
              ? 'opacity-40 cursor-default text-[--ui-text-dimmed]'
              : skipPermissions
                ? 'text-[--git-orange] hover:brightness-125'
                : 'text-[--ui-text-dimmed] hover:text-[--ui-text-primary]'
          }`}
          title={
            claudeRunning
              ? 'Claude is already running in this pane'
              : skipPermissions
                ? 'Start Claude with --dangerously-skip-permissions (bypasses all permission prompts) in this directory'
                : 'Start Claude in this directory'
          }
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l4 4-4 4M9 12h3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className="text-[10px] leading-none">
            {claudeRunning ? 'Running' : skipPermissions ? 'Claude ⚡' : 'Claude'}
          </span>
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
      </div>
    </div>
  )
})
