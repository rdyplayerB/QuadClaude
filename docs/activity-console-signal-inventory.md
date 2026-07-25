# Activity Console — signal inventory & motion plan

What a Claude Code session actually emits, what we use, and what we could use.
Every claim here was measured against real transcripts on 2026-07-24 (Claude Code
2.1.219, 40 transcripts, 6,584 records). Numbers in this doc are observed, not
estimated.

Goal context: the console doubles as a marketing surface. The constraint that
makes it credible is that **nothing on screen may be synthesized** — density has
to come from surfacing *more kinds of real signal*, never from faking movement.

---

## 0. The architectural finding

Everything the console does today is **poll + infer**:

- re-read the last 256KB of the transcript every 1.5s
- infer "busy" from PTY output silence
- infer "blocked" by regex-scanning the terminal buffer

Claude Code also supports **push**: 11 hook events, fired synchronously, with the
tool name and id attached. We use exactly one (`SessionStart`, for delegation).

Switching the console's spine from poll to push is simultaneously the biggest
*accuracy* win and the biggest *motion* win. It is the foundation everything
else in this doc sits on.

---

## 1. Hooks — push events (available, unused)

All 11 confirmed present in the 2.1.219 binary. Hooks already fire in these
sessions (installed by the claude-mem plugin), and the transcript records each
one as a `hook_success` attachment carrying `hookName`, `toolUseID`,
`durationMs`, `exitCode`:

```
PostToolUse   904        hookName: "PostToolUse:Bash"   ← matcher includes the tool
PreToolUse     92        hookName: "PreToolUse:Read"
Stop           63
SessionStart   15
```

| Hook | Fires | What it gives the console |
|---|---|---|
| `UserPromptSubmit` | you press enter | exact turn start; the live instruction with zero lag |
| `PreToolUse` | before every tool | step enters ACTING at t≈0 instead of up to 1.5s late |
| `PostToolUse` | after every tool | exact end + true duration + success/failure |
| `Notification` | permission needed / idle | **real BLOCKED** — retires the buffer regex |
| `Stop` | turn ends | **retires the PTY-silence heuristic entirely** |
| `SubagentStart` | fork spawns | exact fork lifecycle |
| `SubagentStop` | fork finishes | retires the 256KB-window workaround |
| `SessionStart` / `SessionEnd` | session lifecycle | roster accuracy |
| `PreCompact` / `PostCompact` | context compaction | rare, dramatic, very shareable |

**Design:** one small script wired to every event, appending JSONL to
`~/.quadclaude/agent-events.jsonl`; the ops service tails it (already the
pattern used by `qcdelegate` → `events.jsonl`). Latency ≤1500ms → ~0ms.

This also removes the two heuristics I am least happy about: output-silence
busy detection and terminal-buffer prompt scraping.

---

## 2. OpenTelemetry — the metrics firehose (available, unused)

`CLAUDE_CODE_ENABLE_TELEMETRY=1` plus an OTLP endpoint turns on a full metric
stream. Instrument names found in the binary:

```
claude_code.cost.usage              ← actual dollars
claude_code.token.usage
claude_code.lines_of_code.count     ← lines added / removed
claude_code.commit.count
claude_code.pull_request.count
claude_code.tool.execution
claude_code.tool.blocked_on_user    ← time spent waiting on a human
claude_code.subagent.spawn
claude_code.active_time.total
claude_code.compaction
claude_code.code_edit_tool.decision ← accept / reject
claude_code.bash.subprocess
claude_code.llm_request
claude_code.mcp.rpc
claude_code.hook
claude_code.session.count
claude_code.events
```

The app would run a tiny local OTLP receiver and inject the env vars when
spawning a pane. `cost.usage` in particular is the most inherently tweetable
number available anywhere in the system.

---

## 3. Transcript records — what's still untapped

Type census across 40 transcripts:

```
assistant 1737 · attachment 1434 · user 1144 · queue-operation 679
last-prompt 396 · mode 301 · permission-mode 301 · ai-title 296
system 129 · file-history-snapshot 65 · pr-link 50 · file-history-delta 48
```

### 3.1 `queue-operation` — a real QUEUED column
`enqueue` 347 / `dequeue` 233 / `remove` 101, each with `content` and
`timestamp`. Prompts you stack up while an agent works. The board currently has
no queue concept at all; this is a genuine, self-draining one.

