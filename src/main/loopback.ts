// macOS loopback alias management for per-pane port isolation.
//
// 'loopback' isolation binds each pane's dev servers to its own 127.0.0.x address so N
// panes can all use port 3000 without colliding. On macOS only 127.0.0.1 exists by
// default; the others must be added via `ifconfig lo0 alias 127.0.0.x` (root). We add
// them with a single admin prompt and install a launchd daemon so they survive reboot.
// On Linux/Windows the whole 127.0.0.0/8 is bindable already, so nothing is needed.
import { execFile } from 'child_process'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { LoopbackStatus, MAX_PANES, paneLoopbackIp } from '../shared/types'
import { logger } from './logger'

const COUNT = MAX_PANES // one loopback alias per possible pane
const PLIST = '/Library/LaunchDaemons/com.quadclaude.loopback.plist'

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60000 }, (err, stdout) => resolve({ code: err ? 1 : 0, stdout: String(stdout || '') }))
  })
}

export async function loopbackStatus(): Promise<LoopbackStatus> {
  if (process.platform !== 'darwin') {
    // 127.0.0.0/8 is all loopback on Linux/Windows — bindable without aliases.
    return { supported: false, configured: 0, expected: 0, ready: true }
  }
  const { stdout } = await run('ifconfig', ['lo0'])
  let configured = 0
  for (let i = 0; i < COUNT; i++) {
    if (stdout.includes(`inet ${paneLoopbackIp(i)} `)) configured++
  }
  return { supported: true, configured, expected: COUNT, ready: configured >= COUNT }
}

// Add all the aliases now (one admin prompt) and persist them via a launchd daemon.
export async function ensureLoopbackAliases(): Promise<LoopbackStatus> {
  if (process.platform !== 'darwin') return loopbackStatus()

  const ips = Array.from({ length: COUNT }, (_, i) => paneLoopbackIp(i))
  const addNow = ips.map((ip) => `/sbin/ifconfig lo0 alias ${ip} up`).join('\n')
  const bootCmd = ips.map((ip) => `/sbin/ifconfig lo0 alias ${ip} up`).join('; ')

  const script = `#!/bin/sh
${addNow}
cat > '${PLIST}' <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.quadclaude.loopback</string>
  <key>RunAtLoad</key><true/>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string>
    <string>${bootCmd}</string>
  </array>
</dict></plist>
PLIST
chmod 644 '${PLIST}'
launchctl load -w '${PLIST}' 2>/dev/null || true
`
  const tmp = path.join(os.tmpdir(), 'qc-loopback-setup.sh')
  fs.writeFileSync(tmp, script, { mode: 0o755 })
  // Single admin password prompt; runs the setup as root.
  const res = await run('osascript', ['-e', `do shell script "/bin/sh '${tmp}'" with administrator privileges`])
  try { fs.rmSync(tmp) } catch { /* ignore */ }
  if (res.code !== 0) logger.error('loopback', 'Alias setup failed or was cancelled')
  else logger.info('loopback', `Loopback aliases configured (${ips[0]}–${ips[ips.length - 1]})`)
  return loopbackStatus()
}
