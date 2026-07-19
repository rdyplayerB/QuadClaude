// Pane-init diagnostics + blank-pane watchdog.
//
// The "new pane comes up blank, no prompt, can't type" bug is intermittent and
// timing-dependent, so it's hard to catch in the act. This module records the
// terminal/PTY init lifecycle into the main app.log (visible in the Error Log
// window and userData/app.log) and actively *detects* the blank state: when a
// fresh pane is created we arm a watchdog, and if no PTY output ever arrives we
// log an ERROR with a full snapshot (container size, terminal dims, whether the
// PTY spawned, etc.) — exactly the evidence needed to diagnose a recurrence.

type Level = 'info' | 'warn' | 'error'

// If a freshly-created pane has received ZERO bytes of PTY output after this
// long, it's almost certainly the blank-pane bug — a healthy shell prints its
// prompt within a few hundred ms of spawning.
const BLANK_WATCHDOG_MS = 6000

export interface PaneSnapshot {
  containerW: number
  containerH: number
  cols: number
  rows: number
  ptyCreateOk: boolean | null
  fitAttempts: number
  attached: boolean
}

interface WatchdogState {
  timer: ReturnType<typeof setTimeout>
  armedAt: number
  snapshot: () => PaneSnapshot
}

const watchdogs = new Map<number, WatchdogState>()
// Panes that have produced at least one byte of output since (re)creation.
const sawOutput = new Set<number>()

// Low-level: write one structured line into the main app.log. Always safe — a
// diagnostics failure must never break the terminal.
export function paneLog(level: Level, message: string, details?: Record<string, unknown>): void {
  try {
    window.electronAPI.logDiag(level, 'pane-init', message, details ? JSON.stringify(details) : undefined)
  } catch {
    // ignore — diagnostics are best-effort
  }
}

// Arm the blank-pane watchdog for a freshly-created pane. `snapshot` is called
// lazily only if the watchdog fires, so it always reflects the latest state.
export function armBlankWatchdog(paneId: number, snapshot: () => PaneSnapshot): void {
  clearBlankWatchdog(paneId)
  sawOutput.delete(paneId)
  const armedAt = performance.now()
  const timer = setTimeout(() => {
    watchdogs.delete(paneId)
    if (sawOutput.has(paneId)) return
    const snap = snapshot()
    paneLog('error', 'pane-blank-detected', {
      paneId,
      waitedMs: Math.round(performance.now() - armedAt),
      ...snap,
    })
  }, BLANK_WATCHDOG_MS)
  watchdogs.set(paneId, { timer, armedAt, snapshot })
}

// Call when PTY output is observed for a pane. The first call after arming
// clears the watchdog and records how long the first byte took (a useful
// health signal even on success).
export function notePaneOutput(paneId: number): void {
  if (sawOutput.has(paneId)) return
  sawOutput.add(paneId)
  const wd = watchdogs.get(paneId)
  if (wd) {
    clearTimeout(wd.timer)
    watchdogs.delete(paneId)
    paneLog('info', 'first-output', {
      paneId,
      latencyMs: Math.round(performance.now() - wd.armedAt),
    })
  }
}

// Cancel the watchdog without logging (e.g. pane closed / PTY exited).
export function clearBlankWatchdog(paneId: number): void {
  const wd = watchdogs.get(paneId)
  if (wd) {
    clearTimeout(wd.timer)
    watchdogs.delete(paneId)
  }
}
