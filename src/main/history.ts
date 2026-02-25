import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { logger } from './logger'

export interface HistorySession {
  date: string
  file: string
  size: number
  preview: string
  exchangeCount: number
}

export interface HistoryIndex {
  projectPath: string
  projectId: string
  sessions: HistorySession[]
}

export interface HistoryExchange {
  timestamp: string
  paneId: number
  type: 'input' | 'output'
  content: string
}

/**
 * Manages conversation history storage for QuadClaude projects.
 *
 * History is stored in app data folder, indexed by project UUID.
 * Each project has a .quadclaude/project-id file linking it to its history.
 */
export class HistoryManager {
  private historyBasePath: string
  private writeBuffers: Map<string, string[]> = new Map()
  private flushTimer: NodeJS.Timeout | null = null
  private currentSessionId: string
  private sessionStartTime: Date

  constructor() {
    this.historyBasePath = path.join(app.getPath('userData'), 'history')
    this.ensureDirectory(this.historyBasePath)
    this.currentSessionId = crypto.randomUUID()
    this.sessionStartTime = new Date()

    // Start periodic flush timer
    this.startFlushTimer()

    logger.info('history', 'HistoryManager initialized', this.historyBasePath)
  }

  /**
   * Gets or creates a project ID for the given project path.
   * Creates .quadclaude/project-id file if it doesn't exist.
   */
  getOrCreateProjectId(projectPath: string): string {
    const quadClaudeDir = path.join(projectPath, '.quadclaude')
    const projectIdFile = path.join(quadClaudeDir, 'project-id')

    try {
      // Check if project ID already exists
      if (fs.existsSync(projectIdFile)) {
        const projectId = fs.readFileSync(projectIdFile, 'utf-8').trim()
        if (projectId && this.isValidUuid(projectId)) {
          logger.info('history', 'Found existing project ID', projectId)
          return projectId
        }
      }

      // Create new project ID
      this.ensureDirectory(quadClaudeDir)
      const projectId = crypto.randomUUID()
      fs.writeFileSync(projectIdFile, projectId, 'utf-8')

      // Create history directory for this project
      const projectHistoryDir = path.join(this.historyBasePath, projectId)
      this.ensureDirectory(projectHistoryDir)

      // Initialize index
      this.initializeIndex(projectId, projectPath)

      logger.info('history', 'Created new project ID', projectId)
      return projectId
    } catch (error) {
      logger.error('history', 'Failed to get/create project ID', error instanceof Error ? error.message : String(error))
      // Return a temporary ID that won't persist
      return `temp-${crypto.randomUUID()}`
    }
  }

  /**
   * Finds project ID from an existing .quadclaude/project-id file.
   * Returns null if not found (useful for detecting renamed folders).
   */
  findProjectId(projectPath: string): string | null {
    const projectIdFile = path.join(projectPath, '.quadclaude', 'project-id')

    try {
      if (fs.existsSync(projectIdFile)) {
        const projectId = fs.readFileSync(projectIdFile, 'utf-8').trim()
        if (projectId && this.isValidUuid(projectId)) {
          return projectId
        }
      }
    } catch {
      // Ignore errors
    }

    return null
  }

  /**
   * Appends an exchange (input or output) to the history.
   */
  appendExchange(projectId: string, paneId: number, type: 'input' | 'output', content: string): void {
    if (!projectId || projectId.startsWith('temp-')) {
      return // Don't save for temporary projects
    }

    const timestamp = new Date().toISOString()
    const entry = this.formatExchange(timestamp, paneId, type, content)

    // Add to buffer
    if (!this.writeBuffers.has(projectId)) {
      this.writeBuffers.set(projectId, [])
    }
    this.writeBuffers.get(projectId)!.push(entry)
  }

