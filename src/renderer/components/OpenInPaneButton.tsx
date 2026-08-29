import { memo, useCallback } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { focusTerminal, launchAgent, resolvePaneProfile } from './TerminalPane'
import { PortalMenu, useAnchoredMenu } from './ui/PortalMenu'

interface OpenInPaneButtonProps {
  paneId: number
}

// Short human status for the picker (shown only when no pane is free)
function paneStatus(state: string, serverCount: number): string {
  if (state === 'claude-waiting') return 'Claude — needs you'
  if (state === 'claude-active') return 'Claude running'
  if (state === 'claude-idle') return 'Claude — idle'
  if (serverCount > 0) return `server${serverCount > 1 ? 's' : ''} running`
  return 'idle'
}

/**
 * Opens THIS pane's project folder in another pane and auto-starts Claude
 * there. Uses the next free (idle shell, no server) pane in one click; if
 * none are free, shows a picker so you can deliberately override a busy pane.
 */
export const OpenInPaneButton = memo(function OpenInPaneButton({ paneId }: OpenInPaneButtonProps) {
  const menu = useAnchoredMenu({ width: 200 })

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
    menu.close()
    const dir = await resolveDir()
    if (!dir) return
    const store = useWorkspaceStore.getState()
    // Launch the TARGET pane's assigned agent (Claude / local model / ...) in a
    // fresh shell rooted at this project's folder. forceCwd guarantees the right
    // directory and injects the agent's env without leaking secrets.
    const targetPane = store.panes.find((p) => p.id === targetId)
    const profile = resolvePaneProfile(targetPane, store.preferences)
    await launchAgent(targetId, profile, dir, dir)
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
      menu.setOpen(true)
    }
  }, [paneId, launchIn, menu])

  const others = useWorkspaceStore.getState().panes.filter((p) => p.id !== paneId)

  return (
    <>
      <button
        ref={menu.triggerRef}
        onClick={handleClick}
        className="flex items-center gap-1 px-1 py-0.5 text-[--ui-text-dimmed] hover:text-[--ui-text-primary] transition-colors rounded"
        title="Open this folder in another pane and start Claude"
      >
        {/* two overlapping windows */}
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="1" y="3.5" width="7.5" height="7.5" rx="1" />
          <path d="M5 3.5V2.5a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1h-1" strokeLinecap="round" />
        </svg>
        <span className="pane-ctl-label text-meta leading-none">Fork</span>
      </button>

      <PortalMenu menu={menu}>
          <div className="px-3 py-1.5 text-meta uppercase tracking-wide text-[--ui-text-dimmed] border-b border-[--border]">
            No free pane — override:
          </div>
          {others.map((p) => (
            <button
              key={p.id}
              className="w-full px-3 py-1.5 text-body text-left hover:bg-[--ui-bg-active]/50 flex items-center justify-between gap-2"
              onClick={() => launchIn(p.id)}
              title={`Open here and start Claude (replaces what's running)`}
            >
              <span className="text-[--ui-text-primary] truncate">{p.label}</span>
              <span className="text-meta text-[--ui-text-dimmed] shrink-0">
                {paneStatus(p.state, p.servers?.length ?? 0)}
              </span>
            </button>
          ))}
      </PortalMenu>
    </>
  )
})
