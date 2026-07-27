import { useEffect, useRef, useCallback, useState, DragEvent, memo } from 'react'
import { Terminal, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { CanvasAddon } from '@xterm/addon-canvas'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../store/workspace'
import { PaneHeader, PANE_DRAG_TYPE } from './PaneHeader'
import { DEFAULT_HOTKEYS, DEFAULT_BACKGROUND, DEFAULT_AGENT_PROFILES, AgentProfile, PaneConfig, PaneState, WorkspacePreferences } from '../../shared/types'
import { visiblePaneCount } from '../layouts'
import { paneLog, armBlankWatchdog, notePaneOutput, clearBlankWatchdog } from '../paneDiag'

// Module-level tracking to persist across component remounts
const initializedPtys = new Set<number>()
// Diagnostics: last createPty result + cumulative fit attempts per pane, fed
// into the blank-pane watchdog snapshot (see paneDiag.ts).
const ptyCreateResult = new Map<number, boolean>()
const fitAttempts = new Map<number, number>()
const terminals = new Map<number, { terminal: Terminal; fitAddon: FitAddon }>()
// Track focus listeners for proper cleanup
const focusListeners = new Map<number, () => void>()
// Track user scroll state - prevents auto-scroll when user has scrolled up
const userScrolledUp = new Map<number, boolean>()
// Guard to prevent onScroll from resetting userScrolledUp during programmatic writes
const isWritingOutput = new Map<number, boolean>()
// Pending output chunks per pane, drained on the next flush.
const pendingOutput = new Map<number, string[]>()
// Live byte total + cumulative dropped bytes per pane. With PENDING_OUTPUT_CAP,
// these bound the renderer's heap when Chromium pauses RAF on a hidden /
// occluded window while dev servers and Claude keep streaming output (the
// 204 GB blowup path - oldest chunks get evicted, never accumulate forever).
const pendingBytes = new Map<number, number>()
const droppedBytes = new Map<number, number>()
const PENDING_OUTPUT_CAP = 256 * 1024
// Each scheduled flush holds BOTH a RAF (smooth path while visible) and a
// setTimeout backstop (drains when RAF is paused). Whichever fires first
// drains the buffer and cancels the other.
interface PendingFlushHandles {
  raf: number | null
  timer: ReturnType<typeof setTimeout> | null
}
const pendingFlush = new Map<number, PendingFlushHandles>()
// Debounced timer per pane for scanning the buffer for Claude decision prompts
const promptScanTimers = new Map<number, ReturnType<typeof setTimeout>>()
// Per-pane Canvas renderer addon. Kept so it can be reloaded when the
// background toggles (the canvas addon bakes in transparency at load time
// and won't honor a later theme-background alpha change reliably).
const canvasAddons = new Map<number, CanvasAddon>()
// Cumulative bytes this pane's terminal has RECEIVED (renderer side). Bumped
// once per output batch — cheap. Lets diagnostics tell "no output ever arrived"
// apart from "output arrived but never painted" (the two blank-pane causes).
const paneReceivedBytes = new Map<number, number>()
// --- Claude busy detection -----------------------------------------------
// Claude animates a spinner with a live elapsed timer while it works, so a
// working pane writes to its PTY several times a second; a pane parked at the
// input box writes nothing at all (the cursor blink is drawn client-side).
// That makes PTY output the one busy signal that doesn't depend on scraping
// Claude's UI — the affordance strings change between versions, so matching
// them would rot. Two refinements keep it honest:
//   - a lone repaint burst isn't work, so output must run for OUTPUT_STREAK_MS
//     before it counts as busy;
//   - the echo of your own typing is output too, so a keystroke resets the streak.
const lastOutputAt = new Map<number, number>()
const outputStreakFrom = new Map<number, number>()
const OUTPUT_QUIET_MS = 3000 // silent this long → the turn is over
const OUTPUT_STREAK_MS = 800 // output running this long → genuinely working
const OUTPUT_GAP_MS = 1500 // a gap this big starts a new streak

function noteOutput(paneId: number) {
  const now = Date.now()
  const prev = lastOutputAt.get(paneId) ?? 0
  if (now - prev > OUTPUT_GAP_MS) outputStreakFrom.set(paneId, now)
  lastOutputAt.set(paneId, now)
}

function noteInput(paneId: number) {
  outputStreakFrom.set(paneId, Date.now())
}

function isClaudeBusy(paneId: number): boolean {
  const last = lastOutputAt.get(paneId) ?? 0
  if (Date.now() - last > OUTPUT_QUIET_MS) return false
  return last - (outputStreakFrom.get(paneId) ?? last) >= OUTPUT_STREAK_MS
}

// The three Claude states, in precedence order: a blocking prompt beats
// everything, then live output, then "parked at the prompt, your move".
function classifyClaudeState(paneId: number, terminal: Terminal | null): PaneState {
  if (terminal && scanForClaudePrompt(terminal)) return 'claude-waiting'
  return isClaudeBusy(paneId) ? 'claude-active' : 'claude-idle'
}
// Panes the periodic health sweep has already flagged as blank, so each is
// reported once (not every tick) until it recovers.
const healthAnomalyReported = new Set<number>()
// Panes seen without a live terminal on the PREVIOUS sweep — used to require two
// consecutive sightings before flagging, so the brief window at creation (pane
// in the store, terminal not yet built) doesn't false-positive.
const missingTerminalSeen = new Set<number>()

// xterm theme with a fully-transparent background lets the wallpaper show
// through. Used both at terminal creation and on background toggle.
function themeForBackground(bgEnabled: boolean) {
  return bgEnabled ? { ...DARK_THEME, background: '#00000000' } : DARK_THEME
}

function isBackgroundEnabled(): boolean {
  const bg = useWorkspaceStore.getState().preferences.background
  return !!(bg && bg.enabled && bg.image)
}

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
  pendingBytes.set(paneId, 0)

  let joined = chunks.join('')
  const dropped = droppedBytes.get(paneId) ?? 0
  if (dropped > 0) {
    droppedBytes.set(paneId, 0)
    const kb = Math.max(1, Math.round(dropped / 1024))
    joined = `\r\n\x1b[33m[QuadClaude: dropped ${kb} KB of buffered output]\x1b[0m\r\n` + joined
  }

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

// Schedule a single drain for this pane. Arms RAF + setTimeout in parallel;
// the first to fire drains and cancels the other. RAF alone is unreliable
// because Chromium pauses it for hidden/occluded windows.
function schedulePendingFlush(paneId: number, terminal: Terminal) {
  if (pendingFlush.has(paneId)) return
  const drain = () => {
    const handles = pendingFlush.get(paneId)
    if (!handles) return
    if (handles.raf !== null) cancelAnimationFrame(handles.raf)
    if (handles.timer !== null) clearTimeout(handles.timer)
    pendingFlush.delete(paneId)
    flushOutput(paneId, terminal)
  }
  pendingFlush.set(paneId, {
    raf: requestAnimationFrame(drain),
    timer: setTimeout(drain, 250),
  })
}

// Re-evaluate active/idle/waiting from the buffer, transitioning state and
// chiming once when a pane newly enters the waiting state.
function refreshClaudeRunState(paneId: number, terminal: Terminal | null) {
  const store = useWorkspaceStore.getState()
  const current = store.panes.find((p) => p.id === paneId)?.state
  // Only meaningful while Claude is believed to be running
  if (current !== 'claude-active' && current !== 'claude-idle' && current !== 'claude-waiting') return
  const next = classifyClaudeState(paneId, terminal)
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


// Cheap render-state snapshot of one pane, for diagnostics. Reads only already-
// computed xterm buffer fields + a couple of DOM measurements — no layout thrash
// in steady state (called on-demand or on a slow interval).
function snapshotPane(paneId: number, terminal: Terminal) {
  const el = terminal.element as HTMLElement | null
  const rect = el?.getBoundingClientRect()
  const canvases = el ? Array.from(el.querySelectorAll('canvas')) : []
  const canvasPainted = canvases.some((c) => c.width > 0 && c.height > 0)
  const buf = terminal.buffer.active
  return {
    paneId,
    pos: useWorkspaceStore.getState().panes.findIndex((p) => p.id === paneId),
    cols: terminal.cols,
    rows: terminal.rows,
    bufferLines: buf.length,
    baseY: buf.baseY,
    viewportY: buf.viewportY,
    cursorY: buf.cursorY,
    atBottom: buf.baseY + terminal.rows >= buf.length - 1,
    userScrolledUp: userScrolledUp.get(paneId) ?? false,
    hasCanvasAddon: canvasAddons.has(paneId),
    canvasCount: canvases.length,
    canvasPainted,
    elW: rect ? Math.round(rect.width) : -1,
    elH: rect ? Math.round(rect.height) : -1,
    connected: !!el?.isConnected,
    receivedBytes: paneReceivedBytes.get(paneId) ?? 0,
  }
}

// On-demand: dump every live pane's render state to app.log (hotkey
// Cmd+Shift+D). Fire it the instant a pane looks blank — the snapshot
// distinguishes the causes: bufferLines<=1 → no output reached the terminal;
// non-empty + !atBottom → content scrolled out of view; non-empty + atBottom +
// canvas not painted → the canvas renderer failed to paint.
export function dumpPaneDiagnostics() {
  terminals.forEach((entry, paneId) => {
    // Per-pane guard: a disposed/broken terminal in the map (accessing its
    // buffer throws) must not abort the whole dump — otherwise a single bad
    // pane produces NO output at all, which is exactly what happened before.
    try {
      paneLog('info', 'pane-diag-dump', snapshotPane(paneId, entry.terminal))
    } catch (e) {
      paneLog('warn', 'pane-diag-dump-failed', { paneId, error: String(e) })
    }
  })
}

// Always-on but anomaly-gated: called on a slow interval. Logs ONLY panes that
// look wrong, each once until it recovers, so a healthy app produces zero output
// and there's no steady-state cost. Two signatures:
//  - pane-no-terminal: a pane exists in the store but has NO live terminal in the
//    module map. This is the close+reopen bug — the pane is bound to a terminal
//    that was disposed (or never created), so nothing renders and you can't type.
//    Requires two consecutive sweeps to skip the brief init window.
//  - pane-render-anomaly: a pane HAS a terminal, real size, and buffered content,
//    but its canvas renderer isn't painting.
export function checkPaneHealth() {
  const panes = useWorkspaceStore.getState().panes
  const liveIds = new Set(terminals.keys())
  const activeIds = new Set(panes.map((p) => p.id))

  panes.forEach((p, pos) => {
    if (!liveIds.has(p.id)) {
      // No terminal object for this store pane.
      if (missingTerminalSeen.has(p.id)) {
        if (!healthAnomalyReported.has(p.id)) {
          healthAnomalyReported.add(p.id)
          paneLog('warn', 'pane-no-terminal', {
            paneId: p.id,
            pos,
            cwd: p.workingDirectory,
            liveTerminals: [...liveIds],
          })
        }
      } else {
        missingTerminalSeen.add(p.id)
      }
      return
    }
    missingTerminalSeen.delete(p.id)

    const entry = terminals.get(p.id)!
    // Guard the snapshot: a broken terminal in the map must not throw out of the
    // whole sweep (which would stop every later pane from being checked).
    let s: ReturnType<typeof snapshotPane>
    try {
      s = snapshotPane(p.id, entry.terminal)
    } catch (e) {
      if (!healthAnomalyReported.has(p.id)) {
        healthAnomalyReported.add(p.id)
        paneLog('warn', 'pane-snapshot-failed', { paneId: p.id, pos, error: String(e) })
      }
      return
    }
    const canvasBroken = s.hasCanvasAddon && (s.canvasCount === 0 || !s.canvasPainted)
    const blank = s.connected && s.elW > 0 && s.elH > 0 && s.bufferLines > 1 && canvasBroken
    if (blank) {
      if (!healthAnomalyReported.has(p.id)) {
        healthAnomalyReported.add(p.id)
        paneLog('warn', 'pane-render-anomaly', s)
      }
    } else {
      healthAnomalyReported.delete(p.id)
    }
  })

  // Drop bookkeeping for panes that no longer exist (closed for real).
  missingTerminalSeen.forEach((id) => { if (!activeIds.has(id)) missingTerminalSeen.delete(id) })
  healthAnomalyReported.forEach((id) => { if (!activeIds.has(id)) healthAnomalyReported.delete(id) })
}

// Exported functions to control terminals from outside
export function clearTerminal(paneId: number) {
  const entry = terminals.get(paneId)
  if (entry) {
    entry.terminal.clear()
  }
}

// Full terminal reset — clears the buffer AND resets terminal modes. A TUI that crashes
// or is force-stopped can leave mouse tracking (ESC[?1006h) or the alt-screen enabled; the
// shell then echoes raw mouse sequences (^[[<35;…M) on every cursor move and looks frozen.
// terminal.clear() does NOT undo those modes, but reset() does — so the recovery paths
// (Stop, agent re-spawn) use this to guarantee a clean terminal.
export function resetTerminal(paneId: number) {
  const entry = terminals.get(paneId)
  if (entry) {
    entry.terminal.reset()
  }
}

export function sendToTerminal(paneId: number, text: string) {
  const entry = terminals.get(paneId)
  if (entry) {
    window.electronAPI.sendInput(paneId, text)
    entry.terminal.focus()
  }
}

// Transient (not persisted): the profile id whose env the current PTY for each
// pane was spawned with. null = a plain shell (no injected env). Used to decide
// when an agent launch must re-spawn the PTY to inject/clear env.
const paneEnvProfile = new Map<number, string | null>()
// Transient: the Claude account id the current PTY for each pane was spawned with
// (null = the global /login account). Changing it must re-spawn so the new account's
// token is injected. Tracked separately from the agent profile since they're orthogonal.
const paneAccount = new Map<number, string | null>()
// Panes with a launch in flight — guards against double-click / double-fire
// sending the agent command twice (the env re-spawn path is async).
const launchingPanes = new Set<number>()

// Re-fit a pane's xterm to its container and push the resulting cols/rows to its PTY.
// A freshly (re)spawned PTY starts at the default 80x24, so an agent launched right after
// a respawn renders into a cramped window until the next manual resize (e.g. switching a
// pane to Qwen/aider and back to Claude Code). The container size hasn't changed, so we
// just re-measure it and resize the new PTY to match — which also delivers SIGWINCH so the
// agent re-renders at full size.
function refitPane(paneId: number): void {
  const entry = terminals.get(paneId)
  if (!entry || !entry.terminal.element) return
  try {
    entry.fitAddon.fit()
    window.electronAPI.resizeTerminal(paneId, entry.terminal.cols, entry.terminal.rows)
  } catch {
    /* ignore fit errors during transitions */
  }
}

// Resolve which agent profile a pane should run: per-pane assignment, then the
// global default, then the Claude builtin. The id-based fallthrough also makes
// a deleted/dangling agentId degrade gracefully instead of breaking.
export function resolvePaneProfile(
  pane: Pick<PaneConfig, 'agentId'> | undefined,
  prefs: Pick<WorkspacePreferences, 'agentProfiles' | 'defaultAgentId'>,
): AgentProfile {
  const profiles = prefs.agentProfiles ?? DEFAULT_AGENT_PROFILES
  return (
    profiles.find((p) => p.id === pane?.agentId) ??
    profiles.find((p) => p.id === prefs.defaultAgentId) ??
    profiles.find((p) => p.builtin === 'claude') ??
    DEFAULT_AGENT_PROFILES[0]
  )
}

// Launch an agent profile in a pane. Profiles that carry env re-spawn the shell
// with that env (so secrets never hit shell history); env-less profiles (incl.
// Claude) just type the command into the existing shell — identical to before.
// forceCwd (used by Fork) forces a fresh shell in a specific directory.
export async function launchAgent(
  paneId: number,
  profile: AgentProfile,
  fallbackCwd: string,
  forceCwd?: string,
) {
  // Swallow rapid duplicate launches for the same pane (double-click / double-fire).
  if (launchingPanes.has(paneId)) return
  launchingPanes.add(paneId)
  setTimeout(() => launchingPanes.delete(paneId), 600)
  const hasEnv = !!profile.env && Object.keys(profile.env).length > 0
  const currentEnvProfile = paneEnvProfile.get(paneId) ?? null
  // The pane's bound Claude account (if any). Passed to main as a non-secret env HINT;
  // main decrypts the matching token and injects CLAUDE_CODE_OAUTH_TOKEN (the token never
  // reaches the renderer). A different account than the PTY was spawned with forces a
  // re-spawn so the right token takes effect.
  const accountId = useWorkspaceStore.getState().panes.find((p) => p.id === paneId)?.claudeAccountId ?? null
  const accountChanged = (paneAccount.get(paneId) ?? null) !== accountId
  // Re-spawn when a directory is forced, the account changed, this profile needs env, OR
  // the pane's PTY still carries env from a DIFFERENT profile (don't leak prior secrets).
  const needsRespawn =
    !!forceCwd || accountChanged || (hasEnv ? currentEnvProfile !== profile.id : currentEnvProfile !== null)
  if (needsRespawn) {
    // Use the forced dir, else the live tracked cwd (user may have cd'd).
    const cwd = forceCwd || (await window.electronAPI.getCwd(paneId)) || fallbackCwd
    const spawnEnv: Record<string, string> | undefined =
      accountId ? { ...(hasEnv ? profile.env : {}), QC_ACCOUNT_ID: accountId } : (hasEnv ? profile.env : undefined)
    resetTerminal(paneId) // fresh PTY → fully reset the terminal (clears any stuck modes)
    await window.electronAPI.createPty(paneId, cwd, spawnEnv)
    paneEnvProfile.set(paneId, hasEnv ? profile.id : null)
    paneAccount.set(paneId, accountId)
    refitPane(paneId) // size the new PTY to the full pane before the agent starts
  }
  let command = profile.command
  if (profile.builtin === 'claude') {
    const skip = useWorkspaceStore.getState().preferences.dangerouslySkipPermissions === true
    if (skip) command += ' --dangerously-skip-permissions'
  }
  sendToTerminal(paneId, command + '\r')
}

// Kill whatever is running in a pane and re-spawn a fresh shell. Recovers a pane
// that a misbehaving full-screen agent has locked (blank/unresponsive). Re-spawning
// the PTY sends SIGHUP to the shell's process group, killing the stuck child too.
export async function restartShell(paneId: number, fallbackCwd: string) {
  const cwd = (await window.electronAPI.getCwd(paneId)) || fallbackCwd
  resetTerminal(paneId) // full reset clears stuck modes (mouse tracking / alt-screen) left by a crashed TUI
  paneEnvProfile.set(paneId, null)
  await window.electronAPI.createPty(paneId, cwd)
  refitPane(paneId) // size the fresh PTY to the full pane (avoids a cramped window)
  useWorkspaceStore.getState().setPaneState(paneId, 'shell')
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

// Snapshot of each live terminal's buffer size for the performance reporter.
// buffer.active.length grows with scrollback, so this surfaces the per-pane
// memory/GPU cost that accumulates over a long session.
export function getTerminalStats() {
  const list: Array<{ paneId: number; bufferLines: number; cols: number; rows: number }> = []
  let terminalTotalLines = 0
  terminals.forEach((entry, paneId) => {
    const t = entry.terminal
    const bufferLines = t.buffer.active.length
    terminalTotalLines += bufferLines
    list.push({ paneId, bufferLines, cols: t.cols, rows: t.rows })
  })
  return { terminals: list, terminalTotalLines }
}

// Dispose and cleanup a terminal when pane is deleted or app closes
function disposeTerminal(paneId: number) {
  const entry = terminals.get(paneId)
  if (entry) {
    paneLog('info', 'terminal-disposed', { paneId })
    // Remove focus listener if exists
    const focusListener = focusListeners.get(paneId)
    if (focusListener && entry.terminal.textarea) {
      entry.terminal.textarea.removeEventListener('focus', focusListener)
    }
    focusListeners.delete(paneId)
    userScrolledUp.delete(paneId)
    isWritingOutput.delete(paneId)
    pendingOutput.delete(paneId)
    pendingBytes.delete(paneId)
    droppedBytes.delete(paneId)
    lastOutputAt.delete(paneId)
    outputStreakFrom.delete(paneId)
    const handles = pendingFlush.get(paneId)
    if (handles) {
      if (handles.raf !== null) cancelAnimationFrame(handles.raf)
      if (handles.timer !== null) clearTimeout(handles.timer)
    }
    pendingFlush.delete(paneId)
    const scanTimer = promptScanTimers.get(paneId)
    if (scanTimer) clearTimeout(scanTimer)
    promptScanTimers.delete(paneId)
    paneEnvProfile.delete(paneId)
    paneReceivedBytes.delete(paneId)
    healthAnomalyReported.delete(paneId)

    // Dispose the beta CanvasAddon EXPLICITLY and FIRST, while the terminal's
    // core services still exist. Its LinkRenderLayer subscribes to the core
    // linkifier's onShowLinkUnderline; if the addon is torn down by
    // terminal.dispose() AFTER the core is gone, that access hits `undefined`
    // and throws (confirmed: it threw on every close, "Cannot read properties
    // of undefined (reading 'onShowLinkUnderline')"). Disposing it here, in
    // order, both prevents the throw and releases the heavy GPU/canvas layers
    // (the real leak). Guarded regardless.
    const canvasAddon = canvasAddons.get(paneId)
    if (canvasAddon) {
      try {
        canvasAddon.dispose()
      } catch (e) {
        paneLog('warn', 'canvas-dispose-threw', { paneId, error: String(e) })
      }
    }
    canvasAddons.delete(paneId)
    // Cancel the blank-pane watchdog so a deliberately-closed pane never logs a
    // false "blank-detected".
    clearBlankWatchdog(paneId)
    ptyCreateResult.delete(paneId)
    fitAttempts.delete(paneId)

    // Dispose the terminal (releases remaining xterm.js resources, DOM, event
    // listeners). Still guarded belt-and-suspenders: if anything here throws,
    // the map cleanup below MUST run anyway — otherwise a reused pane id would
    // reattach to this disposed terminal (dead PTY) → a blank, unscrollable
    // pane. terminals.delete guarantees a reused id always builds fresh.
    try {
      entry.terminal.dispose()
    } catch (e) {
      paneLog('warn', 'terminal-dispose-threw', { paneId, error: String(e) })
    }
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

// Public teardown for a single pane (used when the user closes an extra
// pane). Disposes the xterm instance and clears all per-pane bookkeeping so
// the id can be reused. PTY kill is the caller's responsibility.
export function disposeTerminalForPane(paneId: number) {
  disposeTerminal(paneId)
}

// Helper to check if terminal is scrolled to bottom
function isTerminalAtBottom(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active
  // Add small tolerance (1 row) to account for edge cases
  return buffer.baseY + terminal.rows >= buffer.length - 1
}

// Load the GPU Canvas renderer for a pane, exactly once (idempotent). Must be
// called AFTER terminal.open() and while the theme background is already
// transparent — the canvas addon bakes transparency in at load time. Returns
// true only if it actually loaded the addon on this call (for diagnostics).
//
// Deferred until the container has real dimensions: the beta canvas addon
// renders a PERMANENTLY blank pane if it bakes at 0×0, which is exactly what
// happens to a pane added into a re-flowing grid (2×2 → 3×2) whose cell is
// still 0×0 for the first frames. The shell and buffer are fine underneath;
// nothing ever paints, and only close+reopen recovers it.
function ensureCanvasAddon(paneId: number, terminal: Terminal): boolean {
  if (canvasAddons.has(paneId)) return false
  try {
    const canvasAddon = new CanvasAddon()
    terminal.loadAddon(canvasAddon)
    canvasAddons.set(paneId, canvasAddon)
    return true
  } catch (e) {
    // Canvas context unavailable — xterm falls back to the DOM renderer.
    return false
  }
}

// Fit a freshly-opened terminal once its container actually has dimensions.
// A new pane mounts INTO the `pane-transition` CSS animation, so its container
// can report offsetWidth === 0 for the first few frames. The old one-shot RAF
// fit simply gave up in that window and relied entirely on the ResizeObserver —
// which intermittently left the pane blank (terminal opened at 0×0 onto the
// canvas renderer, never repainted, PTY never told its real size). This polls a
// bounded number of frames until the container is sized, then fits ONCE, syncs
// the PTY dimensions, scrolls to bottom, and forces a repaint of the buffer.
function fitWhenSized(
  paneId: number,
  terminal: Terminal,
  fitAddon: FitAddon,
  getContainer: () => HTMLElement | null,
  framesLeft = 180 // ~3s at 60fps — well past any layout transition
): void {
  fitAttempts.set(paneId, (fitAttempts.get(paneId) ?? 0) + 1)
  const el = getContainer()
  if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
    try {
      fitAddon.fit()
      // Load the canvas renderer AFTER the fit so it bakes at the pane's real
      // size. When the canvas was deferred at creation (cell was 0×0), this is
      // where it finally loads — baking here instead of at 0×0 is what prevents
      // the permanently-blank added pane. No-op if it already loaded.
      const canvasDeferredLoaded = ensureCanvasAddon(paneId, terminal)
      const { cols, rows } = terminal
      window.electronAPI.resizeTerminal(paneId, cols, rows)
      terminal.scrollToBottom()
      // Force the renderer to paint whatever the PTY already emitted while the
      // pane was 0-sized; without this the pane can stay blank.
      terminal.refresh(0, terminal.rows - 1)
      paneLog('info', 'fit-ok', {
        paneId,
        cols,
        rows,
        attempts: fitAttempts.get(paneId),
        canvasDeferredLoaded,
      })
    } catch (e) {
      paneLog('warn', 'fit-error', { paneId, error: String(e) })
    }
    return
  }
  if (framesLeft <= 0) {
    // Container never got real dimensions within the budget — a strong signal
    // for a stuck/blank pane.
    paneLog('warn', 'fit-retry-exhausted', {
      paneId,
      attempts: fitAttempts.get(paneId),
      containerW: el?.offsetWidth ?? -1,
      containerH: el?.offsetHeight ?? -1,
    })
    return
  }
  requestAnimationFrame(() =>
    fitWhenSized(paneId, terminal, fitAddon, getContainer, framesLeft - 1)
  )
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
    if (!terminalRef.current || !pane) {
      // The effect bailed before creating anything. It re-runs when `pane`
      // becomes defined (see deps below), so this is usually transient — but
      // log it so a pane that stays blank because the retry never happened is
      // traceable.
      paneLog('warn', 'init-bail', {
        paneId,
        hasContainer: !!terminalRef.current,
        hasPane: !!pane,
      })
      return
    }

    // Check if we already have a terminal for this pane (persisted across remounts)
    const existing = terminals.get(paneId)
    if (existing) {
      paneLog('info', 'terminal-reattached', { paneId })
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
      // Initialize with the CORRECT transparency up front - the canvas addon
      // (loaded below) honors transparency from its initial theme, not a
      // later mutation, so passing opaque here would hide the wallpaper.
      const terminal = new Terminal({
        fontSize: preferences.fontSize,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: themeForBackground(isBackgroundEnabled()),
        cursorBlink: true,
        allowProposedApi: true,
        allowTransparency: true,
        scrollback: 1000, // Limit scrollback to prevent memory bloat
        scrollOnUserInput: false, // Preserve scroll position when user types
      })

      const fitAddon = new FitAddon()
      // Open a clicked link in the user's DEFAULT browser as a normal tab in their active
      // session (via the main process → shell.openExternal). The default WebLinksAddon
      // calls window.open(), which Electron turns into a chromeless popup window — not what
      // anyone wants for a localhost preview.
      const webLinksAddon = new WebLinksAddon((_event, uri) => {
        void window.electronAPI.openExternal(uri)
      })

      terminal.loadAddon(fitAddon)
      terminal.loadAddon(webLinksAddon)

      // Make markdown file paths in the output clickable — clicking opens the file in
      // TextEdit. The main process resolves the matched text against this pane's live cwd
      // and refuses anything that isn't an existing .md file, so over-matching here is safe.
      // Match a run of path-like characters that ends in .md / .markdown.
      const MD_PATH_RE = /[^\s'"`()[\]<>|]+\.(?:md|markdown)\b/gi
      terminal.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const line = terminal.buffer.active.getLine(bufferLineNumber - 1)
          if (!line) {
            callback(undefined)
            return
          }
          const text = line.translateToString(false)
          const links: ILink[] = []
          let match: RegExpExecArray | null
          MD_PATH_RE.lastIndex = 0
          while ((match = MD_PATH_RE.exec(text)) !== null) {
            const matched = match[0]
            const startX = match.index + 1 // xterm ranges are 1-based, inclusive
            links.push({
              text: matched,
              range: {
                start: { x: startX, y: bufferLineNumber },
                end: { x: startX + matched.length - 1, y: bufferLineNumber },
              },
              activate: () => {
                void window.electronAPI.openInEditor(paneId, matched)
              },
            })
          }
          callback(links.length ? links : undefined)
        },
      })

      terminal.open(terminalRef.current)

      // GPU-accelerated Canvas renderer, used in ALL cases (wallpaper or
      // not). Must be loaded AFTER open() AND after the theme background is
      // already transparent (set above via themeForBackground) - the canvas
      // addon bakes transparency in at load time. Canvas honors
      // allowTransparency (WebGL does not), so the wallpaper shows through
      // while still getting the GPU CPU win under heavy log output.
      //
      // BUT only bake it now if the cell already has real dimensions. A pane
      // added into a re-flowing grid is 0×0 for the first frames, and a canvas
      // baked at 0×0 paints a permanently-blank pane. When 0-sized, defer the
      // load to fitWhenSized (below), which fires once the cell is sized.
      const containerSized =
        terminalRef.current.offsetWidth > 0 && terminalRef.current.offsetHeight > 0
      if (containerSized) {
        ensureCanvasAddon(paneId, terminal)
      }
      paneLog('info', 'canvas-init', {
        paneId,
        deferred: !containerSized,
        w: terminalRef.current.offsetWidth,
        h: terminalRef.current.offsetHeight,
      })

      xtermRef.current = terminal
      fitAddonRef.current = fitAddon

      // Store in module-level map
      terminals.set(paneId, { terminal, fitAddon })

      fitAttempts.set(paneId, 0)
      ptyCreateResult.set(paneId, false)
      paneLog('info', 'terminal-created', { paneId, cwd: pane.workingDirectory })

      // Arm the blank-pane watchdog: if no PTY output ever arrives, log an ERROR
      // with a full snapshot of why (container unsized, PTY never spawned, etc.).
      armBlankWatchdog(paneId, () => ({
        containerW: terminalRef.current?.offsetWidth ?? -1,
        containerH: terminalRef.current?.offsetHeight ?? -1,
        cols: xtermRef.current?.cols ?? -1,
        rows: xtermRef.current?.rows ?? -1,
        ptyCreateOk: ptyCreateResult.get(paneId) ?? null,
        fitAttempts: fitAttempts.get(paneId) ?? 0,
        attached: !!xtermRef.current?.element?.isConnected,
      }))

      // Fit once the container is actually sized (it can be 0×0 for the first
      // frames while the new pane animates in via `pane-transition`). Retries
      // until sized, then fits + syncs PTY size + repaints, so the pane never
      // gets stuck blank when it happens to open at 0×0.
      fitWhenSized(paneId, terminal, fitAddon, () => terminalRef.current)

      // Create PTY for this pane (only once globally)
      const initPty = async () => {
        if (initializedPtys.has(paneId)) return
        initializedPtys.add(paneId)

        const success = await window.electronAPI.createPty(
          paneId,
          pane.workingDirectory
        )
        ptyCreateResult.set(paneId, success)
        if (!success) {
          paneLog('error', 'pty-create-failed', { paneId, cwd: pane.workingDirectory })
        }
        if (success && xtermRef.current) {
          const { cols, rows } = xtermRef.current
          window.electronAPI.resizeTerminal(paneId, cols, rows)
        }
      }
      initPty()

      // Handle input
      terminal.onData((data) => {
        noteInput(paneId)
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
          if (['1', '2', '3', '4', '5', 'p', 'b'].includes(key)) {
            return false
          }
        } else if (!isMac && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
          if (['1', '2', '3', '4', '5', 'p', 'b'].includes(key)) {
            return false
          }
        }

        // Ctrl+Tab cycles the next pane into view (app-menu accelerator owns
        // the action) — make sure xterm never feeds it to the shell as a tab.
        if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === 'tab') {
          return false
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
    // Deps are [paneId, paneExists] only. paneId is the identity; paneExists
    // (!!pane) makes the effect RE-RUN when the pane appears in the store after
    // an initial render where it was still undefined. Without it, a new pane's
    // first render (where the store selector transiently returns undefined →
    // the component renders null, so terminalRef.current is null) makes the
    // guard below bail, and because paneId never changes the effect never runs
    // again → a permanently blank pane with no terminal/PTY. Re-running is safe:
    // the terminals.get(paneId) and initializedPtys guards make creation
    // idempotent. We deliberately do NOT depend on pane.workingDirectory/state
    // (those change often) to avoid re-initializing the terminal on every update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, !!pane])

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
      const bg = preferences.background ?? DEFAULT_BACKGROUND
      const bgOn = !!(bg.enabled && bg.image)
      xtermRef.current.options.theme = themeForBackground(bgOn)

      // Keep the Canvas renderer in all cases, but RELOAD it so it re-bakes
      // transparency from the new theme background. The canvas addon reads
      // transparency at load time and won't pick up a later alpha change on
      // its own, so toggling the wallpaper requires a fresh addon instance.
      const existing = canvasAddons.get(paneId)
      try {
        if (existing) {
          existing.dispose()
          canvasAddons.delete(paneId)
        }
        const fresh = new CanvasAddon()
        xtermRef.current.loadAddon(fresh)
        canvasAddons.set(paneId, fresh)
      } catch {
        // Canvas unavailable - xterm falls back to the DOM renderer
      }
    }
  }, [preferences.background?.enabled, preferences.background?.image, paneId])

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
        if (outputPaneId !== paneId) return
        if (!xtermRef.current) {
          // Output arrived but there's no terminal to write it to — it is
          // dropped. This is one way a pane ends up blank; record it.
          paneLog('warn', 'output-before-terminal', { paneId, bytes: data.length })
          return
        }
        {
          // Healthy output → cancel the blank-pane watchdog (logs first-byte latency).
          notePaneOutput(paneId)
          noteOutput(paneId)
          paneReceivedBytes.set(paneId, (paneReceivedBytes.get(paneId) ?? 0) + data.length)
          const terminal = xtermRef.current

          // Accumulate, then schedule one drain per pane (RAF + setTimeout
          // backstop). Enforces a per-pane byte cap: if RAF is paused (window
          // hidden / occluded) and the setTimeout fallback is also throttled,
          // oldest chunks are evicted so heap can't grow unboundedly while
          // dev servers stream MB/s of output in the background.
          let buf = pendingOutput.get(paneId)
          if (!buf) {
            buf = []
            pendingOutput.set(paneId, buf)
          }
          buf.push(data)
          let total = (pendingBytes.get(paneId) ?? 0) + data.length
          if (total > PENDING_OUTPUT_CAP) {
            let dropped = droppedBytes.get(paneId) ?? 0
            // Always keep at least one chunk - a single oversized chunk just
            // passes through whole so we don't slice mid-ANSI-escape.
            while (total > PENDING_OUTPUT_CAP && buf.length > 1) {
              const removed = buf.shift()!
              total -= removed.length
              dropped += removed.length
            }
            droppedBytes.set(paneId, dropped)
          }
          pendingBytes.set(paneId, total)
          schedulePendingFlush(paneId, terminal)

          // Debounced prompt scan: only meaningful while Claude is running, so
          // don't even arm the timer (or build the scan string) in shell state.
          const st = useWorkspaceStore
            .getState()
            .panes.find((p) => p.id === paneId)?.state
          if (st === 'claude-idle' && isClaudeBusy(paneId)) {
            // Claude picked the turn back up — don't make the 3s poll find it.
            useWorkspaceStore.getState().setPaneState(paneId, 'claude-active')
          }
          if (st === 'claude-active' || st === 'claude-idle' || st === 'claude-waiting') {
            const existingTimer = promptScanTimers.get(paneId)
            if (existingTimer) clearTimeout(existingTimer)
            promptScanTimers.set(
              paneId,
              setTimeout(() => {
                promptScanTimers.delete(paneId)
                refreshClaudeRunState(paneId, xtermRef.current)
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

          // Recreate PTY in the same directory. This is a plain shell (no agent
          // env), so forget any env profile the prior PTY carried.
          const paneConfig = store.panes.find((p) => p.id === paneId)
          initializedPtys.add(paneId)
          paneEnvProfile.set(paneId, null)
          // Re-arm the blank-pane watchdog: the respawned shell must also print a
          // prompt — if it never does, the pane goes blank and we want that logged.
          armBlankWatchdog(paneId, () => ({
            containerW: terminalRef.current?.offsetWidth ?? -1,
            containerH: terminalRef.current?.offsetHeight ?? -1,
            cols: xtermRef.current?.cols ?? -1,
            rows: xtermRef.current?.rows ?? -1,
            ptyCreateOk: ptyCreateResult.get(paneId) ?? null,
            fitAttempts: fitAttempts.get(paneId) ?? 0,
            attached: !!xtermRef.current?.element?.isConnected,
          }))
          const respawnOk = await window.electronAPI.createPty(
            paneId,
            paneConfig?.workingDirectory
          )
          ptyCreateResult.set(paneId, respawnOk)
          if (!respawnOk) {
            paneLog('error', 'pty-respawn-failed', { paneId, cwd: paneConfig?.workingDirectory })
          }

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

      // Claude is running: classify active vs idle vs waiting. This poll is what
      // catches the end of a turn — output stops, nothing else fires.
      const next = classifyClaudeState(paneId, xtermRef.current)
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
        const store = useWorkspaceStore.getState()
        const wasHidden =
          store.panes.findIndex((p) => p.id === sourcePaneId) >=
          visiblePaneCount(store.layout, store.panes.length)
        // Swap pane positions - this visually swaps them since grid uses array position
        swapPanes(sourcePaneId, paneId)
        // Dragging a PiP tile onto a visible pane promotes it — make it active
        // and focused, matching click-promote in the strip.
        if (wasHidden) {
          setActivePaneId(sourcePaneId)
          requestAnimationFrame(() => {
            requestAnimationFrame(() => focusTerminal(sourcePaneId))
          })
        }
      }
      return
    }

    setActivePaneId(paneId)

    // Get dropped files
    const files = e.dataTransfer.files
    if (files.length > 0) {
      const state = useWorkspaceStore.getState().panes.find((p) => p.id === paneId)?.state
      const claudeRunning = state === 'claude-active' || state === 'claude-waiting'

      const imagePaths: string[] = []
      const otherPaths: string[] = []
      const imageRe = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|tiff?)$/i
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        const filePath = window.electronAPI.getPathForFile(f)
        if (!filePath) continue
        const isImage = f.type.startsWith('image/') || imageRe.test(filePath)
        if (isImage && claudeRunning) {
          imagePaths.push(filePath)
        } else {
          // Quote paths with spaces so the shell / Claude reads them as one arg
          otherPaths.push(filePath.includes(' ') ? `"${filePath}"` : filePath)
        }
      }

      if (otherPaths.length > 0) {
        window.electronAPI.sendInput(paneId, otherPaths.join(' '))
      }

      // Hand images to Claude Code as real [Image #N] attachments. Sequential
      // with a small gap so each clipboard write is consumed before the next.
      if (imagePaths.length > 0) {
        ;(async () => {
          for (const p of imagePaths) {
            await window.electronAPI.pasteImage(paneId, p)
            if (imagePaths.length > 1) {
              await new Promise((r) => setTimeout(r, 200))
            }
          }
        })()
      }

      xtermRef.current?.focus()
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

  // All pane outlines are drawn on an INSET overlay layer inside the pane, because
  // the overflow:hidden grid-cell wrapper clips any OUTER box-shadow. This one layer
  // carries the colored pair ring, the active-pane selection glow, and (animated via
  // .claude-waiting-ring) the amber "Claude is waiting" pulse. Waiting takes over the
  // layer so its pulse reads; the pane's amber border still shows underneath.
  const paired = !!(pane.pairId && pane.pairColor)
  const waiting = pane.state === 'claude-waiting'
  const ringShadows: string[] = []
  if (paired) ringShadows.push(`inset 0 0 0 2px ${pane.pairColor}`)
  // The active pane's own marker moved OUT to .pane-surface.is-active, which
  // can now cast a real ring + lift instead of painting a white glow on the
  // inside of the glass. This layer is left to the pair colour and the waiting
  // pulse, which genuinely belong inside the pane's edge.
  const showRingOverlay = waiting || ringShadows.length > 0

  // Background image for this pane (per-pane mode allows different images per pane)
  const paneBgImage = bgEnabled
    ? (background.mode === 'per-pane'
      ? (background.paneImages?.[paneId] ?? background.image)
      : background.image)
    : null

  return (
    <div
      className={`group h-full min-h-0 flex flex-col overflow-hidden transition-all relative pane-surface ${isActive ? 'is-active' : ''} ${getBorderClass()} ${pane.state === 'claude-waiting' ? 'claude-waiting-pane' : ''}`}
      // The surface colour comes from the shared tint, not a fixed
      // glass-elevated: with a wallpaper the scrim below covers this, without
      // one this IS the pane. Either way it's the same number as the console.
      style={{ backgroundColor: `rgba(var(--window-tint-rgb, 30, 30, 30), var(--window-tint, 0.85))` }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <PaneHeader paneId={paneId} />
      {/* Pane outline overlay: pair ring + active selection glow + amber waiting pulse,
          drawn as inset shadows so the wrapper's overflow:hidden can't clip them, and
          above the terminal (z-[5]) so the terminal canvas can't cover them. */}
      {showRingOverlay && (
        <div
          className={`pointer-events-none absolute inset-0 z-[5] ${waiting ? 'claude-waiting-ring' : ''}`}
          style={
            waiting
              ? { borderRadius: 'var(--pane-radius)' }
              : { borderRadius: 'var(--pane-radius)', boxShadow: ringShadows.join(', ') }
          }
        />
      )}
      {/* Terminal wrapper - fills all remaining space */}
      <div
        className="flex-1 min-h-0 relative"
        style={paneBgImage ? {
          backgroundImage: `url(${paneBgImage?.startsWith('/') ? `file://${paneBgImage}` : paneBgImage})`,
          // Screen-pinned, not viewport-covered — see applyWallpaperAnchor.
          backgroundSize: 'var(--wallpaper-size, cover)',
          backgroundPosition: 'var(--wallpaper-pos, center)',
          backgroundRepeat: 'no-repeat',
          // `fixed` anchors the image to the VIEWPORT, not to each pane, which
          // is the whole point: every pane is a window onto one shared canvas,
          // so the picture lines up across the grid while the gutters between
          // them stay clear. Panes are cut-outs on a single backdrop — not
          // separate tiles each holding their own copy of the photo.
          ...(background.mode === 'unified' ? { backgroundAttachment: 'fixed' as const } : {}),
        } : undefined}
      >
        {/* Opacity overlay - controls how much wallpaper shows through */}
        {bgEnabled && (
          <div
            className="absolute inset-0 pointer-events-none z-0"
            style={{ backgroundColor: `rgba(var(--window-tint-rgb, 30, 30, 30), var(--window-tint, 0.85))` }}
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
          <div className="text-[--accent] text-body font-medium">Drop file here</div>
        </div>
      )}
      {isPaneDragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-[--accent]/10 pointer-events-none font-mono rounded-sm">
          <div className="text-[--accent] text-body font-medium">Swap terminals</div>
        </div>
      )}
    </div>
  )
})
