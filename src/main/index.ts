import { app, BrowserWindow, ipcMain, Menu, shell, powerMonitor, dialog, clipboard, nativeImage } from 'electron'
import liquidGlass from 'electron-liquid-glass'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { PtyManager } from './pty'
import { UsagePoller } from './usage'
import { WorkspaceManager } from './workspace'
import { RouterManager } from './router'
import { delegationLog } from './delegationLog'
import { accountStore } from './accountStore'
import { logger } from './logger'
import { IPC_CHANNELS, MenuAction, RouterProviderInput, portIsolationEnv, DEFAULT_ACCOUNT_MODEL } from '../shared/types'
import { loopbackStatus, ensureLoopbackAliases } from './loopback'
import {
  initPluginHost, getPluginMenuItems, listPlugins, togglePlugin, setPluginSetting,
  openPlugin, receiveWorkspaceSnapshot, emitPtyExit, shutdownPlugins,
} from './pluginHost'
import { WorkspaceSnapshot } from '../shared/plugins'
import {
  startPerfMonitor,
  stopPerfMonitor,
  setupPerfHandlers,
  addMarker,
  revealPerfLogs,
  requestRendererFlush,
} from './perfMonitor'

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
try {
  if (require('electron-squirrel-startup')) {
    app.quit()
  }
} catch {
  // electron-squirrel-startup not installed, skip
}

let mainWindow: BrowserWindow | null = null

// Send to the renderer only if the window AND its webContents are still alive. node-pty
// (and other async sources) can emit one more event after the window/webContents has been
// destroyed on quit/reload; `mainWindow?.` guards null but NOT a destroyed-but-non-null
// webContents, which throws "Object has been destroyed". This guards both.
function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}
let stopDelegationWatch: (() => void) | null = null

// Bridge the app's delegation toggle to the Claude running inside a pane: write an
// authoritative status file the orchestrator (and a SessionStart hook) can read, so a
// fresh session auto-detects "delegation is ON" instead of falling back to OFF-by-default.
// Content: the model route when enabled+configured, else "off".
function delegationModelRoute(): string {
  try {
    const raw = fs.readFileSync(path.join(app.getPath('home'), '.quadclaude', 'delegation-model'), 'utf8').trim()
    return raw.replace('-delegate,', ',') // report the user-facing route
  } catch {
    return ''
  }
}
function delegationEnabled(): boolean {
  try {
    return !!workspaceManager?.load().preferences.delegation?.enabled
  } catch {
    return false
  }
}
function syncDelegationActive(): void {
  try {
    const dir = path.join(app.getPath('home'), '.quadclaude')
    fs.mkdirSync(dir, { recursive: true })
    const route = delegationModelRoute()
    const on = delegationEnabled() && !!route
    fs.writeFileSync(path.join(dir, 'delegation-active'), on ? route : 'off', 'utf8')
  } catch (error) {
    logger.error('delegation', 'failed to sync delegation-active', error instanceof Error ? error.message : String(error))
  }
}
let logWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let usagePoller: UsagePoller | null = null
let workspaceManager: WorkspaceManager | null = null
const routerManager = new RouterManager()
const isDev = process.env.QC_FORCE_PROD === '1' ? false : (process.env.NODE_ENV === 'development' || !app.isPackaged)

