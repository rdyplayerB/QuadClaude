import * as pty from 'node-pty'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { logger } from './logger'
import { GitStatus } from '../shared/types'

type OutputCallback = (paneId: number, data: string) => void
type ExitCallback = (paneId: number, exitCode: number) => void

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
      const cdMatch = cleanData.match(/^cd\s+(.+)/)
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
          logger.info('pty', `Got cwd for pane ${paneId}`, result)
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
      return { isGitRepo: false }
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

      return {
        isGitRepo: true,
        branch,
        ahead,
        behind,
        dirty,
      }
    } catch (error) {
      logger.warn('pty', `Failed to get git status for pane ${paneId}`, error instanceof Error ? error.message : String(error))
      return { isGitRepo: false }
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
