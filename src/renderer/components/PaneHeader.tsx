import { DragEvent, memo, useEffect, useRef, useState } from 'react'
import { ServerInfo } from '../../shared/types'
import { useWorkspaceStore } from '../store/workspace'
import { clearTerminal, sendToTerminal } from './TerminalPane'
import { FavoritesDropdown } from './FavoritesDropdown'
import { OpenInPaneButton } from './OpenInPaneButton'

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

  // Server-start status narration. The spawn may have no terminal attached,
  // so this chip is the user's only feedback: what's being run (info), that
  // it came up (success), or why it didn't (error).
  type Notice = { text: string; kind: 'info' | 'success' | 'error' }
  const [notice, setNotice] = useState<Notice | null>(null)
  // True from Start press until the listener shows up (or we give up).
  // Without it the button looks inert for seconds and gets mashed, stacking
  // duplicate servers on auto-incrementing ports.
  const [starting, setStarting] = useState(false)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // ttlMs 0 = sticky (stays until replaced or dismissed)
  const showNotice = (n: Notice | null, ttlMs = 0) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setNotice(n)
    if (n && ttlMs > 0) noticeTimer.current = setTimeout(() => setNotice(null), ttlMs)
  }
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current) }, [])

  const paneColor = PANE_COLORS[paneIndex % PANE_COLORS.length]

  if (!pane) return null
  const claudeRunning = pane.state === 'claude-active' || pane.state === 'claude-waiting'
  const skipPermissions = useWorkspaceStore((s) => s.preferences.dangerouslySkipPermissions === true)
  const startClaude = () => {
    if (claudeRunning) return
    const cmd = skipPermissions ? 'claude --dangerously-skip-permissions\r' : 'claude\r'
    sendToTerminal(paneId, cmd)
  }

  const servers = pane.servers ?? []
  const openPort = (port: number) => {
    window.electronAPI.openExternal(`http://localhost:${port}`)
  }
  // Start a plain `npm run dev` for this pane. Owning the process as a
  // one-shot (no restart wrapper) is what makes the Stop button below an
  // actual stop — nothing is left babysitting it to bring it back.
  // Re-detect this pane's servers now (instead of waiting for the 10s poll)
  // so the port chip replaces "Starting…" as soon as the listener is up.
  const refreshServers = async (): Promise<ServerInfo[]> => {
    const byPane = await window.electronAPI.detectServers()
    const list = byPane[paneId] ?? []
    useWorkspaceStore.getState().setPaneServers(paneId, list)
    return list
  }

  const startServer = async () => {
    if (starting) return
    setStarting(true)
    try {
      // Resolve what this directory can start (dev/start script via the
      // right package manager, or a static server for an html folder) and
      // tell the user what's about to run — especially the static-server
      // fallback, which is otherwise surprising.
      const resolved = await window.electronAPI.resolveStartCommand(pane.workingDirectory)
      if (!resolved.command) {
        showNotice({ text: resolved.error ?? 'Nothing to start here', kind: 'error' }, 10000)
        return
      }
      const isStatic = resolved.command.startsWith('npx -y serve')
      showNotice({
        text: isStatic
          ? 'No dev script — serving folder as static site'
          : `Running ${resolved.command}${resolved.subdir ? ` in ${resolved.subdir}/` : ''}…`,
        kind: 'info',
      })

      if (claudeRunning) {
        // Claude owns the prompt: spawn via the main process in the pane's
        // cwd instead of typing into the terminal. The process has no
        // terminal, so surface a failure here — otherwise the button
        // silently does nothing.
        const result = await window.electronAPI.startServer(paneId, pane.workingDirectory)
        if (!result.ok) {
          showNotice({ text: result.error ?? 'Failed to start', kind: 'error' }, 12000)
          return
        }
      } else {
        // Plain shell: type the resolved command — in a subshell when the
        // app lives in a subfolder, so the pane's cwd is back where it was
        // once the server stops. \r (carriage return = Enter key) actually
        // submits in a PTY; \n alone gets typed but not executed by zsh's
        // line editor.
        const cmd = resolved.subdir
          ? `(cd "${resolved.subdir}" && ${resolved.command})`
          : resolved.command
        sendToTerminal(paneId, `${cmd}\r`)
      }
      // Hold "Starting…" until the listener appears; give up after ~12s
      // (slow installs/compiles) and fall back to the regular poll.
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        const list = await refreshServers()
        if (list.length > 0) {
          showNotice({ text: `Up on port ${list[0].port}`, kind: 'success' }, 4000)
          return
        }
      }
      showNotice({ text: 'No port detected yet — may still be starting', kind: 'info' }, 8000)
    } finally {
      setStarting(false)
    }
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

        {/* Server-start status: what's running, that it's up, or why it
            isn't (click to dismiss) */}
        {notice && (
          <button
            onClick={() => showNotice(null)}
            className={`max-w-[200px] truncate rounded px-1.5 py-1 font-mono text-[10px] leading-none ${
              notice.kind === 'error'
                ? 'bg-red-500/10 text-red-400'
                : notice.kind === 'success'
                  ? 'bg-[--git-green]/10 text-[--git-green]'
                  : 'bg-[--git-orange]/10 text-[--git-orange]'
            }`}
            title={`${notice.text} — click to dismiss`}
          >
            {notice.kind === 'success' ? '✓ ' : ''}{notice.text}
          </button>
        )}

        {/* No server detected: offer to start one. At a shell the command is
            typed into the terminal; while Claude runs it's spawned by the
            main process so it doesn't land in the Claude prompt. */}
        {servers.length === 0 && (
          <button
            onClick={startServer}
            disabled={starting}
            className={`flex items-center gap-0.5 rounded px-1.5 py-1 font-mono text-[10px] leading-none transition-colors ${
              starting
                ? 'bg-[--git-orange]/10 text-[--git-orange] cursor-default'
                : 'bg-white/[0.04] hover:bg-[--git-orange]/10 text-[--ui-text-muted] hover:text-[--git-orange]'
            }`}
            title={starting ? 'Starting dev server…' : 'Start dev server (dev/start script, or static server for an html folder)'}
          >
            {starting ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: 'var(--git-orange)' }} />
                Starting…
              </>
            ) : (
              <>
                <span className="text-[8px]">▶</span>
                Start
              </>
            )}
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
        <OpenInPaneButton paneId={paneId} />
        <button
          onClick={startClaude}
          disabled={claudeRunning}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors ${
            claudeRunning
              ? 'opacity-40 cursor-default text-[--ui-text-dimmed]'
              : 'text-[--ui-text-dimmed] hover:text-[--ui-text-primary]'
          }`}
          title={claudeRunning ? 'Claude is already running in this pane' : `Start Claude${skipPermissions ? ' (skip permissions)' : ''}`}
        >
          {skipPermissions ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="text-[--git-orange]">
              <path d="M9 1L3 9h4l-2 6 7-9H8l1-5z" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l4 4-4 4M9 12h3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
          <span className="text-[10px] leading-none">{claudeRunning ? 'Running' : 'Claude'}</span>
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