function openLogViewer() {
  if (logWindow) {
    logWindow.focus()
    return
  }

  logWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: 'QuadClaude Error Log',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  const logs = logger.getLogsAsText()
  const logFilePath = logger.getLogFilePath()

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Error Log</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'SF Mono', Menlo, Monaco, 'Courier New', monospace;
      font-size: 12px;
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 20px;
      line-height: 1.5;
    }
    h1 {
      font-size: 16px;
      color: #fff;
      margin-bottom: 8px;
      font-weight: 500;
    }
    .log-path {
      font-size: 11px;
      color: #808080;
      margin-bottom: 16px;
      word-break: break-all;
    }
    .toolbar {
      margin-bottom: 16px;
      display: flex;
      gap: 8px;
    }
    button {
      background: #3c3c3c;
      border: 1px solid #555;
      color: #d4d4d4;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      border-radius: 4px;
    }
    button:hover { background: #4c4c4c; }
    pre {
      background: #252526;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      padding: 16px;
      overflow: auto;
      max-height: calc(100vh - 140px);
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .error { color: #f48771; }
    .warn { color: #cca700; }
    .info { color: #75beff; }
    .empty {
      color: #808080;
      font-style: italic;
    }
  </style>
</head>
<body>
  <h1>Application Error Log</h1>
  <div class="log-path">Log file: ${logFilePath}</div>
  <div class="toolbar">
    <button onclick="location.reload()">Refresh</button>
    <button onclick="copyLogs()">Copy to Clipboard</button>
  </div>
  <pre id="logs">${logs ? escapeHtml(logs) : '<span class="empty">No log entries yet.</span>'}</pre>
  <script>
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    function copyLogs() {
      const logsText = document.getElementById('logs').textContent;
      navigator.clipboard.writeText(logsText).then(() => {
        alert('Logs copied to clipboard');
      });
    }
    // Highlight log levels
    const pre = document.getElementById('logs');
    pre.innerHTML = pre.innerHTML
      .replace(/\\[!ERROR\\]/g, '<span class="error">[!ERROR]</span>')
      .replace(/\\[\\?WARN\\]/g, '<span class="warn">[?WARN]</span>')
      .replace(/\\[ INFO\\]/g, '<span class="info">[ INFO]</span>');
  </script>
</body>
</html>
  `.trim()

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  logWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  logWindow.on('closed', () => {
    logWindow = null
  })

  logger.info('app', 'Log viewer opened')
}

// Install the statusline script (based on Claude-Usage-Tracker) that renders a
// rich terminal statusline AND writes context data for QuadClaude's React UI.
function installStatuslineScript() {
  const claudeDir = path.join(app.getPath('home'), '.claude')
  const scriptPath = path.join(claudeDir, 'quadclaude-statusline.sh')
  const configPath = path.join(claudeDir, 'statusline-config.txt')
  const settingsPath = path.join(claudeDir, 'settings.json')

  // Full statusline bash script based on Claude-Usage-Tracker by hamed-elfayome
  // https://github.com/hamed-elfayome/Claude-Usage-Tracker
  const script = `#!/bin/bash

# --- QuadClaude context data (written for React UI) ---
input=$(cat)
pct_raw=$(echo "$input" | grep -o '"used_percentage":[0-9.]*' | head -1 | sed 's/"used_percentage"://')
[ -z "$pct_raw" ] && pct_raw=0
pct_int=\${pct_raw%%.*}
model_raw=$(echo "$input" | grep -o '"display_name":"[^"]*"' | sed 's/"display_name":"//;s/"$//')
echo "{\\"context_pct\\":$pct_int,\\"model\\":\\"$model_raw\\",\\"ts\\":$(date +%s)}" > "/tmp/quadclaude-ctx-$PPID.json" 2>/dev/null

# --- Statusline display (Claude-Usage-Tracker style) ---
config_file="$HOME/.claude/statusline-config.txt"
if [ -f "$config_file" ]; then
  source "$config_file"
  show_model=$SHOW_MODEL
  show_dir=$SHOW_DIRECTORY
  show_branch=$SHOW_BRANCH
  show_context=$SHOW_CONTEXT
  context_as_tokens=$CONTEXT_AS_TOKENS
  show_usage=$SHOW_USAGE
  show_bar=$SHOW_PROGRESS_BAR
  show_pace_marker=$SHOW_PACE_MARKER
  show_reset=$SHOW_RESET_TIME
  use_24h=$USE_24_HOUR_TIME
  show_context_label=$SHOW_CONTEXT_LABEL
  show_usage_label=$SHOW_USAGE_LABEL
  show_reset_label=$SHOW_RESET_LABEL
  color_mode=$COLOR_MODE
  single_color=$SINGLE_COLOR
  show_profile=$SHOW_PROFILE
  profile_name="$PROFILE_NAME"
  pace_marker_step_colors=$PACE_MARKER_STEP_COLORS
  show_account=\${SHOW_ACCOUNT:-1}
else
  show_model=1
  show_dir=1
  show_branch=1
  show_context=1
  context_as_tokens=0
  show_usage=1
  show_bar=1
  show_pace_marker=1
  show_reset=1
  use_24h=0
  show_context_label=1
  show_usage_label=1
  show_reset_label=1
  color_mode="colored"
  single_color="#00BFFF"
  show_profile=0
  profile_name=""
  pace_marker_step_colors=1
  show_account=1
fi

current_dir_path=$(echo "$input" | grep -o '"current_dir":"[^"]*"' | sed 's/"current_dir":"//;s/"$//')
current_dir=$(basename "$current_dir_path")
model=$(echo "$input" | grep -o '"display_name":"[^"]*"' | sed 's/"display_name":"//;s/"$//')

hex_to_ansi() {
  local hex=$1
  hex=\${hex#\\#}
  local r=$((16#\${hex:0:2}))
  local g=$((16#\${hex:2:2}))
  local b=$((16#\${hex:4:2}))
  printf '\\033[38;2;%d;%d;%dm' "$r" "$g" "$b"
}

RESET=$'\\033[0m'

if [ "$color_mode" = "monochrome" ]; then
  BLUE="" ; GREEN="" ; GRAY="" ; YELLOW="" ; CYAN="" ; MAGENTA=""
  LEVEL_1="" ; LEVEL_2="" ; LEVEL_3="" ; LEVEL_4="" ; LEVEL_5=""
  LEVEL_6="" ; LEVEL_7="" ; LEVEL_8="" ; LEVEL_9="" ; LEVEL_10=""
  PACE_COMFORTABLE="" ; PACE_ON_TRACK="" ; PACE_WARMING=""
  PACE_PRESSING="" ; PACE_CRITICAL="" ; PACE_RUNAWAY=""
elif [ "$color_mode" = "singleColor" ]; then
  single_ansi=$(hex_to_ansi "$single_color")
  BLUE=$single_ansi ; GREEN=$single_ansi ; GRAY=$single_ansi
  YELLOW=$single_ansi ; CYAN=$single_ansi ; MAGENTA=$single_ansi
  LEVEL_1=$single_ansi ; LEVEL_2=$single_ansi ; LEVEL_3=$single_ansi
  LEVEL_4=$single_ansi ; LEVEL_5=$single_ansi ; LEVEL_6=$single_ansi
  LEVEL_7=$single_ansi ; LEVEL_8=$single_ansi ; LEVEL_9=$single_ansi
  LEVEL_10=$single_ansi
  PACE_COMFORTABLE=$single_ansi ; PACE_ON_TRACK=$single_ansi
  PACE_WARMING=$single_ansi ; PACE_PRESSING=$single_ansi
  PACE_CRITICAL=$single_ansi ; PACE_RUNAWAY=$single_ansi
else
  BLUE=$'\\033[0;34m' ; GREEN=$'\\033[0;32m' ; GRAY=$'\\033[0;90m'
  YELLOW=$'\\033[0;33m' ; CYAN=$'\\033[0;36m' ; MAGENTA=$'\\033[0;35m'
  LEVEL_1=$'\\033[38;5;22m' ; LEVEL_2=$'\\033[38;5;28m' ; LEVEL_3=$'\\033[38;5;34m'
  LEVEL_4=$'\\033[38;5;100m' ; LEVEL_5=$'\\033[38;5;142m' ; LEVEL_6=$'\\033[38;5;178m'
  LEVEL_7=$'\\033[38;5;172m' ; LEVEL_8=$'\\033[38;5;166m' ; LEVEL_9=$'\\033[38;5;160m'
  LEVEL_10=$'\\033[38;5;124m'
  PACE_COMFORTABLE=$'\\033[38;5;34m' ; PACE_ON_TRACK=$'\\033[38;5;37m'
  PACE_WARMING=$'\\033[38;5;178m' ; PACE_PRESSING=$'\\033[38;5;208m'
  PACE_CRITICAL=$'\\033[38;5;160m' ; PACE_RUNAWAY=$'\\033[38;5;135m'
fi

if [ "$pace_marker_step_colors" != "0" ]; then
  PACE_COMFORTABLE=$'\\033[38;5;34m' ; PACE_ON_TRACK=$'\\033[38;5;37m'
  PACE_WARMING=$'\\033[38;5;178m' ; PACE_PRESSING=$'\\033[38;5;208m'
  PACE_CRITICAL=$'\\033[38;5;160m' ; PACE_RUNAWAY=$'\\033[38;5;135m'
fi

dir_text=""
if [ "$show_dir" = "1" ]; then
  dir_text="\${BLUE}\${current_dir}\${RESET}"
fi

branch_text=""
if [ "$show_branch" = "1" ]; then
  if git rev-parse --git-dir > /dev/null 2>&1; then
    branch=$(git branch --show-current 2>/dev/null)
    [ -n "$branch" ] && branch_text="\${GREEN}⎇ \${branch}\${RESET}"
  fi
fi

model_text=""
if [ "$show_model" = "1" ] && [ -n "$model" ]; then
  model_text="\${YELLOW}\${model}\${RESET}"
fi

profile_text=""
if [ "$show_profile" = "1" ] && [ -n "$profile_name" ]; then
  profile_text="\${MAGENTA}\${profile_name}\${RESET}"
fi

context_text=""
if [ "$show_context" = "1" ]; then
  input_tokens=$(echo "$input" | grep -o '"input_tokens":[0-9]*' | head -1 | sed 's/"input_tokens"://')
  cache_create=$(echo "$input" | grep -o '"cache_creation_input_tokens":[0-9]*' | sed 's/"cache_creation_input_tokens"://')
  cache_read=$(echo "$input" | grep -o '"cache_read_input_tokens":[0-9]*' | sed 's/"cache_read_input_tokens"://')
  context_size=$(echo "$input" | grep -o '"context_window_size":[0-9]*' | sed 's/"context_window_size"://')

  [ -z "$input_tokens" ] && input_tokens=0
  [ -z "$cache_create" ] && cache_create=0
  [ -z "$cache_read" ] && cache_read=0

  if [ -n "$context_size" ] && [ "$context_size" -gt 0 ]; then
    current_tokens=$((input_tokens + cache_create + cache_read))
    context_pct=$((current_tokens * 100 / context_size))
    if [ "$context_pct" -le 50 ]; then
      context_color="$CYAN"
    elif [ "$context_pct" -le 75 ]; then
      context_color="$YELLOW"
    else
      context_color="$LEVEL_9"
    fi
    context_int=$context_pct
    ctx_label=""
    [ "$show_context_label" = "1" ] && ctx_label="Ctx: "
    if [ "$context_as_tokens" = "1" ]; then
      if [ "$current_tokens" -ge 1000 ]; then
        tokens_k=$((current_tokens / 1000))
        context_text="\${context_color}\${ctx_label}\${tokens_k}K\${RESET}"
      else
        context_text="\${context_color}\${ctx_label}\${current_tokens}\${RESET}"
      fi
    else
      context_text="\${context_color}\${ctx_label}\${context_int}%\${RESET}"
    fi
  fi
fi

usage_text=""
if [ "$show_usage" = "1" ]; then
  utilization=""; reset_epoch=""; weekly_util=""; weekly_reset_epoch=""; weekly_reset=""; resets_at=""
  # PREFER Claude Code's own per-session rate_limits, passed in THIS statusline's JSON input.
  # It reflects the pane's actual account (each pane's claude reports its own usage), is
  # always current, and needs NO API call — so no rate limits and it's per-account by
  # construction. The app-written cache is only a fallback for older Claude Code.
  rl_fh=$(printf '%s' "$input" | tr -d '\\n' | grep -oE '"five_hour"[[:space:]]*:[[:space:]]*\\{[^}]*\\}')
  if [ -n "$rl_fh" ]; then
    fh_pct=$(printf '%s' "$rl_fh" | grep -oE '"used_percentage"[[:space:]]*:[[:space:]]*[0-9.]+' | grep -oE '[0-9.]+' | head -1)
    utilization=\${fh_pct%%.*}
    reset_epoch=$(printf '%s' "$rl_fh" | grep -oE '"resets_at"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | head -1)
  fi
  rl_sd=$(printf '%s' "$input" | tr -d '\\n' | grep -oE '"seven_day"[[:space:]]*:[[:space:]]*\\{[^}]*\\}')
  if [ -n "$rl_sd" ]; then
    sd_pct=$(printf '%s' "$rl_sd" | grep -oE '"used_percentage"[[:space:]]*:[[:space:]]*[0-9.]+' | grep -oE '[0-9.]+' | head -1)
    weekly_util=\${sd_pct%%.*}
    weekly_reset_epoch=$(printf '%s' "$rl_sd" | grep -oE '"resets_at"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | head -1)
  fi

  swift_result=""
  if [ -n "$utilization" ]; then
    swift_result="have" # got it from the JSON; reset_epoch/weekly already set
  else
    # FALLBACK: app-written cache (per-account QC_USAGE_CACHE, else global).
    cache_file="\${QC_USAGE_CACHE:-$HOME/.claude/.statusline-usage-cache}"
    if [ -f "$cache_file" ]; then
      cache_ts=$(grep "^TIMESTAMP=" "$cache_file" 2>/dev/null | cut -d= -f2)
      now_ts=$(date +%s)
      if [ -n "$cache_ts" ] && [ "$((now_ts - cache_ts))" -lt 600 ]; then
        utilization=$(grep "^UTILIZATION=" "$cache_file" | cut -d= -f2)
        resets_at=$(grep "^RESETS_AT=" "$cache_file" | cut -d= -f2)
        weekly_util=$(grep "^WEEKLY=" "$cache_file" | cut -d= -f2)
        weekly_reset=$(grep "^WEEKLY_RESETS_AT=" "$cache_file" | cut -d= -f2)
        [ -n "$utilization" ] && swift_result="have"
      fi
    fi
  fi

  if [ -n "$swift_result" ]; then
    # JSON path already set reset_epoch; cache path needs ISO → epoch.
    if [ -z "$reset_epoch" ] && [ -n "$resets_at" ] && [ "$resets_at" != "null" ]; then
      iso_time=$(echo "$resets_at" | sed 's/\\.[0-9]*Z$//')
      reset_epoch=$(date -ju -f "%Y-%m-%dT%H:%M:%S" "$iso_time" "+%s" 2>/dev/null)
    fi

    # Per-account identity fingerprint: when this pane is bound to a Claude account, record
    # the account's REAL usage (weekly reset is its unique id) so the app can verify which
    # account a token actually reaches — WITHOUT polling the rate-limited usage API itself.
    if [ -n "$QC_ACCOUNT_ID" ] && [ -n "$utilization" ] && [ "$utilization" != "ERROR" ]; then
      mkdir -p "$HOME/.quadclaude" 2>/dev/null
      printf '{"fiveHourPct":%s,"weeklyPct":%s,"weeklyResetEpoch":%s,"at":%s}\n' \
        "\${utilization:-0}" "\${weekly_util:-0}" "\${weekly_reset_epoch:-0}" "$(date +%s)" \
        > "$HOME/.quadclaude/acct-usage-$QC_ACCOUNT_ID.json" 2>/dev/null
    fi

    if [ -n "$utilization" ] && [ "$utilization" != "ERROR" ]; then
      if [ "$utilization" -le 10 ]; then usage_color="$LEVEL_1"
      elif [ "$utilization" -le 20 ]; then usage_color="$LEVEL_2"
      elif [ "$utilization" -le 30 ]; then usage_color="$LEVEL_3"
      elif [ "$utilization" -le 40 ]; then usage_color="$LEVEL_4"
      elif [ "$utilization" -le 50 ]; then usage_color="$LEVEL_5"
      elif [ "$utilization" -le 60 ]; then usage_color="$LEVEL_6"
      elif [ "$utilization" -le 70 ]; then usage_color="$LEVEL_7"
      elif [ "$utilization" -le 80 ]; then usage_color="$LEVEL_8"
      elif [ "$utilization" -le 90 ]; then usage_color="$LEVEL_9"
      else usage_color="$LEVEL_10"
      fi

      if [ "$show_bar" = "1" ]; then
        if [ "$utilization" -eq 0 ]; then filled_blocks=0
        elif [ "$utilization" -eq 100 ]; then filled_blocks=10
        else filled_blocks=$(( (utilization * 10 + 50) / 100 ))
        fi
        [ "$filled_blocks" -lt 0 ] && filled_blocks=0
        [ "$filled_blocks" -gt 10 ] && filled_blocks=10
        empty_blocks=$((10 - filled_blocks))
        progress_bar=" "
        i=0; while [ $i -lt $filled_blocks ]; do progress_bar="\${progress_bar}▓"; i=$((i + 1)); done
        i=0; while [ $i -lt $empty_blocks ]; do progress_bar="\${progress_bar}░"; i=$((i + 1)); done
      else
        progress_bar=""
      fi

      if [ "$show_pace_marker" = "1" ] && [ "$show_bar" = "1" ] && [ -n "$reset_epoch" ]; then
        now_epoch=$(date +%s)
        remaining=$((reset_epoch - now_epoch))
        if [ $remaining -gt 0 ] && [ $remaining -lt 18000 ]; then
          elapsed_secs=$((18000 - remaining))
          marker_pos=$(( (elapsed_secs * 10 + 9000) / 18000 ))
          [ $marker_pos -gt 9 ] && marker_pos=9
          [ $marker_pos -lt 0 ] && marker_pos=0
          pace_color=""
          if [ $elapsed_secs -ge 540 ]; then
            projected_pct=$((utilization * 18000 / elapsed_secs))
            if [ $projected_pct -lt 50 ]; then pace_color="$PACE_COMFORTABLE"
            elif [ $projected_pct -lt 75 ]; then pace_color="$PACE_ON_TRACK"
            elif [ $projected_pct -lt 90 ]; then pace_color="$PACE_WARMING"
            elif [ $projected_pct -lt 100 ]; then pace_color="$PACE_PRESSING"
            elif [ $projected_pct -lt 120 ]; then pace_color="$PACE_CRITICAL"
            else pace_color="$PACE_RUNAWAY"
            fi
          fi
          if [ "$pace_marker_step_colors" = "0" ]; then pace_color="$usage_color"; fi
          if [ -n "$pace_color" ]; then
            left="\${progress_bar:0:$((marker_pos + 1))}"
            right="\${progress_bar:$((marker_pos + 2))}"
            progress_bar="\${left}\${pace_color}┃\${RESET}\${usage_color}\${right}"
          fi
        fi
      fi

      reset_time_display=""
      if [ "$show_reset" = "1" ] && [ -n "$reset_epoch" ]; then
        epoch=$reset_epoch
        if [ -n "$epoch" ]; then
          seconds_part=$((epoch % 60))
          if [ "$seconds_part" -ge 30 ]; then epoch=$((epoch + (60 - seconds_part)))
          else epoch=$((epoch - seconds_part))
          fi
          if [ "$use_24h" = "1" ]; then
            reset_time=$(date -r "$epoch" "+%H:%M" 2>/dev/null)
          else
            reset_time=$(date -r "$epoch" "+%I:%M %p" 2>/dev/null)
          fi
          if [ "$show_reset_label" = "1" ]; then
            [ -n "$reset_time" ] && reset_time_display=$(printf " → Reset: %s" "$reset_time")
          else
            [ -n "$reset_time" ] && reset_time_display=$(printf " → %s" "$reset_time")
          fi
        fi
      fi

      if [ "$show_usage_label" = "1" ]; then
        usage_text="\${usage_color}Usage: \${utilization}%\${progress_bar}\${reset_time_display}\${RESET}"
      else
        usage_text="\${usage_color}\${utilization}%\${progress_bar}\${reset_time_display}\${RESET}"
      fi

      # Weekly (total) window — appended after the 5-hour session so the bar shows both
      # "session remaining" and "total remaining" at a glance, with a day/hour countdown.
      if [ -n "$weekly_util" ]; then
        wk_disp=""
        wk_epoch="$weekly_reset_epoch"
        if [ -z "$wk_epoch" ] && [ -n "$weekly_reset" ] && [ "$weekly_reset" != "null" ]; then
          wk_iso=$(echo "$weekly_reset" | sed 's/\\.[0-9]*Z$//')
          wk_epoch=$(date -ju -f "%Y-%m-%dT%H:%M:%S" "$wk_iso" "+%s" 2>/dev/null)
        fi
        if [ -n "$wk_epoch" ]; then
          wk_rem=$((wk_epoch - $(date +%s)))
          if [ "$wk_rem" -gt 0 ]; then
            wk_days=$((wk_rem / 86400))
            wk_hours=$(((wk_rem % 86400) / 3600))
            if [ "$wk_days" -gt 0 ]; then wk_disp=" \${wk_days}d \${wk_hours}h left"
            else wk_disp=" \${wk_hours}h left"
            fi
          fi
        fi
        usage_text="\${usage_text}\${GRAY} · \${RESET}\${CYAN}Wk: \${weekly_util}%\${wk_disp}\${RESET}"
      fi
    else
      if [ "$show_usage_label" = "1" ]; then usage_text="\${YELLOW}Usage: ~\${RESET}"
      else usage_text="\${YELLOW}~\${RESET}"
      fi
    fi
  else
    if [ "$show_usage_label" = "1" ]; then usage_text="\${YELLOW}Usage: ~\${RESET}"
    else usage_text="\${YELLOW}~\${RESET}"
    fi
  fi
fi

# --- Account (which Claude account is signed in — for juggling multiple accounts) ---
account_text=""
if [ "$show_account" = "1" ]; then
  acct_email=""
  # If THIS pane is bound to a specific Claude account (per-pane token injected by the app),
  # QC_ACCOUNT_LABEL is set in the pane's env — trust it over the global file, because the
  # pane authenticates as that account regardless of who the global /login is.
  if [ -n "$QC_ACCOUNT_LABEL" ]; then
    acct_short="$QC_ACCOUNT_LABEL"
  else
    # Otherwise read the LIVE global account so a /login switch shows on the next repaint;
    # the app-written cache is only a fallback if ~/.claude.json can't be read.
    if [ -f "$HOME/.claude.json" ]; then
      acct_email=$(grep -oE '"emailAddress"[[:space:]]*:[[:space:]]*"[^"]*"' "$HOME/.claude.json" | head -1 | sed -E 's/^.*:[[:space:]]*"//;s/"$//')
    fi
    if [ -z "$acct_email" ] && [ -f "$HOME/.claude/.statusline-account" ]; then
      acct_email=$(head -1 "$HOME/.claude/.statusline-account" 2>/dev/null)
    fi
    acct_short=\${acct_email%%@*}
  fi
  if [ -n "$acct_short" ]; then
    account_text="\${MAGENTA}@\${acct_short}\${RESET}"
  fi
fi

separator="\${GRAY} │ \${RESET}"

# Identity row = everything except usage, in order.
output=""
for seg in "$dir_text" "$branch_text" "$model_text" "$account_text" "$profile_text" "$context_text"; do
  [ -n "$seg" ] || continue
  [ -n "$output" ] && output="\${output}\${separator}"
  output="\${output}\${seg}"
done
id_line="$output"
if [ -n "$usage_text" ]; then full_line="\${id_line}\${separator}\${usage_text}"; else full_line="$id_line"; fi

# Adaptive layout: keep it to ONE row when the whole thing fits the pane width (COLUMNS, set
# by Claude Code). If it would overflow — common in narrow/split panes, where the usage+weekly
# text alone runs ~100 chars — drop usage to its OWN second row so it's never clipped. Width
# is measured on the color-stripped text.
fits=1
if [ -n "$COLUMNS" ] && [ "$COLUMNS" -gt 12 ] && [ -n "$usage_text" ]; then
  esc="\${RESET%%[*}"
  vis=$(printf '%s' "$full_line" | sed "s/\${esc}\\[[0-9;]*m//g")
  [ "\${#vis}" -gt "$COLUMNS" ] && fits=0
fi

if [ "$fits" = "1" ]; then
  printf "%s\\n" "$full_line"
else
  printf "%s\\n" "$id_line"
  printf "%s\\n" "$usage_text"
fi
`

  // Default config for the statusline display
  const defaultConfig = `SHOW_MODEL=1
SHOW_DIRECTORY=1
SHOW_BRANCH=1
SHOW_CONTEXT=1
CONTEXT_AS_TOKENS=0
SHOW_USAGE=1
SHOW_PROGRESS_BAR=1
SHOW_PACE_MARKER=1
PACE_MARKER_STEP_COLORS=1
SHOW_RESET_TIME=1
USE_24_HOUR_TIME=0
SHOW_CONTEXT_LABEL=1
SHOW_USAGE_LABEL=1
SHOW_RESET_LABEL=1
COLOR_MODE=colored
SINGLE_COLOR=#00BFFF
SHOW_PROFILE=0
PROFILE_NAME=""
SHOW_ACCOUNT=1
`

  try {
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(scriptPath, script, { mode: 0o755 })

    // Install default config if none exists
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, defaultConfig, 'utf-8')
      logger.info('statusline', 'Installed default statusline config')
    }

    // Always set our statusline script (replaces any prior script including older QuadClaude versions)
    let settings: Record<string, unknown> = {}
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    }

    settings.statusLine = {
      type: 'command',
      command: `bash ${scriptPath}`,
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
    logger.info('statusline', 'Installed QuadClaude statusline script')
  } catch (error) {
    logger.warn('statusline', 'Failed to install statusline script', error instanceof Error ? error.message : String(error))
  }

  // Clean up stale temp files on startup
  try {
    const tmpFiles = fs.readdirSync('/tmp').filter(f => f.startsWith('quadclaude-ctx-'))
    for (const file of tmpFiles) {
      const filePath = `/tmp/${file}`
      const stat = fs.statSync(filePath)
      if (Date.now() - stat.mtimeMs > 3600_000) { // Older than 1 hour
        fs.unlinkSync(filePath)
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

function createWindow() {
  logger.info('window', 'Creating main window')

  // Load saved window bounds or use defaults
  const savedBounds = workspaceManager?.getWindowBounds()
  logger.info('window', 'Window bounds', savedBounds ? `${savedBounds.width}x${savedBounds.height} at (${savedBounds.x}, ${savedBounds.y})` : 'Using defaults (1400x900)')

  const preloadPath = path.join(__dirname, 'preload.js')
  logger.info('window', 'Preload script path', preloadPath)

  try {
    mainWindow = new BrowserWindow({
      width: savedBounds?.width ?? 1400,
      height: savedBounds?.height ?? 900,
      x: savedBounds?.x,
      y: savedBounds?.y,
      minWidth: 800,
      minHeight: 600,
      transparent: true,
      hasShadow: true,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 15, y: 12 },
      // Hold until first paint so the Dock animation doesn't expand into a
      // fully-transparent empty rectangle while the renderer is still
      // parsing the bundle. ready-to-show is unreliable with transparent
      // windows, so did-finish-load (below) drives show() instead.
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: preloadPath,
        zoomFactor: 1.0,
      },
    })
    logger.info('window', 'BrowserWindow created successfully')
  } catch (error) {
    logger.error('window', 'Failed to create BrowserWindow', error instanceof Error ? error.message : String(error))
    throw error
  }

  // Load the app
  if (isDev) {
    const devUrl = 'http://localhost:5173'
    logger.info('window', 'Loading dev URL', devUrl)
    mainWindow.loadURL(devUrl).catch(err => {
      logger.error('window', 'Failed to load dev URL', err.message)
    })
    mainWindow.webContents.openDevTools()
  } else {
    const htmlPath = path.join(__dirname, '../renderer/index.html')
    logger.info('window', 'Loading production HTML', htmlPath)
    mainWindow.loadFile(htmlPath).catch(err => {
      logger.error('window', 'Failed to load HTML file', err.message)
    })
  }

  // Listen for renderer errors
  mainWindow.webContents.on('did-fail-load', (_, errorCode, errorDescription) => {
    logger.error('renderer', 'Page failed to load', `Code: ${errorCode}, Description: ${errorDescription}`)
  })

  mainWindow.webContents.on('render-process-gone', (_, details) => {
    logger.error('renderer', 'Render process crashed', `Reason: ${details.reason}, Exit code: ${details.exitCode}`)
  })

  mainWindow.webContents.on('unresponsive', () => {
    logger.warn('renderer', 'Renderer became unresponsive')
  })

  mainWindow.webContents.on('responsive', () => {
    logger.info('renderer', 'Renderer is responsive again')
  })

  mainWindow.webContents.on('did-finish-load', () => {
    logger.info('renderer', 'Page finished loading')
    // Reveal the window now that content has painted - avoids the empty
    // transparent flash during the Dock launch animation.
    mainWindow?.show()
    // Push new delegation events to the renderer (drives the live dashboard and the
    // session-scoped worker-feed prompt). Re-armed on every load; the prior watcher
    // is cleared first so a reload doesn't stack pollers.
    stopDelegationWatch?.()
    stopDelegationWatch = delegationLog.startWatching((event) => {
      sendToRenderer(IPC_CHANNELS.DELEGATION_EVENT, event)
    })
    // Ensure zoom is exactly 1.0 to prevent scaling differences
    mainWindow?.webContents.setZoomFactor(1.0)

    // Enable liquid glass effect (macOS Tahoe+)
    try {
      if (mainWindow) {
        mainWindow.setWindowButtonVisibility(true)
        liquidGlass.addView(mainWindow.getNativeWindowHandle(), {
          cornerRadius: 12,
          tintColor: '#20000000',
          opaque: false,
        })
        logger.info('window', 'Liquid glass enabled')
      }
    } catch (err) {
      logger.info('window', 'Liquid glass not available', err instanceof Error ? err.message : String(err))
    }
  })

  // Block browser-like refresh shortcuts to prevent losing terminal state
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Block Cmd+R, Ctrl+R, F5, Cmd+Shift+R, Ctrl+Shift+R
    const keyLower = input.key.toLowerCase()
    const isRefresh =
      (keyLower === 'r' && (input.meta || input.control)) ||
      input.key === 'F5'

    if (isRefresh) {
      event.preventDefault()
      logger.info('window', 'Blocked refresh shortcut', `key: ${input.key}, meta: ${input.meta}, ctrl: ${input.control}, shift: ${input.shift}`)
    }
  })

  // Block programmatic navigation/reloads (e.g., from external links or scripts)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // In production, only allow navigating to the app's own URL
    // In dev, allow the dev server URL
    const currentUrl = mainWindow?.webContents.getURL() || ''
    const allowedOrigin = isDev ? 'http://localhost:5173' : 'file://'

    if (!url.startsWith(allowedOrigin)) {
      event.preventDefault()
      logger.warn('window', 'Blocked navigation attempt', url)
    }
  })

  // Any window.open / target=_blank / popup attempt → hand the URL to the system default
  // browser (a normal tab in the active session) and NEVER spawn a chromeless Electron
  // popup window. Without this, the terminal's link addon and any preview markup open
  // their own bare window instead of the user's real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Save window bounds on resize/move
  mainWindow.on('resize', saveWindowBounds)
  mainWindow.on('move', saveWindowBounds)

  // Returning to the app from another window/app can leave the webContents without
  // keyboard focus — the terminal pane stays selectable but won't accept typing or
  // Ctrl-C until focus is restored. Re-focus the webContents on window focus; the
  // renderer then re-focuses the active terminal's textarea.
  mainWindow.on('focus', () => mainWindow?.webContents.focus())

  mainWindow.on('closed', () => {
    logger.info('window', 'Main window closed')
    mainWindow = null
  })

  // Create application menu
  createApplicationMenu()
}

function saveWindowBounds() {
  if (mainWindow && workspaceManager) {
    const bounds = mainWindow.getBounds()
    workspaceManager.saveWindowBounds(bounds)
  }
}

function createApplicationMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        {
          label: 'About QuadClaude',
          click: () => {
            app.setAboutPanelOptions({
              applicationName: 'QuadClaude',
              applicationVersion: app.getVersion(),
              version: 'Build ' + new Date().toISOString().split('T')[0],
              copyright: '© 2024-2026 rdyplayerB',
              credits: 'The ADHD workspace for Claude Code\n\nCrafted by ビルド studio · https://birudo.studio',
            })
            app.showAboutPanel()
          }
        },
        { type: 'separator' },
        {
          label: 'Settings...',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendMenuAction('open-settings')
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        // Explicitly register refresh shortcuts to block Electron's default reload behavior
        // These must be enabled for the accelerator to be "claimed" and prevent default
        {
          label: 'Reload (Disabled)',
          accelerator: 'CmdOrCtrl+R',
          visible: false,
          click: () => {
            // Intentionally do nothing - blocks page refresh
            logger.info('window', 'Blocked Cmd+R from menu')
          }
        },
        {
          label: 'Force Reload (Disabled)',
          accelerator: 'CmdOrCtrl+Shift+R',
          visible: false,
          click: () => {
            // Intentionally do nothing - blocks force refresh
            logger.info('window', 'Blocked Cmd+Shift+R from menu')
          }
        },
        {
          label: 'Reload F5 (Disabled)',
          accelerator: 'F5',
          visible: false,
          click: () => {
            // Intentionally do nothing - blocks F5 refresh
            logger.info('window', 'Blocked F5 from menu')
          }
        },
        {
          label: 'Always Show Prompt Bar',
          accelerator: 'CmdOrCtrl+P',
          type: 'checkbox',
          checked: true,
          click: (menuItem) => {
            sendMenuAction('toggle-prompt-bar')
            // Menu item checked state toggles automatically
          }
        },
        { type: 'separator' },
        {
          label: 'Grid Layout',
          accelerator: 'CmdOrCtrl+1',
          click: () => sendMenuAction('layout-grid')
        },
        {
          label: 'Focus Left Layout',
          accelerator: 'CmdOrCtrl+2',
          click: () => sendMenuAction('layout-focus')
        },
        {
          label: 'Focus Right Layout',
          accelerator: 'CmdOrCtrl+3',
          click: () => sendMenuAction('layout-focus-right')
        },
        {
          label: 'Duo Layout',
          accelerator: 'CmdOrCtrl+4',
          click: () => sendMenuAction('layout-duo')
        },
        {
          label: 'Solo Layout',
          accelerator: 'CmdOrCtrl+5',
          click: () => sendMenuAction('layout-solo')
        },
        { type: 'separator' },
        {
          label: 'Toggle PiP Strip',
          accelerator: 'CmdOrCtrl+B',
          click: () => sendMenuAction('toggle-pip')
        },
        {
          label: 'Cycle Pane Into View',
          accelerator: 'Ctrl+Tab',
          click: () => sendMenuAction('cycle-pane')
        },
        { type: 'separator' },
        // Cmd +/- targets whichever surface is frontmost — Activity Console,
        // else the delegation dashboard, else the terminals (see App.tsx).
        {
          label: 'Increase Font Size',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => sendMenuAction('increase-font')
        },
        {
          label: 'Decrease Font Size',
          accelerator: 'CmdOrCtrl+-',
          click: () => sendMenuAction('decrease-font')
        },
        { type: 'separator' },
        // The app's own UI text (toolbar, pane headers, Settings), separate
        // from terminal font so each can be sized for how it's read.
        {
          label: 'Increase UI Size',
          accelerator: 'CmdOrCtrl+Shift+Plus',
          click: () => sendMenuAction('increase-ui')
        },
        {
          label: 'Decrease UI Size',
          accelerator: 'CmdOrCtrl+Shift+-',
          click: () => sendMenuAction('decrease-ui')
        },
        {
          label: 'Reset UI Size',
          accelerator: 'CmdOrCtrl+Shift+0',
          click: () => sendMenuAction('reset-ui')
        },
        { type: 'separator' },
        // Plugin-contributed items (e.g. Activity Console). Generic — any
        // enabled window-kind plugin with a menu entry appears here.
        ...getPluginMenuItems(),
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'Focus Terminal 1',
          accelerator: 'CmdOrCtrl+Shift+1',
          click: () => sendMenuAction('focus-pane-1')
        },
        {
          label: 'Focus Terminal 2',
          accelerator: 'CmdOrCtrl+Shift+2',
          click: () => sendMenuAction('focus-pane-2')
        },
        {
          label: 'Focus Terminal 3',
          accelerator: 'CmdOrCtrl+Shift+3',
          click: () => sendMenuAction('focus-pane-3')
        },
        {
          label: 'Focus Terminal 4',
          accelerator: 'CmdOrCtrl+Shift+4',
          click: () => sendMenuAction('focus-pane-4')
        },
        { type: 'separator' },
        {
          label: 'Clear Terminal',
          accelerator: 'CmdOrCtrl+K',
          click: () => sendMenuAction('clear-pane')
        },
        {
          label: 'Launch Claude',
          accelerator: 'CmdOrCtrl+L',
          click: () => sendMenuAction('launch-claude')
        },
        { type: 'separator' },
        {
          label: 'Reset Current Pane',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => sendMenuAction('reset-pane')
        }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    },
    {
      label: 'Performance',
      submenu: [
        {
          label: 'Mark Slowdown Now',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => {
            requestRendererFlush()
            addMarker('user-reported-slowdown')
          }
        },
        {
          label: 'Add Marker',
          click: () => {
            requestRendererFlush()
            addMarker('manual-marker')
          }
        },
        {
          label: 'Dump Pane Diagnostics',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => sendMenuAction('dump-diagnostics')
        },
        { type: 'separator' },
        {
          label: 'Reveal Performance Logs',
          click: () => revealPerfLogs()
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'View Error Log...',
          click: () => openLogViewer()
        },
        {
          label: 'Open Log File in Finder',
          click: async () => {
            const logPath = logger.getLogFilePath()
            logger.info('app', 'Opening log file location', logPath)
            await shell.showItemInFolder(logPath)
          }
        },
        { type: 'separator' },
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://github.com/rdyplayerB/QuadClaude')
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function sendMenuAction(action: MenuAction) {
  sendToRenderer(IPC_CHANNELS.APP_MENU_ACTION, action)
}

// Persist plugin enabled-state + settings to the workspace so they survive a
// restart. Called after every toggle/setSetting (rare, user-driven — load()
// here is fine, unlike the debounced pane-save path). Without this, enabling a
// plugin / "open at launch" / verification mode all silently reset on relaunch.
function persistPluginPrefs(): void {
  if (!workspaceManager) return
  const plugins: Record<string, { enabled: boolean; settings: Record<string, unknown> }> = {}
  for (const d of listPlugins()) {
    if (d.manifest?.id) plugins[d.manifest.id] = { enabled: d.enabled, settings: d.settings }
  }
  const preferences = workspaceManager.load().preferences
  workspaceManager.save({ preferences: { ...preferences, plugins } })
}

// Setup IPC handlers
function setupIPC() {
  // PTY creation
  ipcMain.handle(IPC_CHANNELS.PTY_CREATE, async (_, paneId: number, cwd?: string, env?: Record<string, string>) => {
    logger.info('pty', `Creating PTY for pane ${paneId}`, cwd ? `cwd: ${cwd}` : 'using default cwd')
    try {
      // Inject per-pane port-isolation env (HOST/PORT) so dev servers don't collide,
      // and QC_PANE so a `qcdelegate` run inside this pane stamps its telemetry with the
      // originating pane id (lets the app attribute delegations to the right session).
      const prefs = workspaceManager?.load().preferences
      const iso = portIsolationEnv(paneId, prefs?.portIsolation)
      // Surface the delegation toggle into the pane's shell so a Claude session can detect
      // delegation mode from its environment (mirrors the ~/.quadclaude/delegation-active file).
      const delegationOn = !!prefs?.delegation?.enabled && !!delegationModelRoute()
      const delegationEnv = delegationOn
        ? { QC_DELEGATION: '1', QC_DELEGATION_MODEL: delegationModelRoute() }
        : { QC_DELEGATION: '' }
      // Per-pane Claude account: the renderer passes the bound account id as a non-secret
      // env HINT (QC_ACCOUNT_ID). We decrypt that account's long-lived subscription token
      // and inject it as CLAUDE_CODE_OAUTH_TOKEN so `claude` authenticates as that account,
      // overriding the shared Keychain login. We also blank ANTHROPIC_API_KEY for this pane
      // — it outranks the OAuth token in precedence, so a stray global API key would
      // silently switch the pane to metered billing. QC_ACCOUNT_LABEL feeds the statusline.
      // The hint itself is stripped so it never lingers in the pane env.
      let accountEnv: Record<string, string> = {}
      // Prefer the env HINT from launchAgent (timing-safe right after picking an account,
      // before the debounced workspace save lands). On a COLD pane spawn (e.g. app restart)
      // there's no hint, so fall back to the pane's PERSISTED binding — the workspace is
      // already loaded then, so it's safe. This is what makes the binding survive a restart
      // instead of silently falling back to the global /login.
      const accountId = env?.QC_ACCOUNT_ID || workspaceManager?.load().panes.find((p) => p.id === paneId)?.claudeAccountId
      const baseEnv = { ...(env || {}) }
      delete baseEnv.QC_ACCOUNT_ID
      if (accountId) {
        const token = accountStore.getToken(accountId)
        const label = accountStore.getLabel(accountId)
        if (token) {
          accountEnv = {
            CLAUDE_CODE_OAUTH_TOKEN: token,
            ANTHROPIC_API_KEY: '',
            QC_ACCOUNT_LABEL: label || '',
            // Keep the account id in the pane's env so the status line can stamp this
            // account's identity fingerprint (acct-usage-<id>.json) as it renders.
            QC_ACCOUNT_ID: accountId,
            // Point the statusline at THIS account's usage cache (per-account session +
            // weekly numbers) instead of the global login's.
            QC_USAGE_CACHE: path.join(app.getPath('home'), '.claude', `.statusline-usage-${accountId}`),
          }
          // Pin the model for this account (a fresh token session otherwise starts on
          // Sonnet). Default to Opus 4.8 1M; the sentinel 'default' opts out of pinning.
          const model = accountStore.getModel(accountId) ?? DEFAULT_ACCOUNT_MODEL
          if (model && model !== 'default') accountEnv.ANTHROPIC_MODEL = model
        } else {
          logger.warn('accounts', `Pane ${paneId} bound to account ${accountId} but no token available — using global login`)
        }
      }
      const mergedEnv = { ...baseEnv, ...iso, QC_PANE: String(paneId), ...delegationEnv, ...accountEnv }
      const result = await ptyManager?.createPty(paneId, cwd, mergedEnv)
      if (result) {
        logger.info('pty', `PTY created successfully for pane ${paneId}`)
      } else {
        logger.error('pty', `Failed to create PTY for pane ${paneId}`)
      }
      return result
    } catch (error) {
      logger.error('pty', `Exception creating PTY for pane ${paneId}`, error instanceof Error ? error.message : String(error))
      return false
    }
  })

  // PTY kill
  ipcMain.handle(IPC_CHANNELS.PTY_KILL, async (_, paneId: number) => {
    logger.info('pty', `Killing PTY for pane ${paneId}`)
    ptyManager?.killPty(paneId)
  })

  // Terminal input
  ipcMain.on(IPC_CHANNELS.TERMINAL_INPUT, (_, paneId: number, data: string) => {
    ptyManager?.write(paneId, data)
  })

  // Terminal resize
  ipcMain.on(IPC_CHANNELS.TERMINAL_RESIZE, (_, paneId: number, cols: number, rows: number) => {
    ptyManager?.resize(paneId, cols, rows)
  })

  // Get current working directory
  ipcMain.handle(IPC_CHANNELS.PTY_CWD, async (_, paneId: number) => {
    return ptyManager?.getCwd(paneId)
  })

  // Get git status
  ipcMain.handle(IPC_CHANNELS.PTY_GIT_STATUS, async (_, paneId: number) => {
    return ptyManager?.getGitStatus(paneId)
  })

  // Check if Claude process is running in PTY
  ipcMain.handle(IPC_CHANNELS.PTY_IS_CLAUDE_RUNNING, async (_, paneId: number) => {
    return ptyManager?.isClaudeRunning(paneId) ?? false
  })

  // Workspace operations
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LOAD, async () => {
    logger.info('workspace', 'Loading workspace state')
    try {
      const state = workspaceManager?.load()
      logger.info('workspace', 'Workspace loaded successfully', state ? `Layout: ${state.layout}, Panes: ${state.panes?.length || 0}` : 'No state')
      return state
    } catch (error) {
      logger.error('workspace', 'Failed to load workspace', error instanceof Error ? error.message : String(error))
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SAVE, async (_, state) => {
    try {
      workspaceManager?.save(state)
      syncDelegationActive() // keep the delegation status file current when the toggle changes
      logger.info('workspace', 'Workspace saved')
    } catch (error) {
      logger.error('workspace', 'Failed to save workspace', error instanceof Error ? error.message : String(error))
    }
  })

  // Model router (claude-code-router) — write ccr config so a pane can run the real
  // Claude Code TUI against any non-Anthropic model.
  ipcMain.handle(IPC_CHANNELS.ROUTER_STATUS, async () => {
    return routerManager.status()
  })

  ipcMain.handle(IPC_CHANNELS.ROUTER_SAVE_PROVIDER, async (_, input: RouterProviderInput) => {
    return routerManager.saveProvider(input)
  })

  ipcMain.handle(IPC_CHANNELS.ROUTER_DELETE_PROVIDER, async (_, name: string) => {
    routerManager.deleteProvider(name)
  })

  ipcMain.handle(IPC_CHANNELS.ROUTER_TEST, async (_, input: RouterProviderInput) => {
    return routerManager.testConnection(input)
  })

  ipcMain.handle(IPC_CHANNELS.ROUTER_SET_DELEGATION, async (_, route: string) => {
    return routerManager.setDelegation(route)
  })

  ipcMain.handle(IPC_CHANNELS.ROUTER_DELEGATION_STATUS, async () => {
    return routerManager.delegationStatus()
  })

  ipcMain.handle(IPC_CHANNELS.ROUTER_CLEAR_DELEGATION, async () => {
    routerManager.clearDelegation()
    return routerManager.delegationStatus()
  })

  // Delegation telemetry — per-project rollups, raw events, export, and a wipe action.
  ipcMain.handle(IPC_CHANNELS.DELEGATION_SUMMARIES, async () => {
    return delegationLog.getSummaries()
  })

  ipcMain.handle(IPC_CHANNELS.DELEGATION_EVENTS, async () => {
    return delegationLog.getEvents()
  })

  ipcMain.handle(IPC_CHANNELS.DELEGATION_DECISIONS, async () => {
    return delegationLog.getDecisions()
  })

  ipcMain.handle(IPC_CHANNELS.DELEGATION_INSIGHTS, async () => {
    return delegationLog.getInsights()
  })

  ipcMain.handle(IPC_CHANNELS.DELEGATION_FULL_PROMPT, async (_, ts: string, task: string) => {
    return delegationLog.getFullPrompt(ts, task)
  })

  ipcMain.handle(IPC_CHANNELS.DELEGATION_CLEAR, async () => {
    delegationLog.clearAll()
    return delegationLog.getSummaries()
  })

  // Record the real outcome of a delegated task (ship/revert/edit) into the durable eval
  // memory via `qceval verdict`, so calibration learns how often the eval was right.
  ipcMain.handle(IPC_CHANNELS.DELEGATION_VERDICT, async (_, task: string, verdict: string) => {
    if (!['ship', 'revert', 'edit'].includes(verdict) || !task || task === 'untagged') return false
    return new Promise<boolean>((resolve) => {
      // Run through a login shell so the user's PATH (node + ~/.local/bin) resolves; task and
      // verdict go as positional args ($1/$2) to avoid any shell injection.
      execFile('/bin/zsh', ['-lc', 'qceval verdict "$1" "$2"', 'qcverdict', task, verdict], { timeout: 8000 }, (err) => resolve(!err))
    })
  })

  // Clipboard write from main — reliable even when the renderer isn't focused (the
  // renderer's navigator.clipboard.writeText silently fails without focus/user-gesture).
  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_WRITE_TEXT, async (_, text: string) => {
    clipboard.writeText(text)
    return true
  })

  // Per-pane Claude accounts. The renderer only ever receives metadata (label/email/hasToken)
  // — the token is write-only from the renderer's side and never returned.
  ipcMain.handle(IPC_CHANNELS.CLAUDE_ACCOUNTS_LIST, async () => accountStore.list())
  ipcMain.handle(IPC_CHANNELS.CLAUDE_ACCOUNTS_SAVE, async (_, input: { id?: string; label: string; email?: string; model?: string; token?: string }) => {
    try {
      const accounts = accountStore.save(input)
      // When a token was provided, resolve which account it REALLY is so the UI can flag a
      // wrong/swapped token immediately. Find the (possibly new) record by matching input.
      if (input.token) {
        const saved = accounts.find((a) => a.id === input.id) || accounts.find((a) => a.label === input.label.trim())
        if (saved) { const v = await accountStore.verify(saved.id); return { ok: true, accounts: v.accounts } }
      }
      return { ok: true, accounts }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), accounts: accountStore.list() }
    }
  })
  ipcMain.handle(IPC_CHANNELS.CLAUDE_ACCOUNTS_DELETE, async (_, id: string) => accountStore.delete(id))
  ipcMain.handle(IPC_CHANNELS.CLAUDE_ACCOUNTS_VERIFY, async (_, id: string) => accountStore.verify(id))

  // --- Generic plugin system ---
  ipcMain.handle(IPC_CHANNELS.PLUGIN_LIST, async () => listPlugins())
  ipcMain.handle(IPC_CHANNELS.PLUGIN_TOGGLE, async (_, id: string, enabled: boolean) => { const d = togglePlugin(id, enabled); persistPluginPrefs(); return d })
  ipcMain.handle(IPC_CHANNELS.PLUGIN_SET_SETTING, async (_, id: string, key: string, value: unknown) => { const d = setPluginSetting(id, key, value); persistPluginPrefs(); return d })
  ipcMain.on(IPC_CHANNELS.PLUGIN_OPEN, (_, id: string) => openPlugin(id))
  // Renderer pushes a compact live workspace snapshot for plugins that observe
  // pane state (fire-and-forget; the host no-ops if nothing subscribes).
  ipcMain.on(IPC_CHANNELS.PLUGIN_WORKSPACE_SNAPSHOT, (_, snap: WorkspaceSnapshot) => {
    try { receiveWorkspaceSnapshot(snap) } catch (e) { logger.warn('pluginHost', 'bad workspace snapshot', String(e)) }
  })

  // Build the shareable report; if `save` is requested, write it via a save dialog.
  // Always returns the report text so the renderer can also copy it to the clipboard.
  ipcMain.handle(IPC_CHANNELS.DELEGATION_EXPORT, async (_, save: boolean) => {
    const text = delegationLog.buildReport()
    if (!save) return { text, path: null, canceled: false }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export delegation log',
      defaultPath: path.join(app.getPath('downloads'), `delegation-log-${stamp}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All Files', extensions: ['*'] }],
    })
    if (result.canceled || !result.filePath) return { text, path: null, canceled: true }
    fs.writeFileSync(result.filePath, text, 'utf8')
    return { text, path: result.filePath, canceled: false }
  })

  // Per-pane port isolation — macOS loopback alias management.
  ipcMain.handle(IPC_CHANNELS.NET_LOOPBACK_STATUS, async () => {
    return loopbackStatus()
  })

  ipcMain.handle(IPC_CHANNELS.NET_ENSURE_LOOPBACK, async () => {
    return ensureLoopbackAliases()
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_HOME, async () => {
    const home = app.getPath('home')
    logger.info('workspace', 'Home directory requested', home)
    return home
  })

  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, async () => {
    return app.getVersion()
  })

  // Usage tracking
  ipcMain.handle(IPC_CHANNELS.USAGE_FETCH, async () => {
    return usagePoller?.getLatest() ?? null
  })

  // Per-pane context window usage
  ipcMain.handle(IPC_CHANNELS.PTY_CONTEXT_USAGE, async (_, paneId: number) => {
    return ptyManager?.getContextUsage(paneId) ?? null
  })

  // Detect listening servers for all panes (one shared lsof+ps).
  // Returns a plain object keyed by paneId for easy renderer consumption.
  ipcMain.handle(IPC_CHANNELS.PTY_DETECT_SERVERS, async () => {
    const map = (await ptyManager?.detectServers()) ?? new Map()
    return Object.fromEntries(map)
  })

  // Kill a detected server in a pane
  ipcMain.handle(IPC_CHANNELS.PTY_KILL_SERVER, async (_, paneId: number, pid: number) => {
    return (await ptyManager?.killServer(paneId, pid)) ?? false
  })

  // Paste an image into a pane the way Claude Code expects: put the image
  // bytes on the system clipboard, then send Ctrl+V so Claude Code reads it
  // and shows an [Image #N] attachment instead of a literal file path.
  ipcMain.handle(IPC_CHANNELS.PTY_PASTE_IMAGE, async (_, paneId: number, filePath: string) => {
    try {
      const img = nativeImage.createFromPath(filePath)
      if (img.isEmpty()) return false
      clipboard.writeImage(img)
      ptyManager?.write(paneId, '\x16') // Ctrl+V
      return true
    } catch {
      return false
    }
  })

  // Open a URL (e.g. http://localhost:PORT) in the system default browser
  ipcMain.handle(IPC_CHANNELS.APP_OPEN_EXTERNAL, async (_, url: string) => {
    // Only http(s) — refuse file://, javascript:, etc. to avoid shell-handler abuse
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false
    try {
      await shell.openExternal(url)
      return true
    } catch (error) {
      logger.error('app', 'Failed to open external URL', error instanceof Error ? error.message : String(error))
      return false
    }
  })

  // Diagnostics bridge: let the renderer write structured entries into the same
  // app.log the rest of the app uses (and the Error Log viewer reads). Used for
  // pane-init lifecycle tracking + the blank-pane watchdog. Fire-and-forget
  // (ipcMain.on, not handle) so the renderer never blocks on disk I/O. Inputs
  // are length-capped since they cross the process boundary from the UI.
  ipcMain.on(IPC_CHANNELS.APP_LOG, (_, level: string, category: string, message: string, details?: string) => {
    const cat = typeof category === 'string' ? category.slice(0, 64) : 'renderer'
    const msg = typeof message === 'string' ? message.slice(0, 512) : String(message)
    const det = typeof details === 'string' ? details.slice(0, 2048) : undefined
    if (level === 'error') logger.error(cat, msg, det)
    else if (level === 'warn') logger.warn(cat, msg, det)
    else logger.info(cat, msg, det)
  })

  // Open a markdown file referenced in a pane's output in TextEdit (macOS) / default
  // editor elsewhere. The renderer passes the raw text it matched (e.g. "EO14411/SEO-RUBRIC.md");
  // we resolve it against that pane's live cwd and refuse anything that isn't an existing .md file.
  ipcMain.handle(IPC_CHANNELS.APP_OPEN_IN_EDITOR, async (_, paneId: number, rawPath: string) => {
    if (typeof rawPath !== 'string' || !/\.(md|markdown)$/i.test(rawPath.trim())) return false
    try {
      let candidate = rawPath.trim()
      // Expand a leading ~ to the home directory.
      if (candidate === '~' || candidate.startsWith('~/')) {
        candidate = path.join(os.homedir(), candidate.slice(1))
      }
      // Resolve relative paths against the pane's live cwd (the user may have cd'd).
      if (!path.isAbsolute(candidate)) {
        const cwd = ptyManager?.getCwd(paneId)
        if (!cwd) return false
        candidate = path.resolve(cwd, candidate)
      }
      // Must be an existing regular file ending in .md/.markdown — no dirs, no other types.
      let stat: fs.Stats
      try {
        stat = fs.statSync(candidate)
      } catch {
        return false
      }
      if (!stat.isFile() || !/\.(md|markdown)$/i.test(candidate)) return false

      if (process.platform === 'darwin') {
        await new Promise<void>((resolve, reject) => {
          execFile('/usr/bin/open', ['-a', 'TextEdit', candidate], (err) => (err ? reject(err) : resolve()))
        })
      } else {
        const errMsg = await shell.openPath(candidate)
        if (errMsg) throw new Error(errMsg)
      }
      return true
    } catch (error) {
      logger.error('app', 'Failed to open file in editor', error instanceof Error ? error.message : String(error))
      return false
    }
  })

  // File dialog for background image selection
  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN_IMAGE, async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Background Image',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}

// App lifecycle
app.whenReady().then(() => {
  logger.info('app', 'App ready, starting initialization')
  logger.info('app', 'App version', app.getVersion())
  logger.info('app', 'Electron version', process.versions.electron)
  logger.info('app', 'Chrome version', process.versions.chrome)
  logger.info('app', 'Node version', process.versions.node)
  logger.info('app', 'Platform', `${process.platform} ${process.arch}`)
  logger.info('app', 'User data path', app.getPath('userData'))
  logger.info('app', 'Is packaged', String(app.isPackaged))

  try {
    logger.info('workspace', 'Initializing WorkspaceManager')
    workspaceManager = new WorkspaceManager()
    logger.info('workspace', 'WorkspaceManager initialized')
  } catch (error) {
    logger.error('workspace', 'Failed to initialize WorkspaceManager', error instanceof Error ? error.message : String(error))
  }

  // Keep delegation telemetry bounded: fold an oversized event log into the cumulative
  // per-project rollup and drop summaries for long-abandoned projects.
  delegationLog.maintain()
  // Publish the current delegation toggle so a Claude session in a pane can detect it.
  syncDelegationActive()

  try {
    logger.info('pty', 'Initializing PtyManager')
    ptyManager = new PtyManager((paneId, data) => {
      sendToRenderer(IPC_CHANNELS.TERMINAL_OUTPUT, paneId, data)
    }, (paneId, exitCode) => {
      logger.info('pty', `PTY exited for pane ${paneId}`, `Exit code: ${exitCode}`)
      sendToRenderer(IPC_CHANNELS.PTY_EXIT, paneId, exitCode)
      emitPtyExit(paneId, exitCode) // feed plugins (Ops Console incident toasts)
    })
    logger.info('pty', 'PtyManager initialized')
  } catch (error) {
    logger.error('pty', 'Failed to initialize PtyManager', error instanceof Error ? error.message : String(error))
  }

  logger.info('ipc', 'Setting up IPC handlers')
  setupIPC()
  logger.info('ipc', 'IPC handlers registered')

  // Performance recording: starts automatically and writes JSONL to
  // <userData>/perf-logs. Analyze later with scripts/analyze-perf.mjs.
  setupPerfHandlers()
  startPerfMonitor(
    () => ptyManager?.getStats() ?? { sessions: 0, totalBytesOut: 0, perPaneBytesOut: {} },
    () => ptyManager?.getPaneDescendants() ?? Promise.resolve([])
  )

  createWindow()

  // Generic plugin host: activates enabled plugins (e.g. the Ops Console) and
  // wires them a read-only capability context. Must run after ptyManager +
  // workspaceManager + createWindow (menu/notify depend on them).
  try {
    initPluginHost({
      appVersion: app.getVersion(),
      homeDir: app.getPath('home'),
      initialPluginPrefs: workspaceManager?.load()?.preferences?.plugins,
      ptyStats: () => ptyManager?.getStats() ?? { sessions: 0, totalBytesOut: 0, perPaneBytesOut: {} },
      getGitStatus: (paneId) => ptyManager?.getGitStatus(paneId) ?? Promise.resolve(null),
      getContextUsage: (paneId) => ptyManager?.getContextUsage(paneId) ?? Promise.resolve(null),
      rebuildMenu: () => createApplicationMenu(),
      notifyChanged: (descriptors) => sendToRenderer(IPC_CHANNELS.PLUGIN_CHANGED, descriptors),
      sendToUi: (channel, payload) => sendToRenderer(channel, payload),
    })
    // Rebuild the menu so any auto-enabled plugin's item appears.
    createApplicationMenu()
  } catch (error) {
    logger.error('pluginHost', 'Failed to init plugin host', error instanceof Error ? error.message : String(error))
  }

  // Start usage polling
  usagePoller = new UsagePoller()
  if (mainWindow) usagePoller.start(mainWindow)

  // Install statusline script for context window tracking. Deferred so the
  // sync FS work (settings.json read/write, /tmp scan + statSync per file)
  // doesn't block the main thread while the renderer is loading its bundle
  // and making its first workspace:load IPC call.
  setImmediate(() => installStatuslineScript())

  app.on('activate', () => {
    logger.info('app', 'App activated')
    if (BrowserWindow.getAllWindows().length === 0) {
      logger.info('app', 'No windows open, creating new window')
      createWindow()
    }
  })

  // Listen for system resume (wake from sleep)
  powerMonitor.on('resume', () => {
    logger.info('app', 'System resumed from sleep')
    sendToRenderer(IPC_CHANNELS.SYSTEM_RESUME)
  })
})

app.on('window-all-closed', () => {
  logger.info('app', 'All windows closed')

  // Save current working directories BEFORE killing PTYs
  if (ptyManager && workspaceManager) {
    const cwds = ptyManager.getAllCwds()
    workspaceManager.updatePaneCwds(cwds)
  }

  ptyManager?.killAll()
  if (process.platform !== 'darwin') {
    logger.info('app', 'Quitting app (non-macOS)')
    app.quit()
  }
})

let isHardExiting = false
app.on('before-quit', (e) => {
  if (isHardExiting) return
  isHardExiting = true
  logger.info('app', 'App is quitting')
  try { shutdownPlugins() } catch { /* never block quit */ }
  stopPerfMonitor()
  // Save CWDs before killing PTYs (important when Cmd+Q is used) — synchronous.
  if (ptyManager && workspaceManager) {
    const cwds = ptyManager.getAllCwds()
    if (cwds.size > 0) {
      workspaceManager.updatePaneCwds(cwds)
      logger.info('app', 'Saved CWDs on quit', `${cwds.size} pane(s)`)
    }
  }
  ptyManager?.killAll()
  // node-pty's read threads can fire a ThreadSafeFunction callback into a half-finalized
  // V8 environment during Electron's graceful teardown → SIGABRT in pty.node (the recurring
  // CrBrowserMain abort-on-quit). Bypass that teardown entirely: cancel the graceful quit,
  // give the just-killed ptys a tick to release their native handles, then hard-exit so the
  // OS reaps those threads instead of V8 racing them. State is already saved above.
  e.preventDefault()
  setTimeout(() => app.exit(0), 100)
})

// Catch uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('app', 'Uncaught exception', error.stack || error.message)
})

process.on('unhandledRejection', (reason) => {
  logger.error('app', 'Unhandled promise rejection', String(reason))
})
