// AccountStore — per-pane Claude accounts, backed by isolated profile directories.
//
// Each account maps to its own CLAUDE_CONFIG_DIR (~/.quadclaude/profiles/<id>). When a pane
// is bound to an account, the main process injects that dir into the pane's env at spawn
// (see ipc.ts), so Claude Code keeps a fully separate login, history, and session store per
// account. The user signs in ONCE per profile with `/login` inside a bound pane — Claude
// Code then writes that profile's own Keychain entry and refreshes it itself.
//
// SECURITY: QuadClaude stores NO credentials at all anymore. The OAuth tokens live where
// Claude Code puts them — in macOS Keychain entries named
//   `Claude Code-credentials-<sha256(configDir)[0:8]>`
// (suffix derived exactly like the CLI derives it from CLAUDE_CONFIG_DIR). getToken() reads
// that entry ONLY in the main process, solely so the usage poller can fetch per-account
// usage numbers. The previous token-vault implementation (long-lived setup-token ciphertext
// via safeStorage) is archived at archive/accountStore-token-vault.ts.
import os from 'os'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { app } from 'electron'
import { logger } from './logger'
import { ClaudeAccount } from '../shared/types'

interface StoredAccount {
  id: string
  label: string
  email?: string
  model?: string // ANTHROPIC_MODEL to pin for this account's panes; 'default' = don't pin
  tokenCipher?: string // LEGACY (pre-profile vault) — ignored; left in place so an old store file loads cleanly
}

// The identity fingerprint a bound pane's status line writes (from Claude Code's own
// per-session usage). Read live — never polled from the API, so no rate limits.
function readFingerprint(id: string): ClaudeAccount['verifiedUsage'] | undefined {
  try {
    const f = path.join(os.homedir(), '.quadclaude', `acct-usage-${id}.json`)
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (typeof j.weeklyResetEpoch === 'number') {
      return { weeklyPct: j.weeklyPct ?? 0, weeklyResetEpoch: j.weeklyResetEpoch, fiveHourPct: j.fiveHourPct ?? 0, at: j.at ?? 0 }
    }
  } catch {
    /* not captured yet */
  }
  return undefined
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'claude-accounts.json')
}

function readStore(): StoredAccount[] {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as StoredAccount[]) : []
  } catch {
    return []
  }
}

function writeStore(accounts: StoredAccount[]): void {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(accounts), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    logger.error('accounts', 'Failed to write account store', error instanceof Error ? error.message : String(error))
  }
}

// Cheap unique id without Date.now()/Math.random() entanglements.
let idCounter = 0
function newId(): string {
  idCounter += 1
  return `acct_${process.pid.toString(36)}_${idCounter.toString(36)}_${os.hostname().length}`
}

// ── Profile directories ─────────────────────────────────────────────────────

function profilesRoot(): string {
  return path.join(os.homedir(), '.quadclaude', 'profiles')
}

export function profileDir(id: string): string {
  return path.join(profilesRoot(), id)
}

// The Keychain service name Claude Code uses for a given CLAUDE_CONFIG_DIR: the default
// service plus the first 8 hex chars of sha256 over the (NFC-normalized) dir string. Must
// match the CLI's derivation byte-for-byte — the dir we hash is the exact string we inject.
export function keychainService(dir: string): string {
  const suffix = crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').substring(0, 8)
  return `Claude Code-credentials-${suffix}`
}

// Whether the profile has completed `/login` — i.e. its Keychain entry exists.
function profileLoggedIn(id: string): boolean {
  try {
    execFileSync('/usr/bin/security', ['find-generic-password', '-s', keychainService(profileDir(id))], { stdio: 'ignore', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

// The email Claude Code recorded for this profile's login (from the profile's own
// .claude.json). Authoritative once the user has logged in — beats the hand-typed label.
function profileEmail(id: string): string | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(profileDir(id), '.claude.json'), 'utf8'))
    const email = j?.oauthAccount?.emailAddress
    return typeof email === 'string' && email ? email : undefined
  } catch {
    return undefined
  }
}

