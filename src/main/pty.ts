import * as pty from 'node-pty'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { logger } from './logger'

// Async, non-blocking command runner. Critically, this does NOT block the
// Electron main thread the way the old execSync calls did.
const pExecFile = promisify(execFile)
import { GitStatus, ContextUsage, ServerInfo } from '../shared/types'

type OutputCallback = (paneId: number, data: string) => void
type ExitCallback = (paneId: number, exitCode: number) => void

const CD_REGEX = /^cd\s+(.+)/

interface PtyInstance {
  pty: pty.IPty
  cwd: string
}

// Get the full PATH from a login shell
async function getLoginShellPath(): Promise<string> {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    logger.info('pty', 'Getting login shell PATH', `Shell: ${shell}`)
    // Run a login shell to get the full PATH
    const { stdout } = await pExecFile(shell, ['-l', '-c', 'echo $PATH'], {
      encoding: 'utf-8',
      timeout: 5000,
    })
    const result = stdout.trim()
    logger.info('pty', 'Login shell PATH obtained', `Length: ${result.length} chars`)
    return result
  } catch (error) {
    logger.warn('pty', 'Failed to get login shell PATH, using fallback', error instanceof Error ? error.message : String(error))
    // Fallback to common paths
    return [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      process.env.PATH || '',
    ].join(':')
  }
}

// Cache the login shell PATH
let cachedPath: string | null = null

async function getShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (!cachedPath) {
    cachedPath = await getLoginShellPath()
  }

  return {
    ...process.env,
    PATH: cachedPath,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'en_US.UTF-8',
    HOME: os.homedir(),
    // Disable macOS zsh session save/restore (removes "Restored session" messages)
    SHELL_SESSIONS_DISABLE: '1',
    // Set TERM_PROGRAM to prevent Apple Terminal-specific behavior
    TERM_PROGRAM: 'QuadClaude',
    TERM_PROGRAM_VERSION: '1.0.0-beta',
  }
}

// Git status cache - avoids re-running 4+ shell commands when cwd hasn't changed
interface GitStatusCacheEntry {
  status: GitStatus
  timestamp: number
}
const gitStatusCache = new Map<string, GitStatusCacheEntry>()
const GIT_STATUS_CACHE_TTL = 10_000 // 10 seconds

// Server detection cache - one lsof+ps pair is shared across all panes and
// reused for a few seconds so repeated polls don't re-spawn processes.
let serverCache: { servers: Map<number, ServerInfo[]>; timestamp: number } | null = null
const SERVER_CACHE_TTL = 4_000

// One `ps` snapshot: pid -> ppid and pid -> pgid for the whole system.
async function psSnapshot(): Promise<{ ppid: Map<number, number>; pgid: Map<number, number> }> {
  const ppid = new Map<number, number>()
  const pgid = new Map<number, number>()
  try {
    const { stdout } = await pExecFile('ps', ['-axo', 'pid=,ppid=,pgid='], {
      encoding: 'utf-8',
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
    })
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 3) {
        const p = parseInt(parts[0], 10)
        const pp = parseInt(parts[1], 10)
        const pg = parseInt(parts[2], 10)
        if (!isNaN(p)) {
          ppid.set(p, pp)
          pgid.set(p, pg)
        }
      }
    }
  } catch {
    // ps failed - callers handle empty maps
  }
  return { ppid, pgid }
}

// Walk pid's ancestry up to `ancestor` (or give up after 40 hops / pid 1).
function isDescendantOf(pid: number, ancestor: number, ppid: Map<number, number>): boolean {
  let cur = pid
  for (let i = 0; i < 40 && cur && cur !== 1; i++) {
    if (cur === ancestor) return true
    const next = ppid.get(cur)
    if (next === undefined || next === cur) break
    cur = next
  }
  return cur === ancestor
}

export class PtyManager {
  private ptys: Map<number, PtyInstance> = new Map()
  private onOutput: OutputCallback
  private onExit: ExitCallback

  constructor(onOutput: OutputCallback, onExit: ExitCallback) {
    this.onOutput = onOutput
    this.onExit = onExit
  }

  async createPty(paneId: number, cwd?: string): Promise<boolean> {
    // Kill existing PTY if any
    this.killPty(paneId)

    const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/zsh')
    const homeDir = os.homedir()
    const workingDir = cwd || homeDir

    try {
      // Spawn shell with no flags - node-pty provides a proper TTY so it's interactive
      // We already have the PATH from login shell, and SHELL_SESSIONS_DISABLE prevents session restore
      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: workingDir,
        env: await getShellEnv(),
      })

