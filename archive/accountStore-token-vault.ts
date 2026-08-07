// AccountStore — the encrypted vault for per-pane Claude subscription accounts.
//
// Each account binds a label (e.g. "Work") to a long-lived CLAUDE_CODE_OAUTH_TOKEN (from
// `claude setup-token`). When a pane is bound to an account, the main process injects that
// token into the pane's env at spawn (see index.ts), which overrides the shared macOS
// Keychain login — so two panes can run two different Max subscriptions at once.
//
// SECURITY: the token is a long-lived credential, so it is NEVER written in plaintext and
// NEVER placed in workspace.json. It is encrypted with Electron safeStorage (backed by the
// OS Keychain) and stored as ciphertext in a 0600 file under userData. The renderer can
// only ever see metadata (label/email) + a boolean hasToken — never the token itself.
import os from 'os'
import fs from 'fs'
import path from 'path'
import { app, safeStorage } from 'electron'
import { logger } from './logger'
import { ClaudeAccount } from '../shared/types'

interface StoredAccount {
  id: string
  label: string
  email?: string
  model?: string // ANTHROPIC_MODEL to pin for this account's panes; 'default' = don't pin
  tokenCipher?: string // base64 of safeStorage-encrypted token; absent if no token set
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

function fingerprintPath(id: string): string {
  return path.join(os.homedir(), '.quadclaude', `acct-usage-${id}.json`)
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

function encryptToken(token: string): string | undefined {
  if (!token) return undefined
  if (!safeStorage.isEncryptionAvailable()) {
    logger.error('accounts', 'safeStorage encryption unavailable — refusing to store token in plaintext')
    throw new Error('Secure storage is unavailable on this system; cannot save the account token.')
  }
  return safeStorage.encryptString(token).toString('base64')
}

class AccountStore {
  // Renderer-safe view: metadata + whether a token is on file. NEVER the token.
  list(): ClaudeAccount[] {
    return readStore().map((a) => ({ id: a.id, label: a.label, email: a.email, model: a.model, hasToken: !!a.tokenCipher, verifiedUsage: readFingerprint(a.id) }))
  }

  // Re-read the identity fingerprint (captured by a bound pane's status line). No API call.
  // 'ok' = a fingerprint exists; 'needs_pane' = bind a pane to this account so its status
  // line can capture it.
  verify(id: string): { accounts: ClaudeAccount[]; status: 'ok' | 'needs_pane' } {
    return { accounts: this.list(), status: readFingerprint(id) ? 'ok' : 'needs_pane' }
  }

  // Upsert an account. A token is only (re)written when a non-empty `token` is supplied —
  // editing a label leaves the existing token untouched.
  save(input: { id?: string; label: string; email?: string; model?: string; token?: string }): ClaudeAccount[] {
    const accounts = readStore()
    const id = input.id || newId()
    const existing = accounts.find((a) => a.id === id)
    const tokenCipher = input.token ? encryptToken(input.token) : existing?.tokenCipher
    const next: StoredAccount = {
      id,
      label: input.label.trim() || 'Account',
      email: input.email?.trim() || undefined,
      model: input.model ?? existing?.model,
      tokenCipher,
    }
    if (existing) Object.assign(existing, next)
    else accounts.push(next)
    writeStore(accounts)
    // A new token may be a different account — drop the stale identity fingerprint so the UI
    // doesn't show the old account until a bound pane re-captures it.
    if (input.token) { try { fs.rmSync(fingerprintPath(id)) } catch { /* none */ } }
    logger.info('accounts', existing ? 'Updated Claude account' : 'Added Claude account', `${next.label}${input.token ? ' (token set)' : ''}`)
    return this.list()
  }

  // Every account that has a token, with its decrypted token — MAIN-PROCESS ONLY, for the
  // usage poller to fetch per-account usage. Never exposed over IPC.
  allWithTokens(): Array<{ id: string; label: string; token: string }> {
    const out: Array<{ id: string; label: string; token: string }> = []
    for (const a of readStore()) {
      if (!a.tokenCipher) continue
      const token = this.getToken(a.id)
      if (token) out.push({ id: a.id, label: a.label, token })
    }
    return out
  }

  getModel(id: string): string | null {
    return readStore().find((a) => a.id === id)?.model ?? null
  }

  delete(id: string): ClaudeAccount[] {
    writeStore(readStore().filter((a) => a.id !== id))
    logger.info('accounts', 'Deleted Claude account', id)
    return this.list()
  }

  // MAIN-PROCESS ONLY: decrypt a token for injection into a pane's env. Returns null if the
  // account/token is missing or decryption fails. Never exposed over IPC to the renderer.
  getToken(id: string): string | null {
    const acct = readStore().find((a) => a.id === id)
    if (!acct?.tokenCipher) return null
    try {
      if (!safeStorage.isEncryptionAvailable()) return null
      return safeStorage.decryptString(Buffer.from(acct.tokenCipher, 'base64'))
    } catch (error) {
      logger.error('accounts', 'Failed to decrypt account token', error instanceof Error ? error.message : String(error))
      return null
    }
  }

  getLabel(id: string): string | null {
    return readStore().find((a) => a.id === id)?.label ?? null
  }
}

export const accountStore = new AccountStore()
