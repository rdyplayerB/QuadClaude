import { app, BrowserWindow, ipcMain, Menu, shell, powerMonitor, dialog, clipboard, nativeImage } from 'electron'
import liquidGlass from 'electron-liquid-glass'
import fs from 'fs'
import path from 'path'
import { PtyManager } from './pty'
import { UsagePoller } from './usage'
import { WorkspaceManager } from './workspace'
import { logger } from './logger'
import { IPC_CHANNELS, MenuAction } from '../shared/types'
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
let logWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let usagePoller: UsagePoller | null = null
let workspaceManager: WorkspaceManager | null = null
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

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
  cache_file="$HOME/.claude/.statusline-usage-cache"
  swift_result=""
  if [ -f "$cache_file" ]; then
    cache_ts=$(grep "^TIMESTAMP=" "$cache_file" 2>/dev/null | cut -d= -f2)
    now_ts=$(date +%s)
    if [ -n "$cache_ts" ]; then
      cache_age=$((now_ts - cache_ts))
      if [ "$cache_age" -lt 600 ]; then
        cache_util=$(grep "^UTILIZATION=" "$cache_file" | cut -d= -f2)
        cache_reset=$(grep "^RESETS_AT=" "$cache_file" | cut -d= -f2)
        if [ -n "$cache_util" ]; then
          swift_result="\${cache_util}|\${cache_reset}"
        fi
      fi
    fi
  fi

  if [ -z "$swift_result" ] && [ -x "$HOME/.claude/fetch-claude-usage.swift" ]; then
    swift_result=$(swift "$HOME/.claude/fetch-claude-usage.swift" 2>/dev/null)
  fi

  if [ -n "$swift_result" ]; then
    utilization=$(echo "$swift_result" | cut -d'|' -f1)
    resets_at=$(echo "$swift_result" | cut -d'|' -f2)

    reset_epoch=""
    if [ -n "$resets_at" ] && [ "$resets_at" != "null" ]; then
      iso_time=$(echo "$resets_at" | sed 's/\\.[0-9]*Z$//')
      reset_epoch=$(date -ju -f "%Y-%m-%dT%H:%M:%S" "$iso_time" "+%s" 2>/dev/null)
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

output=""
separator="\${GRAY} │ \${RESET}"

[ -n "$dir_text" ] && output="\${dir_text}"
if [ -n "$branch_text" ]; then
  [ -n "$output" ] && output="\${output}\${separator}"
  output="\${output}\${branch_text}"
fi
if [ -n "$model_text" ]; then
  [ -n "$output" ] && output="\${output}\${separator}"
  output="\${output}\${model_text}"
fi
if [ -n "$profile_text" ]; then
  [ -n "$output" ] && output="\${output}\${separator}"
  output="\${output}\${profile_text}"
fi
if [ -n "$context_text" ]; then
  [ -n "$output" ] && output="\${output}\${separator}"
  output="\${output}\${context_text}"
fi
if [ -n "$usage_text" ]; then
  [ -n "$output" ] && output="\${output}\${separator}"
  output="\${output}\${usage_text}"
fi

printf "%s\\n" "$output"
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

  // Save window bounds on resize/move
  mainWindow.on('resize', saveWindowBounds)
  mainWindow.on('move', saveWindowBounds)

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
        { type: 'separator' },
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
  mainWindow?.webContents.send(IPC_CHANNELS.APP_MENU_ACTION, action)
}

// Setup IPC handlers
function setupIPC() {
  // PTY creation
  ipcMain.handle(IPC_CHANNELS.PTY_CREATE, async (_, paneId: number, cwd?: string) => {
    logger.info('pty', `Creating PTY for pane ${paneId}`, cwd ? `cwd: ${cwd}` : 'using default cwd')
    try {
      const result = await ptyManager?.createPty(paneId, cwd)
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
      logger.info('workspace', 'Workspace saved')
    } catch (error) {
      logger.error('workspace', 'Failed to save workspace', error instanceof Error ? error.message : String(error))
    }
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

  try {
    logger.info('pty', 'Initializing PtyManager')
    ptyManager = new PtyManager((paneId, data) => {
      mainWindow?.webContents.send(IPC_CHANNELS.TERMINAL_OUTPUT, paneId, data)
    }, (paneId, exitCode) => {
      logger.info('pty', `PTY exited for pane ${paneId}`, `Exit code: ${exitCode}`)
      mainWindow?.webContents.send(IPC_CHANNELS.PTY_EXIT, paneId, exitCode)
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
    mainWindow?.webContents.send(IPC_CHANNELS.SYSTEM_RESUME)
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

app.on('before-quit', () => {
  logger.info('app', 'App is quitting')
  stopPerfMonitor()
  // Save CWDs before killing PTYs (important when Cmd+Q is used)
  if (ptyManager && workspaceManager) {
    const cwds = ptyManager.getAllCwds()
    if (cwds.size > 0) {
      workspaceManager.updatePaneCwds(cwds)
      logger.info('app', 'Saved CWDs on quit', `${cwds.size} pane(s)`)
    }
  }
  ptyManager?.killAll()
})

// Catch uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('app', 'Uncaught exception', error.stack || error.message)
})

process.on('unhandledRejection', (reason) => {
  logger.error('app', 'Unhandled promise rejection', String(reason))
})
