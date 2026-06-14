import { useEffect, useRef } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { sendToTerminal, hasTerminal } from '../components/TerminalPane'

// The shell command run in a worker pane to stream the live delegation feed (decisions,
// delegations, worker I/O, results, and the session-start heartbeat all land here).
const FEED_CMD =
  'clear; mkdir -p ~/.quadclaude && touch ~/.quadclaude/delegation.log && tail -F ~/.quadclaude/delegation.log\n'

// Kept for the App import compatibility (the per-event approval prompt was replaced by
// toggle-driven auto-surfacing, so this is always inactive now).
export interface PendingApproval {
  orchestratorId: number
  route: string
  projectName: string
}

// Surfaces delegation reliably: while delegation mode is ON, ensure exactly one worker
// pane is tailing the live feed — independent of per-event timing (the old prompt could
// miss events that predated the app launch). The toggle is the consent. When delegation
// is turned OFF, the feed is torn down.
export function useDelegation() {
  const autoCreatedRef = useRef<Set<number>>(new Set()) // worker panes WE opened (close on teardown)
  const feedRunningRef = useRef<Set<number>>(new Set()) // workers already tailing (don't re-clear)
  const busyRef = useRef(false)

  const startFeed = (workerId: number) => {
    if (feedRunningRef.current.has(workerId)) return
    let tries = 0
    const tick = () => {
      if (hasTerminal(workerId)) {
        sendToTerminal(workerId, FEED_CMD)
        feedRunningRef.current.add(workerId)
        return
      }
      if (tries++ < 40) setTimeout(tick, 250) // retry until the pane's xterm mounts (~10s)
    }
    tick()
  }

  const currentWorker = () => {
    const store = useWorkspaceStore.getState()
    return store.panes.find((p) => p.pairId && p.pairRole === 'worker')
  }

  // Ensure a worker feed exists while delegation is enabled.
  const ensureFeed = () => {
    if (busyRef.current) return
    const store = useWorkspaceStore.getState()
    if (!store.preferences.delegation?.enabled) return
    const worker = currentWorker()
    if (worker) {
      startFeed(worker.id) // make sure it's actually tailing
      return
    }
    busyRef.current = true
    try {
      const orchestratorId = store.activePaneId
      const idle = store.panes.find((p) => p.id !== orchestratorId && p.state === 'shell' && !p.pairId)
      let workerId = idle?.id ?? null
      if (workerId == null) {
        workerId = store.addPane()
        if (workerId != null) autoCreatedRef.current.add(workerId)
      }
      if (workerId == null) return // workspace full
      store.pairPanes(orchestratorId, workerId)
      startFeed(workerId)
    } finally {
      busyRef.current = false
    }
  }

  const teardownFeed = () => {
    const store = useWorkspaceStore.getState()
    const worker = currentWorker()
    if (!worker) return
    feedRunningRef.current.delete(worker.id)
    if (hasTerminal(worker.id)) sendToTerminal(worker.id, '\x03') // stop the tail
    store.unpairPane(worker.id)
    if (autoCreatedRef.current.has(worker.id)) {
      autoCreatedRef.current.delete(worker.id)
      const removed = store.removePane(worker.id)
      if (removed != null) window.electronAPI.killPty(removed)
    }
  }

  // React to the toggle (and keep the feed alive if its pane is closed).
  useEffect(() => {
    ensureFeed()
    let prevEnabled = useWorkspaceStore.getState().preferences.delegation?.enabled
    const unsub = useWorkspaceStore.subscribe((state) => {
      const en = !!state.preferences.delegation?.enabled
      if (en) ensureFeed()
      else if (prevEnabled) teardownFeed()
      prevEnabled = en
    })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Belt-and-suspenders: a delegation/decision event also guarantees the feed is up.
  useEffect(() => window.electronAPI.onDelegationEvent(() => ensureFeed()), [])

  // Approval prompt is retired (toggle drives surfacing); keep the shape App imports.
  return { pending: null as PendingApproval | null, approve: () => {}, decline: () => {} }
}
