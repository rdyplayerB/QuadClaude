import { useEffect, useCallback, useState } from 'react'
import { TerminalGrid } from './components/TerminalGrid'
import { SettingsModal } from './components/SettingsModal'
import { PromptToolbar } from './components/PromptToolbar'
import { LayoutSelector } from './components/LayoutSelector'
import { UsageIndicator } from './components/UsageIndicator'
import { clearTerminal, sendToTerminal, focusTerminal, scrollAllTerminalsToBottom, disposeAllTerminals } from './components/TerminalPane'
import { useWorkspaceStore } from './store/workspace'
import { useHotkeys } from './hooks/useHotkeys'
import { MenuAction, SavedPrompt } from '../shared/types'

function App() {
  const {
    initialize,
    layout,
    activePaneId,
    setActivePaneId,
    setFocusPaneId,
  } = useWorkspaceStore()

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
        case 'open-command-palette':
          // Prompt toolbar is now always visible
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
          <span className="text-[11px] tracking-widest uppercase text-[--ui-text-dimmed]">quadclaude</span>
          <span className="text-[--ui-text-faint]">│</span>
          <span className="text-[10px] text-[--ui-text-faint]">v1.6.0</span>
        </div>

        {/* Center - layout selector */}
        <LayoutSelector />

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

      {/* Main content area */}
      <div className="flex-1 overflow-hidden flex">
        {/* Terminal grid - always mounted to preserve terminal state */}
        <div className="overflow-hidden flex-1">
          <TerminalGrid />
        </div>
      </div>

      {/* Floating prompt toolbar */}
      <PromptToolbar onSelectPrompt={handlePromptClick} />

      {/* Settings modal */}
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </div>
  )
}

export default App
