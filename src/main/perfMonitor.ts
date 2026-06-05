import { app, ipcMain, shell, BrowserWindow, powerMonitor } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { monitorEventLoopDelay, PerformanceObserver } from 'perf_hooks'

/**
 * Performance / resource recorder for the main process.
 *
 * Samples once per SAMPLE_INTERVAL_MS and appends one JSON object per line
 * (JSONL) to a file under <userData>/perf-logs/. Each sample captures:
 *   - system-wide load, free/total memory, and CPU% (from os.cpus() deltas)
 *   - per-process CPU% + memory via app.getAppMetrics() (main/renderer/gpu/pty)
 *   - main-process V8 heap (process.memoryUsage()) + event-loop lag
 *   - PTY session count and byte throughput (supplied by index.ts)
 *   - the most recent renderer snapshot (sent over IPC by src/renderer/perf.ts)
 *
 * The goal is a long, low-overhead "slice" you can run until the app slows
 * down, then analyze offline with scripts/analyze-perf.mjs to determine
 * whether the slowdown is the OS or the app, and which part of the app.
 *
 * Beyond the 5s sampling, this module captures FREEZES automatically — no
 * manual marker needed — via three mechanisms that the sampled histogram
 * could not provide:
 *
 *   1. Stall watchdog: a 500ms timer that, every time it fires, records how
 *      late it was. A timer scheduled for +500ms that fires at +2300ms means
 *      the event loop was blocked for ~1800ms. CRITICALLY, it cross-checks
 *      process.cpuUsage(): a real code freeze burns CPU during the gap; OS
 *      sleep / app suspension does not. That single check is what separates a
 *      genuine main-thread block from the machine going to sleep — the exact
 *      ambiguity that made the sampled histogram untrustworthy. Each stall
 *      logs the most-recent activity breadcrumb, so we know WHAT was running.
 *
 *   2. GC observer: subscribes to V8 garbage-collection events and logs any
 *      GC pause over GC_LOG_THRESHOLD_MS. Long synchronous GC is a prime
 *      cause of multi-hundred-ms main-thread freezes that own no obvious code.
 *
 *   3. Activity breadcrumbs + slow-op timing: markActivity() stamps "what the
 *      main process is about to do" (e.g. "usage:poll", "git:status").
 *      timeOp() wraps an async op and logs it if it exceeds SLOW_OP_MS. When a
 *      stall fires, it reports the last breadcrumb — turning "something froze"
 *      into "usage:poll froze for 1.8s while burning CPU".
 *
 *   4. Power events: explicit suspend/resume/lock markers so the analyzer can
 *      hard-exclude sleep windows instead of guessing from sample gaps.
 */

const SAMPLE_INTERVAL_MS = 5000

// Stall watchdog: a timer set to this interval; if it fires materially late,
// the event loop was blocked for the difference. 500ms is frequent enough to
// catch sub-second freezes without itself being a measurable cost.
const STALL_CHECK_MS = 500
// Only log a stall if the loop was blocked beyond the scheduled interval by
// at least this much (filters normal timer jitter).
const STALL_THRESHOLD_MS = 250
// GC pauses longer than this are logged individually.
const GC_LOG_THRESHOLD_MS = 80
// Async ops wrapped in timeOp() that exceed this are logged.
const SLOW_OP_MS = 300

interface PtyStats {
  sessions: number
  totalBytesOut: number
  perPaneBytesOut: Record<string, number>
}

// How often (in sample intervals) to record the per-pane descendant process
// tree. 6 × 5s = every 30s. Cheaper than every sample, frequent enough to
// catch a child's command line before it detaches/exits.
const DESCENDANT_EVERY_N_SAMPLES = 6

interface PaneDescendants {
  paneId: number
  shellPid: number
  procs: Array<{ pid: number; ppid: number; cmd: string }>
}

