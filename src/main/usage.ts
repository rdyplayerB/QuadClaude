import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import https from 'https'
import { app, BrowserWindow } from 'electron'
import { logger } from './logger'
import { timeOp } from './perfMonitor'
import { IPC_CHANNELS, UsageData } from '../shared/types'

const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const USAGE_URL = '/api/oauth/usage'
const USAGE_HOST = 'api.anthropic.com'
const BASE_POLL_INTERVAL = 5 * 60_000 // 5 minutes
const MAX_POLL_INTERVAL = 30 * 60_000 // 30 minutes max backoff

let cachedToken: string | null = null
let tokenFetchedAt = 0
// Short on purpose: when you switch Claude accounts the Keychain gets a NEW token, and a
// long cache would keep reporting the PREVIOUS account's usage. Re-read often so a switch
// is picked up within ~a minute even if the file watcher below misses it.
const TOKEN_CACHE_MS = 60_000 // 1 minute

function getOAuthToken(): Promise<string | null> {
  const now = Date.now()
  if (cachedToken && now - tokenFetchedAt < TOKEN_CACHE_MS) {
    return Promise.resolve(cachedToken)
  }

  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], (err, stdout) => {
      if (err) {
        logger.warn('usage', 'No Claude Code credentials in Keychain')
        resolve(null)
        return
      }
      try {
        const creds = JSON.parse(stdout.trim())
        const token = creds?.claudeAiOauth?.accessToken
        if (token) {
          cachedToken = token
          tokenFetchedAt = now
          resolve(token)
        } else {
          resolve(null)
        }
      } catch {
        logger.warn('usage', 'Failed to parse Keychain credentials')
        resolve(null)
      }
    })
  })
}

function fetchUsage(token: string): Promise<{ data: UsageData | null; rateLimited: boolean }> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: USAGE_HOST,
      path: USAGE_URL,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'QuadClaude/1.0',
        'Accept': 'application/json',
      },
    }, (res) => {
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk.toString() })
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          cachedToken = null
          tokenFetchedAt = 0
          resolve({ data: null, rateLimited: false })
          return
        }
        if (res.statusCode === 429) {
          logger.warn('usage', 'Rate limited by usage API, backing off')
          resolve({ data: null, rateLimited: true })
          return
        }
        if (res.statusCode !== 200) {
          logger.warn('usage', `API returned ${res.statusCode}`, data.slice(0, 200))
          resolve({ data: null, rateLimited: false })
          return
        }
        try {
          const json = JSON.parse(data)
          logger.info('usage', 'Usage response', JSON.stringify(json).slice(0, 300))
          resolve({
            data: {
              fiveHour: {
                utilization: json.five_hour?.utilization ?? 0,
                resetsAt: json.five_hour?.resets_at ?? null,
              },
              weekly: {
                utilization: json.seven_day?.utilization ?? 0,
                resetsAt: json.seven_day?.resets_at ?? null,
              },
              fetchedAt: Date.now(),
            },
            rateLimited: false,
          })
        } catch {
          logger.warn('usage', 'Failed to parse usage response', data.slice(0, 200))
          resolve({ data: null, rateLimited: false })
        }
      })
    })
    req.on('error', (err) => {
      logger.warn('usage', 'Usage fetch failed', err.message)
      resolve({ data: null, rateLimited: false })
    })
    req.setTimeout(10_000, () => {
      req.destroy()
      resolve({ data: null, rateLimited: false })
    })
    req.end()
  })
}

function getCachePath(): string {
  return path.join(app.getPath('userData'), 'usage-cache.json')
}

function getClaudeJsonPath(): string {
  return path.join(app.getPath('home'), '.claude.json')
}

// The signed-in Claude account's email — the identity the usage token belongs to. Claude
// Code rewrites ~/.claude.json on every account switch, so this is always the current one.
// Cheap regex instead of fully parsing a ~400KB file.
function getCurrentAccountEmail(): string | null {
  try {
    const raw = fs.readFileSync(getClaudeJsonPath(), 'utf-8')
    const m = raw.match(/"emailAddress"\s*:\s*"([^"]+)"/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

// Mirror the current account into a tiny file the bash statusline reads, so each pane can
// show which account it's signed into without grepping the big ~/.claude.json per render.
function writeStatuslineAccount(email: string | null): void {
  try {
    fs.writeFileSync(path.join(app.getPath('home'), '.claude', '.statusline-account'), (email || '') + '\n', 'utf-8')
  } catch {
    // Ignore
  }
}

function loadCachedUsage(): UsageData | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getCachePath(), 'utf-8')) as UsageData & { _account?: string }
    // Never show a cached value that belongs to a DIFFERENT account than the one now signed
    // in — otherwise a freshly-switched account briefly shows the previous account's usage.
    const acct = getCurrentAccountEmail()
    if (acct && parsed._account && parsed._account !== acct) return null
    return parsed
  } catch {
    return null
  }
}

