# QuadClaude — Refactor & Hardening Plan (living handoff)

Working doc for the in-progress code-health effort. Branch: `feat/delegation-dashboard`
(baseline before this session = commit `f9b5562`). Keep this updated as items land.

---

## 0. How to work in this repo (verification infra — reuse every time)

- **Build (renderer):** `npm run build:renderer` (vite; builds renderer + main + preload via vite-plugin-electron). **NEVER run `build:main`** (`tsc -p tsconfig.main.json`) — it emits a stray `src/shared/types.js` and corrupts the tree.
- **Full build + package:** `npm run build` (vite + electron-builder → `release/`). Slow tail = code-signing hundreds of `--timestamp` locale files (~5 min), not a hang.
- **Install:** `rm -rf /Applications/QuadClaude.app && ditto release/mac-arm64/QuadClaude.app /Applications/QuadClaude.app`. Locally-built = no quarantine → launches clean despite `spctl` "rejected" (Apple-Development signed, not notarized — expected).
- **Typecheck gate:** `npx tsc --noEmit -p tsconfig.json` = **renderer, now 0 errors** (real gate as of this session). `tsconfig.main.json` still has 11 pre-existing errors (rootDir config + 3 type mismatches) — separate follow-up, vite builds main fine regardless.
- **Never clobber the user's running app** — they run real Claude sessions. Always test in an isolated instance:
  `QC_FORCE_PROD=1 ./node_modules/.bin/electron . --remote-debugging-port=PORT --user-data-dir=/tmp/ISOLATED`
- **CDP helpers** live in the session scratchpad (`$SP`): `cdp.py <ws> "<expr>"` (Runtime.evaluate; returns JSON — for non-Latin1/large output use `btoa(unescape(encodeURIComponent(JSON.stringify(...))))` then base64-decode), `shot.py <ws> <out.png>` (Page.captureScreenshot — captures the window regardless of z-order; use this instead of `screencapture`, which grabs the user's foreground). Get `ws` from `curl -s http://localhost:PORT/json`.
- **Concurrency hazard:** another Claude Code session (a different terminal / QuadClaude pane) can edit THIS repo via absolute paths. Signs: "file modified on disk" notes, unexplained new files. Diagnose with `lsof -p <pid> -d cwd` on running `claude --dangerously-skip-permissions` processes. (Happened this session — a font-sizing session added the whole `--fs-*`/`--ui-scale`/`uiScale.ts` type scale.)

---

## 1. DONE this session (committed on `feat/delegation-dashboard`)

| commit | what |
|---|---|
| `514bc1d` | **Design system v1 + unified type scale + halved rounding.** One token system in `index.css :root`; ~90 hardcoded values → tokens across 13 components; type scale `--fs-*`; radii halved via Tailwind config (single source). |
| `6e954dd` | **Activity Console plugin + generic plugin host** (native Shadow-DOM overlay, ~+2MB). |
| `0e26bda` | **Reliability cluster** — plugin-prefs persistence, overlay pull-on-mount, console error isolation, **renderer `tsc` → 0 errors** (moved `window.electronAPI` global to `src/renderer/electron-api.d.ts`). |
| `05336b1` | Removed the **dead usage renderer API** (`onUsageUpdate`/`fetchUsage`/`USAGE_FETCH`); kept the live `UsagePoller` (it writes the `.statusline-usage-*` caches the pane status line reads via `QC_USAGE_CACHE`). |
| `c2880f3` | **Shared `<PortalMenu>`/`useAnchoredMenu`** (`components/ui/PortalMenu.tsx`) — deduped 4 dropdowns, **fixed the off-screen-clip bug** (only AgentBadge had the viewport clamp). |
| `f240747` | **Path helpers** → `renderer/util/paths.ts` (`folderName(path, fallback?)`, `normalizePath`). |
| `5fbaa15` | This handoff doc. |
| `5d295a9` | **2.1 Store DRY** — `patchPane`/`patchPaneField` collapse `updatePane`+`setPaneState/Label/Cwd/Agent` (~62 lines → 19). `setPaneState` keeps its no-save hot-path. renderer `tsc` 0. |
| `6998444` | **2.2 Polish** — `:focus-visible` cyan rings (xterm excluded); last emoji (`📡🌐🔗`) → stroke SVGs in LiveFeedButton/AgentBadge/PaneHeader; console **"All quiet"** empty state (`.board.quiet .board-empty`). Screenshot-verified. |
| `b3cfb4d` | **2.3 Button variants (scoped)** — the 6 identical PortalMenu rows → exported `menuItemClass` (Tailwind class-set is order-independent ⇒ byte-identical CSS). Did NOT build a universal `<Button>`. |
| `86f7343` | Version → **1.31.7**. |
| `9641d85` | **2.4 (partial) main split** — `installStatuslineScript` (464 self-contained lines) → `main/statusline.ts`; index.ts **1674 → 1210**. main `tsc --noEmit` holds at 11 pre-existing baseline errors, 0 new. |

Also done earlier in-session (folded into the above / prior commits): dead-code removal
(OPS_SNAPSHOT channel, `anyWorkspaceObserverEnabled`, `recordAgentIndex`, `PluginPrefs`,
`stopFrameTracking`, `markPerf`/`getPerfStatus` + handlers + `isPerfMonitorRunning`, `.bolt`
console CSS, 6 opsview `:host` tokens, ~17 lines of index.css cruft tokens).

**Installed app is NOT yet caught up** — **v1.31.7 is BUILT** in `release/mac-arm64/` (reliability
cluster + this whole batch) but the **install is blocked because the user's app is running** (never
clobber it — real Claude sessions). Install when they quit + relaunch:
`rm -rf /Applications/QuadClaude.app && ditto release/mac-arm64/QuadClaude.app /Applications/QuadClaude.app`.