let sampleTimer: ReturnType<typeof setInterval> | null = null
let stream: fs.WriteStream | null = null
let logFilePath: string | null = null
let getPtyStats: () => PtyStats = () => ({ sessions: 0, totalBytesOut: 0, perPaneBytesOut: {} })
// Optional async getter: the per-pane descendant process trees. Injected by
// index.ts so perfMonitor stays decoupled from PtyManager internals.
let getPaneDescendants: (() => Promise<PaneDescendants[]>) | null = null
let descendantTick = 0

/**
 * Write a one-off event line into the perf log (orphan reports, lineage
 * snapshots, etc.). Exported so other main-process modules (pty.ts) can record
 * process-lifecycle events without importing the file stream directly.
 */
export function logPerfEvent(obj: Record<string, unknown>) {
  writeLine({ t: Date.now(), ...obj })
}

// Event-loop lag histogram (very low overhead, native).
const eld = monitorEventLoopDelay({ resolution: 20 })

// Latest snapshot pushed from the renderer process.
let latestRendererReport: unknown = null
let lastRendererReportAt = 0

// Previous os.cpus() snapshot for computing system CPU% between samples.
let prevCpu: { idle: number; total: number } | null = null

// Previous total PTY bytes for computing throughput between samples.
let prevPtyBytesOut = 0

// ---- Stall watchdog + activity attribution state ----
let stallTimer: ReturnType<typeof setTimeout> | null = null
let lastStallTick = 0 // hrtime ms of the previous watchdog fire
let lastCpu: NodeJS.CpuUsage | null = null // process.cpuUsage() at previous fire
let gcObserver: PerformanceObserver | null = null

// "What is the main process doing right now." Set by markActivity() before any
// potentially-blocking work; read by the stall watchdog so a freeze is
// attributed to a named operation instead of "unknown".
let currentActivity = 'idle'
let currentActivityAt = 0
// Rolling breadcrumb trail: the last few activities with timestamps, so a
// stall can show the lead-up, not just the single active label.
const activityTrail: Array<{ label: string; t: number }> = []
const ACTIVITY_TRAIL_MAX = 8

// Counters surfaced in each periodic sample so trends are visible even between
// individual stall events.
let stallCountWindow = 0
let stallMsWindow = 0
let gcPauseCountWindow = 0
let gcPauseMsWindow = 0

/**
 * Stamp the operation the main process is about to perform. Cheap (two
 * assignments + a small array push). Call right before timer-driven or
 * IPC-driven work that could block: usage polling, git status, lsof, etc.
 */
export function markActivity(label: string) {
  currentActivity = label
  currentActivityAt = Date.now()
  activityTrail.push({ label, t: currentActivityAt })
  if (activityTrail.length > ACTIVITY_TRAIL_MAX) activityTrail.shift()
}

/**
 * Wrap an async operation: stamps the activity, awaits it, and logs a
 * 'slow-op' line if it took longer than SLOW_OP_MS. Returns the op's result so
 * it can transparently replace `await fn()` with `await timeOp('label', fn)`.
 */
export async function timeOp<T>(label: string, fn: () => Promise<T>): Promise<T> {
  markActivity(label)
  const start = Date.now()
  try {
    return await fn()
  } finally {
    const dur = Date.now() - start
    if (dur >= SLOW_OP_MS) {
      writeLine({ t: Date.now(), type: 'slow-op', label, durationMs: dur })
    }
    markActivity('idle')
  }
}

