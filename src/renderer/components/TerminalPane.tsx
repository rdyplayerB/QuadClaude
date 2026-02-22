import { useEffect, useRef, useCallback, useState, DragEvent, memo } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
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
// Guard to prevent onScroll from resetting userScrolledUp during programmatic writes
const isWritingOutput = new Map<number, boolean>()

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
    isWritingOutput.delete(paneId)

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

// Git Status Bar component - only displayed when Claude is active
const GitStatusBar = memo(function GitStatusBar({ paneId }: { paneId: number }) {
  const [showTooltip, setShowTooltip] = useState(false)
  const pane = useWorkspaceStore((state) => state.panes.find((p) => p.id === paneId))
  const gitStatus = pane?.gitStatus
  const workingDir = pane?.workingDirectory || ''
  const shortPath = workingDir.replace(/^\/Users\/[^/]+/, '~')

  // Only show status bar when Claude is active
  if (pane?.state !== 'claude-active') {
    return null
  }

  return (
    <div className="flex items-center justify-between px-3 h-7 bg-[--terminal-bg] font-mono text-xs shrink-0">
      {/* Left side - git info */}
      <div
        className="relative flex items-center gap-2"
        onMouseEnter={() => gitStatus?.isGitRepo && setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        {gitStatus?.isGitRepo ? (
          <>
            <span className="flex items-center gap-1.5">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" className="text-[--git-green]">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
              </svg>
              <span className="text-[--git-green]">{gitStatus.branch}</span>
            </span>
            {(gitStatus.ahead ?? 0) > 0 && (
              <span className="text-[--git-cyan] flex items-center gap-0.5">
                <span className="text-[10px]">↑</span>
                <span>{gitStatus.ahead}</span>
              </span>
            )}
            {(gitStatus.behind ?? 0) > 0 && (
              <span className="text-[--git-yellow] flex items-center gap-0.5">
                <span className="text-[10px]">↓</span>
                <span>{gitStatus.behind}</span>
              </span>
            )}
            {(gitStatus.dirty ?? 0) > 0 && (
              <span className="text-[--git-orange] flex items-center gap-0.5">
                <span className="text-[10px]">●</span>
                <span>{gitStatus.dirty}</span>
              </span>
            )}
            {/* Tooltip - positioned above */}
            {showTooltip && (
              <div className="absolute bottom-full left-0 mb-2 px-3 py-2 bg-[--ui-bg-elevated] border border-[--ui-border] rounded-lg shadow-xl text-xs whitespace-nowrap z-50">
                <div className="text-[--ui-text-primary] mb-1.5">
                  <span className="text-[--git-green]">{gitStatus.branch}</span> branch
                </div>
                {(gitStatus.ahead ?? 0) > 0 && (
                  <div className="text-[--git-cyan] py-0.5">↑ {gitStatus.ahead} commit{gitStatus.ahead !== 1 ? 's' : ''} ahead</div>
                )}
                {(gitStatus.behind ?? 0) > 0 && (
                  <div className="text-[--git-yellow] py-0.5">↓ {gitStatus.behind} commit{gitStatus.behind !== 1 ? 's' : ''} behind</div>
                )}
                {(gitStatus.dirty ?? 0) > 0 && (
                  <div className="text-[--git-orange] py-0.5">● {gitStatus.dirty} uncommitted</div>
                )}
                {(gitStatus.ahead ?? 0) === 0 && (gitStatus.behind ?? 0) === 0 && (gitStatus.dirty ?? 0) === 0 && (
                  <div className="text-[--ui-text-muted] py-0.5">Clean working tree</div>
                )}
              </div>
            )}
          </>
        ) : (
          <span className="text-[--ui-text-faint]">—</span>
        )}
      </div>
      {/* Right side - path */}
      <div className="text-[--ui-text-dimmed] truncate max-w-[300px]" title={workingDir}>
        {shortPath}
      </div>
    </div>
  )
})

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
        scrollOnUserInput: false, // Preserve scroll position when user types
      })

      const fitAddon = new FitAddon()
      const webLinksAddon = new WebLinksAddon()

      terminal.loadAddon(fitAddon)
      terminal.loadAddon(webLinksAddon)

      terminal.open(terminalRef.current)

      // Load WebGL addon for GPU-accelerated rendering (with fallback)
      try {
        const webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => {
          webglAddon.dispose()
        })
        terminal.loadAddon(webglAddon)
      } catch (e) {
        // WebGL not available, fall back to default canvas renderer
        console.warn('WebGL addon failed to load, using default renderer:', e)
      }

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
      // Skip updates during programmatic writes to preserve user's scroll position
      terminal.onScroll(() => {
        if (isWritingOutput.get(paneId)) return
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

        // Let layout switching and command palette hotkeys pass through
        // Only Cmd on Mac to avoid conflict with Ctrl+1-4 terminal focus
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
        if (isMac && e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          if (['1', '2', '3', 'p'].includes(key)) {
            // Return false to prevent xterm from handling, let window handler take it
            return false
          }
        } else if (!isMac && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
          if (['1', '2', '3', 'p'].includes(key)) {
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
  // Debounced to handle rapid Cmd+/- presses and notify PTY of new dimensions
  useEffect(() => {
    if (!xtermRef.current || !fitAddonRef.current || !terminalRef.current) return

    const terminal = xtermRef.current
    const fitAddon = fitAddonRef.current
    const container = terminalRef.current

    // Debounce to coalesce rapid font size changes
    const timeoutId = setTimeout(() => {
      terminal.options.fontSize = preferences.fontSize

      if (container.offsetWidth > 0) {
        // Pause output handling during resize to prevent visual corruption
        isWritingOutput.set(paneId, true)

        safeFit(terminal, fitAddon)

        // Notify PTY of new dimensions so shell reflows correctly
        const { cols, rows } = terminal
        window.electronAPI.resizeTerminal(paneId, cols, rows)

        // Resume output handling after a brief delay for reflow
        requestAnimationFrame(() => {
          isWritingOutput.set(paneId, false)
        })
      }
    }, 50)

    return () => clearTimeout(timeoutId)
  }, [preferences.fontSize, paneId])

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
    if (!xtermRef.current || !fitAddonRef.current || !terminalRef.current) return

    const terminal = xtermRef.current
    const fitAddon = fitAddonRef.current
    const wasAtBottom = isTerminalAtBottom(terminal)

    // Give layout transition time to complete, then refit and restore scroll
    const timeoutId = setTimeout(() => {
      if (terminalRef.current && terminalRef.current.offsetWidth > 0) {
        // Pause output handling during resize
        isWritingOutput.set(paneId, true)

        try {
          fitAddon.fit()
        } catch (e) {
          // Ignore fit errors
        }

        // Notify PTY of new dimensions
        const { cols, rows } = terminal
        window.electronAPI.resizeTerminal(paneId, cols, rows)

        if (wasAtBottom) {
          terminal.scrollToBottom()
        }

        // Resume output handling
        requestAnimationFrame(() => {
          isWritingOutput.set(paneId, false)
        })
      }
    }, 200) // Wait for CSS transitions (150ms) to complete

    return () => clearTimeout(timeoutId)
  }, [layout, paneId])

  // Listen for terminal output
  // Note: Only paneId in deps - use getState() for store actions to prevent re-registration
  useEffect(() => {
    const unsubscribe = window.electronAPI.onTerminalOutput(
      (outputPaneId, data) => {
        if (outputPaneId === paneId && xtermRef.current) {
          const terminal = xtermRef.current
          const hasUserScrolledUp = userScrolledUp.get(paneId)

          // If user has scrolled up, save position before write (xterm auto-scrolls on write)
          let savedViewportY: number | null = null
          if (hasUserScrolledUp) {
            savedViewportY = terminal.buffer.active.viewportY
            isWritingOutput.set(paneId, true) // Guard against onScroll resetting our flag
          }

          // Write data
          terminal.write(data)

          // Restore scroll position if user was scrolled up, otherwise scroll to bottom
          if (hasUserScrolledUp && savedViewportY !== null) {
            // xterm auto-scrolls on write, so scroll back up to where user was
            // viewportY is the top line visible; after write it's at baseY (bottom)
            const currentViewportY = terminal.buffer.active.viewportY
            const linesToScrollBack = savedViewportY - currentViewportY
            if (linesToScrollBack !== 0) {
              terminal.scrollLines(linesToScrollBack)
            }
            isWritingOutput.set(paneId, false) // Clear guard
          } else {
            terminal.scrollToBottom()
          }

          // Claude status is now detected via process polling, not output matching
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
            isWritingOutput.set(paneId, false)
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

  // Poll for Claude process status (fast, lightweight check)
  // Note: Only paneId in deps - use getState() for store access to prevent re-registration
  useEffect(() => {
    const checkClaudeStatus = async () => {
      const store = useWorkspaceStore.getState()
      const currentPane = store.panes.find((p) => p.id === paneId)
      const currentState = currentPane?.state || 'shell'

      // Check if Claude process is actually running - this is the source of truth
      const isClaudeRunning = await window.electronAPI.isClaudeRunning(paneId)

      if (isClaudeRunning && currentState !== 'claude-active') {
        store.setPaneState(paneId, 'claude-active')
      } else if (!isClaudeRunning && currentState === 'claude-active') {
        store.setPaneState(paneId, 'shell')
      }
    }

    // Check Claude status every 2 seconds (pgrep is lightweight)
    checkClaudeStatus()
    const interval = setInterval(checkClaudeStatus, 2000)

    return () => clearInterval(interval)
  }, [paneId])

  // Poll for CWD and git status (heavier operations, less frequent)
  useEffect(() => {
    let pollCount = 0

    const updateCwdAndGitStatus = async () => {
      const store = useWorkspaceStore.getState()
      const currentPane = store.panes.find((p) => p.id === paneId)

      // Update CWD every poll (5 seconds)
      const cwd = await window.electronAPI.getCwd(paneId)
      if (cwd && currentPane && cwd !== currentPane.workingDirectory) {
        store.setPaneCwd(paneId, cwd)
      }

      // Only update git status every 3rd poll (15 seconds) AND only when Claude is active
      pollCount++
      if (pollCount >= 3 && currentPane?.state === 'claude-active') {
        pollCount = 0
        const gitStatus = await window.electronAPI.getGitStatus(paneId)
        if (gitStatus) {
          store.setPaneGitStatus(paneId, gitStatus)
        }
      }
    }

    // Initial update
    updateCwdAndGitStatus()
    const interval = setInterval(updateCwdAndGitStatus, 5000)

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
      if (sourcePaneId !== paneId) {
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

  // Border styling - always visible to define pane boundaries
  const getBorderClass = () => {
    if (isPaneDragOver) return 'border-2 border-[--accent]'
    if (isDragOver) return 'border-2 border-[--accent]/50'
    if (isActive) return 'border-2 border-[--accent]/70'
    return 'border border-[#444]'  // Visible gray border for inactive panes
  }

  return (
    <div
      className={`h-full min-h-0 flex flex-col bg-[--ui-bg-elevated] overflow-hidden rounded-lg transition-all relative ${getBorderClass()}`}
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <PaneHeader paneId={paneId} />
      {/* Terminal + status bar wrapper - shared background eliminates black band */}
      <div className="flex-1 min-h-0 flex flex-col bg-[--terminal-bg]">
        <div
          ref={terminalRef}
          className="flex-1 min-h-0 terminal-container"
          role="application"
          aria-label={`Terminal ${paneId + 1}`}
        />
        <GitStatusBar paneId={paneId} />
      </div>
      {isDragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-[--accent]/10 pointer-events-none font-mono rounded-sm">
          <div className="text-[--accent] text-sm font-medium">Drop file here</div>
        </div>
      )}
      {isPaneDragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-[--accent]/10 pointer-events-none font-mono rounded-sm">
          <div className="text-[--accent] text-sm font-medium">Swap terminals</div>
        </div>
      )}
    </div>
  )
})
