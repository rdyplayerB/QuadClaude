import { useEffect, useRef, useCallback, useState, DragEvent, memo } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { CanvasAddon } from '@xterm/addon-canvas'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../store/workspace'
import { PaneHeader, PANE_DRAG_TYPE } from './PaneHeader'
import { DEFAULT_HOTKEYS, DEFAULT_BACKGROUND } from '../../shared/types'

// Module-level tracking to persist across component remounts
const initializedPtys = new Set<number>()
const terminals = new Map<number, { terminal: Terminal; fitAddon: FitAddon }>()
// Track focus listeners for proper cleanup
const focusListeners = new Map<number, () => void>()
// Track user scroll state - prevents auto-scroll when user has scrolled up
const userScrolledUp = new Map<number, boolean>()
// Guard to prevent onScroll from resetting userScrolledUp during programmatic writes
const isWritingOutput = new Map<number, boolean>()
// Pending output buffer - when user is scrolled up, batch writes to reduce flicker
const pendingOutput = new Map<number, string[]>()
const pendingFlush = new Map<number, number>() // RAF handle per pane
// Debounced timer per pane for scanning the buffer for Claude decision prompts
const promptScanTimers = new Map<number, ReturnType<typeof setTimeout>>()

// Scan the visible terminal buffer for Claude Code's yes/no decision prompt.
// Claude renders a selectable list ("❯ 1. Yes") inside a question box; we look
// for the selector arrow on a numbered option together with prompt wording.
function scanForClaudePrompt(terminal: Terminal): boolean {
  const buf = terminal.buffer.active
  const end = buf.baseY + terminal.rows
  const start = Math.max(0, end - 40)
  let text = ''
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i)
    if (line) text += line.translateToString(true) + '\n'
  }
  const hasSelector = /❯\s*\d+\.\s/.test(text)
  const hasDecision =
    /\b\d+\.\s*Yes\b/i.test(text) ||
    /Do you want to (proceed|continue|make this edit|create|run)/i.test(text)
  return hasSelector && hasDecision
}

// Soft two-note chime synthesized via WebAudio (no asset needed)
let chimeCtx: AudioContext | null = null
function playDecisionChime() {
  try {
    const prefs = useWorkspaceStore.getState().preferences
    if (prefs.decisionSoundEnabled === false) return
    chimeCtx = chimeCtx || new AudioContext()
    const ctx = chimeCtx
    const now = ctx.currentTime
    ;[880, 1174.7].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      osc.connect(gain)
      gain.connect(ctx.destination)
      const t = now + i * 0.13
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.14, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35)
      osc.start(t)
      osc.stop(t + 0.4)
    })
  } catch {
    // Audio unavailable - visual indicator still applies
  }
}

// Coalesced terminal write: drain all chunks buffered this frame in ONE
// terminal.write() + ONE scroll op. A dev server emits dozens-hundreds of
// tiny chunks/sec; writing+scrolling per chunk (the old common path) was the
// single biggest CPU cost across 4 panes.
function flushOutput(paneId: number, terminal: Terminal) {
  const chunks = pendingOutput.get(paneId)
  if (!chunks || chunks.length === 0) return
  pendingOutput.set(paneId, [])
  const joined = chunks.join('')
  isWritingOutput.set(paneId, true)
  if (userScrolledUp.get(paneId)) {
    // Preserve the user's scroll position across the batched write
    const savedViewportY = terminal.buffer.active.viewportY
    terminal.write(joined)
    const delta = savedViewportY - terminal.buffer.active.viewportY
    if (delta !== 0) terminal.scrollLines(delta)
  } else {
    terminal.write(joined)
    terminal.scrollToBottom()
  }
  isWritingOutput.set(paneId, false)
}

// Re-evaluate active vs waiting from the buffer, transitioning state and
// chiming once when a pane newly enters the waiting state.
function refreshClaudeWaitingState(paneId: number, terminal: Terminal | null) {
  const store = useWorkspaceStore.getState()
  const current = store.panes.find((p) => p.id === paneId)?.state
  // Only meaningful while Claude is believed to be running
  if (current !== 'claude-active' && current !== 'claude-waiting') return
  const waiting = terminal ? scanForClaudePrompt(terminal) : false
  const next = waiting ? 'claude-waiting' : 'claude-active'
  if (current !== next) {
    store.setPaneState(paneId, next)
    if (next === 'claude-waiting') playDecisionChime()
  }
}

// Cached parsed hotkeys for fast key event matching
interface ParsedHotkey {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}
let cachedHotkeys: { raw: typeof DEFAULT_HOTKEYS; parsed: Map<string, ParsedHotkey> } | null = null

