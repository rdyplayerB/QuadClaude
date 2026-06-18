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
  tokenCipher?: string // base64 of safeStorage-encrypted token; absent if no token set
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
    return readStore().map((a) => ({ id: a.id, label: a.label, email: a.email, hasToken: !!a.tokenCipher }))
  }

  // Upsert an account. A token is only (re)written when a non-empty `token` is supplied —
  // editing a label leaves the existing token untouched.
  save(input: { id?: string; label: string; email?: string; token?: string }): ClaudeAccount[] {
    const accounts = readStore()
    const id = input.id || newId()
    const existing = accounts.find((a) => a.id === id)
    const tokenCipher = input.token ? encryptToken(input.token) : existing?.tokenCipher
    const next: StoredAccount = { id, label: input.label.trim() || 'Account', email: input.email?.trim() || undefined, tokenCipher }
    if (existing) Object.assign(existing, next)
    else accounts.push(next)
    writeStore(accounts)
    logger.info('accounts', existing ? 'Updated Claude account' : 'Added Claude account', `${next.label}${input.token ? ' (token set)' : ''}`)
    return this.list()
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
