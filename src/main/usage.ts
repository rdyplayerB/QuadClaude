import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import https from 'https'
import { app, BrowserWindow } from 'electron'
import { logger } from './logger'
import { timeOp } from './perfMonitor'
import { IPC_CHANNELS, UsageData } from '../shared/types'
import { accountStore } from './accountStore'

const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const USAGE_URL = '/api/oauth/usage'
const USAGE_HOST = 'api.anthropic.com'
// Per-account usage now comes FREE from each pane's own statusline JSON (Claude Code passes
// rate_limits per session), so we no longer poll the API per account — that just burned the
// shared per-IP rate-limit budget. This poller only refreshes the GLOBAL fallback cache (for
// older Claude Code that doesn't pass rate_limits) on the original slow cadence.
const ROTATION_TICK = 5 * 60_000 // 5 minutes

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

// Write the bash-statusline cache for one usage payload. Carries BOTH the 5-hour session
// and the weekly window (each with its reset time) so the statusline can show session +
// total remaining. `filePath` is the global cache for unbound panes, or a per-account file
// (.statusline-usage-<id>) so an account-bound pane shows ITS account's real numbers.
function writeStatuslineCache(filePath: string, data: UsageData): void {
  try {
    const content =
      `UTILIZATION=${Math.round(data.fiveHour.utilization)}\n` +
      `RESETS_AT=${data.fiveHour.resetsAt || ''}\n` +
      `WEEKLY=${Math.round(data.weekly.utilization)}\n` +
      `WEEKLY_RESETS_AT=${data.weekly.resetsAt || ''}\n` +
      `TIMESTAMP=${Math.floor(Date.now() / 1000)}\n`
    fs.writeFileSync(filePath, content, 'utf-8')
  } catch {
    // Ignore
  }
}

function statuslineCachePath(accountId?: string): string {
  const claudeDir = path.join(app.getPath('home'), '.claude')
  return path.join(claudeDir, accountId ? `.statusline-usage-${accountId}` : '.statusline-usage-cache')
}

function saveCachedUsage(data: UsageData, account: string | null): void {
  try {
    fs.writeFileSync(getCachePath(), JSON.stringify({ ...data, _account: account }), 'utf-8')
  } catch {
    // Ignore write errors
  }
  // Global statusline cache (used by panes on the default /login account).
  writeStatuslineCache(statuslineCachePath(), data)
}

export class UsagePoller {
  private timeout: ReturnType<typeof setTimeout> | null = null
  private window: BrowserWindow | null = null
  private latestData: UsageData | null = null
  private rotationIndex = 0
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
    // First tick soon after startup (targets[0] = global, so the global cache + switch
    // detection refresh fast); accounts then follow on the rotation.
    this.timeout = setTimeout(() => this.tick(), 3000)
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

  // Cancel the pending tick and poll the GLOBAL account now (used on account switch — the
  // global login is what just changed). Resets rotation so the next tick targets global.
  private forcePoll() {
    if (this.timeout) { clearTimeout(this.timeout); this.timeout = null }
    this.rotationIndex = 0
    void this.tick()
  }

  getLatest(): UsageData | null {
    return this.latestData
  }

  // ROTATION: the usage endpoint rate-limits a BURST of requests from one IP (calls 6–42s
  // apart all 429'd; only the ~5-min-spaced global polls ever succeeded). So instead of
  // polling the global account + every account back-to-back, ONE target is polled per tick
  // and targets rotate: [global, account A, account B, …]. Every API call is therefore
  // ROTATION_TICK apart — wide enough that the limiter's bucket refills between calls.
  private scheduleNext(delay = ROTATION_TICK) {
    this.timeout = setTimeout(() => this.tick(), delay)
  }

  // Only the global account is polled now — per-account usage is read directly from each
  // pane's statusline JSON (no API call), so polling accounts here would only waste the
  // shared per-IP rate-limit budget.
  private targets(): string[] {
    return ['global']
  }

  private async tick() {
    if (this.polling) return // a forced poll can overlap the scheduled tick — skip the dup
    this.polling = true
    try {
      const targets = this.targets()
      const target = targets[this.rotationIndex % targets.length]
      this.rotationIndex = (this.rotationIndex + 1) % Math.max(1, targets.length)
      if (target === 'global') await this.pollGlobal()
      else await this.pollAccount(target)
    } finally {
      this.polling = false
      this.scheduleNext()
    }
  }

  // Poll the globally signed-in account (Keychain token). Updates the global statusline
  // cache (for unbound panes), the in-memory latest, and detects account switches.
  private async pollGlobal() {
    // Detect a Claude account switch (re-login): the Keychain token + ~/.claude.json change.
    const account = getCurrentAccountEmail()
    if (account && this.lastAccountEmail && account !== this.lastAccountEmail) {
      logger.info('usage', 'Account changed — clearing cached token + usage', `${this.lastAccountEmail} → ${account}`)
      cachedToken = null
      tokenFetchedAt = 0
      this.latestData = null
    }
    if (account) this.lastAccountEmail = account
    writeStatuslineAccount(account) // keep the per-pane indicator current

    const token = await timeOp('usage:keychain-token', () => getOAuthToken())
    if (!token) return
    const result = await timeOp('usage:fetch-api', () => fetchUsage(token))
    if (result.data) {
      this.latestData = result.data
      saveCachedUsage(result.data, account)
      this.window?.webContents.send(IPC_CHANNELS.USAGE_UPDATE, result.data)
    }
    // On 429/other error: skip this cycle; the next global tick is a full rotation away.
  }

  // Poll one saved account's usage (its own token) → its own statusline cache, so a pane
  // bound to it shows ITS real session + weekly numbers. The endpoint is metadata-only and
  // does NOT consume inference quota, so this can't eat into the limits it reports.
  private async pollAccount(id: string) {
    let token: string | null = null
    try {
      token = accountStore.getToken(id)
    } catch {
      return
    }
    if (!token) return
    try {
      const res = await fetchUsage(token)
      if (res.data) writeStatuslineCache(statuslineCachePath(id), res.data)
      // 429/no data → leave the prior cache so the pane keeps its last value (not "~");
      // it retries on the next rotation.
    } catch {
      // ignore one account's failure
    }
  }
}
