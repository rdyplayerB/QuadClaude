# Plan 01 — Configurable Custom-API Agent Profiles

**Goal:** Let a QuadClaude pane launch *any* CLI coding agent (opencode, aider, codex, …) instead of only Claude Code, by storing a list of generic **agent profiles** (name + command + free-form env vars) and adding a launcher picker + a Settings "Agents" section.

**North-star principle (do not violate):** QuadClaude stays a **pure launcher**. It never speaks any API format, never parses a model response, never builds fixed "Base URL / API Key" fields. A profile is just *a command and a bag of env vars typed/spawned into a terminal*. All provider/auth/format differences live inside the CLI tool. This is what keeps the feature universally compatible **and** low-maintenance.

**Confirmed decisions (settled with user — do not re-litigate):**
- Terminal via CLI agent. NOT a native chat UI. NOT calling APIs from the app.
- Scope = agentic coding (the CLI edits files / runs commands in the pane cwd).
- Env editor = FREE-FORM key/value rows, not labeled fields.
- Exactly ONE preset: `opencode`. Plus an "Other (custom)" blank option.
- Claude-only behaviors must be visibly **labeled** and **never applied** to other agents.
- Existing built-in Claude path must behave EXACTLY as today.
- Commit split: **(a)** types + env-injection plumbing; **(b)** picker + settings UI.

