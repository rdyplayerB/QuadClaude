import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { logger } from './logger'

// Install the statusline script (based on Claude-Usage-Tracker) that renders a
// rich terminal statusline AND writes context data for QuadClaude's React UI.
export function installStatuslineScript() {
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
