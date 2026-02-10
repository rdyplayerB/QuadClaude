import { useEffect, useRef, useCallback, useState, DragEvent, memo } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'
import 'xterm/css/xterm.css'
import { useWorkspaceStore } from '../store/workspace'
import { PaneHeader, PANE_DRAG_TYPE } from './PaneHeader'
import { DEFAULT_HOTKEYS } from '../../shared/types'

// Module-level tracking to persist across component remounts
const initializedPtys = new Set<number>()
const terminals = new Map<number, { terminal: Terminal; fitAddon: FitAddon }>()
// Track focus listeners for proper cleanup
const focusListeners = new Map<number, () => void>()
// Track user scroll state - prevents auto-scroll when user has scrolled up
const userScrolledUp = new Map<number, boolean>()

// Terminal theme constants (extracted to avoid recreation on every render)
const DARK_THEME = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  black: '#1e1e1e',
  red: '#f44747',
  green: '#6a9955',
  yellow: '#dcdcaa',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#808080',
  brightRed: '#f44747',
  brightGreen: '#6a9955',
  brightYellow: '#dcdcaa',
  brightBlue: '#569cd6',
  brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0',
  brightWhite: '#ffffff',
}

const LIGHT_THEME = {
  background: '#f5f5f5',
  foreground: '#1a1a1a',
  cursor: '#1a1a1a',
  cursorAccent: '#f5f5f5',
  selectionBackground: '#b4d5fe',
  black: '#1a1a1a',
  red: '#c4314b',
  green: '#4e8a3e',
  yellow: '#a5850e',
  blue: '#0070c1',
  magenta: '#a855a8',
  cyan: '#1a9e9e',
  white: '#d4d4d4',
  brightBlack: '#666666',
  brightRed: '#c4314b',
  brightGreen: '#4e8a3e',
  brightYellow: '#a5850e',
  brightBlue: '#0070c1',
  brightMagenta: '#a855a8',
  brightCyan: '#1a9e9e',
  brightWhite: '#1a1a1a',
}

// Exported functions to control terminals from outside
export function clearTerminal(paneId: number) {
  const entry = terminals.get(paneId)
  if (entry) {
    entry.terminal.clear()
  }
}

export function sendToTerminal(paneId: number, text: string) {
  const entry = terminals.get(paneId)
  if (entry) {
    window.electronAPI.sendInput(paneId, text)
    entry.terminal.focus()
  }
}

export function focusTerminal(paneId: number) {
  const entry = terminals.get(paneId)
  if (entry) {
    entry.terminal.focus()
  }
}

export function scrollTerminalToBottom(paneId: number) {
  const entry = terminals.get(paneId)
  if (entry) {
    entry.terminal.scrollToBottom()
  }
}

export function scrollAllTerminalsToBottom() {
  terminals.forEach((entry) => {
    entry.terminal.scrollToBottom()
  })
}

// Dispose and cleanup a terminal when pane is deleted or app closes
export function disposeTerminal(paneId: number) {
  const entry = terminals.get(paneId)
  if (entry) {
    // Remove focus listener if exists
    const focusListener = focusListeners.get(paneId)
    if (focusListener && entry.terminal.textarea) {
      entry.terminal.textarea.removeEventListener('focus', focusListener)
    }
    focusListeners.delete(paneId)
    userScrolledUp.delete(paneId)

    // Dispose the terminal (releases xterm.js resources, DOM elements, event listeners)
    entry.terminal.dispose()
    terminals.delete(paneId)
    initializedPtys.delete(paneId)
  }
}

// Dispose all terminals (for app shutdown)
export function disposeAllTerminals() {
  terminals.forEach((_, paneId) => {
    disposeTerminal(paneId)
  })
}

// Helper to check if terminal is scrolled to bottom
function isTerminalAtBottom(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active
  // Add small tolerance (1 row) to account for edge cases
  return buffer.baseY + terminal.rows >= buffer.length - 1
}

// Helper to safely fit terminal while preserving scroll position
function safeFit(terminal: Terminal, fitAddon: FitAddon): void {
  const wasAtBottom = isTerminalAtBottom(terminal)
  try {
    fitAddon.fit()
  } catch (e) {
    // Ignore fit errors during transitions
    return
  }
  // Always scroll to bottom if we were at the bottom before fit
  if (wasAtBottom) {
    terminal.scrollToBottom()
  }
}

interface TerminalPaneProps {
  paneId: number
}