function saveCachedUsage(data: UsageData, account: string | null): void {
  try {
    fs.writeFileSync(getCachePath(), JSON.stringify({ ...data, _account: account }), 'utf-8')
  } catch {
    // Ignore write errors
  }

  // Also write to ~/.claude/.statusline-usage-cache for the bash statusline script
  try {
    const claudeDir = path.join(app.getPath('home'), '.claude')
    const cachePath = path.join(claudeDir, '.statusline-usage-cache')
    const resetsAt = data.fiveHour.resetsAt || ''
    const content = `UTILIZATION=${Math.round(data.fiveHour.utilization)}\nRESETS_AT=${resetsAt}\nTIMESTAMP=${Math.floor(Date.now() / 1000)}\n`
    fs.writeFileSync(cachePath, content, 'utf-8')
  } catch {
    // Ignore
  }
}

export class UsagePoller {
  private timeout: ReturnType<typeof setTimeout> | null = null
  private window: BrowserWindow | null = null
  private latestData: UsageData | null = null
  private currentInterval = BASE_POLL_INTERVAL
  private consecutiveFailures = 0
  private lastAccountEmail: string | null = null
  private polling = false
  private watching = false

  start(window: BrowserWindow) {
    this.window = window
    this.lastAccountEmail = getCurrentAccountEmail()
    writeStatuslineAccount(this.lastAccountEmail) // seed the per-pane account indicator
    // Load cached data immediately so UI has something to show (only if it's THIS account's)
    const cached = loadCachedUsage()
    if (cached) {
      this.latestData = cached
      this.window.webContents.send(IPC_CHANNELS.USAGE_UPDATE, cached)
      logger.info('usage', 'Loaded cached usage data', `${Math.round(cached.fiveHour.utilization)}% (fetched ${Math.round((Date.now() - cached.fetchedAt) / 60_000)}m ago)`)
    }
    // Watch ~/.claude.json (rewritten on login) so an account switch refreshes usage
    // promptly instead of waiting for the next 5-min poll. Debounced via the cheap email
    // compare; Claude Code writes this file often, but the email rarely changes.
    try {
      fs.watchFile(getClaudeJsonPath(), { interval: 5000 }, () => {
        const acct = getCurrentAccountEmail()
        if (acct && acct !== this.lastAccountEmail) {
          logger.info('usage', 'Account switch detected via ~/.claude.json — refreshing', `${this.lastAccountEmail} → ${acct}`)
          writeStatuslineAccount(acct) // update the per-pane indicator immediately
          this.forcePoll()
        }
      })
      this.watching = true
    } catch {
      // watch unsupported — poll-time detection still covers it
    }
    // Delay first API poll to avoid competing with startup IPC traffic
    this.timeout = setTimeout(() => this.poll(), 3000)
  }

  stop() {
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
    if (this.watching) {
      try { fs.unwatchFile(getClaudeJsonPath()) } catch { /* ignore */ }
      this.watching = false
    }
  }

  // Cancel the pending scheduled poll and run one now (used on account switch).
  private forcePoll() {
    if (this.timeout) { clearTimeout(this.timeout); this.timeout = null }
    void this.poll()
  }

  getLatest(): UsageData | null {
    return this.latestData
  }

  private scheduleNext() {
    this.timeout = setTimeout(() => this.poll(), this.currentInterval)
  }

  private async poll() {
    if (this.polling) return // a forced poll can overlap the scheduled one — skip the dup
    this.polling = true
    try {
      // Detect a Claude account switch (re-login). Both the Keychain token and the account
      // in ~/.claude.json change; if we kept the cached token + usage we'd report the
      // PREVIOUS account. On a change, drop the cached token and stale usage, then fetch
      // fresh for the new account.
      const account = getCurrentAccountEmail()
      if (account && this.lastAccountEmail && account !== this.lastAccountEmail) {
        logger.info('usage', 'Account changed — clearing cached token + usage', `${this.lastAccountEmail} → ${account}`)
        cachedToken = null
        tokenFetchedAt = 0
        this.latestData = null
      }
      if (account) this.lastAccountEmail = account
      writeStatuslineAccount(account) // keep the per-pane indicator current

      // Keychain read spawns /usr/bin/security and parses its output — a prime
      // suspect for periodic main-thread cost.
      const token = await timeOp('usage:keychain-token', () => getOAuthToken())
      if (!token) {
        this.currentInterval = BASE_POLL_INTERVAL
        this.scheduleNext()
        return
      }

      const result = await timeOp('usage:fetch-api', () => fetchUsage(token))

      if (result.rateLimited) {
        // Exponential backoff: double interval on each 429, up to max
        this.consecutiveFailures++
        this.currentInterval = Math.min(
          BASE_POLL_INTERVAL * Math.pow(2, this.consecutiveFailures),
          MAX_POLL_INTERVAL
        )
        logger.info('usage', `Backing off to ${Math.round(this.currentInterval / 1000)}s`)
      } else if (result.data) {
        this.latestData = result.data
        saveCachedUsage(result.data, account)
        this.window?.webContents.send(IPC_CHANNELS.USAGE_UPDATE, result.data)
        // Reset to base interval on success
        this.consecutiveFailures = 0
        this.currentInterval = BASE_POLL_INTERVAL
      }
      // If null but not rate limited (other error), keep current interval

      this.scheduleNext()
    } finally {
      this.polling = false
    }
  }
}
