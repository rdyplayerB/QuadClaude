import { getTerminalStats } from './components/TerminalPane'

/**
 * Renderer-side performance reporter.
 *
 * Gathers metrics that only exist in the renderer process (JS heap, DOM size,
 * long tasks, frame rate, and per-terminal scrollback sizes) and pushes a
 * snapshot to the main process every REPORT_INTERVAL_MS, where perfMonitor.ts
 * folds it into the JSONL log.
 *
 * Kept deliberately cheap so it doesn't distort the measurements it records.
 */

const REPORT_INTERVAL_MS = 5000

// ---- Long task tracking (main-thread jank in the renderer) ----
let longTaskCount = 0
let longTaskMsTotal = 0
let longTaskMaxMs = 0

// ---- Frame rate tracking ----
let frameCount = 0
let fpsWindowStart = 0
let lastFps = 0
let rafHandle = 0

function frameTick(now: number) {
  if (fpsWindowStart === 0) fpsWindowStart = now
  frameCount++
  const elapsed = now - fpsWindowStart
  if (elapsed >= 1000) {
    lastFps = Math.round((frameCount / elapsed) * 1000)
    frameCount = 0
    fpsWindowStart = now
  }
  rafHandle = requestAnimationFrame(frameTick)
}

function collectReport() {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory

  const terms = getTerminalStats()

  const report = {
    jsHeapUsedMb: mem ? Math.round((mem.usedJSHeapSize / 1048576) * 10) / 10 : null,
    jsHeapTotalMb: mem ? Math.round((mem.totalJSHeapSize / 1048576) * 10) / 10 : null,
    jsHeapLimitMb: mem ? Math.round((mem.jsHeapSizeLimit / 1048576) * 10) / 10 : null,
    domNodes: document.getElementsByTagName('*').length,
    fps: lastFps,
    longTaskCount,
    longTaskMsTotal: Math.round(longTaskMsTotal),
    longTaskMaxMs: Math.round(longTaskMaxMs),
    paneCount: terms.terminals.length,
    terminalTotalLines: terms.terminalTotalLines,
    terminals: terms.terminals,
  }

  // Reset windowed counters after each report.
  longTaskCount = 0
  longTaskMsTotal = 0
  longTaskMaxMs = 0

  return report
}

function sendReport() {
  try {
    window.electronAPI.reportPerf?.(collectReport())
  } catch {
    // ignore
  }
}

let started = false

export function startPerfReporter() {
  if (started) return
  started = true

  // Observe long tasks (>50ms blocks of the renderer main thread).
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount++
        longTaskMsTotal += entry.duration
        if (entry.duration > longTaskMaxMs) longTaskMaxMs = entry.duration
      }
    })
    obs.observe({ entryTypes: ['longtask'] })
  } catch {
    // longtask not supported; skip
  }

  rafHandle = requestAnimationFrame(frameTick)

  // Allow the main process to ask for an immediate flush (e.g. on a marker).
  window.electronAPI.onPerfFlush?.(() => sendReport())

  setInterval(sendReport, REPORT_INTERVAL_MS)
  // First report shortly after startup once terminals have mounted.
  setTimeout(sendReport, 1500)
}

export function stopFrameTracking() {
  if (rafHandle) cancelAnimationFrame(rafHandle)
}
