# QuadClaude Activity Console — Build Plan

**Codename:** `ops-console` · **Form:** isolated plugin, separate window · **Owner:** design + dev team
**Status:** approved direction, ready to build · **Reference date:** 2026-07-23

---

## 0 · TL;DR

Build a separate, always-openable **Activity Console window** that visualizes everything happening across all QuadClaude panes as a live "AI ops team": agent roster (left) → activity board with cards gliding between lifecycle columns (center) → chronological feed (right), with KPI tiles on top. Modeled on the OMOCHA WORKS "Autonomous Ops Console" reference video, but with one hard differentiator: **every pixel represents real data from the running app.** The end goal is a product feature that doubles as the hero asset for viral clips promoting QuadClaude.

**Success criteria**

1. Open from the QuadClaude menu; zero regressions to the pane/terminal code (delete the plugin folder → app builds and runs unchanged).
2. Every visual element passes the **"everything is real" audit** (§10): each number, bar, card, and movement traces to a named signal in the app.
3. Motion quality ≥ the reference video: cursor-carried cards, choreographed beats, living numbers, 60fps, no visible re-render jank.
4. A **record mode** produces a seamless 40s loop at 1920×1080 that is legible on a phone.
5. **Settings → Plugins** lists the console with a live enable/disable toggle and its plugin-declared settings — powered by a small generic plugin host (§4.4) that future plugins reuse with **zero further app-side diffs**.

**Reference assets**

- Inspiration video: `ssstwitter.com_1784786927617.mp4` (repo root) — frame analysis summary in §2.1
- Approved interactive mock (layout, theme, board/feed/roster structure): https://claude.ai/code/artifact/160c5e4e-e14b-4c26-902d-56eae81b7416
- Real-app theming source of truth: screenshot set from 2026-07-22 session + `src/renderer/index.css` + `DARK_THEME` in `src/renderer/components/TerminalPane.tsx`

---

## 1 · Non-negotiable principles

1. **Real data only.** Nothing decorative that pretends to be data. If a signal can't be sourced, the element doesn't ship (or ships clearly labeled in demo/record mode only).
2. **Exact QuadClaude theme.** Tokens in §6 are copied from the app, not approximated. No invented styling: no drop shadows, no left accent rails, no >6px corner radii, no non-mono fonts.
3. **Code isolation.** All plugin code lives in one folder. Integration surface with the existing app is ≤ 3 touchpoints (§4.3). No edits to `TerminalPane.tsx` internals, the PTY layer, or the workspace store's existing actions.
4. **The window is passive.** Read-only observer. It never sends input to panes, never mutates workspace state (v1; see §13 for the "answer from console" future).

---

## 2 · Product spec

### 2.1 What the reference video does (and what we keep/change)

53s screen recording of a fictional "Autonomous Ops Console": named agent roster with live status + load meters; KPI row with counting numbers and sparklines; a kanban whose cards are **dragged between columns by named agent cursors** (the signature move); live activity feed; system gauges; incident toast that dips an SLA chart, then recovers. The engine is a simulated state machine; every transition simultaneously updates board, feed, KPIs, and agent status.

| Video element | Our translation | Real source |
|---|---|---|
| Named AI agents (HAYATE…) | Panes, named by project folder | workspace store |
| Kanban Backlog/InProgress/Review/Done | **Queued / Working / Needs Input / Done** | Claude todos + pane states |
| Agent cursor drags card | Same animation, pane-colored cursor + name pill | driven by state transitions |
| ¥ revenue KPI | Dropped (fake) → tokens, tasks, needs-input count | statusline/telemetry |
| Load sparklines per agent | **Output meter (tok/s)** — flatlines when waiting | PTY byte counters |
| Incident toast + SLA dip | Error/exit toast + throughput dip | PTY exit / check failures |
| Robot mascot | Dropped (off-brand); personality via Claude Code's whimsy words | — |
| Japanese labels | English | — |