---

## 2. Remaining plan (safe sequencing — do in this order)

### LOW RISK — ✅ ALL COMPLETE (2.1–2.3 done; 2.4 partially done, see note)

> **Batch shipped `5d295a9`→`9641d85` (v1.31.7), screenshot-verified.** 2.1 store DRY ✅, 2.2 polish ✅
> (board-as-hero was the one item deliberately skipped — see below), 2.3 button variants ✅ (scoped to
> `menuItemClass`, not a universal `<Button>` — the ~29 glass-control / ~22 primary sites were judged NOT
> worth a component; they're already token-consistent). 2.4 main split: `statusline.ts` extracted ✅;
> **`createApplicationMenu`→`menu.ts` and `setupIPC`→`main/ipc/*` remain** (see 2.4 note — higher-touch,
> deferred). **Board-as-hero (2.2) intentionally NOT done** — the `.stage` grid weighting is fine as-is;
> re-weighting risks the verified layout for marginal gain.

Original detail (kept for reference):

**2.1 Store DRY** — `renderer/store/workspace.ts` (679 lines).
- `panes.map(p => p.id === id ? {...p, ...u} : p)` appears **~10×** (`updatePane`, `setPaneState/Label/Cwd/Agent/LiveFeed/GitStatus/Servers`).
- The "bail-if-unchanged → set → debounced-save" trio is near-identical in `setPaneState/Label/Cwd/Agent` (~lines 476-526). `debouncedSave(() => get().saveWorkspace())` pasted **~15×**.
- Target: private `patchPane(id, updater)` + `patchPaneIfChanged(id, field, value)` + a `commit()` wrapper. Extract the `initialize()` migration block (~152-269) into a pure `migrateWorkspace(saved)`. NOTE: the store's atomic-selector discipline + change-guards are already good — this is DRYing, not restructuring.
- Effort S-M, risk low.

**2.2 Polish batch** (user-visible):
- **Focus rings** — one `:focus-visible` rule using `var(--accent)` (`outline: 2px solid var(--accent); outline-offset: 1px`). ⚠️ scope out xterm: exclude `.xterm-helper-textarea` / `.terminal-container` so terminals don't get rings. a11y + pro-speed.
- **Console "all quiet" idle/empty states** — `opsview.ts`: idle KPIs render stark `0`s and empty board columns read as broken. Replace with calm em-dash / "all quiet" (the design doc's intent, never implemented). Same for an empty delegation dashboard.
- **One icon language** — emoji (`📡` `🌐` `🔗`) still mix with stroke SVGs in `LiveFeedButton.tsx` (lines ~75, 93, 110) and `AgentBadge.tsx` (~231). Normalize to stroke SVGs at one size.
- **Board-as-hero** — in `opsview.ts` the roster/board/feed are equal-weight; give the board more presence (it's the show; the `.stage` grid is `270px 1fr 322px`).

**2.3 Button variants** — do the **two** high-frequency ones only, NOT a universal `<Button>`.
- `glass-control` pill: **~29 sites** (DelegationDashboard 7, SettingsModal 8, ModelRouterSettings 6, PluginsSettings 4, AgentsSettings 3, ClaudeAccountsSettings 1).
- `bg-[--accent]` filled/primary: **~22 sites** across 9 files.
- Also a tiny `PaneControlButton` (icon + `pane-ctl-label`) for the 5 header controls (PaneHeader 3, OpenInPane, LiveFeed).
- Target: `components/ui/Button.tsx` with `variant: 'primary' | 'glass'` + `size`, resolving to existing tokens (optionally `@apply`-based `.btn-primary`/`.btn-glass` in index.css). **Leave** the one-off link/chip/segmented buttons.
- Effort M, risk low (pure styling; screenshot modals before/after).

**2.4 `main/index.ts` split** — PARTIALLY DONE (`9641d85`). index.ts now **1210 lines**.
- ✅ `installStatuslineScript` → `main/statusline.ts` (464 lines, app/fs/path/logger only).
- **REMAINING (deferred — not "continue straight through"; needs a full build per iteration since there's no fast main tsc gate, and `setupIPC` wires the module singletons so it carries real init-order risk):**
  - `createApplicationMenu` + `sendMenuAction` (~851-1128 in old numbering, ~278 lines) → `main/menu.ts`. Mechanical, but references `mainWindow`/`sendMenuAction`/`workspaceManager`.
  - `setupIPC` (~386 lines, 47 handlers, 8 domains) → `main/ipc/{pty,workspace,router,delegation,accounts,plugins,app}.ts` each exporting `register(deps)`; thin `setupIPC` calls them. `IPC_CHANNELS` already give stable names. **Highest-risk of the "low-risk" set** — do as its own focused pass with a full build + boot smoke-test (every menu item + IPC path).

### MEDIUM RISK

**2.5 Plugin-host decoupling** — the "second plugin is easy" item. The lifecycle (`pluginHost.ts`, `shared/plugins.ts`) is genuinely generic; the **presentation/transport is hardcoded to ops-console**:
- `OpsOverlay.tsx:2` statically `import { createOpsView } from '../../plugins/ops-console/opsview'` (named generic, renders one plugin).
- `App.tsx` (~389-401) hardcoded "Activity Console" button calling `togglePlugin('ops-console', true)` + `openPlugin('ops-console')` by string.
- `App.tsx` (~290-321) ops-console **verification-mode** (`verifyOn`, `pushOpsTransition`, `prevStates`) baked into App's generic workspace-snapshot effect.
- `preload.ts` seven `ops*` methods; `types.ts` `OPS_*` channels interleaved with generic `PLUGIN_*`.
- Target: renderer plugin-UI registry — a plugin exposes optional `renderOverlay(shadowRoot, bridge)` (mirrors `createOpsView`); `OpsOverlay` → generic `PluginOverlayHost` that looks up the active window-plugin's factory. Generic top-bar "open plugin" from `listPlugins()` menu metadata. Generalize IPC to `PLUGIN_UI_SHOW / PLUGIN_UI_MESSAGE(pluginId, payload)`; move verification-transition emission behind a generic capability. Keep ops-console as the reference adopter.
- Effort M, risk medium (touches the live overlay + IPC). NOTE: the overlay pull-on-mount + `ops:request-state` added this session should migrate onto the generic path.

### HIGH RISK (each its own focused pass, before/after verification)

**2.6 PiP canvas disposal (memory win).** In duo/solo, up to 10 hidden PiP panes each keep a live `CanvasAddon` (GPU textures/layers) while `visibility:hidden` (`index.css` `.pip-wrapper`, `TerminalPane.tsx`). Dispose the addon on hide, re-attach on promote → reclaim tens of MB. ⚠️ **This is exactly where the blank-pane bug lived** (see memory `terminal-dispose-throws-blank-pane`); guard with the existing `pane-blank-detected` watchdog (`paneDiag.ts`) as the regression canary. High value, high risk — do carefully, last-ish.

**2.7 `TerminalPane.tsx` split** (1535 lines) — the load-bearing core. Fuses an imperative singleton terminal engine with the React component: ~20 module-level Map/Set registries (lines 14-59: `terminals`, `canvasAddons`, `pendingOutput`, `pendingFlush`, `promptScanTimers`, `paneReceivedBytes`, `healthAnomalyReported`, …); ~30 free functions (63-709), 15 `export`ed and imported across PaneHeader/App/AgentBadge/OpenInPaneButton; 8 `useEffect`s (one ~300 lines, 731-1025).
- Target: `renderer/terminal/manager.ts` (registries + lifecycle/fit/flush/dispose/launch, no JSX; consumers import from here), `renderer/terminal/promptScan.ts` (Claude-waiting detector + chime), `renderer/terminal/health.ts` (blank-pane sweep). Component keeps rendering + effects.
- Effort L, risk med-high (documented blank-pane/canvas history). Move in slices behind UNCHANGED exports; verify with `checkPaneHealth`/`dumpPaneDiagnostics` + zero `pane-blank-detected` in app.log.

### DONE ✅ (from the original plan)
- **Shared `<PortalMenu>`** (2.x) — `c2880f3`.
- **Path helpers** — `f240747`.
- **`tsc` gate** (renderer 0 errors) — `0e26bda`.
- **Reliability**: persistence, overlay pull, error isolation — `0e26bda`.

### Explicitly NOT worth doing (agent's honest calls — don't churn these)
- A `<GitStatusChips>` component (only rendered once, `PaneHeader.tsx:154-172`).
- `PANE_COLORS` extraction (already centralized/exported from PaneHeader, consumed by PipStrip).
- Generic factory for `preload.ts`'s 65 typed wrappers (the explicit per-method return types are a feature). Just stop adding `ops*`-style plugin-specific methods (→ 2.5).
- `debouncedSave` module singleton (intentional shared timer).
- A universal `<Button>` forcing every icon-only/color-stateful one-off through it (costs more than it saves — do the two hot variants only, 2.3).

---

## 3. Dead-code follow-ups (verified, low value — batch when convenient)

- **Drop redundant `export`** (symbol used only intra-file — do NOT delete the symbol, only the `export` keyword): `logger.ts` `LogLevel`/`LogEntry`; `router.ts` `ROUTER_COMMAND`/`DELEGATE_COMMAND`/`DELEGATION_FEED_COMMAND`; `pluginHost.ts` `HostDeps`; `transcript-tailer.ts` `Todo`; `plugins.ts` `PluginStatus`; `types.ts` `DelegationPrefs`/`ShadowCouldMatch`/`RouterStatusProvider`; `perfMonitor.ts` `getPerfLogDir`; renderer: `resetTerminal`, `clampOpsScale`, `readOpsScale`, `gridDimensions`, `PIP_STRIP_W`, `PipTileRect`, `PipGeometry`, `clampUiScale`, `LayoutConfig`.
- **Broken tailwind refs:** `tailwind.config.js` `terminal.active`/`claude.pink`/`claude.pinkMuted` reference `var(--claude-pink)`/`--claude-pink-muted` which are **undefined** (removed in the design refactor) → resolve to nothing. Remove those color entries (verify no `bg-claude-pink`/`text-terminal-active` utilities are used first).
- **`--terminal-bg/fg/header/muted` + tailwind `terminal.*` colors:** the generated `bg-terminal-bg`/etc. utilities are used nowhere (xterm hardcodes `#1e1e1e`/`#d4d4d4` in `TerminalPane.tsx:~224`). Removable, but the token + tailwind entry must go together. `--terminal-border` and `--terminal-bg-rgb` ARE used — keep.
- **KEEP:** `analyze-verify.mjs` (standalone manual tool). **KEEP:** the design-system palette tokens that are currently unused but intentional (`--surface-3`, `--edge`/`--edge-soft`, `--accent-strong`, `--success-line`, `--info`, `--git-clean/ahead/behind/dirty`, `--s1..s7`, `--r-sm/md/lg`, `--ease`/`--motion*`) — the system's vocabulary, about to be consumed by the Button work.
- **`main` tsconfig:** 11 errors (`TS6059` rootDir rejecting `src/shared`/`src/plugins` imports + 3 pre-existing type mismatches: env `Record<string,string>`, `openInEditor` Promise, `favoriteDirectories`). Needs a `rootDir`/composite-project restructure — its own task; not blocking (vite builds main fine).

---

## 4. Reliability — remaining (beyond the committed cluster)

- **PiP canvas disposal** — see 2.6 (memory).
- **Verification harness as a regression gate** — the console's accuracy/latency tracking (VerificationTracker, `~/.quadclaude/ops-verify.jsonl`, `scripts/analyze-verify.mjs`) is a *process* asset: after risky refactors, run a session with verification ON (Settings → Plugins → Activity Console → "Verification logging") and report match-rate / p95 as proof nothing degraded.
- Console memory is already lean (+2MB same-process, zero cost closed, rAF paused when `document.hidden`, feed capped) — nothing more to chase there.

---

## 5. Design-system decisions (locked — don't relitigate)

- **Cohesive = NEUTRAL gray surfaces + mono-forward + glass + cyan accent + wallpaper ground.** The app is neutral `#141414/#1e1e1e/#252525` — a cool blue-biased tint (the design doc's first instinct) read as "a different app". Surfaces (`--surface-1..4`) and text ramp are neutral.
- **Console** sits on the app wallpaper (`OpsOverlay.tsx` reads `preferences.background`), is **monospace** (SF-chrome experiment reverted), full-bleed title bar with **84px macOS traffic-light safe-area**, plain "QuadClaude" wordmark (bolt removed), calm sine-wave tok/s meters, amber **DEMO LOOP** badge in record mode.
- **"Live" = cyan** (`--info` = accent); **red = danger only**.
- **Rounding halved** from Tailwind defaults, single source = `tailwind.config.js` `borderRadius` (sm 1 / DEFAULT 2 / md 3 / lg 4 / xl 6 / 2xl 8) + `--r-*` tokens; `rounded-full` stays.
- **Delegation briefing = editorial (option B)** — user explicitly chose the big-headline analyst-briefing over a tightened "tool" version (A was built then reverted).
- Type scale (`--fs-meta/body/heading/title/display` = 10/11/13/15/28) + `--ui-scale` chrome zoom + per-surface zoom (console/dashboard) — from the parallel font-sizing session; `uiScale.ts`; Tailwind `text-meta/body/heading/title/display` aliases. Prefer these over raw `text-[Npx]`.
- Design-system spec artifact (living): https://claude.ai/code/artifact/98647cfa-6c10-4dd8-8b30-5a35c2cfe9b2

---

## 6. Gotchas discovered this session (don't rediscover the hard way)

- **`*/` inside a CSS comment closes it early** → PostCSS "Unknown word" build failure. Never write `--ui-*/--glass-*` etc. in an index.css comment.
- **Plugin settings didn't persist** — `PLUGIN_TOGGLE`/`PLUGIN_SET_SETTING` updated memory only. Fixed via `persistPluginPrefs()` in `main/index.ts` (writes `preferences.plugins`). This was the "I enabled it at launch but it's not there" bug.
- **Console open was a no-op** — `openConsole()` had `if (visible) return`; a dropped startup show-push wedged it. Fixed: always re-assert show + overlay pulls state on mount (`ops:request-state`).
- **The blinking cursor** in the console title bar is a decorative terminal-prompt flourish (`.cur`); the **VERIFICATION overlay** is the accuracy tracker (default OFF; toggle in Settings → Plugins). Neither is a bug.
- **Usage isn't dead** — `UsagePoller` feeds the pane status line via `.statusline-usage-*` cache files (`QC_USAGE_CACHE`); only the renderer API on top was dead.
- **`getFolderName` had 3 divergent fallbacks** (`'Terminal'` / path / `''`) — consolidated with a `fallback` param to preserve each.