**Build notes (repo memory — obey):**
- NEVER run `npm run build:main` (emits stray `src/shared/types.js`, breaks vite). Use `npm run build:renderer`.
- Typecheck with `npm run typecheck` (`tsc --noEmit`).
- xterm canvas addon needs the load-bearing vite alias + `--legacy-peer-deps` (don't touch).

---

## Phase 0 — Verified facts ("Allowed APIs" / current code)

All line numbers verified from HEAD on 2026-06-09. Treat these as the ground truth; re-grep if anything looks off before editing.

### PTY / IPC / main (commit a surface)
- `src/main/pty.ts:149` — `async createPty(paneId: number, cwd?: string): Promise<boolean>`. Kills existing PTY first (`this.killPty(paneId)` at top), then `pty.spawn(shell, [], { name, cols, rows, cwd: workingDir, env: await getShellEnv() })` (spawn at ~`:160`, env at `:165`).
- `src/main/pty.ts:58` — `async function getShellEnv(): Promise<NodeJS.ProcessEnv>` returns `{ ...process.env, PATH, TERM, COLORTERM, LANG, HOME, SHELL_SESSIONS_DISABLE, TERM_PROGRAM, TERM_PROGRAM_VERSION }`.
- `src/shared/types.ts:133-173` — `IPC_CHANNELS` (incl. `PTY_CREATE: 'pty:create'`).
- `src/main/preload.ts:7-8` — `createPty: (paneId, cwd?) => ipcRenderer.invoke(IPC_CHANNELS.PTY_CREATE, paneId, cwd)`; type decl at `preload.ts:126-127`.
- `src/main/index.ts:933-947` — `ipcMain.handle(IPC_CHANNELS.PTY_CREATE, async (_, paneId, cwd?) => { ... ptyManager?.createPty(paneId, cwd) ... })`.

### Types (commit a surface)
- `src/shared/types.ts:111-123` — `WorkspacePreferences` (theme, fontSize, hotkeys, savedPrompts, favoriteDirectories, background?, showPromptBar?, dangerouslySkipPermissions?, decisionSoundEnabled?).
- `src/shared/types.ts:22` — `PaneState = 'shell' | 'claude-active' | 'claude-waiting'`.
- `src/shared/types.ts:45-52` — `PaneConfig`.
- `src/shared/types.ts:27-28` — `MIN_PANES = 4`, `MAX_PANES = 6`.

### Renderer launch + detection (commit b surface)
- `src/renderer/components/PaneHeader.tsx:52-58` — `claudeRunning`, `skipPermissions` (read from store), `startClaude()` → `sendToTerminal(paneId, skip ? 'claude --dangerously-skip-permissions\r' : 'claude\r')`.
- `src/renderer/components/PaneHeader.tsx:198-218` — the Claude `<button>` JSX (icon + "Claude"/"Running" label).
- `src/renderer/components/PaneHeader.tsx:4` — imports `{ clearTerminal, sendToTerminal, disposeTerminalForPane } from './TerminalPane'`.
- **`src/renderer/components/OpenInPaneButton.tsx:59-60`** — SECOND hardcoded launch: `const skip = store.preferences.dangerouslySkipPermissions === true; const claude = skip ? 'claude --dangerously-skip-permissions' : 'claude'`. Must route through the shared helper too.
- `src/renderer/components/TerminalPane.tsx:535-538` — PTY creation call: `await window.electronAPI.createPty(paneId, pane.workingDirectory)`.
- `src/renderer/components/TerminalPane.tsx:239-245` — exported `sendToTerminal(paneId, text)` (uses module `terminals` map; calls `electronAPI.sendInput` + `terminal.focus()`).
- `src/renderer/components/TerminalPane.tsx:58-72` — `scanForClaudePrompt` (regex `❯\s*\d+\.\s` + decision wording).
- `src/renderer/components/TerminalPane.tsx:74-99` — `playDecisionChime()` (guards on `prefs.decisionSoundEnabled === false`).
- `src/renderer/components/TerminalPane.tsx:155-166` — `refreshClaudeWaitingState` (only acts when state is already `claude-active`/`claude-waiting`).
- `src/renderer/components/TerminalPane.tsx:776-790` — ~400ms debounced scan, **armed only when state is `claude-active`/`claude-waiting`**.

### Settings + store (commit b surface)
- `src/renderer/components/SettingsModal.tsx:12-13` — `const { preferences, updatePreferences, updateBackground } = useWorkspaceStore()`.
- `src/renderer/components/SettingsModal.tsx:216-235` — "Skip permission prompts" toggle (copy-ready pattern for new controls).
- `src/renderer/components/SettingsModal.tsx:237-257` — "Decision chime" toggle (same pattern; note tri-state `=== false` checks).
- `src/renderer/store/workspace.ts:75-82` — `preferences` defaults (no agentProfiles yet).
- `src/renderer/store/workspace.ts:356-368` — `updatePreferences(updates)` (enforces array caps, `set`, `debouncedSave`).
- `src/renderer/store/workspace.ts:371-384` — `saveWorkspace()` (strips transient pane fields, calls `electronAPI.saveWorkspace`).
- `src/renderer/store/workspace.ts:62-66` — `debouncedSave` (500ms).

### Key design resolutions (derived from the facts above)
1. **Runtime Claude-isolation is mostly automatic.** A pane only becomes `claude-active` via main-process detection that greps for a literal `claude` process (`isClaudeRunning`). The decision chime + prompt scan only arm in `claude-active`/`claude-waiting` (TerminalPane.tsx:781). So a pane running `opencode` never enters those states and never chimes — **no runtime gating code needed** beyond what already exists. Our job is just (a) not appending the skip flag for non-Claude, and (b) labeling the Claude-only toggles in Settings.
2. **Env injection requires a PTY re-spawn**, because the shell PTY is created at pane mount (TerminalPane.tsx:535) before any profile is chosen. Rule: **profiles WITH env entries re-spawn the PTY with merged env, then type the bare command** (keys never hit history). **Profiles WITHOUT env (incl. Claude) behave exactly as today** — just type the command into the existing shell, no re-spawn. `createPty` already kills the old PTY first, so re-spawn = one `createPty` call.
3. **Single shared launch helper** used by PaneHeader, OpenInPaneButton (and anywhere else that launches an agent) to avoid divergence.

---

## Phase 1 — Types + env-injection plumbing  *(commit a)*

**Frame: thread one optional `env` param through the existing PTY call chain, and add the generic profile type. Copy the existing param-threading shape exactly; do not invent new IPC channels.**

### 1.1 `src/shared/types.ts` — add the profile type + constants
Add near `WorkspacePreferences`:
```ts
export interface AgentProfile {
  id: string
  name: string
  command: string                 // bare executable + args, e.g. "opencode" or "aider --model x"
  env?: Record<string, string>    // free-form; injected at PTY spawn, never echoed
  builtin?: 'claude'              // discriminator for Claude-only UI/behavior
}

export const CLAUDE_PROFILE_ID = 'claude'

// Seed so the built-in Claude path is identical to today.
export const DEFAULT_AGENT_PROFILES: AgentProfile[] = [
  { id: CLAUDE_PROFILE_ID, name: 'Claude Code', command: 'claude', builtin: 'claude' },
]
```
Extend `WorkspacePreferences` (types.ts:111-123) with two optional fields (optional → existing stored prefs stay valid):
```ts
  agentProfiles?: AgentProfile[]
  defaultAgentId?: string   // global fallback when a pane has no agent assigned yet
```
Extend `PaneConfig` (types.ts:45-52) with a **per-pane** assignment so each window remembers its role across restarts:
```ts
  agentId?: string          // which profile THIS pane runs; falls back to defaultAgentId
```
This is the field that delivers the user's "turn it on/off per individual window" requirement and the always-visible per-pane model identity. It persists automatically (saveWorkspace at workspace.ts:371 strips only `gitStatus`/`servers`, so `agentId` round-trips).

### 1.2 `src/main/pty.ts` — accept + merge env
Change signature (`:149`) to:
```ts
async createPty(paneId: number, cwd?: string, env?: Record<string, string>): Promise<boolean> {
```
At the spawn (`:165`), merge profile env OVER the shell env (profile wins):
```ts
      env: { ...(await getShellEnv()), ...(env || {}) },
```

### 1.2b `src/main/pty.ts` — supersession guard on the PTY event closures ⚠️ CRITICAL
**Verified gotcha:** the renderer auto-respawns a PTY on exit (`TerminalPane.tsx:800-830` — recreates the PTY with NO env and clears the terminal), and the old process's `onExit` closure (`pty.ts:177-179`) unconditionally runs `this.ptys.delete(paneId)`. Without a guard, the env re-spawn sequence breaks itself: old PTY's late exit event (a) deletes the NEW pty from the map (input/resize dead) and (b) triggers the renderer to spawn a third, env-less PTY over ours.

Fix — make both closures no-op when their instance has been superseded:
```ts
ptyProcess.onExit(({ exitCode }) => {
  if (this.ptys.get(paneId)?.pty !== ptyProcess) return  // superseded by re-spawn or killPty
  this.ptys.delete(paneId)
  this.onExit(paneId, exitCode)
})
```
Apply the same identity check at the top of the `onData` closure. Since `killPty` deletes the map entry *before* killing, intentional kills now emit no spurious exit (correct: renderer auto-respawn is only for *natural* exits like the user typing `exit`, which still match the map and fire normally). Verified safe for current `killPty` callers: pane removal (the TerminalPane component is unmounted, listener unsubscribed) and app-quit `killAll`.

### 1.3 `src/main/index.ts` — pass env through the handler (`:933-947`)
```ts
ipcMain.handle(IPC_CHANNELS.PTY_CREATE, async (_, paneId: number, cwd?: string, env?: Record<string, string>) => {
  // ...existing logging...
  const result = await ptyManager?.createPty(paneId, cwd, env)
  // ...existing return/catch...
})
```

### 1.4 `src/main/preload.ts` — extend the bridge (`:7-8` and type decl `:126-127`)
```ts
createPty: (paneId: number, cwd?: string, env?: Record<string, string>) =>
  ipcRenderer.invoke(IPC_CHANNELS.PTY_CREATE, paneId, cwd, env),
```
```ts
createPty: (paneId: number, cwd?: string, env?: Record<string, string>) => Promise<boolean>
```

### 1.5 `src/renderer/store/workspace.ts` — seed + migrate defaults
- In the defaults block (`:75-82`) add:
  ```ts
  agentProfiles: DEFAULT_AGENT_PROFILES,
  defaultAgentId: CLAUDE_PROFILE_ID,
  ```
  (import `DEFAULT_AGENT_PROFILES, CLAUDE_PROFILE_ID` from `@shared/types` or the existing types import path used in this file.)
- In the workspace-load/initialize path (where persisted `preferences` are merged in — find it near `loadWorkspace`/`initialize`), ensure backward-compat for users whose stored prefs predate this feature:
  ```ts
  // After merging loaded preferences:
  if (!prefs.agentProfiles || prefs.agentProfiles.length === 0) prefs.agentProfiles = DEFAULT_AGENT_PROFILES
  // Guarantee the Claude builtin is always present and first:
  if (!prefs.agentProfiles.some(p => p.builtin === 'claude')) prefs.agentProfiles = [...DEFAULT_AGENT_PROFILES, ...prefs.agentProfiles]
  if (!prefs.defaultAgentId) prefs.defaultAgentId = CLAUDE_PROFILE_ID
  ```
  (Adapt variable names to the actual load code; the intent is: never lose the Claude builtin, always have a default.)

### Phase 1 verification
- `npm run typecheck` passes.
- **Supersession-guard regression:** type `exit` in a pane → shell still auto-respawns in the same cwd (natural-exit path intact). Close/remove a pane → no errors, no ghost PTY (intentional-kill path intact).
- `grep -n "createPty" src/main/pty.ts src/main/index.ts src/main/preload.ts src/renderer/components/TerminalPane.tsx` — all `createPty` signatures now accept the optional 3rd `env` arg; the TerminalPane call site (1.x untouched here) still compiles (env optional).
- App still launches and Claude still starts from the existing button (no behavior change yet — this commit is plumbing only).

### Phase 1 anti-patterns
- ❌ Do NOT add a new IPC channel — reuse `PTY_CREATE`.
- ❌ Do NOT make `env` required anywhere (breaks the existing call site).
- ❌ Do NOT spread `env` UNDER `getShellEnv()` — profile must win.

---

## Phase 2 — Shared launch helper + picker + OpenInPaneButton  *(commit b, part 1)*

**Frame: introduce one `launchAgent` helper, then make every launch site call it. Copy the existing `sendToTerminal`/`clearTerminal` usage; reuse the existing `createPty` bridge for re-spawn.**

### 2.1 `src/renderer/components/TerminalPane.tsx` — add `launchAgent`
Co-locate with the other exports (`sendToTerminal` at `:239`). Add:
```ts
import type { AgentProfile } from '@shared/types' // adjust to file's import style

// Transient, renderer-module-level: what env (by profile id) the current PTY
// for each pane was spawned with. Not persisted.
const paneEnvProfile = new Map<number, string | null>()

export async function launchAgent(paneId: number, profile: AgentProfile, fallbackCwd: string) {
  const hasEnv = !!profile.env && Object.keys(profile.env).length > 0
  const currentEnvProfile = paneEnvProfile.get(paneId) ?? null
  // Re-spawn when this profile needs env, OR the pane's PTY carries env from a
  // DIFFERENT profile (prevents stale secrets leaking into the next agent's shell).
  const needsRespawn = hasEnv ? currentEnvProfile !== profile.id : currentEnvProfile !== null
  if (needsRespawn) {
    // Use the LIVE tracked cwd (user may have cd'd since pane creation), not the stored one.
    const cwd = (await window.electronAPI.getCwd(paneId)) || fallbackCwd
    clearTerminal(paneId)
    await window.electronAPI.createPty(paneId, cwd, hasEnv ? profile.env : undefined)
    paneEnvProfile.set(paneId, hasEnv ? profile.id : null)
  }
  let command = profile.command
  if (profile.builtin === 'claude') {
    const skip = useWorkspaceStore.getState().preferences.dangerouslySkipPermissions === true
    if (skip) command += ' --dangerously-skip-permissions'
  }
  sendToTerminal(paneId, command + '\r')
}
```
Notes for implementer:
- The common path stays untouched: a pane that has never run an env profile (`currentEnvProfile === null`) launching Claude or any env-less profile does NOT re-spawn — identical to today.
- Also update the renderer auto-respawn (`TerminalPane.tsx:~820`) and `disposeTerminal` to clear `paneEnvProfile` for that pane (auto-respawn creates an env-less PTY, so set to `null`).
- The xterm instance persists across re-spawn (only the PTY is replaced), and the global `terminal:output` listener is keyed by paneId, so new PTY output flows to the same terminal automatically.
- PTY input is kernel-buffered, so typing the command immediately after `createPty` resolves is safe (zsh reads it once ready). If empirically racy, a single `requestAnimationFrame`/short `setTimeout` before `sendToTerminal` is acceptable — but try without first.
- Depends on Phase 1.2b (supersession guard); without it the re-spawn self-destructs via the auto-respawn race.

### 2.2 `src/renderer/components/PaneHeader.tsx` — the picker IS the always-visible model badge
Replace `startClaude` (`:54-58`) and the button (`:198-218`) with a single element that does double duty: it **always displays this pane's model name** (identity requirement) AND is the dropdown to switch/launch it. One control, always visible.

Behavior:
- Resolve this pane's profile: `pane.agentId` → matching profile; fall back to `defaultAgentId`; fall back to the Claude builtin. Call it `paneProfile`.
- Badge label = `paneProfile.name` (e.g. "Claude", "Qwen Coder", "Codex"), with a small status dot: green/live when running, dim otherwise. Liveness is reliable only for Claude (existing process detection); for other agents reflect "launched since last spawn" optimistically (set on `launchAgent`, cleared on PTY exit). Honest + simple.
- Primary click (or an explicit ▶ within the badge) → `launchAgent(paneId, paneProfile, pane.workingDirectory)`.
- Caret ▾ → menu listing all `agentProfiles`. **Selecting one sets `pane.agentId` (persisted) AND launches it** — so the pane both remembers its role and starts the agent in one action.
- For the Claude builtin badge only, keep the skip-permissions icon variant and the existing `claudeRunning` "Running"/disabled treatment. Other agents have no running-detection, so their badge is never disabled.
- Persist the assignment via the store (add a small `setPaneAgent(paneId, agentId)` action next to the existing `setPaneState`/`setPaneCwd` in workspace.ts, mirroring their shape; it should trigger `debouncedSave`).

### 2.3 `src/renderer/components/OpenInPaneButton.tsx` — route through the helper
Replace the hardcoded claude logic (`:59-60`) so it launches the **target pane's assigned agent** via the shared helper — same resolution chain as the badge (pane → global default → Claude builtin), so the two UIs can never disagree:
```ts
export function resolvePaneProfile(pane: PaneConfig, prefs: WorkspacePreferences): AgentProfile {
  const profiles = prefs.agentProfiles ?? DEFAULT_AGENT_PROFILES
  return profiles.find(p => p.id === pane.agentId)          // per-pane assignment
    ?? profiles.find(p => p.id === prefs.defaultAgentId)    // global default
    ?? profiles.find(p => p.builtin === 'claude')           // builtin
    ?? DEFAULT_AGENT_PROFILES[0]
}
```
Put `resolvePaneProfile` in one shared location (e.g. next to `launchAgent` or in a small `agents.ts` util) and use it in BOTH PaneHeader (2.2) and OpenInPaneButton. The find-by-id fallthrough also covers deleted profiles: a pane whose `agentId` no longer resolves silently falls back instead of breaking.
(Preserve whatever cwd/targeting this button already computes; only the command-construction changes.)

### Phase 2 verification
- `npm run typecheck` passes.
- With no custom profiles configured, the picker default is "Claude Code" and clicking it launches Claude **exactly as before** (incl. skip-permissions flag when the pref is on). Confirm by `grep -n "claude --dangerously-skip-permissions" src/renderer` → now only constructed inside `launchAgent`.
- `grep -rn "'claude\\\\r'\|claude --dangerously" src/renderer/components/PaneHeader.tsx src/renderer/components/OpenInPaneButton.tsx` → returns nothing (both routed through helper).

### Phase 2 anti-patterns
- ❌ Do NOT duplicate launch/command-building logic in PaneHeader and OpenInPaneButton — both call `launchAgent`.
- ❌ Do NOT append `--dangerously-skip-permissions` for non-Claude profiles.
- ❌ Do NOT re-spawn the PTY for env-less profiles (Claude must keep its existing in-place launch).

---

## Phase 3 — Settings "Agents" section + Claude-only labeling  *(commit b, part 2)*

**Frame: copy the existing toggle/section markup from SettingsModal (`:216-257`) for styling; add CRUD over `preferences.agentProfiles` via the existing `updatePreferences`.**

### 3.1 New "Agents" section in `src/renderer/components/SettingsModal.tsx`
- List existing `preferences.agentProfiles`. Each row: name, command, "Edit"/"Delete". The Claude builtin (`builtin === 'claude'`) is **not deletable** and its name/command are read-only (still selectable as default).
- "Add agent" → choose a template, then show the edit form. Templates (pure data, renderer-local const — no provider logic):
  ```ts
  const AGENT_PRESETS = [
    { label: 'opencode', command: 'opencode', env: { OPENAI_BASE_URL: '', OPENAI_API_KEY: '' } },
    { label: 'Other (custom)', command: '', env: {} },
  ]
  ```
- Edit form fields:
  - `name` (text), `command` (text).
  - **Free-form env editor**: list of `{ key, value }` rows with add/remove. Render `value` as a password input (with a reveal toggle) when the key matches `/key|token|secret|password/i`; plain text otherwise.
- "Default agent" selector (dropdown/radio) → writes `defaultAgentId`.
- **Deletion semantics:** deleting a profile that is some pane's `agentId` or the `defaultAgentId` is allowed but should reset `defaultAgentId` to the Claude builtin if it pointed at the deleted profile; pane `agentId`s can be left dangling — `resolvePaneProfile` (2.3) falls back safely. Optionally show "in use by N panes" before deleting.
- **Preset key verification (do at implementation time, not from memory):** the opencode preset's env KEYS were drafted as `OPENAI_BASE_URL`/`OPENAI_API_KEY`, but opencode configures custom providers primarily via its own config file (`opencode.json` / `~/.config/opencode`), and the exact env-var names must be verified against current opencode docs (https://opencode.ai/docs / github.com/sst/opencode) before shipping. If env vars alone can't select a custom provider+model, the preset should instead pre-fill a `command` that works (still pure data — e.g. a command with flags) and the env rows stay empty. Presets are inert data, so this is a content fix, not a design change.
- Persist all changes via `updatePreferences({ agentProfiles: nextList })` / `updatePreferences({ defaultAgentId })` — reuse the exact store method at workspace.ts:356. Generate ids without `Date.now()`/`Math.random()` only if you're in a workflow context; in normal renderer code a simple `crypto.randomUUID()` or incrementing-max-id is fine (this is app runtime, not a workflow script).

### 3.2 Label the Claude-only controls
The existing "Skip permission prompts" (`:216-235`) and "Decision chime" (`:237-257`) toggles are Claude-specific. Wrap them under a clearly labeled subsection heading, e.g. **"Claude Code only"**, so it's explicit they don't affect other agents. No behavior change — they already only act on Claude (see Phase 0 resolution #1); this is purely a label/heading addition.

### Phase 3 verification
- `npm run build:renderer` succeeds (NOT build:main).
- Add an `opencode` profile via the preset, fill `OPENAI_BASE_URL=http://609c5d0c0.shared.olares.com/v1` and a placeholder `OPENAI_API_KEY=ollama`; set it default. Reload app → profile persists (electron-store round-trip).
- Secret-keyed env value renders masked.
- The "Claude Code only" heading is visible above the skip/chime toggles.

### Phase 3 anti-patterns
- ❌ Do NOT add per-provider branches (no "if opencode … else aider …"). Presets are inert data.
- ❌ Do NOT build fixed "Base URL"/"API Key" inputs — env editor stays generic key/value.
- ❌ Do NOT let the Claude builtin be deleted or lose its `builtin: 'claude'` flag.

---

## Phase 4 — Final verification

1. **Typecheck:** `npm run typecheck` clean.
2. **Build:** `npm run build:renderer` clean. (Never `build:main`.)
3. **Anti-pattern greps:**
   - `grep -rn "claude --dangerously-skip-permissions" src/renderer` → only inside `launchAgent` (TerminalPane.tsx).
   - `grep -rn "Base URL\|API Key" src/renderer/components/SettingsModal.tsx` → nothing (generic env editor only).
   - `grep -rn "createPty" src/main src/renderer` → all signatures carry the optional `env` arg.
4. **Behavioral (manual, real app):**
   - Default Claude profile: pane picker shows "Claude Code"; launch works incl. skip-permissions; decision chime still fires on a real Claude yes/no prompt.
   - opencode profile pointed at the Olares `/v1` endpoint (model `qwen3-coder:30b`): launches in a fresh shell with env injected; `grep`-style check that the API key is NOT visible in scrollback/history; pane stays in `'shell'` state and never chimes.
   - **Env-switch hygiene:** launch the opencode (env) profile, exit it, then launch Claude in the SAME pane → pane re-spawns clean and `echo $OPENAI_API_KEY` is empty (no stale secrets). Then Claude→Claude again → no re-spawn (terminal history preserved).
   - **Race check:** launch the env profile and confirm typing/resize still work afterwards (proves the 1.2b guard prevented the auto-respawn race) and the terminal wasn't cleared a second time after the command was typed.
   - Default-agent switch: set opencode as default → primary button launches it; OpenInPaneButton also launches it.
5. **Persistence:** quit + relaunch → custom profiles, default selection, and env values survive.

---

## Delivers which user modes
- **Mode (a) Pure Claude Code:** a pane left on the Claude profile — behaves exactly as today.
- **Mode (b) Solo local/other model:** a pane assigned opencode/Codex/etc., standing alone.
- The always-visible badge satisfies "whatever model is running must be clearly identified."
- **Mode (c) Claude orchestrates → local grinds** needs the pane-pairing visual — see `plans/02-pane-pairing.md`. (The collaboration itself works manually after this plan via the plan-file + git handoff; plan 02 only adds the explicit visual link + roles.)

## Out of scope for THIS plan (handled elsewhere / deferred)
- Pane pairing + visual link + orchestrator/worker roles → **plan 02**.
- One-click "send to worker pane" handoff → plan 02 (deferred phase; cheap later via existing `sendToTerminal`).
- Native chat-UI pane (rejected by design).
- Per-agent running-state detection / chimes for non-Claude agents (v1 leaves them in `'shell'`).
- OS-keychain storage for keys (electron-store is acceptable for v1; masking in UI only).
