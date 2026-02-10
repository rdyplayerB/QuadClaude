import { app } from 'electron'
import path from 'path'
import fs from 'fs'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  timestamp: string
  level: LogLevel
  category: string
  message: string
  details?: string
}

class Logger {
  private logs: LogEntry[] = []
  private maxEntries = 500
  private logFilePath: string | null = null
  private initialized = false
  private maxFileSize = 1024 * 1024 // 1MB max log file size

  private ensureInitialized() {
    if (this.initialized) return

    try {
      const userDataPath = app.getPath('userData')
      this.logFilePath = path.join(userDataPath, 'app.log')
      this.initialized = true
      this.rotateLogIfNeeded()
    } catch {
      // App not ready yet, will try again later
    }
  }

  private rotateLogIfNeeded() {
    if (!this.logFilePath) return

    try {
      const stats = fs.statSync(this.logFilePath)
      if (stats.size > this.maxFileSize) {
        // Rotate: rename current to .old (overwrites previous .old)
        const oldLogPath = this.logFilePath + '.old'
        fs.renameSync(this.logFilePath, oldLogPath)
      }
    } catch {
      // File doesn't exist or can't be rotated - that's fine
    }
  }

  private formatTimestamp(): string {
    return new Date().toISOString()
  }

  private addEntry(level: LogLevel, category: string, message: string, details?: string) {
    const entry: LogEntry = {
      timestamp: this.formatTimestamp(),
      level,
      category,
      message,
      details
    }

    this.logs.push(entry)

    // Keep only the last maxEntries - use shift() for efficiency instead of slice()
    while (this.logs.length > this.maxEntries) {
      this.logs.shift()
    }

    // Also write to file for persistent logs
    this.appendToFile(entry)

    // Mirror to console for dev debugging
    const consoleMsg = `[${entry.timestamp}] [${level.toUpperCase()}] [${category}] ${message}${details ? '\n  ' + details : ''}`
    if (level === 'error') {
      console.error(consoleMsg)
    } else if (level === 'warn') {
      console.warn(consoleMsg)
    } else {
      console.log(consoleMsg)
    }
  }

  private appendToFile(entry: LogEntry) {
    this.ensureInitialized()
    if (!this.logFilePath) return

    try {
      // Check for rotation every 100 entries to avoid stat() on every write
      if (this.logs.length % 100 === 0) {
        this.rotateLogIfNeeded()
      }

      const line = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.category}] ${entry.message}${entry.details ? ' | ' + entry.details : ''}\n`
      fs.appendFileSync(this.logFilePath, line)
    } catch {
      // Silently fail file writes - don't cause issues if we can't write
    }
  }

  info(category: string, message: string, details?: string) {
    this.addEntry('info', category, message, details)
  }

  warn(category: string, message: string, details?: string) {
    this.addEntry('warn', category, message, details)
  }

  error(category: string, message: string, details?: string) {
    this.addEntry('error', category, message, details)
  }

  getLogs(): LogEntry[] {
    return [...this.logs]
  }

  getLogsAsText(): string {
    return this.logs.map(entry => {
      const levelIcon = entry.level === 'error' ? '!' : entry.level === 'warn' ? '?' : ' '
      return `[${entry.timestamp}] [${levelIcon}${entry.level.toUpperCase()}] [${entry.category}] ${entry.message}${entry.details ? '\n    ' + entry.details : ''}`
    }).join('\n')
  }

  getLogFilePath(): string {
    this.ensureInitialized()
    return this.logFilePath || 'Log file not yet initialized'
  }

  clearLogs() {
    this.logs = []
    this.info('app', 'Logs cleared')
  }
}

// Singleton instance
export const logger = new Logger()
