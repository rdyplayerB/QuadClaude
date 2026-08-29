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
      },
      // The shared type scale (see index.css). Prefer these over text-[Npx]
      // or Tailwind's default text-xs/sm — those are what drifted apart.
      // Line heights ride along so vertical rhythm scales with the zoom too.
      fontSize: {
        meta: ['var(--fs-meta)', { lineHeight: '1.35' }],
        body: ['var(--fs-body)', { lineHeight: '1.45' }],
        heading: ['var(--fs-heading)', { lineHeight: '1.3' }],
        title: ['var(--fs-title)', { lineHeight: '1.25' }],
        display: ['var(--fs-display)', { lineHeight: '1.05' }],
        mono: ['var(--fs-mono)', { lineHeight: '1.4' }],
      },
      // Corner radius — the single source of truth for the whole app. Halved
      // from Tailwind's defaults for a tighter, more precise feel. Every
      // rounded-* class (and the console's --r/--rp, kept in sync) draws from
      // this one scale, so changing rounding anywhere is a one-line edit here.
      // rounded-full stays round (pills, dots, toggles).
      borderRadius: {
        sm: '1px',
        DEFAULT: '2px',   // rounded  (was 4px)
        md: '3px',        // rounded-md  (was 6px)
        lg: '4px',        // rounded-lg  (was 8px)
        xl: '6px',        // rounded-xl  (was 12px)
        '2xl': '8px',     // rounded-2xl (was 16px)
        '3xl': '12px',
      },
    },
  },
  plugins: [],
}
