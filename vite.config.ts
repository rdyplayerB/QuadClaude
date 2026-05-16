import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import electronRenderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/index.ts',
        vite: {
          build: {
            outDir: 'dist/main',
            rollupOptions: {
              external: ['electron', 'node-pty', 'electron-store', 'electron-liquid-glass']
            }
          }
        }
      },
      {
        entry: 'src/main/preload.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          build: {
            outDir: 'dist/main',
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      }
    ]),
    electronRenderer()
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
      // @xterm/addon-canvas@0.8.0-beta.48 ships a broken package.json whose
      // "module" points at lib/addon-canvas.mjs, but the real file is
      // lib/xterm-addon-canvas.mjs. Alias straight to the file that exists.
      '@xterm/addon-canvas': resolve(
        __dirname,
        'node_modules/@xterm/addon-canvas/lib/xterm-addon-canvas.mjs'
      )
    }
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true
  }
})
