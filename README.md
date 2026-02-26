# QuadClaude

A multi-terminal workspace for Claude Code - run 4 Claude sessions side by side with flexible layouts.

## Features

- **4 Independent Terminals**: Run separate Claude sessions in each pane
- **3 Layout Modes**: Grid (2x2), Focus (1 large + 3 small), Focus-Right (3 small + 1 large)
- **Conversation History**: Automatically tracks terminal I/O for git repositories
- **History Review Mode**: Full-screen view to browse past conversations by terminal/project
- **Auto-Named Terminals**: Headers show folder/repo name automatically
- **Always-Visible Status Bar**: Git branch, ahead/behind counts, and working directory on every terminal
- **Workspace Persistence**: Remembers your directories and layout between sessions
- **Drag & Drop Reordering**: Rearrange terminal positions by dragging headers

## Installation

### Prerequisites

- Node.js 18+
- npm or yarn
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

### Conversation History

QuadClaude automatically records terminal conversations for **git repositories only**.

- History is stored per-project using a unique project ID
- Each terminal's working directory determines which project history it belongs to
- Click the clock icon in a terminal header to enter History Review Mode
- Browse conversations by date, search across history, and switch between terminal histories

**Note**: History is not tracked for non-git directories (like your home folder).

### Status Bar

Each terminal displays a status bar showing:
- Current working directory path
- Git branch name (when in a git repo)
- Commits ahead/behind remote
- Number of uncommitted changes

### Workspace Persistence

Your workspace state is automatically saved and restored:
- Terminal working directories
- Current layout mode
- Active pane selection

## Project Structure

```
src/
├── main/              # Electron main process
│   ├── index.ts       # App entry, window management
│   ├── pty.ts         # PTY process management
│   ├── history.ts     # Conversation history tracking
│   ├── preload.ts     # Preload script for IPC
│   └── workspace.ts   # State persistence
├── renderer/          # React UI
│   ├── App.tsx
│   ├── components/
│   │   ├── TerminalPane.tsx
│   │   ├── TerminalGrid.tsx
│   │   ├── PaneHeader.tsx
│   │   ├── HistoryPanel.tsx
│   │   └── HistoryReviewView.tsx
│   ├── hooks/
│   ├── layouts/
│   └── store/
└── shared/            # Shared types
```

## Tech Stack

- Electron 28
- React 18 + TypeScript
- xterm.js + node-pty
- Zustand (state management)
- Tailwind CSS
- Vite

## License

MIT