### 3.2 `structuredPatch` — exact per-edit line counts
On every edit's `toolUseResult`. Hunks with `oldStart/oldLines/newStart/newLines`
and `+`/`-` lines. Verified on a real edit: **+5 / −1 across 1 hunk**. This gives
a truthful, constantly-incrementing "lines changed" odometer.

### 3.3 `system` subtypes
```
stop_hook_summary 63 · turn_duration 57 · away_summary 9
```
`turn_duration` carries `{durationMs, messageCount}` — real observed values
include `{23151ms, 29 msgs}` and `{1257511ms, 378 msgs}`.

### 3.4 Attribution fields on `assistant`
`attributionSkill` (observed: `artifact-design` ×28), `attributionMcpServer` +
`attributionMcpTool` (observed: `claude-in-chrome::tabs_context_mcp` ×117), and
`effort` (observed: `xhigh` ×1596). Skills and MCP calls are currently invisible
on the board despite being distinctive, on-brand activity.

### 3.5 Failure signals
`isAbortedMidStream` (4), `apiErrorStatus` (2× HTTP 400), `error`,
`errorDetails`, plus `is_error` on tool results and `exitCode` on hooks. Real
incidents — worth showing, and honest.

### 3.6 Attachment subtypes
```
hook_success 1072 · task_reminder 113 · queued_command 101
deferred_tools_delta 40 · skill_listing 40 · hook_additional_context 26
edited_text_file 20 · nested_memory 7 · hook_system_message 5
agent_listing_delta 5 · mcp_instructions_delta 5
read_truncation_notice 1 · command_permissions 1
```

### 3.7 `pr-link` (50) — PRs opened, straight to a milestone card.

### 3.8 Observed tool mix
`Bash 594 · Edit 174 · Read 92 · Write 32 · ToolSearch 4 · AskUserQuestion 3 ·
Artifact 3 · WebFetch 3 · Agent 2 · SendMessage 2 · Skill 1 · WebSearch 1`

Bash dominates by 3×. Card design should assume a Bash-heavy board and make
command text legible rather than optimizing for edits.

---

## 4. Already wired

PTY bytes → tok/s meters · git branch/dirty/ahead · ctx% via the statusline
cache (`/tmp/quadclaude-ctx-<pid>.json`) · usage API (5h / 7d utilization) ·
`qcdelegate` → `~/.quadclaude/events.jsonl` + `delegation-trace.jsonl`.

---

## 5. Build order (motion per unit of effort)

1. **Hook event bus** — foundation. Every downstream item gets more accurate and
   more immediate for free. Also deletes two heuristics.
2. **QUEUED column** from `queue-operation` — a fifth column that fills and
   drains on its own: QUEUED → THINKING → ACTING → RETURNED, plus BLOCKED.
3. **Diff odometer** from `structuredPatch` — a running +N/−M that ticks upward
   visibly on every edit.
4. **Cost + token odometer** from OTEL — "this 20-minute clip cost $2.14".
5. **Skill / MCP lanes** — `attributionSkill`, `attributionMcpTool`.
6. **Delegation lane** — `qcdelegate` Bash calls + `events.jsonl`, showing route,
   duration, and whether `QC_CHECK` passed. *(Still outstanding.)*
7. **Incident states** — aborts, API errors, non-zero exits. Red, real, rare.
8. **Subagent tree** — exact nesting/duration once `SubagentStart/Stop` land.
9. **Milestone cards** — commits, `pr-link`, compaction sweeps.

---

## 6. Honest limits — do not build these

- **Reasoning text.** 356 thinking blocks scanned, **16 with any text**; the rest
  are `thinking: ''` with only a `signature`. Reasoning is stored encrypted.
  THINKING can show *that* an agent is composing and for how long — never what
  about.
- **Subagent inner progress.** The `Base64-encoding Plex font files · 97.1k
  tokens` line the pane prints is not in the parent transcript (no
  `isSidechain:true` records, no separate file). Only reachable by scraping the
  terminal buffer.
- **OTEL is opt-in per process** — the app must inject the env vars at pane
  spawn; sessions started outside QuadClaude won't report.

---

## 7. Repo note

`tsconfig.json` includes only `src/renderer` and `src/shared`, and
`tsconfig.main.json` only `src/main` and `src/shared`. **`src/plugins` is
typechecked by neither**, so `npm run typecheck` does not cover the ops-console
service, tailer, verifier, or record script. Until that's fixed, gate plugin
changes with:

```
npx tsc --noEmit --strict --target ES2022 --module CommonJS \
  --moduleResolution node --skipLibCheck --esModuleInterop --types node \
  src/plugins/ops-console/main/*.ts
```
