import { Worker } from 'worker_threads'
import { logger } from './logger'
import { ServerInfo } from '../shared/types'

/**
 * Off-main-thread server detection.
 *
 * Finding which pane owns which listening port means reading two system-wide
 * lists — `lsof` for every listening socket, `ps` for the whole process table —
 * and walking each socket's ancestry back to a pane's shell. Both lists are
 * parsed line by line, and doing that on the main thread is what froze the UI:
 * across two months of telemetry every genuine busy-freeze came from here, six
 * from the lsof parse and one from the ps parse, up to 1,070ms at 0.77 CPU-busy.
 *
 * The exec was always async; only the parsing blocked. So the whole job moves to
 * a worker — the worker runs both commands itself, so the multi-megabyte output
 * never crosses into the main thread at all, not even as a string to hand over.
 * What comes back is the finished per-pane mapping: a few dozen small objects.
 *
 * The worker is defined as source text and started with `eval`, because the main
 * process is bundled into a single file and a separate worker entry point would
 * have to survive that bundling.
 */

const WORKER_SRC = `
const { parentPort } = require('worker_threads')
const { execFile } = require('child_process')

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf-8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err && !stdout ? '' : (stdout || '')))
  })
}

// pid -> ppid and pid -> pgid for every process on the machine.
function parsePs(out) {
  const ppid = new Map(), pgid = new Map()
  for (const line of out.split('\\n')) {
    const parts = line.trim().split(/\\s+/)
    if (parts.length < 3) continue
    const p = parseInt(parts[0], 10)
    if (isNaN(p)) continue
    ppid.set(p, parseInt(parts[1], 10))
    pgid.set(p, parseInt(parts[2], 10))
  }
  return { ppid, pgid }
}

function scan(shells) {
  return Promise.all([
    run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']),
    run('ps', ['-axo', 'pid=,ppid=,pgid=']),
  ]).then(([lsofOut, psOut]) => {
    const { ppid, pgid } = parsePs(psOut)
    const shellPids = new Map(shells)

    // A backgrounded server gets reparented to launchd (ppid 1) but keeps its
    // shell's process group, so pgid is the fallback route back to a pane.
    const shellPgids = new Map()
    for (const [pid, paneId] of shellPids) {
      const pg = pgid.get(pid)
      if (pg !== undefined) shellPgids.set(pg, paneId)
    }

    const result = new Map()
    const seen = new Set()
    let curPid = 0, curCmd = ''
    for (const line of lsofOut.split('\\n')) {
      if (!line) continue
      const tag = line[0], val = line.slice(1)
      if (tag === 'p') { curPid = parseInt(val, 10) || 0; curCmd = '' }
      else if (tag === 'c') { curCmd = val }
      else if (tag === 'n') {
        // "127.0.0.1:3000" | "*:5173" | "[::1]:8080"
        const idx = val.lastIndexOf(':')
        if (idx < 0) continue
        const port = parseInt(val.slice(idx + 1), 10)
        if (!port || isNaN(port)) continue

        let owner
        let cur = curPid
        for (let i = 0; i < 40 && cur && cur !== 1; i++) {
          if (shellPids.has(cur)) { owner = shellPids.get(cur); break }
          const next = ppid.get(cur)
          if (next === undefined || next === cur) break
          cur = next
        }
        if (owner === undefined) {
          const pg = pgid.get(curPid)
          if (pg !== undefined) owner = shellPgids.get(pg)
        }
        if (owner === undefined) continue

        const key = owner + ':' + port
        if (seen.has(key)) continue
        seen.add(key)
        const arr = result.get(owner) || []
        arr.push({ pid: curPid, port, command: curCmd })
        result.set(owner, arr)
      }
    }
    return Array.from(result.entries())
  })
}

parentPort.on('message', (msg) => {
  scan(msg.shells)
    .then((servers) => parentPort.postMessage({ id: msg.id, ok: true, servers }))
    .catch((e) => parentPort.postMessage({ id: msg.id, ok: false, error: String(e && e.message || e) }))
})
`

type ScanReply =
  | { id: number; ok: true; servers: Array<[number, ServerInfo[]]> }
  | { id: number; ok: false; error: string }

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, (r: ScanReply) => void>()

function ensureWorker(): Worker | null {
  if (worker) return worker
  try {
    worker = new Worker(WORKER_SRC, { eval: true })
    worker.on('message', (reply: ScanReply) => {
      const resolve = pending.get(reply.id)
      if (resolve) {
        pending.delete(reply.id)
        resolve(reply)
      }
    })
    // A dead worker must not strand its callers: fail everything in flight, drop
    // the handle, and let the next scan build a fresh one.
    const teardown = (why: string) => {
      logger.warn('pty', 'server-scan worker ended', why)
      worker = null
      for (const [id, resolve] of pending) resolve({ id, ok: false, error: why })
      pending.clear()
    }
    worker.on('error', (err) => teardown(err.message))
    worker.on('exit', (code) => { if (worker) teardown(`exit ${code}`) })
    worker.unref() // never hold the app open
    return worker
  } catch (err) {
    logger.error('pty', 'could not start server-scan worker', err instanceof Error ? err.message : String(err))
    worker = null
    return null
  }
}

/**
 * Map each pane to the TCP ports its process tree is listening on.
 * Resolves empty on any failure — a missing port chip is a cosmetic loss, and
 * never worth propagating an error into the poll loop that calls this.
 */
export function scanServers(shells: Array<[number, number]>): Promise<Map<number, ServerInfo[]>> {
  const w = ensureWorker()
  if (!w) return Promise.resolve(new Map())

  const id = nextId++
  return new Promise((resolve) => {
    // Belt and braces: if the worker wedges rather than dies, the poll loop still
    // gets an answer and simply tries again on the next tick.
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        logger.warn('pty', 'server-scan timed out', `id ${id}`)
        resolve(new Map())
      }
    }, 8000)

    pending.set(id, (reply) => {
      clearTimeout(timer)
      if (!reply.ok) {
        resolve(new Map())
        return
      }
      resolve(new Map(reply.servers))
    })

    try {
      w.postMessage({ id, shells })
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      logger.warn('pty', 'server-scan post failed', err instanceof Error ? err.message : String(err))
      resolve(new Map())
    }
  })
}

export function stopServerScan(): void {
  if (!worker) return
  const w = worker
  worker = null
  for (const [id, resolve] of pending) resolve({ id, ok: false, error: 'shutting down' })
  pending.clear()
  void w.terminate()
}
