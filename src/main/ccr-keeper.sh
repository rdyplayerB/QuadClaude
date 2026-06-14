#!/bin/zsh
# ccr-keeper — keep the claude-code-router (ccr) local router alive on :3456.
#
# Installed as a launchd agent (com.quadclaude.ccr) that fires on an interval.
# Each run: health-check the local router; if it's down, (re)start it detached.
# ccr itself is the LOCAL proxy — it does not need the VPN to run; the VPN only
# matters when a request is actually forwarded to Olares. So we keep ccr up
# unconditionally and let individual delegations surface a VPN error if needed.
#
# The nvm-installed ccr/node live off the default launchd PATH (see memory:
# opencode-nvm-path-symlink), and the node version churns (memory:
# node-env-broken-nvm-default), so we SELF-LOCATE ccr instead of hard-pinning.
# Search order: PATH, the homebrew symlink, then the newest nvm node bin.
# ccr's shebang is `#!/usr/bin/env node`, so node's bin dir MUST be on PATH even
# when ccr resolves to the homebrew symlink. Prepend the newest nvm node bin dir
# (where both node AND ccr live) plus homebrew, then resolve ccr from PATH.
for nvm in "$HOME"/.nvm/versions/node/*/bin(N); do NVM_BIN="$nvm"; done  # last glob = newest
export PATH="${NVM_BIN:+$NVM_BIN:}/opt/homebrew/bin:$PATH"
CCR="$(command -v ccr 2>/dev/null)"

PORT=3456
URL="http://127.0.0.1:${PORT}"
LOG="$HOME/.quadclaude/ccr-keeper.log"
mkdir -p "$HOME/.quadclaude"

ts() { date +"%Y-%m-%dT%H:%M:%S%z"; }

# Already up? Nothing to do.
if curl -s -o /dev/null -m 4 "$URL" 2>/dev/null; then
  exit 0
fi

if [ -z "$CCR" ]; then
  echo "$(ts) ERROR: ccr binary not found (PATH / homebrew symlink / nvm) — cannot start router" >> "$LOG"
  exit 0
fi

echo "$(ts) router down on :${PORT} — starting ccr ($CCR)" >> "$LOG"

# Start detached; a foreground `ccr start` would block launchd's interval slot.
( "$CCR" start >>"$LOG" 2>&1 & )

# Wait briefly for it to come up so launchd records a clean exit.
for _ in $(seq 1 30); do
  curl -s -o /dev/null -m 4 "$URL" 2>/dev/null && { echo "$(ts) router up on :${PORT}" >> "$LOG"; exit 0; }
  sleep 0.3
done

echo "$(ts) WARN: ccr did not come up within ~9s" >> "$LOG"
exit 0
