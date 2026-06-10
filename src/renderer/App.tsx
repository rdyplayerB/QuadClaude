import { useEffect, useCallback, useState } from 'react'
import { TerminalGrid } from './components/TerminalGrid'
import { SettingsModal } from './components/SettingsModal'
import { PromptToolbar } from './components/PromptToolbar'
import { LayoutSelector } from './components/LayoutSelector'
import { UsageIndicator } from './components/UsageIndicator'
import { clearTerminal, sendToTerminal, focusTerminal, scrollAllTerminalsToBottom, disposeAllTerminals } from './components/TerminalPane'
import { useWorkspaceStore } from './store/workspace'
import { useHotkeys } from './hooks/useHotkeys'
import { MenuAction, SavedPrompt, MAX_PANES } from '../shared/types'

// Toolbar "+" to add a pane — works in every layout (the in-grid ghost tile
// only appears when the grid has a blank cell). Hidden at the pane cap.
function AddPaneButton() {
  const count = useWorkspaceStore((s) => s.panes.length)
  const addPane = useWorkspaceStore((s) => s.addPane)
  if (count >= MAX_PANES) return null
  return (
    <button
      onClick={() => addPane()}
      className="flex items-center gap-1 px-2 py-1 text-[--ui-text-dimmed] hover:text-[--ui-text-primary] transition-colors titlebar-no-drag"
      title={`Add terminal (${count}/${MAX_PANES})`}
      aria-label="Add terminal"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M8 3v10M3 8h10" strokeLinecap="round" />
      </svg>
      <span className="text-[11px] leading-none">Add</span>
    </button>
  )
}

