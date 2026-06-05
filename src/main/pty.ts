import * as pty from 'node-pty'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { logger } from './logger'
import { markActivity, logPerfEvent } from './perfMonitor'

// Async, non-blocking command runner. Critically, this does NOT block the
// Electron main thread the way the old execSync calls did.
const pExecFile = promisify(execFile)
import { GitStatus, ContextUsage, ServerInfo, ServerStartResult, StartCommand } from '../shared/types'

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
    // Synchronous parse of a system-wide process list — this loop runs on the
    // main thread and scales with total process count.
    markActivity('pty:ps-snapshot-parse')
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

// Lockfile -> package manager, so "Start" runs the same tool the project uses.
async function detectPackageManager(cwd: string): Promise<string> {
  const checks: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
  ]
  for (const [file, pm] of checks) {
    try {
      await fs.promises.access(path.join(cwd, file))
      return pm
    } catch {
      // try next lockfile
    }
  }
  return 'npm'
}

// package.json in `dir` with a runnable script -> "<pm> run <script>", else null.
async function npmStartCommand(dir: string): Promise<string | null> {
  const raw = await fs.promises.readFile(path.join(dir, 'package.json'), 'utf-8')
  const scripts = JSON.parse(raw)?.scripts ?? {}
  const pick = ['dev', 'start', 'serve', 'develop'].find((s) => typeof scripts[s] === 'string')
  if (!pick) return null
  const pm = await detectPackageManager(dir)
  // `npm start` is the idiomatic form; everything else is `<pm> run <script>`
  return pm === 'npm' && pick === 'start' ? 'npm start' : `${pm} run ${pick}`
}