function startStallWatchdog() {
  lastStallTick = performance.now()
  lastCpu = process.cpuUsage()

  const tick = () => {
    const now = performance.now()
    const elapsed = now - lastStallTick
    const blockedMs = elapsed - STALL_CHECK_MS // how much later than scheduled

    // CPU burned during the gap. If the loop was genuinely blocked by JS, this
    // is close to wall-clock elapsed. If the machine slept/suspended, the
    // process burned ~no CPU while wall-clock advanced — the discriminator.
    const cpu = process.cpuUsage(lastCpu ?? undefined)
    const cpuMs = (cpu.user + cpu.system) / 1000
    lastCpu = process.cpuUsage()
    lastStallTick = now

    if (blockedMs >= STALL_THRESHOLD_MS) {
      // cpuBusyRatio near 1 => real on-CPU freeze; near 0 => sleep/suspend.
      const cpuBusyRatio = Math.min(1, cpuMs / elapsed)
      const kind = cpuBusyRatio > 0.5 ? 'busy-freeze' : 'idle-gap'
      stallCountWindow++
      stallMsWindow += blockedMs
      writeLine({
        t: Date.now(),
        type: 'stall',
        kind, // 'busy-freeze' = real main-thread block; 'idle-gap' = sleep/suspend
        blockedMs: Math.round(blockedMs),
        cpuMsDuringGap: Math.round(cpuMs),
        cpuBusyRatio: Math.round(cpuBusyRatio * 100) / 100,
        activity: currentActivity,
        activityAgeMs: currentActivityAt ? Date.now() - currentActivityAt : null,
        trail: activityTrail.slice(-5).map((a) => ({ label: a.label, agoMs: Date.now() - a.t })),
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
      })
    }
    stallTimer = setTimeout(tick, STALL_CHECK_MS)
  }
  stallTimer = setTimeout(tick, STALL_CHECK_MS)
}

function startGcObserver() {
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= GC_LOG_THRESHOLD_MS) {
          gcPauseCountWindow++
          gcPauseMsWindow += entry.duration
          // entry.detail.kind: 1=scavenge 2=minor-mc 4=mark-sweep-compact 8=incremental 16=weakcb
          const kind = (entry as unknown as { detail?: { kind?: number } }).detail?.kind ?? 0
          writeLine({
            t: Date.now(),
            type: 'gc',
            durationMs: Math.round(entry.duration * 100) / 100,
            gcKind: kind,
            activity: currentActivity,
          })
        }
      }
    })
    gcObserver.observe({ entryTypes: ['gc'] })
  } catch {
    // gc entryType unavailable on this runtime; skip
  }
}

function cpuSnapshot() {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const c of cpus) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  return { idle, total }
}

function systemCpuPercent(): number | null {
  const snap = cpuSnapshot()
  if (!prevCpu) {
    prevCpu = snap
    return null
  }
  const idleDelta = snap.idle - prevCpu.idle
  const totalDelta = snap.total - prevCpu.total
  prevCpu = snap
  if (totalDelta <= 0) return null
  return Math.round((1 - idleDelta / totalDelta) * 1000) / 10 // one decimal
}

export function getPerfLogDir(): string {
  return path.join(app.getPath('userData'), 'perf-logs')
}