function parseHotkey(hotkeyStr: string): ParsedHotkey {
  const parts = hotkeyStr.toLowerCase().split('+')
  const key = parts.pop() || ''
  return {
    key,
    ctrl: parts.includes('ctrl'),
    alt: parts.includes('alt'),
    shift: parts.includes('shift'),
    meta: parts.includes('meta') || parts.includes('cmd'),
  }
}

function getParsedHotkeys(hotkeys: typeof DEFAULT_HOTKEYS): Map<string, ParsedHotkey> {
  // Return cached if hotkeys haven't changed
  if (cachedHotkeys && cachedHotkeys.raw === hotkeys) {
    return cachedHotkeys.parsed
  }
  // Parse and cache
  const parsed = new Map<string, ParsedHotkey>()
  parsed.set('focusTerminal1', parseHotkey(hotkeys.focusTerminal1))
  parsed.set('focusTerminal2', parseHotkey(hotkeys.focusTerminal2))
  parsed.set('focusTerminal3', parseHotkey(hotkeys.focusTerminal3))
  parsed.set('focusTerminal4', parseHotkey(hotkeys.focusTerminal4))
  cachedHotkeys = { raw: hotkeys, parsed }
  return parsed
}

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

export function scrollAllTerminalsToBottom() {
  terminals.forEach((entry) => {
    entry.terminal.scrollToBottom()
  })
}

// Dispose and cleanup a terminal when pane is deleted or app closes
function disposeTerminal(paneId: number) {
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
    pendingOutput.delete(paneId)
    const raf = pendingFlush.get(paneId)
    if (raf) cancelAnimationFrame(raf)
    pendingFlush.delete(paneId)
    const scanTimer = promptScanTimers.get(paneId)
    if (scanTimer) clearTimeout(scanTimer)
    promptScanTimers.delete(paneId)

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
  if (chimeCtx) {
    chimeCtx.close().catch(() => {})
    chimeCtx = null
  }
}

// Helper to check if terminal is scrolled to bottom
function isTerminalAtBottom(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active
  // Add small tolerance (1 row) to account for edge cases
  return buffer.baseY + terminal.rows >= buffer.length - 1
}