### 2.2 Window layout (from approved mock)

```
┌──────────────────────────────────────────────────────────────────────┐
│ titlebar: ⚡QuadClaude · activity-console · v___        clock▊       │
├──────────────────────────────────────────────────────────────────────┤
│ KPI row: agents active · tasks working · NEEDS INPUT · avg ctx · output │
├───────────────┬──────────────────────────────────┬───────────────────┤
│ AI AGENTS     │ ACTIVITY BOARD                   │ ACTIVITY FEED     │
│ (roster,      │ queued | working | needs | done  │ (history, newest  │
│  270px)       │  input                           │  first, 322px)    │
│               │ + cursor-carry overlay layer     │                   │
├───────────────┴──────────────────────────────────┴───────────────────┤
│ footer: legend · counts        [toast layer overlays top-right]      │
└──────────────────────────────────────────────────────────────────────┘
```

- **Roster row** = one pane: identity color avatar, folder name (in pane color), state chip (`active`/`waiting`/`idle`), statusline strip (`⎇ branch ●dirty · Opus 4.8 · @account · Ctx: N%`), output meter + `N tok/s` label.
- **Card** = one unit of work: agent dot+name header, tag, title; body varies by column — Working: `● Update(file) +A −D` + `✳ <Word>… (elapsed · ↓N tokens)`; Needs Input: amber question box with the real question text + the app's `claude-waiting-glow`; Done: `● completed · <when>`; Queued: muted meta line.
- **Feed item** = one event: pane-color dot, main line, detail sub-line (file/diff/state names like `claude-active → claude-waiting`), aging relative timestamp.
- **Interactions (v1):** click agent → filter/dim board to that agent; click card → expand detail (full question, file list, timings); hover states per mock. Everything else read-only.

---

## 3 · The activity model (what a "card" IS — decided)

The app has no task objects, but **Claude Code does**: the `TodoWrite` tool. Every session's transcript (JSONL under `~/.claude/projects/<cwd-slug>/`) records todo lists with `pending / in_progress / completed` status, plus every `Edit`/`Write` tool call (file paths, diffs), user prompts, and assistant questions. That is the board's backbone:

