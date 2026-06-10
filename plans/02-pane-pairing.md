# Plan 02 — Pane Pairing (Orchestrator ⇄ Worker)

**Prereq:** Plan 01 (custom agent profiles + per-pane `agentId` + always-visible model badge) is shipped.

**Goal:** Let the user explicitly **link two panes into a collaborating pair** — typically a Claude "orchestrator" and a local-model "worker" — with a clear visual indicator that they're a team, plus role labels. This delivers **mode (c)** from the user's three modes. Pairing is always **opt-in**; unpaired panes (modes a & b) are visually unchanged.

**Design principles (carry over from plan 01):**
- Pairing is metadata + visuals only. It does NOT auto-drive either pane (no orchestration engine — see "Out of scope"). The human (or a later handoff button) still moves work between panes; this plan just makes the relationship visible and persistent.
- Low complexity, additive, fully reversible (unpair returns both panes to normal).
- Build notes from repo memory still apply: never `build:main`; use `build:renderer`; don't touch the xterm canvas vite alias.

---

## Phase 0 — Facts to confirm before building
Re-verify (they're the same surfaces plan 01 touched):
- `src/shared/types.ts` — `PaneConfig` (now has `agentId?` from plan 01). Pairing fields go here.
- `src/renderer/store/workspace.ts` — pane mutators (`setPaneState`, `setPaneCwd`, the new `setPaneAgent` from plan 01) and `saveWorkspace` (strips only `gitStatus`/`servers`, so pairing fields persist).
- `src/renderer/components/PaneHeader.tsx` — where the model badge now lives (plan 01); the link chip goes beside it.
- `src/renderer/components/TerminalGrid.tsx` / `TerminalPane.tsx` — the pane container element where the accent ring border is applied.
- `MIN_PANES`/`MAX_PANES` (4–6) — pairing is between any two existing panes; does not change counts.

---

## Phase 1 — Pairing data model + store actions

### 1.1 `src/shared/types.ts` — pairing fields on `PaneConfig`
```ts
  pairId?: string                          // shared id; both panes in a pair carry the same value
  pairRole?: 'orchestrator' | 'worker'     // who drives vs who grinds
  pairColor?: string                       // persisted hue from PAIR_RING_COLORS — stored, NOT derived,
                                           // so rings keep their color across restarts and never swap
```
Optional → existing stored panes stay valid. Persist automatically (not stripped by saveWorkspace).

Add a small palette so each active pair gets a distinct ring hue (supports more than one pair at once across a 6-pane grid):
```ts
export const PAIR_RING_COLORS = ['teal', 'violet', 'amber'] as const // map to CSS vars in the renderer
```
`pairPanes` picks the first palette color not used by any existing pair and writes it to `pairColor` on both panes.

### 1.2 `src/renderer/store/workspace.ts` — pair/unpair actions
Mirror the shape of the existing pane mutators; both must `debouncedSave`.
```ts
pairPanes: (orchestratorId, workerId) => {
  // generate a pairId (crypto.randomUUID() is fine in renderer runtime)
  // assign the next free hue from PAIR_RING_COLORS based on existing pairs
  // set pairId + pairRole on BOTH panes; clear any prior pairing on either first
}
unpairPane: (paneId) => {
  // find partner by shared pairId; clear pairId + pairRole on BOTH
}
```
Guard rules: a pane can belong to at most ONE pair; pairing a pane that's already paired first dissolves its old pair. Don't allow pairing a pane with itself. Set both panes' `pairId`/`pairRole`/`pairColor` in a SINGLE `set()` call so the pair can never be observed half-formed (and roles can never desync into two orchestrators).

**⚠️ `removePane` integration (verified gap):** the existing `removePane(id)` in the workspace store knows nothing about pairs. It MUST dissolve the pair when a paired pane is removed — otherwise the surviving partner keeps a ghost ring/chip pointing at a pane that no longer exists. Add to `removePane`: if the removed pane has a `pairId`, clear `pairId`/`pairRole`/`pairColor` on its partner in the same state update. Same applies to any future pane-reset path.

---

## Phase 2 — Creating / dissolving a pair (UX)

Keep it to one obvious entry point. In the pane model-badge dropdown (plan 01, PaneHeader), add below the agent list:
- **"Pair with…"** → submenu of the *other* current panes (by label/folder). Picking one creates the pair. The pane initiating from the Claude profile defaults to `orchestrator`; the partner defaults to `worker`. Offer a "swap roles" affordance.
- When already paired, the entry becomes **"Unpair"** (calls `unpairPane`).

(Roles are a hint for the human + a label; nothing enforces them functionally in this plan.)

---

## Phase 3 — Visual indicators

### 3.1 Always-visible model identity
Already delivered by plan 01's badge — no change. Every pane shows its model regardless of pairing.

### 3.2 Pair ring
On the pane container element (TerminalGrid/TerminalPane), when `pane.pairId` is set, apply a 1–2px accent ring/border in the pair's hue (`PAIR_RING_COLORS` → CSS var). Both panes in the pair share the same hue, so a matching ring reads instantly as "these two are a team." Unpaired panes: no ring (unchanged appearance).

### 3.3 Link chip in the header
Next to the model badge, when paired, render a small chip:
```
🔗 Orchestrator        🔗 Worker
```
Optionally include the partner's pane label (e.g. `🔗 Worker ⇄ pane 1`). Clicking the chip can offer "Swap roles" / "Unpair".

Target look:
```
╔═[ teal ]═══════════════════╗   ╔═[ teal ]═══════════════════╗
║ repo ⎇ main  ◆ Claude ▾    ║   ║ repo ⎇ main  ◆ Qwen ▾      ║
║          🔗 Orchestrator   ║   ║          🔗 Worker         ║
╚════════════════════════════╝   ╚════════════════════════════╝
```

---

## Phase 4 — Verification
1. `npm run typecheck` + `npm run build:renderer` clean.
2. Pair two panes → both show the same-hue ring + correct role chips. Unpair → both rings/chips disappear.
3. Pairing a third pane to one already paired dissolves the old pair (no pane in two pairs).
3b. **Remove a paired pane** (grid at 5–6 panes) → the surviving partner's ring/chip clears immediately and after relaunch.
4. Two independent pairs across a 5–6 pane grid get distinct hues.
5. Persistence: pairing survives quit/relaunch.
6. Modes (a) and (b) regression: an unpaired Claude pane and an unpaired local-model pane look exactly as after plan 01 (no ring, just the badge).

### Anti-patterns
- ❌ No auto-driving / message-passing between paired panes in this plan (pairing is visual + metadata only).
- ❌ A pane must never belong to two pairs.
- ❌ Don't change pane counts or the grid algorithm — pairing is an overlay on existing panes.

---

## Out of scope (future, only if the manual flow proves it's needed)
- **One-click handoff button** — "send this plan / selection to my paired worker pane," typing a templated prompt via the existing `sendToTerminal`. Cheap to add once pairing exists; deferred until real-use friction justifies it.
- **Auto-orchestration loop** — Claude programmatically driving the worker and reviewing its diff without a human relay. This is a genuine multi-agent harness with real failure modes (loops, cost, conflict resolution) and is explicitly NOT part of the pairing concept. If ever wanted, prefer running an existing multi-agent tool inside a single pane over building orchestration into QuadClaude.