// Decide what command starts a server in this directory, instead of blindly
// assuming `npm run dev`:
//   1. package.json with a dev/start/serve/develop script -> run it with the
//      project's package manager
//   2. no package.json but an index.html -> static file server
//   3. neither, but exactly ONE immediate subdirectory is a runnable app ->
//      run it there (repos often keep the app in a subfolder, content at the
//      root); several candidates -> name them instead of guessing
//   4. nothing anywhere -> a human-readable error for the pane header
export async function resolveStartCommand(cwd: string): Promise<StartCommand> {
  const folder = path.basename(cwd)
  try {
    const command = await npmStartCommand(cwd)
    if (command) return { command }
    return { error: `No dev/start/serve script in ${folder}/package.json` }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return { error: `Unreadable package.json in ${folder}` }
    }
  }
  // No package.json — plain html folder gets a static server.
  try {
    await fs.promises.access(path.join(cwd, 'index.html'))
    return { command: 'npx -y serve .' }
  } catch {
    // fall through to the subdirectory scan
  }
  // Look one level down for a runnable app.
  try {
    const entries = await fs.promises.readdir(cwd, { withFileTypes: true })
    const candidates: Array<{ name: string; command: string }> = []
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      try {
        const command = await npmStartCommand(path.join(cwd, e.name))
        if (command) candidates.push({ name: e.name, command })
      } catch {
        // not an npm project - skip
      }
    }
    if (candidates.length === 1) {
      return {
        command: candidates[0].command,
        cwd: path.join(cwd, candidates[0].name),
        subdir: candidates[0].name,
      }
    }
    if (candidates.length > 1) {
      return {
        error: `Multiple apps in ${folder}: ${candidates.map((c) => c.name).join(', ')} — cd into one`,
      }
    }
  } catch {
    // unreadable directory - fall through to the generic error
  }
  return { error: `Nothing to start in ${folder} (no package.json or index.html)` }
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

  // Throughput accounting for the performance monitor. Cumulative bytes
  // emitted by PTYs since app start, total and per pane.
  private totalBytesOut = 0
  private perPaneBytesOut: Map<number, number> = new Map()

  // Dev servers started by the main process (Start button while Claude is
  // running in the pane, so the command can't be typed into the shell).
  // paneId -> root pids of detached `npm run dev` process groups.
  private spawnedServers: Map<number, Set<number>> = new Map()

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
        // Track throughput for the performance monitor (byte length, not chars).
        const len = Buffer.byteLength(data, 'utf8')
        this.totalBytesOut += len
        this.perPaneBytesOut.set(paneId, (this.perPaneBytesOut.get(paneId) || 0) + len)

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

    // shell pid -> paneId (+ pgid-based lookup for backgrounded processes)
    const shellPids = new Map<number, number>()
    const shellPgids = new Map<number, number>()
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

      // Build pgid -> paneId map: the shell's pgid typically matches itself
      for (const [shellPid, paneId] of shellPids) {
        const pg = snap.pgid.get(shellPid)
        if (pg !== undefined) shellPgids.set(pg, paneId)
      }
      // Main-process-spawned servers (Start button) are detached with their
      // own pgid == root pid; their listeners share it, so the pgid fallback
      // below attributes them to the right pane.
      for (const [paneId, roots] of this.spawnedServers) {
        for (const rootPid of roots) shellPgids.set(rootPid, paneId)
      }

      // Synchronous parse of system-wide lsof output (all listening sockets).
      markActivity('pty:lsof-servers-parse')
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
          // Fallback: backgrounded processes get reparented (ppid=1) but
          // keep the shell's process group ID
          if (owner === undefined) {
            const pg = snap.pgid.get(curPid)
            if (pg !== undefined) owner = shellPgids.get(pg)
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

  // Start `npm run dev` for a pane without going through its terminal — used
  // when Claude is running in the pane, so typing the command into the pty
  // would land in the Claude prompt. Spawned detached (own process group) via
  // an interactive login shell so nvm/homebrew PATH setup applies. The root
  // pid is tracked so detectServers() attributes the listener to this pane
  // and killServer() is allowed to stop it.
  //
  // The spawn is attached to no terminal, so failures are invisible unless we
  // return them: pre-check that the cwd actually has a `dev` script, and hold
  // the result briefly to catch instant-death exits (missing script, node too
  // old) — both bite as "pressed Start, nothing happened" otherwise.
  async startServer(paneId: number, cwd: string): Promise<ServerStartResult> {
    if (os.platform() === 'win32') return { ok: false, error: 'Not supported on Windows' }

    // One spawned server per pane. Without this, repeat Start presses (the
    // detect poll lags the spawn by seconds) stack up duplicate dev servers
    // on auto-incrementing ports.
    const live = this.spawnedServers.get(paneId)
    if (live && live.size > 0) {
      return { ok: false, error: 'Server already starting in this pane' }
    }

    // Pre-flight: figure out what (if anything) can be started here. Fail
    // fast with a reason instead of a silent exit-1.
    const resolved = await resolveStartCommand(cwd)
    if (!resolved.command) {
      return { ok: false, error: resolved.error ?? 'Nothing to start here' }
    }
    // App may live in a subfolder of the pane's cwd (e.g. repo/app) — run it
    // there so npm and any .nvmrc resolve against the right directory.
    const runCwd = resolved.cwd ?? cwd

    try {
      // Resolve a usable node: respect .nvmrc via nvm when present, otherwise
      // prepend the highest nvm-installed node to PATH. A login shell's
      // default node can be an old homebrew install (e.g. node@18) that
      // modern dev servers refuse to run on.
      const script = [
        'NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
        'if [ -f .nvmrc ] && [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh" --no-use; nvm use >/dev/null 2>&1',
        'else NODE_BIN="$(ls -d "$NVM_DIR/versions/node"/*/bin 2>/dev/null | sort -V | tail -n 1)"; [ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"; fi',
        `exec ${resolved.command}`,
      ].join('\n')
      const child = spawn('/bin/zsh', ['-lc', script], {
        cwd: runCwd,
        detached: true, // own pgid = child.pid, so kill(-pgid) takes the whole tree
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (!child.pid) return { ok: false, error: 'Failed to spawn npm' }
      const rootPid = child.pid
      const set = this.spawnedServers.get(paneId) ?? new Set()
      set.add(rootPid)
      this.spawnedServers.set(paneId, set)
      // Keep a small rolling tail of output so a failed start is diagnosable
      // from the log (the server isn't attached to any terminal).
      let tail = ''
      const capture = (d: Buffer) => { tail = (tail + d.toString()).slice(-2048) }
      child.stdout?.on('data', capture)
      child.stderr?.on('data', capture)
      // Resolves with the failure tail if the server dies within the grace
      // window below; a healthy server outlives it and we report ok.
      let reportEarlyExit: ((msg: string) => void) | null = null
      const earlyExit = new Promise<string>((resolve) => { reportEarlyExit = resolve })
      child.on('exit', (code, signal) => {
        set.delete(rootPid)
        serverCache = null
        if (code !== 0 && code !== null) {
          const reason = tail.trim().slice(-500)
          logger.warn('pty', `Spawned server ${rootPid} (pane ${paneId}) exited code=${code}: ${reason}`)
          reportEarlyExit?.(reason || `exited with code ${code}`)
        } else {
          logger.info('pty', `Spawned server ${rootPid} (pane ${paneId}) exited code=${code} signal=${signal}`)
        }
      })
      serverCache = null // surface the new listener on the next poll
      logger.info('pty', `Started server pid ${rootPid} for pane ${paneId} in ${runCwd}`, resolved.command)
      // Grace window: instant failures (missing script, unsupported node)
      // exit well under a second; report them to the caller instead of
      // pretending the server started.
      const result = await Promise.race([
        earlyExit.then((reason): ServerStartResult => ({ ok: false, error: reason })),
        new Promise<ServerStartResult>((resolve) =>
          setTimeout(() => resolve({ ok: true, command: resolved.command }), 1500)
        ),
      ])
      reportEarlyExit = null // later exits go to the log only
      return result
    } catch (e) {
      logger.warn('pty', `Failed to start dev server for pane ${paneId}`, e instanceof Error ? e.message : String(e))
      return { ok: false, error: e instanceof Error ? e.message : 'Failed to start' }
    }
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
    // The pid is fair game if it's in the pane shell's tree OR in the tree of
    // a dev server the main process spawned for this pane (those are detached,
    // so they're not shell descendants).
    const spawnedRoots = this.spawnedServers.get(paneId) ?? new Set()
    const inSpawnedTree = [...spawnedRoots].some(
      (root) => pid === root || isDescendantOf(pid, root, snap.ppid)
    )
    if (!inSpawnedTree && !isDescendantOf(pid, shellPid, snap.ppid)) {
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
      const shellPid = instance.pty.pid
      // Snapshot this pane's descendant tree BEFORE killing, then re-check a
      // few seconds AFTER, so any process that survived the pane close (and
      // reparented away from the shell — i.e. detached/orphaned) gets logged
      // with its command line. This is the data that proves whether closing a
      // QuadClaude pane leaves processes behind. Fire-and-forget; never blocks
      // or throws into the kill path.
      this.detectOrphansAfterKill(paneId, shellPid).catch(() => {})
      instance.pty.kill()
      this.ptys.delete(paneId)
    }
    // Take down any dev servers the main process spawned for this pane —
    // they're detached from the shell, so killing the pty doesn't reach them.
    const roots = this.spawnedServers.get(paneId)
    if (roots) {
      for (const rootPid of roots) {
        try { process.kill(-rootPid, 'SIGTERM') } catch { /* already gone */ }
      }
      this.spawnedServers.delete(paneId)
    }
  }

  killAll(): void {
    for (const [paneId] of this.ptys) {
      this.killPty(paneId)
    }
  }

  // Compute the full descendant PID set of a root pid from a ps snapshot.
  private descendantsOf(rootPid: number, ppid: Map<number, number>): Set<number> {
    // Build child adjacency once, then BFS from rootPid.
    const children = new Map<number, number[]>()
    for (const [pid, parent] of ppid) {
      const arr = children.get(parent) ?? []
      arr.push(pid)
      children.set(parent, arr)
    }
    const out = new Set<number>()
    const queue = [rootPid]
    while (queue.length) {
      const cur = queue.shift()!
      for (const c of children.get(cur) ?? []) {
        if (!out.has(c)) {
          out.add(c)
          queue.push(c)
        }
      }
    }
    return out
  }

  // Snapshot pane descendants BEFORE kill; ~3s after, report any that are
  // still alive AND no longer descend from the (now-dead) shell — i.e. they
  // detached/reparented (typically to launchd, ppid 1). Logged via perfMonitor.
  private async detectOrphansAfterKill(paneId: number, shellPid: number): Promise<void> {
    const before = await psSnapshot()
    const beforeDesc = this.descendantsOf(shellPid, before.ppid)
    if (beforeDesc.size === 0) return // nothing was running under this pane

    // Capture command lines now, while the processes still exist.
    const cmds = await this.commandLines([...beforeDesc])

    await new Promise((r) => setTimeout(r, 3000))

    const after = await psSnapshot()
    const survivors: Array<{ pid: number; ppid: number; cmd: string }> = []
    for (const pid of beforeDesc) {
      const nowParent = after.ppid.get(pid)
      if (nowParent === undefined) continue // exited cleanly — good
      // Still alive. Did it detach from the shell's tree?
      const stillUnderShell = this.descendantsOf(shellPid, after.ppid).has(pid)
      if (!stillUnderShell) {
        survivors.push({ pid, ppid: nowParent, cmd: cmds.get(pid) ?? '(unknown)' })
      }
    }

    if (survivors.length > 0) {
      logPerfEvent({
        type: 'orphan',
        paneId,
        shellPid,
        count: survivors.length,
        survivors: survivors.map((s) => ({ pid: s.pid, reparentedTo: s.ppid, cmd: s.cmd.slice(0, 120) })),
      })
    }
  }

  // Best-effort command lines for a set of pids (one ps call).
  private async commandLines(pids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>()
    if (pids.length === 0) return out
    try {
      const { stdout } = await pExecFile('ps', ['-axo', 'pid=,command='], {
        encoding: 'utf-8',
        timeout: 3000,
        maxBuffer: 8 * 1024 * 1024,
      })
      const want = new Set(pids)
      for (const line of stdout.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/)
        if (m) {
          const pid = parseInt(m[1], 10)
          if (want.has(pid)) out.set(pid, m[2])
        }
      }
    } catch {
      // ps failed; return whatever we have
    }
    return out
  }

  // Per-pane descendant process trees, for the perfMonitor lineage log. One ps
  // snapshot shared across panes; returns each pane's shell + descendants with
  // command lines so a later detach can be traced back to the pane that spawned
  // it.
  async getPaneDescendants(): Promise<
    Array<{ paneId: number; shellPid: number; procs: Array<{ pid: number; ppid: number; cmd: string }> }>
  > {
    if (this.ptys.size === 0) return []
    const snap = await psSnapshot()
    const result: Array<{ paneId: number; shellPid: number; procs: Array<{ pid: number; ppid: number; cmd: string }> }> = []
    // Gather every descendant pid across all panes in one go for a single
    // command-line lookup.
    const perPane = new Map<number, { shellPid: number; pids: Set<number> }>()
    const allPids = new Set<number>()
    for (const [paneId, inst] of this.ptys) {
      const shellPid = inst.pty.pid
      const desc = this.descendantsOf(shellPid, snap.ppid)
      desc.add(shellPid)
      perPane.set(paneId, { shellPid, pids: desc })
      for (const p of desc) allPids.add(p)
    }
    const cmds = await this.commandLines([...allPids])
    for (const [paneId, { shellPid, pids }] of perPane) {
      const procs: Array<{ pid: number; ppid: number; cmd: string }> = []
      for (const pid of pids) {
        procs.push({ pid, ppid: snap.ppid.get(pid) ?? 0, cmd: cmds.get(pid) ?? '' })
      }
      result.push({ paneId, shellPid, procs })
    }
    return result
  }

  // Snapshot of PTY throughput + session count for the performance monitor.
  getStats(): { sessions: number; totalBytesOut: number; perPaneBytesOut: Record<string, number> } {
    const perPane: Record<string, number> = {}
    for (const [paneId, bytes] of this.perPaneBytesOut) {
      perPane[String(paneId)] = bytes
    }
    return {
      sessions: this.ptys.size,
      totalBytesOut: this.totalBytesOut,
      perPaneBytesOut: perPane,
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