function App() {
  // Atomic selectors: App is the root, so a whole-store subscription here
  // re-renders the entire tree on every pane git/state/cwd update during
  // streaming. Subscribe only to what App actually reacts to.
  const initialize = useWorkspaceStore((s) => s.initialize)
  const layout = useWorkspaceStore((s) => s.layout)
  const activePaneId = useWorkspaceStore((s) => s.activePaneId)
  const setActivePaneId = useWorkspaceStore((s) => s.setActivePaneId)
  const setFocusPaneId = useWorkspaceStore((s) => s.setFocusPaneId)

  const [isSettingsOpen, setIsSettingsOpen] = useState(false)

  // Handle prompt injection (no newline - just inject text)
  const handlePromptClick = useCallback((prompt: SavedPrompt) => {
    sendToTerminal(activePaneId, prompt.text)
    focusTerminal(activePaneId)
  }, [activePaneId])

  // Initialize workspace on mount
  useEffect(() => {
    initialize()
  }, [initialize])

  // Single shared poll for local servers across all panes (one lsof+ps in
  // main, not per-pane). Visibility-gated so it pauses when hidden.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (document.hidden) return
      try {
        const byPane = await window.electronAPI.detectServers()
        if (cancelled) return
        const store = useWorkspaceStore.getState()
        for (const pane of store.panes) {
          store.setPaneServers(pane.id, byPane[pane.id] ?? [])
        }
      } catch {
        // ignore - transient
      }
    }
    const startDelay = setTimeout(poll, 3000)
    const interval = setInterval(poll, 10000)
    return () => {
      cancelled = true
      clearTimeout(startDelay)
      clearInterval(interval)
    }
  }, [])


  // Prevent Electron from navigating when files are dropped outside a terminal pane
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault()
    document.addEventListener('dragover', prevent)
    document.addEventListener('drop', prevent)
    return () => {
      document.removeEventListener('dragover', prevent)
      document.removeEventListener('drop', prevent)
    }
  }, [])

  // Enable global hotkeys (disabled when settings modal is open)
  useHotkeys(!isSettingsOpen)

  // Shared logic for focusing a terminal (used by both menu actions and hotkeys)
  const handleTerminalFocus = useCallback(
    (paneId: number) => {
      setActivePaneId(paneId)

      if (layout === 'focus' || layout === 'focus-right') {
        setFocusPaneId(paneId)
      }

      focusTerminal(paneId)
    },
    [layout, setActivePaneId, setFocusPaneId]
  )

  // Listen for menu actions
  // Uses getState() inside handler to always read latest values, avoiding re-subscriptions
  useEffect(() => {
    const unsubscribe = window.electronAPI.onMenuAction((action: MenuAction) => {
      const store = useWorkspaceStore.getState()
      switch (action) {
        case 'layout-grid':
          store.setLayout('grid')
          break
        case 'layout-focus':
          store.setLayout('focus')
          break
        case 'layout-focus-right':
          store.setLayout('focus-right')
          break
        case 'focus-pane-1':
          handleTerminalFocus(0)
          break
        case 'focus-pane-2':
          handleTerminalFocus(1)
          break
        case 'focus-pane-3':
          handleTerminalFocus(2)
          break
        case 'focus-pane-4':
          handleTerminalFocus(3)
          break
        case 'clear-pane':
          clearTerminal(store.activePaneId)
          break
        case 'launch-claude':
          sendToTerminal(store.activePaneId, 'claude\n')
          break
        case 'increase-font':
          store.updatePreferences({ fontSize: Math.min(24, store.preferences.fontSize + 1) })
          break
        case 'decrease-font':
          store.updatePreferences({ fontSize: Math.max(10, store.preferences.fontSize - 1) })
          break
        case 'open-settings':
          setIsSettingsOpen(true)
          break
        case 'toggle-prompt-bar':
          store.updatePreferences({ showPromptBar: store.preferences.showPromptBar === false })
          break
      }
    })

    return unsubscribe
  }, [handleTerminalFocus])

  // Scroll all terminals to bottom when system resumes from sleep
  useEffect(() => {
    const unsubscribe = window.electronAPI.onSystemResume(() => {
      // Small delay to ensure terminals are ready after resume
      setTimeout(() => {
        scrollAllTerminalsToBottom()
      }, 100)
    })

    return unsubscribe
  }, [])

  // Cleanup terminals on window close to prevent memory leaks
  useEffect(() => {
    const handleBeforeUnload = () => {
      disposeAllTerminals()
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])

  return (
    <div className="h-screen w-screen flex flex-col bg-transparent overflow-hidden relative font-mono">
      {/* Title bar - glass effect */}
      <div className="h-9 titlebar-drag-region border-b border-white/[0.06] flex items-center justify-between px-3 glass-header">
        {/* Left side - after traffic lights */}
        <div className="flex items-center gap-2 pl-[72px]">
          <span
            className="text-[12px] font-medium text-[--ui-text-secondary]"
            title="QuadClaude — the ADHD workspace for Claude Code"
          >
            QuadClaude
          </span>
          <span className="text-[--ui-text-faint]">│</span>
          <span className="text-[10px] text-[--ui-text-faint]">v1.15.0</span>
        </div>

        {/* Center - layout selector + add pane */}
        <div className="flex items-center gap-1">
          <LayoutSelector />
          <AddPaneButton />
        </div>

        {/* Right side - usage + utility buttons */}
        <div className="flex items-center gap-0.5">
          <UsageIndicator />
          <span className="text-[--ui-text-faint] text-xs px-1">│</span>
          {/* Settings */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="px-1.5 py-1 text-[--ui-text-dimmed] hover:text-[--ui-text-primary] transition-colors titlebar-no-drag"
            title="Settings (Cmd+,)"
            aria-label="Open settings"
          >
            <svg width="14" height="14" viewBox="0 0 18 18" fill="currentColor">
              <path d="M9 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/>
              <path fillRule="evenodd" d="M7.25 1a.75.75 0 0 0-.75.75v1.15a5.5 5.5 0 0 0-1.62.67l-.82-.82a.75.75 0 0 0-1.06 0L1.69 4.06a.75.75 0 0 0 0 1.06l.82.82A5.5 5.5 0 0 0 1.84 7.5H.75a.75.75 0 0 0-.75.75v2a.75.75 0 0 0 .75.75h1.1a5.5 5.5 0 0 0 .67 1.62l-.82.82a.75.75 0 0 0 0 1.06l1.36 1.36a.75.75 0 0 0 1.06 0l.82-.82a5.5 5.5 0 0 0 1.56.66v1.05a.75.75 0 0 0 .75.75h2a.75.75 0 0 0 .75-.75v-1.05a5.5 5.5 0 0 0 1.56-.66l.82.82a.75.75 0 0 0 1.06 0l1.36-1.36a.75.75 0 0 0 0-1.06l-.82-.82a5.5 5.5 0 0 0 .66-1.56h1.06a.75.75 0 0 0 .75-.75v-2a.75.75 0 0 0-.75-.75h-1.06a5.5 5.5 0 0 0-.66-1.56l.82-.82a.75.75 0 0 0 0-1.06l-1.36-1.36a.75.75 0 0 0-1.06 0l-.82.82a5.5 5.5 0 0 0-1.56-.66V1.75a.75.75 0 0 0-.75-.75h-2ZM9 12.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" clipRule="evenodd"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Prompt bookmarks bar */}
      <PromptToolbar onSelectPrompt={handlePromptClick} />

      {/* Main content area */}
      <div className="flex-1 overflow-hidden flex">
        {/* Terminal grid - always mounted to preserve terminal state */}
        <div className="overflow-hidden flex-1">
          <TerminalGrid />
        </div>
      </div>

      {/* Settings modal */}
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </div>
  )
}

export default App
