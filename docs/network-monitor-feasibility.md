# Network Activity Monitor — feasibility (evaluated, not built)

Render the Activity Console on a separate device (an iPad on the same WiFi) via a
web page, so the Mac carries no rendering overhead and the console gets a
dedicated screen. Evaluated 2026-07-25 against the code as of the
`feat/delegation-dashboard` branch. **Status: documented only — nothing
implemented.**

## Verdict

Highly feasible, ~1 day of work, accuracy identical to the in-app console by
construction. Two existing design decisions do most of the work:

1. **The view is already portable.** `opsview.ts` is framework-free and
   self-contained — no React, no zustand, no Electron APIs — and is already
   hosted by two different surfaces (in-app Shadow DOM overlay,
   popped-out window via `ops.html`). A browser on another device is just a
   third surface.
2. **The data contract is snapshot-only** (`src/plugins/ops-console/types.ts`):
   the renderer diffs consecutive self-contained `OpsSnapshot`s; there is no
   event stream to miss. A client that disconnects (iPad sleeps, WiFi blips) is
   **instantly correct on reconnect** — no replay, no drift. This is exactly the
   property a flaky-tablet viewer needs, and it already exists.

The entire change concentrates in `toSurface()`
(`src/plugins/ops-console/index.ts`), which currently routes frames to one of
two surfaces; it grows a third: broadcast to connected network clients.

## Resource math (honest)

| Cost | Today | With remote rendering |
|---|---|---|
| Data collection (transcript tails, token meter, git, ctx) | main process | **stays on the Mac** — the data lives on its disk |
| Popped-window renderer process | ~100 MB + GPU compositing (per the comment in `index.ts`) | gone |
| In-app overlay | ~2 MB + rAF/FLIP animation in the main renderer | gone |
| Serialization/network | — | ~10–30 KB JSON at 1 Hz ≈ 0.1–0.2 Mbps — negligible |
| Screen real estate | a window competing with the panes | zero — dedicated display |

If the console is normally popped out, this reclaims a ~100 MB renderer
process. If it's normally the in-app overlay, the RAM saving is small and the
real win is the dedicated screen. Collection overhead stays on the Mac in every
design — a network monitor cannot make that free.

## Accuracy

Same producer, same 1 s tick, same transcript tailer. Freshness chain:
transcript write → ≤1.5 s cache → 1 s tick → 1–5 ms LAN hop → render. The
network adds noise ~200× smaller than the tick interval; worst-case staleness
stays ~2.5 s, identical to in-app.

**Required caveats:**

- **Producer lifecycle.** The producer only runs while the console is open
  (`visible` flag in `index.ts`). A network surface needs a client refcount so
  snapshots flow while any viewer is connected; otherwise the iPad shows a
  frozen board.
- **Verify mode must be display-only on remote viewers.** The verification
  tracker assumes ONE surface reporting moves; N viewers calling `onMove` would
  double-count into phantom moves. Remote clients render the overlay but never
  report.
- **Wallpaper ground** uses a `file://` URL (`ops-window.ts`) which won't load
  over HTTP. The flat-ground fallback already covers this; optionally serve the
  wallpaper through the same HTTP server.

## Transport: SSE, not WebSocket

For a read-only monitor, Server-Sent Events win:

- zero new dependencies (Node `http` is enough — no `ws` package)
- one-way push matches the snapshot model exactly
- `EventSource` auto-reconnects natively, which composes with
  snapshots-are-self-contained to give free crash/sleep recovery

WebSocket becomes worth it only if the iPad should *control* the console
(record toggle, pop-in). Interactions could also land later as plain HTTP POSTs
without changing transport.

## Security — LAN-only by default

Snapshots contain prompts, commands, file paths, and branch names. Posture:

- Feature **off by default**; toggle in plugin settings.
- Bind to the local interface; URL `http://<mac>.local:<port>/?token=<random>`,
  token minted per session and required on both the page and the SSE stream.
- Never bind publicly. For off-LAN viewing, **Tailscale** provides the same URL
  over an encrypted mesh with no exposed port.

## Options considered

| Option | Effort | Notes |
|---|---|---|
| **A. SSE server in the app; serve existing `ops.html` with a ~40-line shim replacing the `electronAPI` bridge** | ~1 day | Recommended. Reuses everything; a future board redesign is inherited for free since it's the same `opsview` module |
| B. Standalone daemon reading transcripts itself | days | Duplicates `OpsService`; only justified if the monitor must outlive the app |
| C. Native iPad app | weeks | Nothing a web page can't do here; Add-to-Home-Screen gives full-screen standalone, Safari handles this DOM load trivially |
| D. Cloud-relayed page | — | Rejected: routes private activity through a third party to reach a device on the same desk |

## Implementation sketch (when built)

1. `src/plugins/ops-console/main/net-server.ts`: Node `http` server —
   `GET /` serves the built `ops.html` + assets, `GET /stream?token=` is the SSE
   endpoint. Client set with add/remove; refcount keeps the producer alive.
2. `toSurface()` additionally writes each snapshot/verify frame to all SSE
   clients (`data: <json>\n\n`).
3. Web entry (`ops-net.ts`): identical to `ops-window.ts` but subscribes via
   `EventSource` instead of `electronAPI`, passes no-op interaction handlers,
   adds `<meta name="viewport">` and (Safari ≥16.4) a screen wake-lock request.
4. Settings: `networkMonitor` toggle + port; menu item showing the tokened URL
   (and a QR code, ideally) for pairing.

## Related

- `docs/activity-console-signal-inventory.md` — what feeds the snapshots.
- The 2026-07-25 lane study (four candidate column systems replayed against
  2,700 real events) found the turn-unit board fullest; a remote viewer is just
  another `OpsSnapshot` consumer and inherits whichever board ships.