// Create + seed the profile dir so a first launch feels like home instead of a bare
// onboarding wizard: copy the global settings.json and CLAUDE.md, share plugins/agents/
// commands/skills via symlink (installs stay global), and pre-complete onboarding.
// Idempotent — safe to call on every pane spawn.
export function ensureProfileDir(id: string): string {
  const dir = profileDir(id)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const globalClaude = path.join(os.homedir(), '.claude')
    for (const f of ['settings.json', 'CLAUDE.md']) {
      const src = path.join(globalClaude, f)
      const dst = path.join(dir, f)
      if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst)
    }
    for (const d of ['plugins', 'agents', 'commands', 'skills']) {
      const src = path.join(globalClaude, d)
      const dst = path.join(dir, d)
      if (!fs.existsSync(dst) && fs.existsSync(src)) fs.symlinkSync(src, dst)
    }
    const stateFile = path.join(dir, '.claude.json')
    if (!fs.existsSync(stateFile)) {
      fs.writeFileSync(stateFile, JSON.stringify({ hasCompletedOnboarding: true }), { encoding: 'utf8', mode: 0o600 })
    }
  } catch (error) {
    logger.error('accounts', `Failed to prepare profile dir for ${id}`, error instanceof Error ? error.message : String(error))
  }
  return dir
}

class AccountStore {
  // Renderer-safe view: metadata + whether the profile has a login on file. Never a secret.
  list(): ClaudeAccount[] {
    return readStore().map((a) => ({
      id: a.id,
      label: a.label,
      email: profileEmail(a.id) ?? a.email,
      model: a.model,
      loggedIn: profileLoggedIn(a.id),
      verifiedUsage: readFingerprint(a.id),
    }))
  }

  // Re-read the identity fingerprint (captured by a bound pane's status line). No API call.
  // 'ok' = a fingerprint exists; 'needs_pane' = bind a pane to this account so its status
  // line can capture it.
  verify(id: string): { accounts: ClaudeAccount[]; status: 'ok' | 'needs_pane' } {
    return { accounts: this.list(), status: readFingerprint(id) ? 'ok' : 'needs_pane' }
  }

  // Upsert an account (metadata only — there is no credential to store; the profile's
  // login happens inside a bound pane via `/login`).
  save(input: { id?: string; label: string; email?: string; model?: string }): ClaudeAccount[] {
    const accounts = readStore()
    const id = input.id || newId()
    const existing = accounts.find((a) => a.id === id)
    const next: StoredAccount = {
      id,
      label: input.label.trim() || 'Account',
      email: input.email?.trim() || undefined,
      model: input.model ?? existing?.model,
      tokenCipher: existing?.tokenCipher, // legacy field carried, never read
    }
    if (existing) Object.assign(existing, next)
    else accounts.push(next)
    writeStore(accounts)
    if (!existing) ensureProfileDir(id)
    logger.info('accounts', existing ? 'Updated Claude account' : 'Added Claude account (profile dir)', next.label)
    return this.list()
  }

  getModel(id: string): string | null {
    return readStore().find((a) => a.id === id)?.model ?? null
  }

  // Deletes the account entry. The profile dir (history, sessions) and its Keychain login
  // are left on disk deliberately — cheap, and re-adding the account can't lose data. The
  // dir is small; the user can remove ~/.quadclaude/profiles/<id> by hand if they care.
  delete(id: string): ClaudeAccount[] {
    writeStore(readStore().filter((a) => a.id !== id))
    logger.info('accounts', 'Deleted Claude account', id)
    return this.list()
  }

  // MAIN-PROCESS ONLY: the profile's CURRENT access token, read from the Keychain entry
  // Claude Code itself maintains for that profile (written/refreshed by its own /login
  // machinery). Used solely by the usage poller. Never exposed over IPC to the renderer.
  getToken(id: string): string | null {
    try {
      const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', keychainService(profileDir(id)), '-w'], { encoding: 'utf8', timeout: 3000 })
      const creds = JSON.parse(out.trim())
      const token = creds?.claudeAiOauth?.accessToken
      return typeof token === 'string' && token ? token : null
    } catch {
      return null // not logged in yet (or Keychain read failed) — poller just skips
    }
  }

  getLabel(id: string): string | null {
    return readStore().find((a) => a.id === id)?.label ?? null
  }
}

export const accountStore = new AccountStore()
