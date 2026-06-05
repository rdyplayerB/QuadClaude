import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspaceStore } from '../store/workspace'
import { sendToTerminal, focusTerminal } from './TerminalPane'

interface OpenInPaneButtonProps {
  paneId: number
}

// Short human status for the picker (shown only when no pane is free)
function paneStatus(state: string, serverCount: number): string {
  if (state === 'claude-waiting') return 'Claude — needs you'
  if (state === 'claude-active') return 'Claude running'
  if (serverCount > 0) return `server${serverCount > 1 ? 's' : ''} running`
  return 'idle'
}

/**
 * Opens THIS pane's project folder in another pane and auto-starts Claude
 * there. Uses the next free (idle shell, no server) pane in one click; if
 * none are free, shows a picker so you can deliberately override a busy pane.
 */
export const OpenInPaneButton = memo(function OpenInPaneButton({ paneId }: OpenInPaneButtonProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pickerOpen) return
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pickerOpen])

  // Resolve the freshest folder for the source pane (real cwd, then tracked)
  const resolveDir = useCallback(async (): Promise<string | null> => {
    const store = useWorkspaceStore.getState()
    const tracked = store.panes.find((p) => p.id === paneId)?.workingDirectory ?? null
    try {
      const real = await window.electronAPI.getCwd(paneId)
      return real || tracked
    } catch {
      return tracked
    }
  }, [paneId])

  const launchIn = useCallback(async (targetId: number) => {
    setPickerOpen(false)
    const dir = await resolveDir()
    if (!dir) return
    const store = useWorkspaceStore.getState()
    const skip = store.preferences.dangerouslySkipPermissions === true
    const claude = skip ? 'claude --dangerously-skip-permissions' : 'claude'
    // cd into the same project folder, then start Claude
    sendToTerminal(targetId, `cd "${dir}" && ${claude}\n`)
    store.setActivePaneId(targetId)
    focusTerminal(targetId)
  }, [resolveDir])

  const handleClick = useCallback(() => {
    const store = useWorkspaceStore.getState()
    const free = store.panes.find(
      (p) =>
        p.id !== paneId &&
        p.state === 'shell' &&
        (!p.servers || p.servers.length === 0)
    )
    if (free) {
      launchIn(free.id)
    } else {
      // No free pane - let the user pick which busy pane to override
      setPickerOpen(true)
    }
  }, [paneId, launchIn])

  const getPosition = () => {
    if (!buttonRef.current) return { top: 0, left: 0 }
    const rect = buttonRef.current.getBoundingClientRect()
    return { top: rect.bottom + 4, left: rect.right - 200 }
  }

  const others = useWorkspaceStore.getState().panes.filter((p) => p.id !== paneId)

  return (
    <>
      <button
        ref={buttonRef}
        onClick={handleClick}
        className="flex items-center gap-1 px-1 py-0.5 text-[--ui-text-dimmed] hover:text-[--ui-text-primary] transition-colors rounded"
        title="Open this folder in another pane and start Claude"
      >
        {/* two overlapping windows */}
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="1" y="3.5" width="7.5" height="7.5" rx="1" />
          <path d="M5 3.5V2.5a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1h-1" strokeLinecap="round" />
        </svg>
        <span className="text-[10px] leading-none">Fork</span>
      </button>

      {pickerOpen && createPortal(
        <div
          ref={panelRef}
          className="fixed z-50 w-[200px] bg-[--ui-bg-elevated] border border-[#444] rounded-md shadow-lg overflow-hidden"
          style={getPosition()}
        >
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-[--ui-text-dimmed] border-b border-[#444]">
            No free pane — override:
          </div>
          {others.map((p) => (
            <button
              key={p.id}
              className="w-full px-3 py-1.5 text-xs text-left hover:bg-[--ui-bg-active]/50 flex items-center justify-between gap-2"
              onClick={() => launchIn(p.id)}
              title={`Open here and start Claude (replaces what's running)`}
            >
              <span className="text-[--ui-text-primary] truncate">{p.label}</span>
              <span className="text-[10px] text-[--ui-text-dimmed] shrink-0">
                {paneStatus(p.state, p.servers?.length ?? 0)}
              </span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
})
