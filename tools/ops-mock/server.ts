// Vite plugin: streams REAL OpsSnapshots to the design harness page.
//
// Both the service and the data source are loaded through Vite's SSR module
// graph, so editing src/plugins/ops-console/main/*.ts takes effect on the next
// page reload — no Electron rebuild, no restarting the user's app.

import type { Plugin, ViteDevServer } from 'vite'

const PANE_LIMIT = 4
const REDISCOVER_MS = 4000

export function opsMockPlugin(): Plugin {
  return {
    name: 'quadclaude:ops-mock',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/ops-stream', async (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        })

        let stopped = false
        let rediscover: ReturnType<typeof setInterval> | null = null
        let service: { stop(): void } | null = null

        try {
          // Fresh through the SSR graph on every connection: reload the page and
          // you are running whatever the files say right now.
          const src = await server.ssrLoadModule('/tools/ops-mock/live-source.ts')
          const svcMod = await server.ssrLoadModule('/src/plugins/ops-console/main/service.ts')

          let snapshot = src.buildWorkspaceSnapshot(PANE_LIMIT)
          rediscover = setInterval(() => {
            try { snapshot = src.buildWorkspaceSnapshot(PANE_LIMIT) } catch { /* keep last */ }
          }, REDISCOVER_MS)

          const ctx = src.makeMockContext(() => snapshot, { pollIntervalMs: 1000 })
          const svc = new svcMod.OpsService(ctx)
          service = svc
          svc.start((snap: unknown) => {
            if (stopped) return
            res.write(`data: ${JSON.stringify(snap)}\n\n`)
          })
        } catch (e) {
          res.write(`event: fail\ndata: ${JSON.stringify(String(e))}\n\n`)
        }

        const shutdown = () => {
          if (stopped) return
          stopped = true
          if (rediscover) clearInterval(rediscover)
          try { service?.stop() } catch { /* already down */ }
          res.end()
        }
        req.on('close', shutdown)
        req.on('error', shutdown)
      })
    },
  }
}
