# QuadClaude

**The Claude Code client for the ADHD brain.** Run up to 12 Claude sessions side by side in one glass window — because an agent you can't see is an agent you forgot about. A dozen sessions, zero impulse control.

[![Latest release](https://img.shields.io/github/v/release/rdyplayerB/QuadClaude)](https://github.com/rdyplayerB/QuadClaude/releases)
![Platform](https://img.shields.io/badge/platform-macOS-blue)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL%20v3-blue)](LICENSE)

![QuadClaude running four Claude Code sessions in a 2×2 grid](docs/screenshot.png)

<sub>Real app screenshot — the four panes show demo projects with simulated session output.</sub>

## Why QuadClaude

Claude Code made it easy to run five agents at once. Your terminal made it easy to forget four of them exist.

QuadClaude is built around one rule: **out of sight is out of mind.** Nothing lives in a tab, nothing hides behind another window — every session stays on screen with its state readable at a glance.

- **Everything visible, always.** Agents don't get buried. The grid is the whole app.
- **One glance, total state.** Every pane shows its repo, branch, ahead/behind counts, and whether Claude is working or waiting on you.
- **Interrupt-proof.** Wander off mid-task and the grid shows exactly where you left things when you come back. Quit the app and the whole workspace restores itself.
- **Hyperfocus on tap.** Focus layouts make one pane huge while the rest stay in the corner of your eye. Double-click a header to dive in, double-click to surface.

## Features

- **4–12 Independent Terminals**: Run separate Claude sessions in each pane; add or close extra panes beyond the core four (up to 12)
- **Run Any Model as Claude Code**: Drive the *real* Claude Code TUI with any non-Anthropic model (OpenRouter, DeepSeek, any OpenAI-compatible API) — identical look, identical behavior (applies edits instead of dumping code). Add it from a one-screen wizard.
- **Delegation**: Let your main Claude hand bulk/mechanical work to a cheaper configured model via a generated `qcdelegate` command — the worker applies edits and you watch it live in a feed pane.
- **Custom Agents (Bring Your Own Model)**: Launch any CLI agent (Claude Code, opencode, aider, …) against your own OpenAI-compatible endpoint — one agent per pane, chosen from the model badge
- **Pane Pairing**: Link two panes as an orchestrator ⇄ worker team (e.g. Claude plans, a local model grinds) with a shared-color ring and role chips
- **3 Layout Modes**: Grid (auto-balanced), Focus (1 large + rest small), Focus-Right (rest small + 1 large)
- **Glass UI**: macOS Liquid Glass visual effects with dark-mode-only design
- **Prompt Library**: Save and recall frequently used prompts via a floating toolbar
- **Usage Tracking**: Real-time Claude API usage indicator in the title bar
- **Custom Wallpapers**: Set background wallpapers with adjustable opacity
- **Favorite Directories**: Star directories for quick access across terminals
- **Git Status Bar**: Shows branch name and ahead/behind counts on every terminal
- **Auto-Named Terminals**: Headers show folder/repo name automatically
- **Workspace Persistence**: Remembers your directories, layout, and preferences between sessions
- **Drag & Drop Reordering**: Rearrange terminal positions by dragging headers

## Run Any Model as Claude Code

Want a non-Claude model that still *looks and behaves 100% like Claude Code* — same `⏺` tool bullets, same diffs, same todo lists, and crucially the same behavior (it **applies edits** and gives a tight summary instead of dumping walls of code)? QuadClaude can run the **genuine `claude` CLI** against any hosted model.

It works because the look/feel comes from Claude Code itself, not from QuadClaude. So instead of restyling another tool's output, QuadClaude runs the real client and routes its API calls to your model through [claude-code-router](https://github.com/musistudio/claude-code-router):

```
pane → real `claude` TUI → claude-code-router (local) → your hosted API (OpenRouter / DeepSeek / …)
```

**Setup (one screen):**

1. Install the router once, in any pane: `npm install -g @musistudio/claude-code-router`
2. Open **Settings → Run any model as Claude Code → Add a model**.
3. Pick a provider preset (OpenRouter, DeepSeek, OpenAI-compatible, or Custom), paste your **base URL**, **API key**, and **model id**, give it a name, and hit **Test connection** → **Save model**.
4. A new **“Claude Code · <your model>”** agent appears. Pick it on any pane from the model badge — that pane is now Claude Code, powered by your model.

Add as many models as you like and run them in different panes simultaneously. Your API key is written only to claude-code-router's local config (`~/.claude-code-router/config.json`, `chmod 600`) — never to the cloud, never echoed into shell history.

> **How close to 100%?** The TUI is *literally* Claude Code, so it's indistinguishable visually. The only real tells are the model's own intelligence/speed and the occasional self-identity slip (a model saying "I'm Qwen"). Everything QuadClaude controls is identical.

### Delegation: offload bulk work to a cheaper model

Once you've added a model, you can use it as a **delegation worker** — let your main Claude (the orchestrator) hand off grunt work (boilerplate, repetitive edits, scaffolding) to a cheaper model from the command line, saving your budget for planning and review.

In **Settings → Models → Delegation**, pick which configured model handles delegation. QuadClaude writes a `qcdelegate` command to `~/.local/bin` that runs the real `claude -p` through the router against that model — it **applies edits** in the current directory and returns a tight summary (instead of dumping code). Nothing is hardcoded; it targets whatever model you chose.

Then:
- **Copy orchestrator instructions** — paste the snippet into your orchestrator's `~/.claude/CLAUDE.md` so it knows when and how to call `qcdelegate "<task>"`.
- **Add Delegation Feed pane** — a one-click pane that tails `~/.quadclaude/delegation.log` so you can watch the worker live.

Your orchestrator then runs `qcdelegate "rename foo to bar across these files"`; the worker model does the edits, and you review the diff. Switch the delegation model anytime — the command repoints without reinstalling.

## Bring Your Own Model (Custom Agents)

> The section above is the turnkey path. This one is the **raw launcher** — use it when you'd rather run a tool's own UI (opencode, aider) instead of the Claude Code TUI.

Each pane can launch any CLI coding agent — not just Claude Code — so you can mix Claude with a local or self-hosted model and run them side by side. QuadClaude is a **pure launcher**: it runs a command with a set of env vars in a terminal and never speaks any API itself, so it works with any tool and any provider.

Add an agent in **Settings → Agents → Add agent**. A profile is just a **name**, a **command**, and an optional set of **environment variables**. Pick a preset (opencode / aider) or **Other** for anything else. The model badge in each pane header shows and switches the agent; the default agent is used for new panes.

Tools configure themselves in one of two ways — the presets reflect both:

- **Env-driven tools (e.g. aider)** — set the variables right in the profile:
  - `OPENAI_API_BASE` = `http://your-host/v1`
  - `OPENAI_API_KEY` = your key (any placeholder like `ollama` for local models that don't check it)
- **Config-file tools (e.g. opencode)** — leave the env empty and configure the tool itself. For opencode, edit `~/.config/opencode/opencode.json`:

  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "provider": {
      "my-local": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "My Local Model",
        "options": { "baseURL": "http://your-host/v1", "apiKey": "ollama" },
        "models": { "your-model-id": { "name": "Your Model" } }
      }
    }
  }
  ```

API keys set in a profile are injected into the agent's shell at launch and never echoed into shell history.

> **Reaching a self-hosted endpoint.** Your tool runs on *your* machine, so the endpoint must be reachable from it. Local models (`http://localhost:11434/v1` for Ollama) just work. For a remote/self-hosted box, make sure the URL resolves and isn't gated behind browser SSO — a private VPN (e.g. Tailscale, or an Olares LarePass VPN to an internal entrance) is the cleanest way. Quick check: `curl http://your-host/v1/models` should return a JSON model list (HTTP 200), not a redirect.

## Installation

### Prerequisites

- Node.js 18+
- npm or yarn
- macOS (Liquid Glass requires macOS)
- Claude CLI installed and authenticated (`claude` command available)

### From Release

Download the latest `.dmg` from the [Releases](https://github.com/rdyplayerB/QuadClaude/releases) page.

### Development

```bash
# Clone the repository
git clone https://github.com/rdyplayerB/QuadClaude.git
cd QuadClaude

# Install dependencies
npm install

# Start development server
npm run electron:dev
```

### Build

```bash
# Build for production
npm run build
```

The packaged app will be in the `release` directory.

## Usage

### Layouts

| Layout | Shortcut | Description |
|--------|----------|-------------|
| Grid | `Cmd+1` | Auto-balanced grid — 2×2 with four panes, up to 4×3 with twelve |
| Focus | `Cmd+2` | 1 large pane on left + the rest small on the right |
| Focus-Right | `Cmd+3` | Small panes on left + 1 large on the right |

**Tip**: Double-click any terminal header to toggle focus mode on that pane.

### Navigation

| Action | Shortcut |
|--------|----------|
| Focus Terminal 1–9 | `Ctrl+1-9` (1–4 rebindable in Settings; 5–9 fixed) |
| Clear Current Terminal | `Cmd+K` |
| Increase Font | `Cmd++` |
| Decrease Font | `Cmd+-` |

### Terminal Lifecycle

1. Each pane starts as a standard shell (bash/zsh)
2. Navigate to your project directory with `cd`
3. Run `claude` to start a Claude session
4. When Claude exits, the pane returns to a shell in the same directory

### Prompt Library

Save frequently used prompts and inject them into any terminal with one click.

- Click the **+** button on the floating toolbar to create a prompt
- Click a saved prompt to inject its text into the active terminal
- Right-click a prompt to delete it

### Git Status Bar

Each terminal displays a compact status bar showing:
- Git branch name (when in a git repo)
- Commits ahead/behind remote

### Workspace Persistence

Your workspace state is automatically saved and restored:
- Terminal working directories
- Current layout mode
- Active pane selection
- Saved prompts and favorite directories
- Background/wallpaper settings

## Project Structure

```
src/
├── main/              # Electron main process
│   ├── index.ts       # App entry, window management, Liquid Glass
│   ├── pty.ts         # PTY process management + git status caching
│   ├── usage.ts       # Claude API usage polling
│   ├── preload.ts     # Preload script for IPC
│   └── workspace.ts   # State persistence
├── renderer/          # React UI
│   ├── App.tsx
│   ├── components/
│   │   ├── TerminalPane.tsx
│   │   ├── TerminalGrid.tsx
│   │   ├── PaneHeader.tsx
│   │   ├── PromptToolbar.tsx
│   │   ├── UsageIndicator.tsx
│   │   ├── FavoritesDropdown.tsx
│   │   ├── LayoutSelector.tsx
│   │   └── SettingsModal.tsx
│   ├── hooks/
│   ├── layouts/
│   └── store/
└── shared/            # Shared types
```

## Tech Stack

- Electron 41
- React 18 + TypeScript
- xterm.js + node-pty
- Zustand (state management)
- Tailwind CSS
- Vite
- electron-liquid-glass

## Acknowledgments

- [Claude-Usage-Tracker](https://github.com/hamed-elfayome/Claude-Usage-Tracker) by [@hamed-elfayome](https://github.com/hamed-elfayome) - the statusline script is adapted from this project; powers Claude Code statusline integration and usage tracking
- [electron-liquid-glass](https://github.com/Meridius-Labs/electron-liquid-glass) by [Meridius Labs](https://github.com/Meridius-Labs) - macOS Liquid Glass window effects behind QuadClaude's glass UI

Built on [xterm.js](https://github.com/xtermjs/xterm.js), [node-pty](https://github.com/microsoft/node-pty), [Electron](https://www.electronjs.org/), [React](https://react.dev/), and [Zustand](https://github.com/pmndrs/zustand).

## License

QuadClaude — Copyright (C) 2026 rdyplayerB

Licensed under the [GNU AGPL v3.0](LICENSE) or later — if you run a modified version of QuadClaude over a network, you must make your source available to its users.

## Trademarks

QuadClaude is an independent, community project. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Anthropic" are trademarks of Anthropic PBC. QuadClaude uses the name only to describe its interoperability with Anthropic's Claude products.