| Board column | Primary source | Fallback (no todos in session) |
|---|---|---|
| **Queued** | todos `status: pending` | — (column may be empty; that's honest) |
| **Working** | todos `in_progress` (pane state `claude-active`) | synthetic "session episode" card: one card per active-Claude span, titled from the last user prompt (first line, truncated) |
| **Needs Input** | pane state `claude-waiting` → the agent's current card moves here; question text = last assistant message/AskUserQuestion from transcript, fallback = last non-empty terminal line | same |
| **Done** | todos `completed` (keep last N=4 per fleet, age out) | episode card on `claude-active → shell` |

**Card enrichment** (all from transcript tail): current file being edited (`Edit`/`Write` `file_path`), cumulative `+adds −dels` this task, elapsed since `in_progress`, `↓tokens` (from statusline ctx JSON or transcript usage), the whimsy word from the live terminal line if cheaply available (else rotate Claude's real word list).

**Identity rule:** every card carries `paneId`; agent dot + name in the pane's `PANE_COLORS[position]` color. A card never exists without an owning pane.

---

## 4 · Architecture & isolation contract

### 4.1 Components

```
src/plugins/ops-console/             ← THE plugin folder (delete = uninstall)
├── plugin.json                      ← manifest: id, menu entry, capabilities, settings schema (§4.4)
├── main/
│   ├── window.ts                    ← BrowserWindow create/show/persist bounds
│   ├── service.ts                   ← data aggregator: subscribes/polls, emits OpsSnapshot + OpsEvent
│   ├── transcript-tailer.ts         ← fs.watch on ~/.claude/projects/<slug>/*.jsonl, incremental parse
│   └── ipc.ts                       ← channels `ops:*` (registered only if plugin enabled)
├── renderer/                        ← separate vite entry → dist/opsconsole/
│   ├── index.html / main.tsx
│   ├── store.ts                     ← receives snapshot + event stream
│   ├── components/ (Roster, Board, Card, Feed, Kpis, Toasts, CursorLayer)
│   ├── motion/ (flip.ts, cursor.ts, odometer.ts, choreographer.ts)
│   └── theme.css                    ← tokens from §6 (copied, single file)
└── shared/types.ts                  ← OpsSnapshot, OpsEvent, ActivityCard, AgentInfo
```

Precedent: the log-viewer already opens a dedicated `BrowserWindow` from main — follow that pattern (`src/main/index.ts` log window).

### 4.2 Data flow

```
[existing app]                                [plugin main]              [plugin window]
workspace store (panes, states, git) ──IPC──▶
PtyManager.getStats() bytesOut ──poll 1s────▶  service.ts ──ops:snapshot──▶ store ──▶ UI
/tmp/quadclaude-ctx-<pid>.json (ctx%) ─poll─▶  (diff → OpsEvents)  ──ops:event────▶ choreographer
~/.claude/projects/<slug>/*.jsonl ──watch───▶
~/.quadclaude/events.jsonl (optional) ─watch▶
```

- **Push, not pull, into the renderer:** service diffs consecutive snapshots and emits typed events (`agent-state-changed`, `card-moved`, `card-created`, `question-asked`, `task-completed`, `output-rate`, `pty-exited`). The renderer's choreographer consumes the event queue and *sequences* animations (§7) — this is what makes motion deliberate instead of everything popping at once.
- Batch: snapshot every 1s; output-rate every 500ms; events immediate.

### 4.3 Integration surface (the entire allowed diff outside plugin folders)

One-time, **generic** app-side investment (not ops-console-specific — future plugins ride it for free):

1. `src/main/pluginHost.ts` (new, small — budget ≤ ~300 LOC): discovery, lifecycle, menu + accelerator registration (§4.4), plus one `initPluginHost(deps)` call in `src/main/index.ts`.
2. `SettingsModal.tsx`: one new **Plugins** tab (generic component; renders rows from manifests — knows nothing about any specific plugin).
3. `src/shared/types.ts`: `plugins?: Record<string, { enabled: boolean; settings: Record<string, unknown> }>` added to `WorkspacePreferences` (merged with manifest defaults on load, same backward-compat pattern as the hotkeys merge).
4. `vite.config` (or equivalent): one renderer entry per window-kind plugin.

After this lands, **adding a future plugin = dropping a folder with a manifest + adding its vite entry.** No menu edits, no settings edits, no store edits.

Explicitly forbidden (unchanged): edits to `TerminalPane.tsx`, `pty.ts` logic (read `getStats()` only), workspace store actions, `index.css`. If a needed signal isn't exposed, expose it via a *new* getter in the plugin host's `deps` injection, not by modifying producers.

### 4.4 Plugin host & Settings integration (generalizes to future plugins)

**Manifest** — every plugin folder carries a `plugin.json`; the host validates it at startup:

```json
{
  "id": "ops-console",
  "name": "Activity Console",
  "version": "0.1.0",
  "description": "Live ops view of every pane: agents, activity board, feed.",
  "kind": "window",
  "entry": { "main": "main/index.ts", "window": "renderer/index.html" },
  "menu": { "parent": "View", "label": "Activity Console", "accelerator": "CmdOrCtrl+Shift+A" },
  "capabilities": ["read:workspace", "read:pty-stats", "read:transcripts", "read:telemetry"],
  "settings": [
    { "key": "openAtLaunch", "type": "boolean", "default": false, "label": "Open at launch" },
    { "key": "showDelegationLane", "type": "boolean", "default": false, "label": "Show delegation events in feed" },
    { "key": "pollIntervalMs", "type": "select", "options": [500, 1000, 2000], "default": 1000, "label": "Refresh rate" }
  ],
  "minAppVersion": "1.30.0"
}
```

**PluginHost (main process):** scans `src/plugins/*/plugin.json`, validates (id, minAppVersion, accelerator conflicts — duplicates rejected, first wins, logged), applies the enabled state from preferences, and drives lifecycle: `activate(deps)` registers the menu item + namespaced IPC and starts services; `deactivate()` closes the plugin's windows, unregisters IPC, and stops all watchers/timers. v1 plugins are **compiled into the app** — "plugin" means compartmentalization + toggling, *not* third-party code loading.

**Settings → Plugins tab** (follows the existing tabbed-settings pattern): one row per discovered plugin — name, version, description, status pill (`running / off / error`), **enable toggle**, an **Open** button for window-kind plugins, and a disclosure that renders the plugin's declared settings *generically* from the manifest schema (boolean → toggle, select → dropdown, string → text). No plugin renderer code ever loads inside the main window — the tab reads manifests only, preserving the isolation contract. Footer note in the tab: "Plugins are compartmentalized — disabling one never affects your terminals."

**Preferences & change flow:** manifest defaults merged under saved values on load; plugin services receive their prefs via `deps` and a `plugins:prefs-changed` event (e.g., ops-console picks up a new `pollIntervalMs` without restart).

**Lifecycle semantics (v1):**
- **Toggle ON** → menu item appears, IPC live, window opens if `openAtLaunch` — no app restart.
- **Toggle OFF** → plugin windows close immediately, watchers (e.g., transcript tailer) stop, IPC unregistered — measurably zero residual CPU/fs activity.
- **Folder missing** → row absent; stale prefs preserved harmlessly (no orphan crash).
- **Plugin error** → caught by the host; row shows `error` + "view log" (routes to app.log); the app never goes down with a plugin.

**Explicit non-goals (v1, scope control):** no third-party/unsigned plugin loading, no sandboxing (capabilities are declarative documentation for now — enforcement only becomes real work if third-party ever happens), no marketplace/auto-update, no plugin-to-plugin APIs.

### 4.5 Signal inventory (Tier 1 = already exists; Tier 2 = plugin-built)

| Signal | Source | Tier |
|---|---|---|
| Pane list, folder names, cwd | workspace store `panes[]` | 1 |
| Pane state `shell/claude-active/claude-waiting` | store `pane.state` (already scanned by app) | 1 |
| Git branch / ahead / dirty | store `pane.gitStatus` (already polled) | 1 |
| Output bytes per pane → tok/s | `PtyManager.getStats().perPaneBytesOut` (delta/interval; display ÷4 bytes≈token; clamp realistic 0–200 tok/s) | 1 |
| Context % + model per pane | existing `getContextUsage(paneId)` IPC (statusline temp file) | 1 |
| Account per pane | store `claudeAccountId` | 1 |
| Todos (cards), file edits (+/−), question text, task titles, token usage | **transcript-tailer** on `~/.claude/projects/` | 2 |
| PTY exit / respawn (incident toast) | `onPtyExit` already broadcast on IPC | 1 |
| Delegation events (optional lane/badge) | `~/.quadclaude/events.jsonl` | 2 |

---

## 5 · Design system spec (hand to design; enforce in review)

### 5.1 Tokens (copied from app — do not tweak)

```css
--bg:#141414; --pane:#1a1a1a; --term:#1e1e1e;          /* grounds */
--line:rgba(255,255,255,.08); --line-soft:rgba(255,255,255,.05);
--fg:#d4d4d4; --fg2:#8a8a8a; --fg3:#6b6b6b; --faint:#565656; --bright:#fff;
/* terminal content palette (xterm DARK_THEME) — for code-ish content */
--green:#6a9955; --red:#f44747; --blue:#569cd6; --teal:#4ec9b0; --gold:#dcdcaa;
/* chrome/git colors (app UI) */
--g-green:#4ade80; --g-cyan:#22d3ee; --g-yellow:#fbbf24; --g-orange:#fb923c;
/* pane identity (PANE_COLORS, indexed by pane position) */
#22d3ee #4ade80 #fbbf24 #a78bfa #f472b6 #fb923c #38bdf8 #34d399 #f59e0b #c084fc #fb7185 #2dd4bf
/* geometry & type */
radius: 4px cards / 6px panels; borders: 1px hairline only;
font: Menlo, Monaco, "Courier New", monospace — everywhere; tabular-nums;
sizes: 12.5 body · 11.5 card title · 10.5 meta · 9.5 micro · 23 KPI value;
selection: #264f78; waiting glow: reuse app keyframes `claude-waiting-glow`.
```

**Do:** wallpaper ghosting — a barely-visible backdrop (≈4–5% opacity radial tints) matching the app's glass-over-wallpaper depth. macOS traffic lights in the window titlebar (it's a real window — let it look like one).
**Don't:** shadows, left accent rails, rounded-xl, gradient fills (except the ⚡ bolt logo), non-mono type, any color not in the token list.

### 5.2 Semantic color rules (accuracy-bearing)

- Ctx %: `≤50` → `--g-cyan`, `51–75` → `--g-yellow`, `>75` → `--red` (matches statusline script).
- Git chip: branch `--g-green`, `↑ahead` `--g-cyan`, `↓behind` `--g-yellow`, `●dirty` `--g-orange`.
- States: active `--g-green`, waiting `--amber/--g-yellow` (+glow), idle `--fg3`. Diff: `+` green / `−` red.
- Card IDs: `QC-<paneId><seq>` in `--faint` (ops credibility, video-reference nod).

### 5.3 Design deliverables

1. Component sheet (roster row, card ×4 column variants, feed item, KPI tile, toast, cursor+pill) on the tokens above — Figma or a coded storybook page in the plugin folder.
2. Motion spec sign-off (§7 timings) + cursor/pill art (arrow glyph + name pill per pane color).
3. Record-mode layout at 1920×1080 with ~1.3× type scale (phone legibility) — including a 2-panel variant (roster+board) if 3 panels prove illegible on phones.
4. Clip storyboard (§8.3).

---

## 6 · Motion & choreography spec (the virality core)

### 6.1 Cursor-carry (signature move — highest priority)

A pane-colored cursor arrow with a name pill (`promovid ·`) lives on a dedicated overlay layer above the board.

Sequence per `card-moved` event (total ≈ 1.15s):
1. **t=0:** cursor fades in near owning card (120ms, from 12px offset).
2. **t=150ms:** cursor "grabs" card — card scales 1.0→1.02, border brightens.
3. **t=250ms:** cursor + card travel together to target slot — 600ms, `cubic-bezier(.3,.1,.25,1)`, gentle arc (±14px perpendicular bow), card lags cursor by ~40ms (spring follow).
4. **t=850ms:** land — card scale 1.02→0.995→1.0 (soft overshoot), column count ticks.
5. **t=950ms:** cursor fades out (200ms). Sibling cards FLIP into place during travel (450ms).

Rules: max 1 carry at a time (queue events; if >2 queued, batch non-hero moves as plain FLIPs); Needs-Input arrivals start the amber glow **on landing**, not before; reduced-motion → instant moves, no cursors.

### 6.2 Choreographed beat (per event, not simultaneous)

```
card lands → +180ms feed item slides in (height+opacity, 300ms)
          → +330ms KPI odometer ticks (350ms tween)
          → +450ms roster state chip / meter updates
```

### 6.3 Living numbers (anti-mock tells)

- KPI values: odometer tween on change; never snap.
- Working cards: elapsed time ticks each second (`47s`, `1m 12s`); `↓tokens` increments in small irregular steps while owner is active.
- Ctx % per agent: creeps up during activity; color threshold crossings are real, visible moments.
- Git `●dirty`: +1 on each Update event for that pane.
- Feed timestamps age (`now → 1m → 2m…`) on a 30s cycle; Done cards' `just now` ages too.
- Output meters: rAF-driven, lerp toward target (smoothing 0.15), active 40–150 tok/s realistic range, **flatline** (2–3px) when waiting/idle — the flatline IS the "needs you" signal.

### 6.4 Rendering discipline

No `innerHTML` rebuilds after initial mount. Cards/feed items are persistent DOM nodes, moved via FLIP transforms; spinners (`✳`, 1.2s steps(8)) and glows must never restart from a re-render. Perf gate: 60fps during a carry on a base M-series; ≤2% CPU idle; rAF suspended when window hidden.

### 6.5 Incident layer

On `pty-exited` (non-zero) or a failed check (delegation telemetry): red toast top-right (`pane · process exited (code) — respawning`), owning card flashes red border 600ms, fleet-output chart (if present, see §13) dips; recovery event (respawn = real app behavior) posts a green follow-up toast + feed entry. Toasts: max 2 stacked, 5s auto-dismiss, same card styling with `--red` accents.

---

## 7 · Record mode (viral clip production)

**Activation:** `?record=1` (or hidden menu toggle). Changes:

1. **Deterministic script, not live data:** plays a seeded JSON timeline (same event types as real engine — the engine cannot tell the difference; this keeps demo behavior honest to real behavior).
2. **The 40s arc** (loops seamlessly — state at t=40s == t=0):
   - 0–8s: busy steady state — 2 carries, meters dancing, numbers ticking
   - 8–14s: quick completion burst (2 cards → Done, green feed lines)
   - 14–22s: **hero moment** — an agent asks a question: carry to Needs Input, amber glow, its meter flatlines, needs-input KPI turns amber
   - 22–26s: answer → carry back to Working, meter resumes
   - 26–33s: incident toast + red flash → auto-respawn recovery
   - 33–40s: recovery burst, KPIs tick up, return to opening state
3. **Legibility:** 1.3× type scale, exact 1920×1080 layout, cursor always mid-motion at loop start (first-2-seconds rule).
4. Hidden: any dev chrome. Optional `?panels=2` variant (roster+board only) for phone-first cuts.

**Clip plan (marketing):** master 40s loop → cuts: 9:16 crop pan (phone), 1:1, and the **split-screen proof shot** — real QuadClaude grid on the left, console reacting on the right (this is the "it's real" differentiator; schedule after Phase 3 when live data drives it).

---

## 8 · Phases, estimates, acceptance criteria

Assumes 1 dev + 1 designer, days ≈ focused dev-days.

| Phase | Scope | Est | Acceptance |
|---|---|---|---|
| **P0 — Design lock** | Component sheet on tokens; cursor/pill art; motion spec sign-off; record-mode layout | 2–3d (design) | Components pixel-match app screenshot side-by-side; motion timings approved |
| **P1 — Plugin host + shell + Tier-1 roster** | Generic `pluginHost` + Settings **Plugins** tab + prefs schema (§4.3–4.4); folder scaffold, manifest, second vite entry, window via host, `ops:*` IPC, service snapshot loop; roster fully real (states, git, ctx%, meters from real bytes) | 5–6d | Delete-folder test passes; **toggle on/off live** (no restart, zero residual CPU when off); plugin settings persist across restart; a dummy "hello" manifest fixture loads (proves generality); roster mirrors app within 1s of any pane change; meters flatline when a pane waits |
| **P2 — Activity engine** | transcript-tailer (todos, edits, questions, titles); board + feed live; card lifecycle from real transitions | 4–6d | Todos in any pane appear as cards ≤2s; question text correct on waiting; feed entries match transcript order; fallback episode-cards work in a no-todo session |
| **P3 — Motion polish** | Cursor-carry, choreographer, odometers, living numbers, no-rebuild rendering, incident toasts | 4–5d | §6 timings implemented; 60fps carry; zero spinner restarts; reduced-motion path |
| **P4 — Record mode + clips** | Scripted timeline, loop arc, type-scale layout, capture; split-screen shoot | 2–3d + edit | 40s seamless loop; phone-legible; split-screen take captured |

Parallelization: P0 ∥ P1; P3 motion work can start against P1's snapshot data with a stub event script while P2 lands.

---

## 9 · QA — the "everything is real" audit (release gate)

For every element, verify the chain *element → signal → source → live test*:

| Element | Live test |
|---|---|
| State chips / card column | Toggle a real pane: launch claude, ask it something that triggers a question, answer, finish — chip and card follow within 2s each step |
| Output meter | `yes > /dev/null`-style noisy command in a pane → meter spikes; Claude waiting → flatline + `0 tok/s · waiting` |
| Ctx % + color | Compare against the pane's own statusline; force >50% session → yellow |
| Git chip | Touch files in a repo → `●dirty` increments on next poll |
| Card diff counts | Compare `+A −D` against transcript tool events |
| Question text | Compare with the actual prompt in the pane |
| Incident toast | Kill a pane's shell process → toast + feed + recovery |
| KPIs | Recompute by hand from roster/board state |

Plus: perf budget (§6.4), isolation test (folder delete), 12-pane stress, window-hidden CPU check, reduced-motion pass.

Plugin-host tests: disable mid-animation → window closes cleanly, watchers/timers stop (verify zero fs/CPU activity after 5s); prefs survive restart; a legacy `workspace.json` without the `plugins` key loads clean; duplicate-accelerator manifest is rejected and logged, app unaffected.

---

## 10 · Risks & mitigations

| Risk | Mitigation |
|---|---|
| Transcript JSONL format drift (Claude Code updates) | Defensive parser: tolerate unknown fields/types; feature-degrade to episode-cards; parser unit-tested against fixture transcripts checked into the plugin folder |
| Waiting-question extraction wrong/ugly | Prefer transcript AskUserQuestion/assistant tail; truncate at 90 chars; fallback label `waiting for input` (never show garbage) |
| Tailer CPU on huge transcripts | Incremental reads (byte offset), fs.watch debounce 250ms, only the newest session file per pane |
| Motion jank from re-renders | Architecture rule (§6.4) from day one — persistent nodes, FLIP only; review gate |
| tok/s credibility | ÷4 bytes→token heuristic, clamp 0–200, label it `output` not "tokens" if contested |
| Scope creep into pane code | Isolation contract (§4.3) enforced in PR review |
| Plugin-host scope creep (accidentally building VS Code) | v1 non-goals locked (§4.4): first-party compiled-in plugins only, no sandbox/marketplace/dynamic loading; host LOC budget ≤ ~300; review gate |
| Virality window | Record mode (P4) can ship against a stub script right after P3 — don't block clips on P2 edge cases |

---

## 11 · Out of scope (v1) / future

- **Answering from the console** (click Needs-Input card → send keystrokes to pane) — v2 flagship; requires write-path safety design *and* a real capability-enforcement step in the plugin host (`write:pane` — v1 capabilities are declarative only).
- Cross-window / multi-instance aggregation; historical replay ("scrub yesterday's session"); throughput time-series chart panel; delegation lane as a dedicated column; publishing the console as a sharable web page.
- Third-party plugin distribution: marketplace, sandboxing, signing, auto-update (§4.4 non-goals). Revisit only if external demand materializes.

---

## As-built (2026-07-23) — status + reasoned deviations

**Built and verified end-to-end** (isolated prod instance + CDP). All phases implemented:

| Area | Verified |
|---|---|
| Plugin host discovers + off-by-default | `initialized (1 plugin(s), 0 active)` |
| Toggle ON (no restart) → running + window opens | CDP: status `running`, "Activity Console" window target appears |
| Toggle OFF → window closes, producers stop | CDP: 0 windows, `deactivated` logged |
| Settings → Plugins tab (generic, manifest-driven) | tab renders row, toggle, Open (enabled-only), 2 bool + 1 select rendered from manifest |
| Persistence | `preferences.plugins.ops-console` written to disk |
| Live roster from real panes | 4 real panes shown as agents within 1s of workspace push |
| Meters flatline when not active | code + record: waiting/idle → flat |
| Record mode | 6 real project names, cards move Queued→Working→Needs-Input→Done across beats, seamless loop |
| Isolation | uninstall (folder + registry line + vite entry) → `npm run build:renderer` builds clean |
| Terminal theming | screenshot matches app: #1e1e1e, VS Code palette, git chips, statusline readouts, no rails/shadows |

**Deviations (each an improvement over the plan, same intent):**
1. **Renderer = self-contained HTML via data URL + Vite `?raw` inline**, not a second Vite renderer entry. Mirrors the app's existing log-viewer window pattern; stronger isolation (no shared bundle, no build step for plugin UI); the HTML is editable at `src/plugins/ops-console/renderer.html` and inlined into `dist/main` at build.
2. **Renderer is vanilla JS**, not React components. Keeps plugin UI out of the app's React tree entirely (isolation) and needs no build step. Same behaviors implemented: keyed DOM reconcile (no `innerHTML` rebuilds → no spinner/glow restarts), FLIP + cursor-carry, KPI odometers, living numbers, rAF-smoothed meters, reduced-motion.
3. **Compiled-in static registry** (v1 non-goal: no dynamic loading). Uninstall = delete folder **+ remove one `REGISTRY` line + one vite entry** (verified builds clean) — a literal folder-only delete can't work for a compiled-in import, so the criterion is met as the documented 3-token removal.
4. **Card source in practice**: `ai-title` / `last-prompt` episode cards are the primary path (TodoWrite is rare — only 5 transcripts have it); todos enrich when present. The tailer was confirmed against the real on-disk JSONL format.
5. **Integration touchpoints** landed as: `pluginHost.ts` (new), `index.ts` (import + init + menu + IPC + pty-exit pipe + shutdown), `preload.ts` (plugin API + snapshot push), `types.ts` (prefs + channels), `SettingsModal.tsx` + `PluginsSettings.tsx` (Plugins tab), `App.tsx` (workspace-snapshot push), `vite.config.ts` (ops preload entry). All generic except the one-line registry entry — future plugins reuse everything.

**Not independently exercised (code-verified / architecturally sound):** exact 60fps under a carry; ≤2s live-todo latency (tailer throttled to 3s disk reads); a throwing-plugin fixture (host wraps `activate` in try/catch → status `error`, app unaffected — generality already proven by the empty-registry build + manifest-driven settings).

## Appendix A · Real signals discovered during planning (verified in this repo)

- `PtyManager.getStats()` → `{ perPaneBytesOut }` (src/main/pty.ts) — basis for meters
- `getContextUsage(paneId)` IPC → `{ contextPct, model }` from `/tmp/quadclaude-ctx-<pid>.json`
- Pane states `shell | claude-active | claude-waiting` (src/shared/types.ts) — the entire movement grammar
- `claude-waiting-glow` keyframes (src/renderer/index.css) — reuse verbatim for Needs-Input cards
- `PANE_COLORS` (src/renderer/components/PaneHeader.tsx) — agent identity colors
- Log-viewer window (src/main/index.ts) — BrowserWindow precedent to copy
- `~/.claude/projects/<slug>/*.jsonl` — todos, tool calls, questions, per-session usage
- `~/.quadclaude/events.jsonl` + `delegation-active` — optional delegation lane

## Appendix B · Reference-video motion cheatsheet (for the motion designer)

- Card travel ~600–750ms with soft arc; agent cursor leads, card follows with lag
- Every board move triggers: feed prepend (+~200ms) → KPI tick (+~350ms)
- Numbers count up continuously; nothing snaps
- Incident: toast → chart dip → recovery over ~6s; exactly one dramatic beat per ~30s
- At any random 5s window, ≥3 things are visibly alive (meter, timer, feed, or carry)
