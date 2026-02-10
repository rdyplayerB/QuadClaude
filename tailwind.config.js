/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/renderer/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: 'var(--terminal-bg)',
          fg: 'var(--terminal-fg)',
          border: 'var(--terminal-border)',
          active: 'var(--claude-pink)',
          header: 'var(--terminal-header)',
          muted: 'var(--terminal-muted)',
        },
        claude: {
          pink: 'var(--claude-pink)',
          pinkMuted: 'var(--claude-pink-muted)',
        }
      },
      fontFamily: {
        mono: ['Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', 'monospace'],
      }
    },
  },
  plugins: [],
}