export function getPerfLogPath(): string | null {
  return logFilePath
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

function timestampForFilename(): string {
  const d = new Date()
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

function writeLine(obj: Record<string, unknown>) {
  if (!stream) return
  try {
    stream.write(JSON.stringify(obj) + '\n')
  } catch {
    // ignore write errors
  }
}

function collectAppMetrics() {
  let procs: Array<Record<string, unknown>> = []
  let totalCpu = 0
  let totalMemKb = 0
  try {
    const metrics = app.getAppMetrics()
    procs = metrics.map((m) => {
      const cpu = m.cpu?.percentCPUUsage ?? 0
      const memKb = m.memory?.workingSetSize ?? 0
      totalCpu += cpu
      totalMemKb += memKb
      return {
        pid: m.pid,
        type: m.type, // Browser | Tab | GPU | Utility | Zygote | ...
        name: (m as { name?: string }).name ?? null,
        serviceName: (m as { serviceName?: string }).serviceName ?? null,
        cpuPercent: Math.round(cpu * 10) / 10,
        memWorkingSetKb: memKb,
        memPeakKb: m.memory?.peakWorkingSetSize ?? 0,
      }
    })
  } catch {
    // getAppMetrics can throw very early in startup
  }
  return {
    procs,
    totals: {
      cpuPercent: Math.round(totalCpu * 10) / 10,
      memWorkingSetKb: totalMemKb,
    },
  }
}

function takeSample() {
  const mem = process.memoryUsage()
  const sysCpu = systemCpuPercent()
  const freeMem = os.freemem()
  const totalMem = os.totalmem()

  const appMetrics = collectAppMetrics()

  const ptyStats = getPtyStats()
  const bytesOutDelta = ptyStats.totalBytesOut - prevPtyBytesOut
  prevPtyBytesOut = ptyStats.totalBytesOut

  // Event-loop lag, in milliseconds, since the previous sample.
  const lagMeanMs = Math.round((eld.mean / 1e6) * 100) / 100
  const lagMaxMs = Math.round((eld.max / 1e6) * 100) / 100
  const lagP99Ms = Math.round((eld.percentile(99) / 1e6) * 100) / 100
  eld.reset()

  // Snapshot then reset the windowed stall/GC counters for the next interval.
  const stallCountWindowSnap = stallCountWindow
  const stallMsWindowSnap = stallMsWindow
  const gcPauseCountWindowSnap = gcPauseCountWindow
  const gcPauseMsWindowSnap = gcPauseMsWindow
  stallCountWindow = 0
  stallMsWindow = 0
  gcPauseCountWindow = 0
  gcPauseMsWindow = 0

  // Only attach the renderer report if it's fresh (within ~3 sample windows).
  const rendererFresh = Date.now() - lastRendererReportAt < SAMPLE_INTERVAL_MS * 3

  writeLine({
    t: Date.now(),
    type: 'sample',
    uptimeSec: Math.round(process.uptime()),
    sys: {
      cpuPercent: sysCpu,
      loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      freeMemMb: Math.round(freeMem / 1048576),
      totalMemMb: Math.round(totalMem / 1048576),
      memUsedPct: Math.round((1 - freeMem / totalMem) * 1000) / 10,
    },
    main: {
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round((mem.heapUsed / 1048576) * 10) / 10,
      heapTotalMb: Math.round((mem.heapTotal / 1048576) * 10) / 10,
      externalMb: Math.round((mem.external / 1048576) * 10) / 10,
      arrayBuffersMb: Math.round((mem.arrayBuffers / 1048576) * 10) / 10,
      eventLoopLagMeanMs: lagMeanMs,
      eventLoopLagMaxMs: lagMaxMs,
      eventLoopLagP99Ms: lagP99Ms,
      // Windowed stall/GC counts from the high-resolution detectors below.
      stallCount: stallCountWindowSnap,
      stallMs: stallMsWindowSnap,
      gcPauseCount: gcPauseCountWindowSnap,
      gcPauseMs: Math.round(gcPauseMsWindowSnap),
    },
    procs: appMetrics.procs,
    appTotals: appMetrics.totals,
    pty: {
      sessions: ptyStats.sessions,
      totalBytesOut: ptyStats.totalBytesOut,
      bytesOutDelta,
      bytesOutPerSec: Math.round(bytesOutDelta / (SAMPLE_INTERVAL_MS / 1000)),
      perPaneBytesOut: ptyStats.perPaneBytesOut,
    },
    renderer: rendererFresh ? latestRendererReport : null,
  })

  // Periodically snapshot each pane's descendant process tree. This is the
  // lineage record: if a child later detaches (reparents to launchd) or
  // survives a pane close, we can prove which pane spawned it and when —
  // exactly the data needed to tell whether QuadClaude is orphaning processes.
  if (getPaneDescendants && ++descendantTick % DESCENDANT_EVERY_N_SAMPLES === 0) {
    getPaneDescendants()
      .then((panes) => {
        for (const p of panes) {
          // Only log non-trivial trees (more than just the shell) to keep the
          // log lean — a bare shell with no children isn't interesting.
          if (p.procs.length > 1) {
            logPerfEvent({
              type: 'lineage',
              paneId: p.paneId,
              shellPid: p.shellPid,
              procs: p.procs.map((x) => ({ pid: x.pid, ppid: x.ppid, cmd: x.cmd.slice(0, 120) })),
            })
          }
        }
      })
      .catch(() => {
        /* ps snapshot failed; skip this round */
      })
  }
}

export function addMarker(label: string) {
  writeLine({ t: Date.now(), type: 'marker', uptimeSec: Math.round(process.uptime()), label })
}

export function startPerfMonitor(
  ptyStatsGetter?: () => PtyStats,
  paneDescendantsGetter?: () => Promise<PaneDescendants[]>
) {
  if (sampleTimer) return // already running
  if (ptyStatsGetter) getPtyStats = ptyStatsGetter
  if (paneDescendantsGetter) getPaneDescendants = paneDescendantsGetter

  const dir = getPerfLogDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // ignore
  }

  logFilePath = path.join(dir, `perf-${timestampForFilename()}.jsonl`)
  stream = fs.createWriteStream(logFilePath, { flags: 'a' })

  eld.enable()
  prevCpu = cpuSnapshot()

  // Session metadata as the first line, so the analyzer has machine context.
  const cpus = os.cpus()
  writeLine({
    t: Date.now(),
    type: 'meta',
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemMb: Math.round(os.totalmem() / 1048576),
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
  })

  // High-resolution freeze detection (no manual marker needed).
  startStallWatchdog()
  startGcObserver()

  // Power events: hard markers for sleep/lock so the analyzer can exclude
  // those windows instead of inferring them from sample gaps.
  try {
    powerMonitor.on('suspend', () => writeLine({ t: Date.now(), type: 'power', event: 'suspend' }))
    powerMonitor.on('resume', () => {
      // Reset watchdog/CPU baselines so the first post-resume tick doesn't
      // log the entire sleep duration as a (false) stall.
      lastStallTick = performance.now()
      lastCpu = process.cpuUsage()
      writeLine({ t: Date.now(), type: 'power', event: 'resume' })
    })
    powerMonitor.on('lock-screen', () => writeLine({ t: Date.now(), type: 'power', event: 'lock-screen' }))
    powerMonitor.on('unlock-screen', () => writeLine({ t: Date.now(), type: 'power', event: 'unlock-screen' }))
  } catch {
    // powerMonitor unavailable before app ready / on some platforms; skip
  }

  // Take an immediate sample, then on the interval.
  takeSample()
  sampleTimer = setInterval(takeSample, SAMPLE_INTERVAL_MS)

  console.log(`[perfMonitor] recording to ${logFilePath}`)
}

export function stopPerfMonitor() {
  if (sampleTimer) {
    clearInterval(sampleTimer)
    sampleTimer = null
  }
  if (stallTimer) {
    clearTimeout(stallTimer)
    stallTimer = null
  }
  if (gcObserver) {
    try {
      gcObserver.disconnect()
    } catch {
      // ignore
    }
    gcObserver = null
  }
  if (stream) {
    addMarker('recording-stopped')
    stream.end()
    stream = null
  }
  try {
    eld.disable()
  } catch {
    // ignore
  }
}

export function isPerfMonitorRunning(): boolean {
  return sampleTimer !== null
}

export function setupPerfHandlers() {
  // Renderer pushes its snapshot here every few seconds.
  ipcMain.on('perf:report', (_e, data) => {
    latestRendererReport = data
    lastRendererReportAt = Date.now()
  })

  // Renderer (or a hotkey) can drop a labeled marker, e.g. "feels slow now".
  ipcMain.on('perf:marker', (_e, label: string) => {
    addMarker(typeof label === 'string' ? label : 'marker')
  })

  ipcMain.handle('perf:status', () => ({
    running: isPerfMonitorRunning(),
    logFile: logFilePath,
    logDir: getPerfLogDir(),
  }))
}

export function revealPerfLogs() {
  if (logFilePath && fs.existsSync(logFilePath)) {
    shell.showItemInFolder(logFilePath)
  } else {
    shell.openPath(getPerfLogDir())
  }
}

// Broadcast a request to the renderer to immediately flush a snapshot
// (used when a marker is dropped so the marker lines up with a fresh report).
export function requestRendererFlush() {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('perf:flush')
  }
}