// Git Status Bar component - always visible
const GitStatusBar = memo(function GitStatusBar({ paneId }: { paneId: number }) {
  const [showTooltip, setShowTooltip] = useState(false)
  const pane = useWorkspaceStore((state) => state.panes.find((p) => p.id === paneId))
  const gitStatus = pane?.gitStatus

  return (
    <div className="flex items-center justify-end px-3 h-7 glass-header font-mono text-xs shrink-0 border-t border-white/[0.04] overflow-hidden min-w-0">
      {/* Right side - branch and changes */}
      <div
        className="relative flex items-center gap-2 min-w-0 shrink-0"
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
              <div className="absolute bottom-full right-0 mb-2 px-3 py-2 bg-[--ui-bg-elevated] border border-[--ui-border] rounded-lg shadow-xl text-xs whitespace-nowrap z-50">
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

  // Atomic selectors: this pane only re-renders when ITS OWN slice changes,
  // not when any other pane's state/git/cwd updates (the old whole-store
  // subscription caused all 4 panes to re-render on every pane change).
  const pane = useWorkspaceStore((s) => s.panes.find((p) => p.id === paneId))
  const isActive = useWorkspaceStore((s) => s.activePaneId === paneId)
  const focusPaneId = useWorkspaceStore((s) => s.focusPaneId)
  const layout = useWorkspaceStore((s) => s.layout)
  const preferences = useWorkspaceStore((s) => s.preferences)
  const setActivePaneId = useWorkspaceStore((s) => s.setActivePaneId)
  const setFocusPaneId = useWorkspaceStore((s) => s.setFocusPaneId)
  const swapPanes = useWorkspaceStore((s) => s.swapPanes)
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
          if (wasAtBottom) {
            existing.terminal.scrollToBottom()
          }
          const { cols, rows } = existing.terminal
          window.electronAPI.resizeTerminal(paneId, cols, rows)
        }
      })
    } else {
      // Create new terminal with optimized settings
      // allowTransparency enables background image to show through terminal
      const terminal = new Terminal({
        fontSize: preferences.fontSize,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: DARK_THEME,
        cursorBlink: true,
        allowProposedApi: true,
        allowTransparency: true,
        scrollback: 1000, // Limit scrollback to prevent memory bloat
        scrollOnUserInput: false, // Preserve scroll position when user types
      })

      const fitAddon = new FitAddon()
      const webLinksAddon = new WebLinksAddon()

      terminal.loadAddon(fitAddon)
      terminal.loadAddon(webLinksAddon)

      terminal.open(terminalRef.current)

      // GPU-accelerated Canvas renderer. Must be loaded AFTER open(). Canvas
      // (unlike WebGL) honors allowTransparency, so the glass/wallpaper UI
      // still shows through. This is the big CPU win under heavy log output
      // vs xterm's fallback DOM renderer.
      try {
        terminal.loadAddon(new CanvasAddon())
      } catch (e) {
        // If the canvas context can't be created, xterm falls back to DOM
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
            terminal.scrollToBottom()
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
      // Uses cached parsed hotkeys to avoid string parsing on every keystroke
      terminal.attachCustomKeyEventHandler((e) => {
        // Only handle keydown events
        if (e.type !== 'keydown') return true

        const key = e.key.toLowerCase()

        // Get cached parsed hotkeys (re-parses only when hotkeys change)
        const hotkeys = useWorkspaceStore.getState().preferences.hotkeys || DEFAULT_HOTKEYS
        const parsed = getParsedHotkeys(hotkeys)

        // Check terminal focus hotkeys (Ctrl+1-4 by default)
        const focusKeys = [
          { name: 'focusTerminal1', index: 0 },
          { name: 'focusTerminal2', index: 1 },
          { name: 'focusTerminal3', index: 2 },
          { name: 'focusTerminal4', index: 3 },
        ]

        for (const { name, index } of focusKeys) {
          const hk = parsed.get(name)
          if (hk && key === hk.key && e.ctrlKey === hk.ctrl && e.altKey === hk.alt && e.shiftKey === hk.shift && e.metaKey === hk.meta) {
            e.preventDefault()
            window.dispatchEvent(new CustomEvent('terminal-hotkey', { detail: { index } }))
            return false
          }
        }

        // Let layout switching and command palette hotkeys pass through
        // Only Cmd on Mac to avoid conflict with Ctrl+1-4 terminal focus
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
        if (isMac && e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          if (['1', '2', '3', 'p'].includes(key)) {
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

  // Update terminal theme when preference changes (including background transparency)
  useEffect(() => {
    if (xtermRef.current) {
      const baseTheme = DARK_THEME
      const bg = preferences.background ?? DEFAULT_BACKGROUND

      if (bg.enabled && bg.image) {
        // Fully transparent background so the background image shows through
        xtermRef.current.options.theme = { ...baseTheme, background: '#00000000' }
      } else {
        xtermRef.current.options.theme = baseTheme
      }
    }
  }, [preferences.background?.enabled, preferences.background?.image])

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
          if (terminalRef.current) closeRowGap(terminalRef.current)
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

          // Accumulate; flush once per animation frame (both at-bottom and
          // scrolled-up paths). One write + one scroll per frame per pane.
          let buf = pendingOutput.get(paneId)
          if (!buf) {
            buf = []
            pendingOutput.set(paneId, buf)
          }
          buf.push(data)
          if (!pendingFlush.has(paneId)) {
            pendingFlush.set(
              paneId,
              requestAnimationFrame(() => {
                pendingFlush.delete(paneId)
                flushOutput(paneId, terminal)
              })
            )
          }

          // Debounced prompt scan: only meaningful while Claude is running, so
          // don't even arm the timer (or build the scan string) in shell state.
          const st = useWorkspaceStore
            .getState()
            .panes.find((p) => p.id === paneId)?.state
          if (st === 'claude-active' || st === 'claude-waiting') {
            const existingTimer = promptScanTimers.get(paneId)
            if (existingTimer) clearTimeout(existingTimer)
            promptScanTimers.set(
              paneId,
              setTimeout(() => {
                promptScanTimers.delete(paneId)
                refreshClaudeWaitingState(paneId, xtermRef.current)
              }, 400)
            )
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
      // Don't poll while the window is hidden/minimized/occluded
      if (document.hidden) return
      const store = useWorkspaceStore.getState()
      const currentPane = store.panes.find((p) => p.id === paneId)
      const currentState = currentPane?.state || 'shell'

      // Check if Claude process is actually running - this is the source of truth
      const isClaudeRunning = await window.electronAPI.isClaudeRunning(paneId)

      if (!isClaudeRunning) {
        if (currentState !== 'shell') store.setPaneState(paneId, 'shell')
        return
      }

      // Claude is running: classify active vs waiting from the buffer.
      const waiting = xtermRef.current ? scanForClaudePrompt(xtermRef.current) : false
      const next = waiting ? 'claude-waiting' : 'claude-active'
      if (currentState !== next) {
        store.setPaneState(paneId, next)
        // Chime on any transition into waiting (poll covers cases the
        // output-settle scan missed); guarded so it fires once per prompt.
        if (next === 'claude-waiting') playDecisionChime()
      }
    }

    // Stagger initial check by paneId to avoid all 4 panes hitting IPC at once
    const startDelay = setTimeout(() => {
      checkClaudeStatus()
    }, 500 + paneId * 300)
    const interval = setInterval(checkClaudeStatus, 3000)

    return () => { clearTimeout(startDelay); clearInterval(interval) }
  }, [paneId])

  // Poll for CWD and git status (heavier operations, less frequent)
  useEffect(() => {
    let pollCount = 0

    const updateCwdAndGitStatus = async () => {
      // Don't poll while the window is hidden/minimized/occluded
      if (document.hidden) return
      const store = useWorkspaceStore.getState()
      const currentPane = store.panes.find((p) => p.id === paneId)

      // Update CWD every poll (5 seconds)
      const cwd = await window.electronAPI.getCwd(paneId)
      if (cwd && currentPane && cwd !== currentPane.workingDirectory) {
        store.setPaneCwd(paneId, cwd)
      }

      // Update git status on first poll, then every 3rd poll (15 seconds)
      pollCount++
      if (pollCount === 1 || pollCount >= 3) {
        if (pollCount >= 3) pollCount = 0
        const gitStatus = await window.electronAPI.getGitStatus(paneId)
        if (gitStatus) {
          store.setPaneGitStatus(paneId, gitStatus)
        }
      }
    }

    // Stagger initial update by paneId
    const startDelay = setTimeout(() => {
      updateCwdAndGitStatus()
    }, 2000 + paneId * 500)
    const interval = setInterval(updateCwdAndGitStatus, 5000)

    return () => { clearTimeout(startDelay); clearInterval(interval) }
  }, [paneId])

  // Handle click to focus
  const handleClick = useCallback(() => {
    setActivePaneId(paneId)
    xtermRef.current?.focus()
  }, [paneId, setActivePaneId])

  // Handle double-click in focus mode (both focus and focus-right):
  // - On a small pane: make it the big pane
  // - On the big pane: do nothing (already focused)
  const handleDoubleClick = useCallback(() => {
    if (layout === 'focus' || layout === 'focus-right') {
      if (paneId !== focusPaneId) {
        // Double-clicked a small pane - make it the big one
        setFocusPaneId(paneId)
        xtermRef.current?.focus()
      }
    }
  }, [layout, paneId, focusPaneId, setFocusPaneId])

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
        const filePath = window.electronAPI.getPathForFile(files[i])
        if (filePath) {
          // Escape spaces and special characters by quoting
          const path = filePath.includes(' ') ? `"${filePath}"` : filePath
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

  const background = preferences.background ?? DEFAULT_BACKGROUND
  const bgEnabled = background.enabled && !!background.image

  // Border styling - thin glass-style borders
  const getBorderClass = () => {
    if (isPaneDragOver) return 'border border-[--accent]'
    if (isDragOver) return 'border border-[--accent]/50'
    if (isActive) return 'border border-white/[0.1]'
    return 'border border-white/[0.05]'
  }

  // Background image for this pane (per-pane mode allows different images per pane)
  const paneBgImage = bgEnabled
    ? (background.mode === 'per-pane'
      ? (background.paneImages?.[paneId] ?? background.image)
      : background.image)
    : null

  return (
    <div
      className={`group h-full min-h-0 flex flex-col overflow-hidden rounded transition-all relative ${getBorderClass()} glass-elevated ${pane.state === 'claude-waiting' ? 'claude-waiting-pane' : ''}`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <PaneHeader paneId={paneId} />
      {/* Terminal wrapper - fills all remaining space */}
      <div
        className="flex-1 min-h-0 relative"
        style={paneBgImage ? {
          backgroundImage: `url(${paneBgImage?.startsWith('/') ? `file://${paneBgImage}` : paneBgImage})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          ...(background.mode === 'unified' ? { backgroundAttachment: 'fixed' } : {}),
        } : undefined}
      >
        {/* Opacity overlay - controls how much wallpaper shows through */}
        {bgEnabled && (
          <div
            className="absolute inset-0 pointer-events-none z-0"
            style={{ backgroundColor: `rgba(var(--terminal-bg-rgb), ${background.opacity})` }}
          />
        )}
        <div
          ref={terminalRef}
          className="absolute inset-0 terminal-container z-[1]"
          role="application"
          aria-label={`Terminal ${paneId + 1}`}
        />
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
