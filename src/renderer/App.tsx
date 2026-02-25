import { useEffect, useCallback, useState, useRef } from 'react'
import { TerminalGrid } from './components/TerminalGrid'
import { SettingsModal } from './components/SettingsModal'
import { PromptToolbar } from './components/PromptToolbar'
import { LayoutSelector } from './components/LayoutSelector'
import { HistoryPanel } from './components/HistoryPanel'
import { clearTerminal, sendToTerminal, focusTerminal, scrollAllTerminalsToBottom, disposeAllTerminals } from './components/TerminalPane'
import { useWorkspaceStore } from './store/workspace'
import { useHotkeys } from './hooks/useHotkeys'
import { MenuAction, SavedPrompt } from '../shared/types'

function App() {
  const {
    initialize,
    layout,
    setLayout,
    activePaneId,
    setActivePaneId,
    setFocusPaneId,
    preferences,
    updatePreferences,
  } = useWorkspaceStore()

  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)
  const [projectId, setProjectId] = useState<string | null>(null)
  const projectIdRef = useRef<string | null>(null)

  // Initialize workspace on mount
  useEffect(() => {
    initialize()
  }, [initialize])

  // Initialize project ID for history tracking
  useEffect(() => {
    const initProjectId = async () => {
      // Use the home directory as the base project path
      // In a real scenario, you might want to use the working directory of the first pane
      const homeDir = await window.electronAPI.getHomeDir()
      const id = await window.electronAPI.getProjectId(homeDir)
      setProjectId(id)
      projectIdRef.current = id
    }
    initProjectId()
  }, [])


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

  // Handle prompt injection (no newline - just inject text)
  const handlePromptClick = useCallback((prompt: SavedPrompt) => {
    sendToTerminal(activePaneId, prompt.text)
    focusTerminal(activePaneId)
  }, [activePaneId])


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
  useEffect(() => {
    const unsubscribe = window.electronAPI.onMenuAction((action: MenuAction) => {
      switch (action) {
        case 'layout-grid':
          setLayout('grid')
          break
        case 'layout-focus':
          setLayout('focus')
          break
        case 'layout-focus-right':
          setLayout('focus-right')
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
        case 'open-command-palette':
          // Prompt toolbar is now always visible
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

  // Capture terminal I/O for history (buffered to reduce writes)
  const outputBufferRef = useRef<Map<number, string>>(new Map())
  const flushTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    // Flush buffered output to history
    const flushBuffer = () => {
      const id = projectIdRef.current
      if (!id) return

      outputBufferRef.current.forEach((content, paneId) => {
        if (content.trim()) {
          window.electronAPI.appendHistory(id, paneId, 'output', content)
        }
      })
      outputBufferRef.current.clear()
    }

    const unsubscribe = window.electronAPI.onTerminalOutput((paneId, data) => {
      // Buffer output
      const existing = outputBufferRef.current.get(paneId) || ''
      outputBufferRef.current.set(paneId, existing + data)

      // Debounce flush: wait for output to settle before saving
      if (flushTimeoutRef.current) {
        clearTimeout(flushTimeoutRef.current)
      }
      flushTimeoutRef.current = window.setTimeout(flushBuffer, 2000)
    })

    return () => {
      unsubscribe()
      // Flush on cleanup
      if (flushTimeoutRef.current) {
        clearTimeout(flushTimeoutRef.current)
      }
      flushBuffer()
    }
  }, [])

  return (
    <div className="h-screen w-screen flex flex-col bg-terminal-bg overflow-hidden">
      {/* Title bar - clean, minimal */}
      <div className="h-11 titlebar-drag-region bg-[--ui-bg-primary] border-b border-[--ui-border-subtle] flex items-center justify-between px-3">
        {/* Left side - breathing room for traffic lights */}
        <div className="w-20" />

        {/* Center - layout selector as segmented control */}
        <LayoutSelector />

        {/* Right side - utility buttons */}
        <div className="flex items-center gap-1">
          {/* History */}
          <button
            onClick={() => setIsHistoryOpen(true)}
            className="p-2 text-[--ui-text-secondary] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active]/50 transition-all titlebar-no-drag rounded-md"
            title="Conversation History"
            aria-label="Open history"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
              <path d="M9 1.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM0 9a9 9 0 1 1 18 0A9 9 0 0 1 0 9Z"/>
              <path d="M9 4.5a.75.75 0 0 1 .75.75v3.44l2.03 2.03a.75.75 0 1 1-1.06 1.06l-2.25-2.25A.75.75 0 0 1 8.25 9V5.25A.75.75 0 0 1 9 4.5Z"/>
            </svg>
          </button>
          {/* Theme toggle */}
          <button
            onClick={() => updatePreferences({ theme: preferences.theme === 'light' ? 'dark' : 'light' })}
            className="p-2 text-[--ui-text-secondary] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active]/50 transition-all titlebar-no-drag rounded-md"
            title={`Switch to ${preferences.theme === 'light' ? 'dark' : 'light'} mode`}
            aria-label="Toggle theme"
          >
            {preferences.theme === 'light' ? (
              // Moon icon for switching to dark
              <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
                <path d="M7 2a7 7 0 1 0 9 9 6 6 0 0 1-9-9Z"/>
              </svg>
            ) : (
              // Sun icon for switching to light
              <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
                <circle cx="9" cy="9" r="3.5"/>
                <path d="M9 1v2.5M9 14.5V17M1 9h2.5M14.5 9H17M3.4 3.4l1.77 1.77M12.83 12.83l1.77 1.77M3.4 14.6l1.77-1.77M12.83 5.17l1.77-1.77" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            )}
          </button>
          {/* Settings */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="p-2 text-[--ui-text-secondary] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active]/50 transition-all titlebar-no-drag rounded-md"
            title="Settings (Cmd+,)"
            aria-label="Open settings"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
              <path d="M9 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/>
              <path fillRule="evenodd" d="M7.25 1a.75.75 0 0 0-.75.75v1.15a5.5 5.5 0 0 0-1.62.67l-.82-.82a.75.75 0 0 0-1.06 0L1.69 4.06a.75.75 0 0 0 0 1.06l.82.82A5.5 5.5 0 0 0 1.84 7.5H.75a.75.75 0 0 0-.75.75v2a.75.75 0 0 0 .75.75h1.1a5.5 5.5 0 0 0 .67 1.62l-.82.82a.75.75 0 0 0 0 1.06l1.36 1.36a.75.75 0 0 0 1.06 0l.82-.82a5.5 5.5 0 0 0 1.56.66v1.05a.75.75 0 0 0 .75.75h2a.75.75 0 0 0 .75-.75v-1.05a5.5 5.5 0 0 0 1.56-.66l.82.82a.75.75 0 0 0 1.06 0l1.36-1.36a.75.75 0 0 0 0-1.06l-.82-.82a5.5 5.5 0 0 0 .66-1.56h1.06a.75.75 0 0 0 .75-.75v-2a.75.75 0 0 0-.75-.75h-1.06a5.5 5.5 0 0 0-.66-1.56l.82-.82a.75.75 0 0 0 0-1.06l-1.36-1.36a.75.75 0 0 0-1.06 0l-.82.82a5.5 5.5 0 0 0-1.56-.66V1.75a.75.75 0 0 0-.75-.75h-2ZM9 12.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" clipRule="evenodd"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Terminal grid - full width now, no sidebar */}
      <div className="flex-1 overflow-hidden">
        <TerminalGrid />
      </div>

      {/* Floating prompt toolbar */}
      <PromptToolbar onSelectPrompt={handlePromptClick} />

      {/* Settings modal */}
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

      {/* History panel */}
      <HistoryPanel
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
        projectId={projectId}
      />
    </div>
  )
}

export default App
