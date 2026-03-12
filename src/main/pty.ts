import * as pty from 'node-pty'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { logger } from './logger'
import { GitStatus, ContextUsage } from '../shared/types'

type OutputCallback = (paneId: number, data: string) => void
type ExitCallback = (paneId: number, exitCode: number) => void

const CD_REGEX = /^cd\s+(.+)/

interface PtyInstance {
  pty: pty.IPty
  cwd: string
}

// Get the full PATH from a login shell
function getLoginShellPath(): string {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    logger.info('pty', 'Getting login shell PATH', `Shell: ${shell}`)
    // Run a login shell to get the full PATH
    const result = execSync(`${shell} -l -c 'echo $PATH'`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
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

function getShellEnv(): NodeJS.ProcessEnv {
  if (!cachedPath) {
    cachedPath = getLoginShellPath()
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

export class PtyManager {
  private ptys: Map<number, PtyInstance> = new Map()
  private onOutput: OutputCallback
  private onExit: ExitCallback

  constructor(onOutput: OutputCallback, onExit: ExitCallback) {
    this.onOutput = onOutput
    this.onExit = onExit
  }

  createPty(paneId: number, cwd?: string): boolean {
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
        env: getShellEnv(),
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

      // Track cd commands to update cwd
      // This is a simple heuristic - could be improved with shell integration
      // Remove any trailing newlines/carriage returns before matching
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

  resize(paneId: number, cols: number, rows: number): void {
    const instance = this.ptys.get(paneId)
    if (instance) {
      instance.pty.resize(cols, rows)
    }
  }

  getCwd(paneId: number): string | null {
    const instance = this.ptys.get(paneId)
    if (!instance) return null

    // Try to get the actual cwd from the process
    // On macOS/Linux, we can use lsof or /proc
    try {
      if (os.platform() === 'darwin') {
        const pid = instance.pty.pid
        // Use -a to AND conditions, -d cwd to filter to just cwd entries
        // -F n outputs in parseable format where path starts with 'n'
        const result = execSync(`lsof -a -d cwd -p ${pid} -F n 2>/dev/null | grep '^n' | cut -c2-`, {
          encoding: 'utf-8',
          timeout: 2000,
        }).trim()
        if (result && result.startsWith('/')) {
          if (result !== instance.cwd) {
            logger.info('pty', `Pane ${paneId} cwd changed`, `${instance.cwd} → ${result}`)
          }
          instance.cwd = result
        } else {
          logger.warn('pty', `lsof returned unexpected result for pane ${paneId}`, result || '(empty)')
        }
      } else if (os.platform() === 'linux') {
        const pid = instance.pty.pid
        const result = execSync(`readlink /proc/${pid}/cwd`, {
          encoding: 'utf-8',
          timeout: 1000,
        }).trim()
        if (result) {
          instance.cwd = result
        }
      }
    } catch (error) {
      logger.warn('pty', `Failed to get cwd for pane ${paneId}`, error instanceof Error ? error.message : String(error))
      // Fall back to tracked cwd
    }

    return instance.cwd
  }

  getGitStatus(paneId: number): GitStatus | null {
    const instance = this.ptys.get(paneId)
    if (!instance) return null

    const cwd = this.getCwd(paneId) || instance.cwd

    // Check cache first - avoids spawning 4+ shell processes if recently checked
    const cached = gitStatusCache.get(cwd)
    if (cached && Date.now() - cached.timestamp < GIT_STATUS_CACHE_TTL) {
      return cached.status
    }

    try {
      // Check if this is a git repo
      execSync('git rev-parse --is-inside-work-tree', {
        cwd,
        encoding: 'utf-8',
        timeout: 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      // Not a git repo
      const status: GitStatus = { isGitRepo: false }
      gitStatusCache.set(cwd, { status, timestamp: Date.now() })
      return status
    }

    try {
      // Get branch name
      let branch = ''
      try {
        branch = execSync('git symbolic-ref --short HEAD 2>/dev/null || git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD', {
          cwd,
          encoding: 'utf-8',
          timeout: 1000,
        }).trim()
      } catch {
        branch = 'HEAD'
      }

      // Get ahead/behind counts
      let ahead = 0
      let behind = 0
      try {
        const tracking = execSync('git rev-list --left-right --count HEAD...@{u} 2>/dev/null', {
          cwd,
          encoding: 'utf-8',
          timeout: 1000,
        }).trim()
        const [aheadStr, behindStr] = tracking.split(/\s+/)
        ahead = parseInt(aheadStr, 10) || 0
        behind = parseInt(behindStr, 10) || 0
      } catch {
        // No upstream set, ignore
      }

      // Get dirty file count (staged + unstaged + untracked)
      let dirty = 0
      try {
        const status = execSync('git status --porcelain', {
          cwd,
          encoding: 'utf-8',
          timeout: 1000,
        })
        dirty = status.split('\n').filter((line) => line.trim().length > 0).length
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
  isClaudeRunning(paneId: number): boolean {
    const instance = this.ptys.get(paneId)
    if (!instance) return false

    try {
      const pid = instance.pty.pid
      if (os.platform() === 'darwin' || os.platform() === 'linux') {
        // Use pgrep to find claude process with this shell as parent
        // -P filters by parent PID, returns exit code 0 if found
        execSync(`pgrep -P ${pid} -f "claude" 2>/dev/null`, {
          encoding: 'utf-8',
          timeout: 500,
        })
        return true
      }
    } catch {
      // pgrep returns non-zero if no process found - this is expected
    }
    return false
  }

  // Get the Claude process PID running in this pane's PTY
  getClaudePid(paneId: number): number | null {
    const instance = this.ptys.get(paneId)
    if (!instance) return null
    try {
      const pid = instance.pty.pid
      const result = execSync(`pgrep -P ${pid} -f "claude" 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 500,
      }).trim()
      return result ? parseInt(result.split('\n')[0], 10) : null
    } catch {
      return null
    }
  }

  // Read context usage from statusline temp file for this pane
  getContextUsage(paneId: number): ContextUsage | null {
    const claudePid = this.getClaudePid(paneId)
    if (!claudePid) return null
    try {
      const data = fs.readFileSync(`/tmp/quadclaude-ctx-${claudePid}.json`, 'utf-8')
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

  getAllCwds(): Map<number, string> {
    const cwds = new Map<number, string>()
    logger.info('pty', `Getting cwds for ${this.ptys.size} active PTYs`)
    for (const [paneId] of this.ptys) {
      const cwd = this.getCwd(paneId)
      if (cwd) {
        cwds.set(paneId, cwd)
        logger.info('pty', `Pane ${paneId} cwd`, cwd)
      } else {
        logger.warn('pty', `Pane ${paneId} has no cwd`)
      }
    }
    return cwds
  }
}
