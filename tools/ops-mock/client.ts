// Harness page script: mounts the REAL console renderers and feeds them live
// snapshots over SSE. Two renderers share one stream so they can be compared
// on identical data — the lane board (createOpsView, exactly as the app mounts
// it, into a Shadow DOM host) and the timeline (createTimelineView).
// Editing either module hot-reloads through Vite.

import '../../src/renderer/index.css'
import { createOpsView } from '../../src/plugins/ops-console/opsview'
import { createTimelineView } from '../../src/plugins/ops-console/timeline'

const host = document.getElementById('host') as HTMLElement
const statusEl = document.getElementById('status') as HTMLElement
const toggle = document.getElementById('toggle') as HTMLButtonElement

type View = { update(s: unknown): void; destroy(): void }

const VIEW_KEY = 'qc-harness-view'
let mode = (new URLSearchParams(location.search).get('view')
  || localStorage.getItem(VIEW_KEY)
  || 'timeline') as 'timeline' | 'board'

let view: View | null = null
let last: unknown = null

function mount() {
  if (view) view.destroy()
  host.innerHTML = ''
  if (mode === 'board') {
    // The board renders into a ShadowRoot, same as OpsOverlay does in the app.
    const shell = document.createElement('div')
    shell.style.cssText = 'width:100%;height:100%'
    host.appendChild(shell)
    const shadow = shell.attachShadow({ mode: 'open' })
    view = createOpsView(shadow, {
      onMove: () => {}, onRecord: () => {}, onClose: () => {}, onPopOut: () => {},
      initialScale: 1, onScale: () => {},
    }) as View
  } else {
    view = createTimelineView(host, {}) as View
  }
  toggle.textContent = mode === 'board' ? 'view: board →' : 'view: timeline →'
  localStorage.setItem(VIEW_KEY, mode)
  // Repaint immediately from the last frame so switching never shows an empty
  // surface waiting on the next tick.
  if (last) view.update(last)
}

toggle.addEventListener('click', () => {
  mode = mode === 'board' ? 'timeline' : 'board'
  mount()
})
// Same flip from the keyboard, for recording without a cursor in the frame.
window.addEventListener('keydown', (e) => {
  if (e.key === 'v' && !e.metaKey && !e.ctrlKey) { mode = mode === 'board' ? 'timeline' : 'board'; mount() }
})

mount()

let frames = 0
const es = new EventSource('/ops-stream')

es.onmessage = (e) => {
  try {
    const snap = JSON.parse(e.data)
    last = snap
    view?.update(snap)
    frames++
    const active = snap.agents.filter((a: { state: string }) => a.state === 'active').length
    statusEl.textContent = `live · ${snap.paneCount} session${snap.paneCount === 1 ? '' : 's'} · ` +
      `${active} generating · ${snap.cards.length} cards · frame ${frames}`
    statusEl.className = 'ok'
  } catch (err) {
    statusEl.textContent = `render failed: ${String(err)}`
    statusEl.className = 'bad'
  }
}

es.addEventListener('fail', (e) => {
  statusEl.textContent = `stream failed: ${(e as MessageEvent).data}`
  statusEl.className = 'bad'
})

es.onerror = () => {
  statusEl.textContent = 'stream dropped — reconnecting…'
  statusEl.className = 'bad'
}

if (import.meta.hot) {
  import.meta.hot.accept(
    ['../../src/plugins/ops-console/opsview', '../../src/plugins/ops-console/timeline'],
    () => location.reload(),
  )
}
