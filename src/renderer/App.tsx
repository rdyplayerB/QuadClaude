import { useEffect, useCallback, useState } from 'react'
import { TerminalGrid } from './components/TerminalGrid'
import { LayoutSwitcher } from './components/LayoutSwitcher'
import { SettingsModal } from './components/SettingsModal'
import { ShortcutHints } from './components/ShortcutHints'
import { clearTerminal, sendToTerminal, focusTerminal, scrollAllTerminalsToBottom, disposeAllTerminals } from './components/TerminalPane'
import { useWorkspaceStore } from './store/workspace'
import { useHotkeys } from './hooks/useHotkeys'
import { MenuAction } from '../shared/types'

function App() {
  const {
    initialize,
    layout,
    setLayout,
    activePaneId,
    splitPaneIds,
    setActivePaneId,
    setFocusPaneId,
    setSplitPaneId,
    preferences,
    updatePreferences,
  } = useWorkspaceStore()

  const [isSettingsOpen, setIsSettingsOpen] = useState(false)

  // Initialize workspace on mount
  useEffect(() => {
    initialize()
  }, [initialize])


  // Apply theme to document
  useEffect(() => {
    const root = document.documentElement
    if (preferences.theme === 'light') {
      root.classList.add('light')
    } else if (preferences.theme === 'dark') {
      root.classList.remove('light')
    } else {
      // System preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      if (prefersDark) {
        root.classList.remove('light')
      } else {
        root.classList.add('light')
      }
    }
  }, [preferences.theme])

  // Enable global hotkeys (disabled when settings modal is open)
  useHotkeys(!isSettingsOpen)


  // Shared logic for focusing a terminal (used by both menu actions and hotkeys)
  const handleTerminalFocus = useCallback(
    (paneId: number) => {
      setActivePaneId(paneId)

      if (layout === 'focus') {
        setFocusPaneId(paneId)
      } else if (layout === 'split') {
        if (!splitPaneIds.includes(paneId)) {
          const activePosition = splitPaneIds.indexOf(activePaneId)
          const targetPosition = activePosition !== -1 ? activePosition : 0
          setSplitPaneId(targetPosition as 0 | 1, paneId)
        }
      }

      focusTerminal(paneId)
    },
    [layout, activePaneId, splitPaneIds, setActivePaneId, setFocusPaneId, setSplitPaneId]
  )

  // Listen for menu actions
  useEffect(() => {
    const unsubscribe = window.electronAPI.onMenuAction((action: MenuAction) => {
      switch (action) {
        case 'layout-grid':
          setLayout('grid')
          break
        case 'layout-focus':
          setLayout('focus')
          break
        case 'layout-split':
          setLayout('split')
          break
        case 'layout-horizontal':
          setLayout('horizontal')
          break
        case 'layout-vertical':
          setLayout('vertical')
          break
        case 'layout-fullscreen':
          setLayout('fullscreen')
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
          clearTerminal(activePaneId)
          break
        case 'launch-claude':
          sendToTerminal(activePaneId, 'claude\n')
          break
        case 'increase-font':
          updatePreferences({ fontSize: Math.min(24, preferences.fontSize + 1) })
          break
        case 'decrease-font':
          updatePreferences({ fontSize: Math.max(10, preferences.fontSize - 1) })
          break
        case 'toggle-theme':
          updatePreferences({
            theme: preferences.theme === 'dark' ? 'light' : 'dark',
          })
          break
        case 'open-settings':
          setIsSettingsOpen(true)
          break
      }
    })

    return unsubscribe
  }, [setLayout, activePaneId, handleTerminalFocus, preferences, updatePreferences])

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
    <div className="h-screen w-screen flex flex-col bg-terminal-bg overflow-hidden">
      {/* Top drag region for macOS traffic lights - full width */}
      <div className="h-10 titlebar-drag-region bg-terminal-header border-b border-terminal-border flex items-center justify-end pr-4">
        <ShortcutHints />
      </div>

      {/* Main content area with sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Terminal grid */}
        <div className="flex-1 overflow-hidden">
          <TerminalGrid />
        </div>

        {/* Right sidebar - ASCII style */}
        <div className="w-16 flex flex-col items-center py-3 bg-terminal-bg border-l border-terminal-border font-mono">
          {/* Spacer */}
          <div className="flex-1" />

          {/* Layout switcher - centered */}
          <LayoutSwitcher />

          {/* Spacer */}
          <div className="flex-1" />

          {/* Settings button - ASCII style */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="text-terminal-muted hover:text-claude-pink transition-colors text-lg"
            title="Settings"
            aria-label="Open settings"
          >
            [⚙]
          </button>
        </div>
      </div>

      {/* Settings modal */}
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </div>
  )
}

export default App