  /**
   * Formats an exchange entry for the markdown file.
   */
  private formatExchange(timestamp: string, paneId: number, type: 'input' | 'output', content: string): string {
    const time = new Date(timestamp).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })

    const typeLabel = type === 'input' ? '**Input:**' : '**Output:**'

    // Escape content that might interfere with markdown
    const escapedContent = content.trim()

    return `### [${time}] Terminal ${paneId + 1} - ${type}\n${typeLabel}\n\`\`\`\n${escapedContent}\n\`\`\`\n\n`
  }

  /**
   * Flushes all buffered content to disk.
   */
  flush(): void {
    const today = this.getTodayDateString()

    for (const [projectId, buffer] of this.writeBuffers.entries()) {
      if (buffer.length === 0) continue

      try {
        const projectHistoryDir = path.join(this.historyBasePath, projectId)
        this.ensureDirectory(projectHistoryDir)

        const filePath = path.join(projectHistoryDir, `${today}.md`)

        // Check if we need to write session header
        const needsSessionHeader = !fs.existsSync(filePath) || this.isNewSession(filePath)

        let content = ''
        if (needsSessionHeader) {
          content = this.getSessionHeader()
        }
        content += buffer.join('')

        // Append to file
        fs.appendFileSync(filePath, content, 'utf-8')

        // Update index
        this.updateIndex(projectId, today, filePath)

        logger.info('history', `Flushed ${buffer.length} entries for project`, projectId)
      } catch (error) {
        logger.error('history', 'Failed to flush history', error instanceof Error ? error.message : String(error))
      }
    }

    // Clear all buffers
    this.writeBuffers.clear()
  }

  /**
   * Gets the session header for markdown file.
   */
  private getSessionHeader(): string {
    const now = new Date()
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
    const timeStr = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })

    return `\n---\n## Session: ${dateStr} at ${timeStr}\n\n`
  }

  /**
   * Checks if this is a new session (more than 30 min since last write).
   */
  private isNewSession(filePath: string): boolean {
    try {
      const stats = fs.statSync(filePath)
      const lastModified = stats.mtime.getTime()
      const now = Date.now()
      const thirtyMinutes = 30 * 60 * 1000
      return (now - lastModified) > thirtyMinutes
    } catch {
      return true
    }
  }

  /**
   * Gets list of sessions/days for a project.
   */
  getSessions(projectId: string): HistorySession[] {
    const indexPath = path.join(this.historyBasePath, projectId, 'index.json')

    try {
      if (fs.existsSync(indexPath)) {
        const index: HistoryIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
        return index.sessions.sort((a, b) => b.date.localeCompare(a.date)) // Most recent first
      }
    } catch (error) {
      logger.error('history', 'Failed to read sessions', error instanceof Error ? error.message : String(error))
    }

    return []
  }

  /**
   * Gets the content for a specific day.
   */
  getDayContent(projectId: string, date: string): string {
    const filePath = path.join(this.historyBasePath, projectId, `${date}.md`)

    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8')
      }
    } catch (error) {
      logger.error('history', 'Failed to read day content', error instanceof Error ? error.message : String(error))
    }

    return ''
  }

  /**
   * Searches history for a query string.
   */
  search(projectId: string, query: string, limit: number = 50): { date: string; matches: string[] }[] {
    const results: { date: string; matches: string[] }[] = []
    const projectHistoryDir = path.join(this.historyBasePath, projectId)

    try {
      if (!fs.existsSync(projectHistoryDir)) {
        return results
      }

      const files = fs.readdirSync(projectHistoryDir)
        .filter(f => f.endsWith('.md'))
        .sort((a, b) => b.localeCompare(a)) // Most recent first

      const queryLower = query.toLowerCase()
      let totalMatches = 0

      for (const file of files) {
        if (totalMatches >= limit) break

        const content = fs.readFileSync(path.join(projectHistoryDir, file), 'utf-8')
        const lines = content.split('\n')
        const matches: string[] = []

        for (let i = 0; i < lines.length && totalMatches < limit; i++) {
          if (lines[i].toLowerCase().includes(queryLower)) {
            // Get context: 2 lines before and after
            const start = Math.max(0, i - 2)
            const end = Math.min(lines.length, i + 3)
            const context = lines.slice(start, end).join('\n')
            matches.push(context)
            totalMatches++
            i = end // Skip ahead to avoid overlapping contexts
          }
        }

        if (matches.length > 0) {
          results.push({
            date: file.replace('.md', ''),
            matches
          })
        }
      }
    } catch (error) {
      logger.error('history', 'Search failed', error instanceof Error ? error.message : String(error))
    }

    return results
  }

  /**
   * Initializes the index file for a new project.
   */
  private initializeIndex(projectId: string, projectPath: string): void {
    const indexPath = path.join(this.historyBasePath, projectId, 'index.json')
    const index: HistoryIndex = {
      projectPath,
      projectId,
      sessions: []
    }

    try {
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
    } catch (error) {
      logger.error('history', 'Failed to initialize index', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Updates the index after writing to a file.
   */
  private updateIndex(projectId: string, date: string, filePath: string): void {
    const indexPath = path.join(this.historyBasePath, projectId, 'index.json')

    try {
      let index: HistoryIndex

      if (fs.existsSync(indexPath)) {
        index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
      } else {
        index = { projectPath: '', projectId, sessions: [] }
      }

      const stats = fs.statSync(filePath)
      const content = fs.readFileSync(filePath, 'utf-8')
      const exchangeCount = (content.match(/^### \[/gm) || []).length

      // Get preview from last few exchanges
      const lines = content.split('\n')
      const previewLines = lines.slice(-20).join(' ').substring(0, 100)

      // Update or add session
      const existingIndex = index.sessions.findIndex(s => s.date === date)
      const session: HistorySession = {
        date,
        file: `${date}.md`,
        size: stats.size,
        preview: previewLines.replace(/[#*`]/g, '').trim(),
        exchangeCount
      }

      if (existingIndex >= 0) {
        index.sessions[existingIndex] = session
      } else {
        index.sessions.push(session)
      }

      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
    } catch (error) {
      logger.error('history', 'Failed to update index', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Starts the periodic flush timer.
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush()
    }, 30000) // Flush every 30 seconds
  }

  /**
   * Stops the flush timer and performs final flush.
   */
  shutdown(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    this.flush() // Final flush
    logger.info('history', 'HistoryManager shut down')
  }

  /**
   * Gets today's date as YYYY-MM-DD string.
   */
  private getTodayDateString(): string {
    const now = new Date()
    return now.toISOString().split('T')[0]
  }

  /**
   * Validates a UUID string.
   */
  private isValidUuid(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    return uuidRegex.test(str)
  }

  /**
   * Ensures a directory exists.
   */
  private ensureDirectory(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
  }
}
