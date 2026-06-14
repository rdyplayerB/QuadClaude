// RouterManager — bridges QuadClaude to claude-code-router (ccr) so a pane can run
// the REAL `claude` TUI against any non-Anthropic model. QuadClaude never speaks an
// LLM API itself: it only writes ccr's local config file. ccr (launched as `ccr code`
// inside the pane's own shell) translates Anthropic's Messages API to/from the user's
// hosted provider, so the pane looks and behaves 100% like Claude Code.
//
// Config lives at ~/.claude-code-router/config.json (ccr's documented location).
import os from 'os'
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { logger } from './logger'
import { RouterProviderInput, RouterStatus, RouterSaveResult, RouterTestResult } from '../shared/types'

const CONFIG_DIR = path.join(os.homedir(), '.claude-code-router')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

// The pane command. `ccr code` starts ccr's local router daemon if it isn't already
// up, then launches the genuine `claude` CLI pointed at it — no QuadClaude-managed
// daemon, so PATH/node resolution happens in the user's real login shell.
export const ROUTER_COMMAND = 'ccr code'

// Minimal shape of ccr's config we touch. We preserve any other keys the user set.
interface CcrProvider {
  name: string
  api_base_url: string
  api_key: string
  models: string[]
  transformer?: Record<string, unknown>
}
interface CcrConfig {
  LOG?: boolean
  Providers?: CcrProvider[]
  Router?: Record<string, string>
  [key: string]: unknown
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'model'
  )
}

export class RouterManager {
  private readConfig(): CcrConfig {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return {}
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as CcrConfig) : {}
    } catch (error) {
      logger.error('router', 'Failed to read ccr config', error instanceof Error ? error.message : String(error))
      return {}
    }
  }

  private writeConfig(cfg: CcrConfig): void {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 })
  }

  // Is the `ccr` binary resolvable from the user's real login shell? We check via a
  // login shell (not main's process.env) so nvm/global-npm PATHs are honored.
  detectCcr(): Promise<boolean> {
    return new Promise((resolve) => {
      const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')
      const args = process.platform === 'win32' ? ['-Command', 'Get-Command ccr'] : ['-lc', 'command -v ccr']
      execFile(shell, args, { timeout: 4000 }, (err, stdout) => {
        resolve(!err && !!String(stdout).trim())
      })
    })
  }

  async status(): Promise<RouterStatus> {
    const cfg = this.readConfig()
    const ccrInstalled = await this.detectCcr()
    const providers = (cfg.Providers ?? []).map((p) => ({
      name: p.name,
      model: p.models?.[0] ?? '',
      baseUrl: p.api_base_url,
    }))
    return {
      configPath: CONFIG_PATH,
      ccrInstalled,
      installHint: 'npm install -g @musistudio/claude-code-router',
      command: ROUTER_COMMAND,
      providers,
    }
  }

  // Merge one provider into ccr's config and return the env + command a pane needs.
  // Idempotent per provider `name` (re-saving the same model updates it in place).
  async saveProvider(input: RouterProviderInput): Promise<RouterSaveResult> {
    try {
      const name = slugify(input.label || input.model)
      const model = input.model.trim()
      if (!input.baseUrl.trim() || !model) {
        return { ok: false, route: '', command: ROUTER_COMMAND, env: {}, ccrInstalled: false, error: 'Base URL and model are required.' }
      }

      const provider: CcrProvider = {
        name,
        api_base_url: input.baseUrl.trim(),
        api_key: input.apiKey ?? '',
        models: [model],
        ...(input.transformer ? { transformer: { use: [input.transformer] } } : {}),
      }

      const cfg = this.readConfig()
      const providers = (cfg.Providers ?? []).filter((p) => p.name !== name)
      providers.push(provider)
      cfg.Providers = providers

      const route = `${name},${model}`
      // Route Claude Code's requests to this model. `default` is the fallback the
      // single-model case always hits; per-pane selection rides on ANTHROPIC_MODEL.
      cfg.Router = { ...(cfg.Router ?? {}), default: route }
      // Quieter logs by default; users can flip this in the file.
      if (cfg.LOG === undefined) cfg.LOG = false

      this.writeConfig(cfg)
      logger.info('router', 'Saved ccr provider', `${name} -> ${model}`)

      const ccrInstalled = await this.detectCcr()
      return {
        ok: true,
        route,
        command: ROUTER_COMMAND,
        // ANTHROPIC_MODEL lets different panes target different providers concurrently:
        // ccr routes a "name,model"-formatted model directly to that provider entry.
        env: { ANTHROPIC_MODEL: route },
        ccrInstalled,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error('router', 'Failed to save provider', msg)
      return { ok: false, route: '', command: ROUTER_COMMAND, env: {}, ccrInstalled: false, error: msg }
    }
  }

  deleteProvider(name: string): void {
    const cfg = this.readConfig()
    if (!cfg.Providers) return
    cfg.Providers = cfg.Providers.filter((p) => p.name !== name)
    this.writeConfig(cfg)
    logger.info('router', 'Deleted ccr provider', name)
  }

  // Direct, lightweight reachability check: one tiny chat completion straight to the
  // provider (NOT through ccr), so the wizard can confirm the URL+key+model before a
  // pane is ever launched. Uses global fetch (Node 18+/Electron).
  async testConnection(input: RouterProviderInput): Promise<RouterTestResult> {
    const url = input.baseUrl.trim()
    if (!url) return { ok: false, error: 'Base URL is required.' }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      }).finally(() => clearTimeout(timer))

      if (res.ok) return { ok: true }
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 300)
      } catch {
        /* ignore body read errors */
      }
      return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}` }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { ok: false, error: msg.includes('abort') ? 'Request timed out.' : msg }
    }
  }
}
