# QuadClaude

A multi-terminal workspace for Claude - run 4 Claude sessions side by side with Zoom-like layouts.

## Features

- **4 Independent Terminals**: Run separate Claude sessions in each pane
- **5 Layout Modes**: Grid, Focus, Split, Horizontal Stack, Vertical Stack
- **Workspace Persistence**: Remembers your directories and layout between sessions
- **Cold/Warm Start**: Choose to auto-restore Claude sessions or start fresh
- **Keyboard Navigation**: Quick shortcuts to switch layouts and focus panes

## Installation

### Prerequisites

- Node.js 18+
- npm or yarn
- Claude CLI installed and authenticated

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
| Focus | `Cmd+2` | 1 large + 3 small panes |
| Split | `Cmd+3` | 2 side-by-side panes |
| Horizontal | `Cmd+4` | 4 columns |
| Vertical | `Cmd+5` | 4 rows |

### Navigation

| Action | Shortcut |
|--------|----------|
| Focus Terminal 1-4 | `Cmd+Shift+1-4` |
| Reset Current Pane | `Cmd+K` |
| Increase Font | `Cmd++` |
| Decrease Font | `Cmd+-` |

### Terminal Lifecycle

1. Each pane starts as a standard shell (bash/zsh)
2. Navigate to your project directory with `cd`
3. Run `claude` to start a Claude session
4. When Claude exits, the pane returns to a shell in the same directory

### Workspace Persistence

- **Cold Start** (default): Restores directories only; you start Claude manually
- **Warm Start**: Restores directories AND auto-runs Claude where it was active

## Development

### Project Structure

```
src/
├── main/           # Electron main process
│   ├── index.ts    # App entry, window management
│   ├── pty.ts      # PTY process management
│   ├── preload.ts  # Preload script for IPC
│   └── workspace.ts # State persistence
├── renderer/       # React UI
│   ├── App.tsx
│   ├── components/
│   ├── hooks/
│   ├── layouts/
│   └── store/
└── shared/         # Shared types
```

### Tech Stack

- Electron 28+
- React 18 + TypeScript
- xterm.js + node-pty
- Zustand (state management)
- Tailwind CSS
- Vite

## License

MIT
