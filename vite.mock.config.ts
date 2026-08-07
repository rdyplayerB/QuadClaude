// Design harness for the Activity Console: `npm run mock:console`.
//
// Deliberately separate from vite.config.ts — that one launches Electron. This
// serves the console alone, in a browser, fed by real session data, so its
// layout can be iterated without rebuilding or quitting a running QuadClaude.

import { defineConfig } from 'vite'
import { resolve } from 'path'
import { opsMockPlugin } from './tools/ops-mock/server'

export default defineConfig({
  plugins: [opsMockPlugin()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
      // Same load-bearing alias as vite.config.ts: the beta canvas addon ships a
      // package.json pointing at a file that does not exist, and without this the
      // dependency scan fails before the server can serve anything.
      '@xterm/addon-canvas': resolve(
        __dirname,
        'node_modules/@xterm/addon-canvas/lib/xterm-addon-canvas.mjs'
      ),
    },
  },
  // Scan only the harness page. Left to itself Vite also scans the app's
  // index.html/ops.html and drags the whole terminal stack in for no reason.
  optimizeDeps: { entries: ['tools/ops-mock/index.html'] },
  server: {
    port: 5183,
    strictPort: true,
    open: '/tools/ops-mock/index.html',
  },
})
