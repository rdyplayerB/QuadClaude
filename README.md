# QuadClaude

A multi-terminal workspace for Claude Code - run 4 Claude sessions side by side with flexible layouts and a glass-effect UI.

## Features

- **4 Independent Terminals**: Run separate Claude sessions in each pane
- **3 Layout Modes**: Grid (2x2), Focus (1 large + 3 small), Focus-Right (3 small + 1 large)
- **Glass UI**: macOS Liquid Glass visual effects with dark-mode-only design
- **Prompt Library**: Save and recall frequently used prompts via a floating toolbar
- **Usage Tracking**: Real-time Claude API usage indicator in the title bar
- **Custom Wallpapers**: Set background wallpapers with adjustable opacity
- **Favorite Directories**: Star directories for quick access across terminals
- **Git Status Bar**: Shows branch name and ahead/behind counts on every terminal
- **Auto-Named Terminals**: Headers show folder/repo name automatically
- **Workspace Persistence**: Remembers your directories, layout, and preferences between sessions
- **Drag & Drop Reordering**: Rearrange terminal positions by dragging headers

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
| Grid | `Cmd+1` | 2x2 equal quadrants |
| Focus | `Cmd+2` | 1 large pane on left + 3 small on right |
| Focus-Right | `Cmd+3` | 3 small panes on left + 1 large on right |

**Tip**: Double-click any terminal header to toggle focus mode on that pane.

### Navigation

| Action | Shortcut |
|--------|----------|
| Focus Terminal 1-4 | `Cmd+Shift+1-4` |
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

- [Claude-Usage-Tracker](https://github.com/hamed-elfayome/Claude-Usage-Tracker) by [@hamed-elfayome](https://github.com/hamed-elfayome) - Inspiration for Claude Code statusline integration and usage tracking approach

## License

MIT
