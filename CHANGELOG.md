# Changelog

## v1.21.0

A dedicated Delegation dashboard, richer logging, and an exportable log.

### Added
- **Delegation dashboard** — a full-screen view (chart icon in the title bar) replacing the Settings tab. KPIs (delegations, check-pass rate, lines, files, cold starts, avg time), per-project cards (click to filter), and an expandable per-call timeline showing each delegation's status, attribution, prompt, and worker-output tail.
- **Richer event capture** — each delegation now records a `promptPreview` (what was delegated) and `outputPreview` (how the worker responded), in addition to attribution and check results.
- **Export** — "Copy log" (to clipboard) and "Export" (save to file) produce a single self-contained markdown + JSON report of all delegation activity, designed to be pasted back to Claude to analyze and improve how it delegates to custom LLMs.
- **`qwen` parity** — the `qwen` delegate wrapper is now fully instrumented (structured events, pane tagging, git-snapshot attribution, cold-start retry) and routes through the mergesystem transformer so its edits actually apply.

### Changed
- Delegation moved out of Settings into its own dashboard.

## v1.20.0

Delegation logging, dashboard, and an automatic worker-window workflow.

### Added
- **Per-project delegation telemetry.** Every `qcdelegate` run now appends one structured event to `~/.quadclaude/events.jsonl` capturing the project, originating pane, route, duration, exit code, the exact lines/files the worker changed, and — when `QC_CHECK` is set — whether that check passed (objective ground truth). This is the source of truth for "how much was delegated, and did it work?".
- **Delegation dashboard** (Settings → Delegation). Per-project cards showing delegations, check-pass / success rate, lines and files delegated, and cold-start retries, with live refresh and a "Clear telemetry" action.
- **Enable-delegation setting** with a capability gate that points you to the Models tab when no delegation model is configured.
- **Session-scoped worker window.** With delegation enabled, the first time Claude delegates in a session you're asked once whether to show a live worker window; on approval a pane is reused (or a new one opened, up to the 12-pane cap) and streams the feed. The approval is remembered for that Claude session only and is re-asked next session.
- **Git-snapshot change attribution.** The worker measures exactly what it changed via a before/after worktree snapshot using a throwaway index, so it never touches your real git staging and counts new files correctly — including a shadow repo for non-git projects so nothing is written into the project directory.

### Fixed
- **Cold-start retries.** The worker now warms past the "model may not exist" error a local model emits before it's loaded, retrying a couple of times and recording how many warm-ups it took.
- **Empty worker window.** The feed now retries until the worker pane's terminal is mounted, fixing the silent no-op that previously left the window blank.

### Internal
- Delegation logs are app-managed: a single rolling `events.jsonl` folded into a cumulative `summary.json` with size-based rotation and a 90-day retention prune on startup, so log growth stays bounded.
- The `qcdelegate` worker script is now maintained as `src/main/qcdelegate.sh` and embedded base64-encoded (mirroring the ccr transformer), rather than an inline template literal.