      ptyProcess.onData((data) => {
        this.onOutput(paneId, data)
      })

      ptyProcess.onExit(({ exitCode }) => {
        this.ptys.delete(paneId)
        this.onExit(paneId, exitCode)
      })

      this.ptys.set(paneId, {
        pty: ptyProcess,
        cwd: workingDir,
      })

      return true
    } catch (error) {
      logger.error('pty', `Failed to create PTY for pane ${paneId}`, error instanceof Error ? error.stack || error.message : String(error))
      return false
    }
  }

  write(paneId: number, data: string): void {
    const instance = this.ptys.get(paneId)
    if (instance) {
      instance.pty.write(data)

      // Track cd commands to update cwd - only check when user presses Enter
      // (data contains newline). Skip single-character input for performance.
      if (data.includes('\n') || data.includes('\r')) {
        const cleanData = data.replace(/[\r\n]+$/, '')
        const cdMatch = cleanData.match(CD_REGEX)
        if (cdMatch) {
          const newDir = cdMatch[1].trim().replace(/['"]/g, '').replace(/[\r\n]/g, '')
          if (newDir.startsWith('/')) {
            instance.cwd = newDir
          } else if (newDir === '~') {
            instance.cwd = os.homedir()
          } else if (newDir.startsWith('~')) {
            instance.cwd = path.join(os.homedir(), newDir.slice(2))
          } else {
            instance.cwd = path.join(instance.cwd, newDir)
          }
          logger.info('pty', `Tracked cd for pane ${paneId}`, instance.cwd)
        }
      }
    }
  }

  resize(paneId: number, cols: number, rows: number): void {
    const instance = this.ptys.get(paneId)
    if (instance) {
      instance.pty.resize(cols, rows)
    }
  }

  async getCwd(paneId: number): Promise<string | null> {
    const instance = this.ptys.get(paneId)
    if (!instance) return null

    // Try to get the actual cwd from the process. On macOS use lsof, on Linux
    // /proc. NOTE: -n -P disable reverse-DNS and port-name resolution, which
    // is what made lsof crawl (seconds) once local servers opened sockets.
    try {
      if (os.platform() === 'darwin') {
        const pid = instance.pty.pid
        const { stdout } = await pExecFile(
          'lsof',
          ['-nP', '-a', '-d', 'cwd', '-p', String(pid), '-F', 'n'],
          { encoding: 'utf-8', timeout: 2000 }
        )
        const line = stdout.split('\n').find((l) => l.startsWith('n') && l.length > 1)
        const result = line ? line.slice(1).trim() : ''
        if (result && result.startsWith('/') && result !== instance.cwd) {
          logger.info('pty', `Pane ${paneId} cwd changed`, `${instance.cwd} → ${result}`)
          instance.cwd = result
        } else if (result && result.startsWith('/')) {
          instance.cwd = result
        }
      } else if (os.platform() === 'linux') {
        const pid = instance.pty.pid
        const { stdout } = await pExecFile('readlink', [`/proc/${pid}/cwd`], {
          encoding: 'utf-8',
          timeout: 1000,
        })
        if (stdout.trim()) {
          instance.cwd = stdout.trim()
        }
      }
    } catch {
      // Process may have exited or lsof timed out - fall back to tracked cwd.
      // Intentionally not logged: this fires on a 5s poll and would spam the log.
    }

    return instance.cwd
  }

  async getGitStatus(paneId: number): Promise<GitStatus | null> {
    const instance = this.ptys.get(paneId)
    if (!instance) return null

    // Use the tracked cwd (kept fresh by the periodic getCwd poll + cd
    // tracking) instead of running another lsof here.
    const cwd = instance.cwd

    // Check cache first - avoids spawning 4+ git processes if recently checked
    const cached = gitStatusCache.get(cwd)
    if (cached && Date.now() - cached.timestamp < GIT_STATUS_CACHE_TTL) {
      return cached.status
    }

    try {
      // Check if this is a git repo
      await pExecFile('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd,
        encoding: 'utf-8',
        timeout: 1000,
      })
    } catch {
      // Not a git repo
      const status: GitStatus = { isGitRepo: false }
      gitStatusCache.set(cwd, { status, timestamp: Date.now() })
      return status
    }

    try {
      // Get branch name (try symbolic-ref, then tag, then short sha)
      let branch = 'HEAD'
      for (const args of [
        ['symbolic-ref', '--short', 'HEAD'],
        ['describe', '--tags', '--exact-match'],
        ['rev-parse', '--short', 'HEAD'],
      ]) {
        try {
          const { stdout } = await pExecFile('git', args, { cwd, encoding: 'utf-8', timeout: 1000 })
          const v = stdout.trim()
          if (v) { branch = v; break }
        } catch {
          // try next form
        }
      }

      // Get ahead/behind counts
      let ahead = 0
      let behind = 0
      try {
        const { stdout } = await pExecFile(
          'git',
          ['rev-list', '--left-right', '--count', 'HEAD...@{u}'],
          { cwd, encoding: 'utf-8', timeout: 1000 }
        )
        const [aheadStr, behindStr] = stdout.trim().split(/\s+/)
        ahead = parseInt(aheadStr, 10) || 0
        behind = parseInt(behindStr, 10) || 0
      } catch {
        // No upstream set, ignore
      }

      // Get dirty file count (staged + unstaged + untracked)
      let dirty = 0
      try {
        const { stdout } = await pExecFile('git', ['status', '--porcelain'], {
          cwd,
          encoding: 'utf-8',
          timeout: 1000,
        })
        dirty = stdout.split('\n').filter((line) => line.trim().length > 0).length
      } catch {
        // Ignore errors
      }

      const result: GitStatus = {
        isGitRepo: true,
        branch,
        ahead,
        behind,
        dirty,
      }
      gitStatusCache.set(cwd, { status: result, timestamp: Date.now() })

      // Evict stale cache entries to prevent unbounded growth
      if (gitStatusCache.size > 20) {
        const now = Date.now()
        for (const [key, entry] of gitStatusCache) {
          if (now - entry.timestamp > GIT_STATUS_CACHE_TTL * 3) {
            gitStatusCache.delete(key)
          }
        }
      }

      return result
    } catch (error) {
      logger.warn('pty', `Failed to get git status for pane ${paneId}`, error instanceof Error ? error.message : String(error))
      return { isGitRepo: false }
    }
  }

  // Check if claude process is running in this PTY
  async isClaudeRunning(paneId: number): Promise<boolean> {
    const instance = this.ptys.get(paneId)
    if (!instance) return false

    try {
      const pid = instance.pty.pid
      if (os.platform() === 'darwin' || os.platform() === 'linux') {
        // pgrep exits non-zero (rejects) when no match - that's the "not running" signal
        await pExecFile('pgrep', ['-P', String(pid), '-f', 'claude'], { timeout: 500 })
        return true
      }
    } catch {
      // pgrep returns non-zero if no process found - this is expected
    }
    return false
  }

  // Get the Claude process PID running in this pane's PTY
  async getClaudePid(paneId: number): Promise<number | null> {
    const instance = this.ptys.get(paneId)
    if (!instance) return null
    try {
      const pid = instance.pty.pid
      const { stdout } = await pExecFile('pgrep', ['-P', String(pid), '-f', 'claude'], {
        encoding: 'utf-8',
        timeout: 500,
      })
      const result = stdout.trim()
      return result ? parseInt(result.split('\n')[0], 10) : null
    } catch {
      return null
    }
  }

  // Read context usage from statusline temp file for this pane
  async getContextUsage(paneId: number): Promise<ContextUsage | null> {
    const claudePid = await this.getClaudePid(paneId)
    if (!claudePid) return null
    try {
      const data = await fs.promises.readFile(`/tmp/quadclaude-ctx-${claudePid}.json`, 'utf-8')
      const parsed = JSON.parse(data)
      // Only return if data is fresh (< 30 seconds old)
      if (Date.now() / 1000 - parsed.ts > 30) return null
      return {
        contextPct: parsed.context_pct ?? 0,
        model: parsed.model ?? '',
        updatedAt: parsed.ts ?? 0,
      }
    } catch {
      return null
    }
  }

  // Detect listening TCP servers for ALL panes in one shot (one lsof + one
  // ps, app-wide), mapped back to each pane via process-tree ancestry.
  async detectServers(): Promise<Map<number, ServerInfo[]>> {
    if (serverCache && Date.now() - serverCache.timestamp < SERVER_CACHE_TTL) {
      return serverCache.servers
    }
    const result = new Map<number, ServerInfo[]>()
    if (os.platform() === 'win32' || this.ptys.size === 0) {
      serverCache = { servers: result, timestamp: Date.now() }
      return result
    }

    // shell pid -> paneId
    const shellPids = new Map<number, number>()
    for (const [paneId, inst] of this.ptys) shellPids.set(inst.pty.pid, paneId)

    try {
      const [lsofRes, snap] = await Promise.all([
        pExecFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], {
          encoding: 'utf-8',
          timeout: 3000,
          maxBuffer: 4 * 1024 * 1024,
        }),
        psSnapshot(),
      ])

      let curPid = 0
      let curCmd = ''
      const seen = new Set<string>() // dedupe paneId:port
      for (const line of lsofRes.stdout.split('\n')) {
        if (!line) continue
        const tag = line[0]
        const val = line.slice(1)
        if (tag === 'p') {
          curPid = parseInt(val, 10) || 0
          curCmd = ''
        } else if (tag === 'c') {
          curCmd = val
        } else if (tag === 'n') {
          // val: "127.0.0.1:3000" | "*:5173" | "[::1]:8080"
          const idx = val.lastIndexOf(':')
          if (idx < 0) continue
          const port = parseInt(val.slice(idx + 1), 10)
          if (!port || isNaN(port)) continue
          // Walk the listening process's ancestry to a pane's shell
          let owner: number | undefined
          let cur = curPid
          for (let i = 0; i < 40 && cur && cur !== 1; i++) {
            if (shellPids.has(cur)) {
              owner = shellPids.get(cur)
              break
            }
            const next = snap.ppid.get(cur)
            if (next === undefined || next === cur) break
            cur = next
          }
          if (owner === undefined) continue
          const key = `${owner}:${port}`
          if (seen.has(key)) continue
          seen.add(key)
          const arr = result.get(owner) ?? []
          arr.push({ pid: curPid, port, command: curCmd })
          result.set(owner, arr)
        }
      }
    } catch {
      // lsof/ps unavailable or timed out - return whatever was resolved
    }

    serverCache = { servers: result, timestamp: Date.now() }
    return result
  }

  // Kill a server running in a pane. SIGTERM the server's process group
  // (taking down its workers), escalate to SIGKILL after 3s. Hard guards:
  // the pid must be inside this pane's process tree and never the shell.
  async killServer(paneId: number, pid: number): Promise<boolean> {
    const instance = this.ptys.get(paneId)
    if (!instance) return false
    const shellPid = instance.pty.pid
    if (pid === shellPid) return false

    const snap = await psSnapshot()
    if (!isDescendantOf(pid, shellPid, snap.ppid)) {
      logger.warn('pty', `Refusing to kill ${pid}: not in pane ${paneId}'s tree`)
      return false
    }

    const pgid = snap.pgid.get(pid)
    const shellPgid = snap.pgid.get(shellPid)
    try {
      if (pgid && pgid !== 0 && pgid !== shellPid && pgid !== shellPgid) {
        // Foreground job has its own process group - kill the whole group
        process.kill(-pgid, 'SIGTERM')
        setTimeout(() => {
          try { process.kill(-pgid, 'SIGKILL') } catch { /* already gone */ }
        }, 3000)
      } else {
        // Shares the shell's group - only target the specific process
        process.kill(pid, 'SIGTERM')
        setTimeout(() => {
          try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
        }, 3000)
      }
      serverCache = null // force fresh detection on next poll
      logger.info('pty', `Killed server pid ${pid} in pane ${paneId}`)
      return true
    } catch (e) {
      logger.warn('pty', `Failed to kill server ${pid} in pane ${paneId}`, e instanceof Error ? e.message : String(e))
      return false
    }
  }

  killPty(paneId: number): void {
    const instance = this.ptys.get(paneId)
    if (instance) {
      instance.pty.kill()
      this.ptys.delete(paneId)
    }
  }

  killAll(): void {
    for (const [paneId] of this.ptys) {
      this.killPty(paneId)
    }
  }

  // Synchronous + cheap: returns the tracked cwd (kept fresh by the periodic
  // async getCwd poll during the session). Used on quit, where we must not
  // block on lsof and cannot await.
  getAllCwds(): Map<number, string> {
    const cwds = new Map<number, string>()
    for (const [paneId, instance] of this.ptys) {
      if (instance.cwd) cwds.set(paneId, instance.cwd)
    }
    return cwds
  }
}