export const TerminalPane = memo(function TerminalPane({ paneId }: TerminalPaneProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  const {
    panes,
    activePaneId,
    setActivePaneId,
    preferences,
    layout,
    swapPanes,
  } = useWorkspaceStore()

  const pane = panes.find((p) => p.id === paneId)
  const isActive = activePaneId === paneId
  const [isDragOver, setIsDragOver] = useState(false)
  const [isPaneDragOver, setIsPaneDragOver] = useState(false)

  // Initialize terminal
  useEffect(() => {
    if (!terminalRef.current || !pane) return

    // Check if we already have a terminal for this pane (persisted across remounts)
    const existing = terminals.get(paneId)
    if (existing) {
      // Reattach existing terminal to new DOM element
      xtermRef.current = existing.terminal
      fitAddonRef.current = existing.fitAddon

      // Save scroll position BEFORE reattaching (open() resets the viewport)
      const wasAtBottom = isTerminalAtBottom(existing.terminal)

      // Clear the container and reattach
      terminalRef.current.innerHTML = ''
      existing.terminal.open(terminalRef.current)

      // Refit after reattaching and restore scroll position
      requestAnimationFrame(() => {
        if (terminalRef.current && terminalRef.current.offsetWidth > 0) {
          try {
            existing.fitAddon.fit()
          } catch (e) {
            // Ignore fit errors
          }
          // Always scroll to bottom if we were at bottom before reattachment
          if (wasAtBottom) {
            existing.terminal.scrollToBottom()
          }
          const { cols, rows } = existing.terminal
          window.electronAPI.resizeTerminal(paneId, cols, rows)
        }
      })
    } else {
      // Create new terminal with optimized settings
      const terminal = new Terminal({
        fontSize: preferences.fontSize,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: DARK_THEME,
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 1000, // Limit scrollback to prevent memory bloat
      })

      const fitAddon = new FitAddon()
      const webLinksAddon = new WebLinksAddon()

      terminal.loadAddon(fitAddon)
      terminal.loadAddon(webLinksAddon)

      terminal.open(terminalRef.current)

      xtermRef.current = terminal
      fitAddonRef.current = fitAddon

      // Store in module-level map
      terminals.set(paneId, { terminal, fitAddon })

      // Delay fit to ensure container has dimensions
      requestAnimationFrame(() => {
        if (terminalRef.current && terminalRef.current.offsetWidth > 0) {
          try {
            fitAddon.fit()
            terminal.scrollToBottom() // New terminal always starts at bottom
          } catch (e) {
            // Ignore fit errors
          }
        }
      })

      // Create PTY for this pane (only once globally)
      const initPty = async () => {
        if (initializedPtys.has(paneId)) return
        initializedPtys.add(paneId)

        const success = await window.electronAPI.createPty(
          paneId,
          pane.workingDirectory
        )
        if (success && xtermRef.current) {
          const { cols, rows } = xtermRef.current
          window.electronAPI.resizeTerminal(paneId, cols, rows)
        }
      }
      initPty()

      // Handle input
      terminal.onData((data) => {
        window.electronAPI.sendInput(paneId, data)
      })

      // Set active pane when terminal receives focus (e.g., from clicking on it)
      // Store the listener for proper cleanup later
      const focusHandler = () => {
        useWorkspaceStore.getState().setActivePaneId(paneId)
      }
      if (terminal.textarea) {
        terminal.textarea.addEventListener('focus', focusHandler)
        focusListeners.set(paneId, focusHandler)
      }

      // Track user scroll to allow reading history during output
      // When user scrolls up, disable auto-scroll; when at bottom, re-enable
      terminal.onScroll(() => {
        const atBottom = isTerminalAtBottom(terminal)
        userScrolledUp.set(paneId, !atBottom)
      })

      // Custom key handler to intercept hotkeys before xterm processes them
      terminal.attachCustomKeyEventHandler((e) => {
        // Only handle keydown events
        if (e.type !== 'keydown') return true

        const key = e.key.toLowerCase()

        // Get current hotkeys from store or use defaults
        const hotkeys = useWorkspaceStore.getState().preferences.hotkeys || DEFAULT_HOTKEYS

        // Parse hotkey to check for match
        const matchHotkey = (hotkeyStr: string): boolean => {
          const parts = hotkeyStr.toLowerCase().split('+')
          const hotkeyKey = parts.pop() || ''
          const needsCtrl = parts.includes('ctrl')
          const needsAlt = parts.includes('alt')
          const needsShift = parts.includes('shift')
          const needsMeta = parts.includes('meta') || parts.includes('cmd')

          return (
            key === hotkeyKey &&
            e.ctrlKey === needsCtrl &&
            e.altKey === needsAlt &&
            e.shiftKey === needsShift &&
            e.metaKey === needsMeta
          )
        }

        // Check terminal focus hotkeys FIRST (Ctrl+1-4 by default)
        const hotkeyMap = [
          { hotkey: hotkeys.focusTerminal1, index: 0 },
          { hotkey: hotkeys.focusTerminal2, index: 1 },
          { hotkey: hotkeys.focusTerminal3, index: 2 },
          { hotkey: hotkeys.focusTerminal4, index: 3 },
        ]

        for (const { hotkey, index } of hotkeyMap) {
          if (matchHotkey(hotkey)) {
            e.preventDefault()
            // Dispatch a custom event that useHotkeys can listen for
            window.dispatchEvent(new CustomEvent('terminal-hotkey', { detail: { index } }))
            return false
          }
        }

        // Let layout switching hotkeys pass through (Cmd + 1-6 on Mac, no shift)
        // Only Cmd on Mac to avoid conflict with Ctrl+1-4 terminal focus
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
        if (isMac && e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          if (['1', '2', '3', '4', '5', '6'].includes(key)) {
            // Return false to prevent xterm from handling, let window handler take it
            return false
          }
        } else if (!isMac && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
          if (['1', '2', '3', '4', '5', '6'].includes(key)) {
            return false
          }
        }

        // Let xterm handle all other keys
        return true
      })
    }

    // Handle resize with debounce and dimension check - preserve scroll position
    let resizeTimeout: number
    const handleResize = () => {
      clearTimeout(resizeTimeout)
      resizeTimeout = window.setTimeout(() => {
        if (fitAddonRef.current && xtermRef.current && terminalRef.current) {
          if (terminalRef.current.offsetWidth > 0 && terminalRef.current.offsetHeight > 0) {
            safeFit(xtermRef.current, fitAddonRef.current)
            const { cols, rows } = xtermRef.current
            window.electronAPI.resizeTerminal(paneId, cols, rows)
          }
        }
      }, 50)
    }

    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(terminalRef.current)

    return () => {
      clearTimeout(resizeTimeout)
      resizeObserver.disconnect()
      // Don't dispose terminal or kill PTY - they persist in module-level storage
    }
  }, [paneId]) // Remove pane.workingDirectory from deps to prevent re-init

  // Update font size when preference changes - preserve scroll position
  useEffect(() => {
    if (xtermRef.current && fitAddonRef.current && terminalRef.current) {
      xtermRef.current.options.fontSize = preferences.fontSize
      if (terminalRef.current.offsetWidth > 0) {
        safeFit(xtermRef.current, fitAddonRef.current)
      }
    }
  }, [preferences.fontSize])

  // Update terminal theme when preference changes
  useEffect(() => {
    if (xtermRef.current) {
      const isLight = preferences.theme === 'light' ||
        (preferences.theme === 'system' && !window.matchMedia('(prefers-color-scheme: dark)').matches)
      xtermRef.current.options.theme = isLight ? LIGHT_THEME : DARK_THEME
    }
  }, [preferences.theme])

  // Handle layout changes - ensure terminal stays at bottom after resize settles
  useEffect(() => {
    if (xtermRef.current && fitAddonRef.current && terminalRef.current) {
      const terminal = xtermRef.current
      const fitAddon = fitAddonRef.current
      const wasAtBottom = isTerminalAtBottom(terminal)

      // Give layout transition time to complete, then refit and restore scroll
      const timeoutId = setTimeout(() => {
        if (terminalRef.current && terminalRef.current.offsetWidth > 0) {
          try {
            fitAddon.fit()
          } catch (e) {
            // Ignore fit errors
          }
          if (wasAtBottom) {
            terminal.scrollToBottom()
          }
        }
      }, 200) // Wait for CSS transitions (150ms) to complete

      return () => clearTimeout(timeoutId)
    }
  }, [layout])

  // Listen for terminal output
  // Note: Only paneId in deps - use getState() for store actions to prevent re-registration
  useEffect(() => {
    const unsubscribe = window.electronAPI.onTerminalOutput(
      (outputPaneId, data) => {
        if (outputPaneId === paneId && xtermRef.current) {
          const terminal = xtermRef.current

          // Write data first
          terminal.write(data)

          // Only auto-scroll if user hasn't explicitly scrolled up
          // The userScrolledUp flag is set by the onScroll handler
          if (!userScrolledUp.get(paneId)) {
            terminal.scrollToBottom()
          }

          // Detect Claude activation/deactivation from output
          if (data.includes('Claude Code') || data.includes('claude>')) {
            useWorkspaceStore.getState().setPaneState(paneId, 'claude-active')
          }
        }
      }
    )

    return unsubscribe
  }, [paneId])

  // Listen for PTY exit
  // Note: Only paneId in deps - use getState() for store actions to prevent re-registration
  useEffect(() => {
    const unsubscribe = window.electronAPI.onPtyExit(
      async (exitPaneId, _exitCode) => {
        if (exitPaneId === paneId) {
          const store = useWorkspaceStore.getState()

          // Get the current directory before resetting
          const cwd = await window.electronAPI.getCwd(paneId)
          if (cwd) {
            store.setPaneCwd(paneId, cwd)
          }

          // Reset pane to shell state
          store.setPaneState(paneId, 'shell')

          // Mark PTY as not initialized so it can be recreated
          initializedPtys.delete(paneId)

          // Recreate PTY in the same directory
          const paneConfig = store.panes.find((p) => p.id === paneId)
          initializedPtys.add(paneId)
          await window.electronAPI.createPty(
            paneId,
            paneConfig?.workingDirectory
          )

          // Clear and resize terminal - scroll to bottom since we cleared
          if (xtermRef.current && fitAddonRef.current && terminalRef.current) {
            xtermRef.current.clear()
            userScrolledUp.set(paneId, false) // Reset scroll state after clear
            if (terminalRef.current.offsetWidth > 0) {
              try {
                fitAddonRef.current.fit()
                xtermRef.current.scrollToBottom() // After clear, always at bottom
                const { cols, rows } = xtermRef.current
                window.electronAPI.resizeTerminal(paneId, cols, rows)
              } catch (e) {
                // Ignore
              }
            }
          }
        }
      }
    )

    return unsubscribe
  }, [paneId])

  // Poll for current working directory updates
  // Note: Only paneId in deps - use getState() for store access to prevent re-registration
  useEffect(() => {
    const updateCwd = async () => {
      const cwd = await window.electronAPI.getCwd(paneId)
      if (cwd) {
        const store = useWorkspaceStore.getState()
        const currentPane = store.panes.find((p) => p.id === paneId)
        if (currentPane && cwd !== currentPane.workingDirectory) {
          store.setPaneCwd(paneId, cwd)
        }
      }
    }

    // Update immediately and then every 10 seconds (reduced from 2s to lower IPC overhead)
    updateCwd()
    const interval = setInterval(updateCwd, 10000)

    return () => clearInterval(interval)
  }, [paneId])

  // Handle click to focus
  const handleClick = useCallback(() => {
    setActivePaneId(paneId)
    xtermRef.current?.focus()
  }, [paneId, setActivePaneId])

  // Handle drag and drop
  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()

    // Check if this is a pane drag
    if (e.dataTransfer.types.includes(PANE_DRAG_TYPE)) {
      setIsPaneDragOver(true)
      setIsDragOver(false)
    } else {
      setIsDragOver(true)
      setIsPaneDragOver(false)
    }
  }, [])

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    setIsPaneDragOver(false)
  }, [])

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    setIsPaneDragOver(false)

    // Check if this is a pane drag
    const draggedPaneId = e.dataTransfer.getData(PANE_DRAG_TYPE)
    if (draggedPaneId) {
      const sourcePaneId = parseInt(draggedPaneId, 10)
      if (sourcePaneId !== paneId && layout !== 'fullscreen') {
        // Swap pane positions - this visually swaps them since grid uses array position
        swapPanes(sourcePaneId, paneId)
      }
      return
    }

    setActivePaneId(paneId)

    // Get dropped files
    const files = e.dataTransfer.files
    if (files.length > 0) {
      // Build a string of all file paths, space-separated and quoted if needed
      const paths: string[] = []
      for (let i = 0; i < files.length; i++) {
        const file = files[i] as File & { path?: string }
        if (file.path) {
          // Escape spaces and special characters by quoting
          const path = file.path.includes(' ') ? `"${file.path}"` : file.path
          paths.push(path)
        }
      }

      if (paths.length > 0) {
        // Insert paths into the terminal
        const pathString = paths.join(' ')
        window.electronAPI.sendInput(paneId, pathString)
        xtermRef.current?.focus()
      }
    }
  }, [paneId, setActivePaneId, layout, swapPanes])

  if (!pane) return null

  const borderClass = isPaneDragOver
    ? 'border-claude-pink/50'
    : isDragOver
      ? 'border-claude-pink/30'
      : isActive
        ? 'border-claude-pink/40'
        : 'border-terminal-border'

  return (
    <div
      className={`h-full min-h-0 flex flex-col bg-terminal-bg overflow-hidden border transition-colors relative ${borderClass}`}
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <PaneHeader paneId={paneId} />
      <div
        ref={terminalRef}
        className="flex-1 min-h-0 terminal-container"
        role="application"
        aria-label={`Terminal ${paneId + 1}`}
      />
      {isDragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-claude-pink/10 pointer-events-none font-mono">
          <div className="text-claude-pink text-sm">[ drop file here ]</div>
        </div>
      )}
      {isPaneDragOver && layout !== 'fullscreen' && (
        <div className="absolute inset-0 flex items-center justify-center bg-claude-pink/10 pointer-events-none font-mono">
          <div className="text-claude-pink text-sm">[ swap ]</div>
        </div>
      )}
    </div>
  )
})
