import { useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { sendToTerminal, hasTerminal } from '../components/TerminalPane'
import { DelegationEvent } from '../../shared/types'

// The shell command run in a worker pane to stream the live delegation feed.
const FEED_CMD =
  'clear; mkdir -p ~/.quadclaude && touch ~/.quadclaude/delegation.log && tail -F ~/.quadclaude/delegation.log\n'

export interface PendingApproval {
  orchestratorId: number
  route: string
  projectName: string
}

// Drives the delegation worker-window workflow:
//  • when delegation is enabled and Claude delegates for the FIRST time in a session,
//    ask once whether to show a live worker window (session-scoped, ephemeral);
//  • on approval, allocate a worker pane (reuse an idle one, else open a new one) and
//    stream the feed into it reliably (retrying until its terminal mounts);
//  • when that Claude session ends (the orchestrator pane returns to 'shell'), forget
//    the approval and tear the worker feed down so the next session re-asks.
export function useDelegation() {
  const [pending, setPending] = useState<PendingApproval | null>(null)
  // Per-orchestrator-pane decision for the CURRENT session. Ephemeral by design.
  const decisionRef = useRef<Map<number, 'yes' | 'no'>>(new Map())
  // Orchestrator -> worker pane id, but only for panes we OPENED for the feed (so we
  // can close them on teardown; reused panes are left as-is, just unpaired).
  const autoCreatedRef = useRef<Map<number, number>>(new Map())
  // Worker pane ids whose feed is already streaming — so repeat delegations don't
  // re-run the feed command and wipe the worker's scrollback every time.
  const feedRunningRef = useRef<Set<number>>(new Set())

  // Stream the feed into a worker pane, retrying until its xterm exists. This is the
  // fix for the old "worker window stays empty" bug: sendToTerminal silently no-ops
  // before the terminal mounts, so we poll briefly until it's ready.
  const startFeed = (workerId: number) => {
    if (feedRunningRef.current.has(workerId)) return // already streaming — don't re-clear
    let tries = 0
    const tick = () => {
      if (hasTerminal(workerId)) {
        sendToTerminal(workerId, FEED_CMD)
        feedRunningRef.current.add(workerId)
        return
      }
      if (tries++ < 40) setTimeout(tick, 250) // ~10s of retries while the pane mounts
    }
    tick()
  }

  // Pick the worker pane: an existing paired worker, else an idle unpaired shell, else
  // a freshly added pane (up to MAX_PANES). Returns null only when the workspace is full.
  const ensureWorker = (orchestratorId: number): number | null => {
    const store = useWorkspaceStore.getState()
    const orch = store.panes.find((p) => p.id === orchestratorId)
    if (orch?.pairId) {
      const existing = store.panes.find((p) => p.pairId === orch.pairId && p.pairRole === 'worker')
      if (existing) {
        startFeed(existing.id)
        return existing.id
      }
    }
    const idle = store.panes.find((p) => p.id !== orchestratorId && p.state === 'shell' && !p.pairId)
    if (idle) {
      store.pairPanes(orchestratorId, idle.id)
      startFeed(idle.id)
      return idle.id
    }
    const newId = store.addPane()
    if (newId == null) return null
    store.pairPanes(orchestratorId, newId)
    autoCreatedRef.current.set(orchestratorId, newId)
    startFeed(newId)
    return newId
  }

  const approve = () => {
    setPending((cur) => {
      if (cur) {
        decisionRef.current.set(cur.orchestratorId, 'yes')
        ensureWorker(cur.orchestratorId)
      }
      return null
    })
  }
  const decline = () => {
    setPending((cur) => {
      if (cur) decisionRef.current.set(cur.orchestratorId, 'no')
      return null
    })
  }

  // React to delegation events pushed from main.
  useEffect(() => {
    return window.electronAPI.onDelegationEvent((event: DelegationEvent) => {
      const store = useWorkspaceStore.getState()
      if (!store.preferences.delegation?.enabled) return
      const paneId = parseInt(event.pane, 10)
      if (Number.isNaN(paneId)) return
      if (!store.panes.some((p) => p.id === paneId)) return
      const decision = decisionRef.current.get(paneId)
      if (decision === 'no') return
      if (decision === 'yes') {
        ensureWorker(paneId)
        return
      }
      // First delegation this session for this pane → ask once (don't stack prompts).
      setPending((cur) => cur ?? {
        orchestratorId: paneId,
        route: event.route,
        projectName: event.project.split('/').pop() || event.project,
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Session boundary: when a tracked orchestrator pane goes back to 'shell' (Claude
  // exited), forget the approval and tear down its worker feed.
  useEffect(() => {
    return useWorkspaceStore.subscribe((state, prev) => {
      for (const id of Array.from(decisionRef.current.keys())) {
        const before = prev.panes.find((p) => p.id === id)?.state
        const now = state.panes.find((p) => p.id === id)?.state
        if (before && before !== 'shell' && now === 'shell') {
          teardown(id)
        }
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const teardown = (orchestratorId: number) => {
    const store = useWorkspaceStore.getState()
    decisionRef.current.delete(orchestratorId)
    setPending((cur) => (cur?.orchestratorId === orchestratorId ? null : cur))
    const orch = store.panes.find((p) => p.id === orchestratorId)
    const worker = orch?.pairId
      ? store.panes.find((p) => p.pairId === orch.pairId && p.pairRole === 'worker')
      : undefined
    const autoId = autoCreatedRef.current.get(orchestratorId)
    autoCreatedRef.current.delete(orchestratorId)
    if (!worker) return
    feedRunningRef.current.delete(worker.id)
    if (hasTerminal(worker.id)) sendToTerminal(worker.id, '\x03') // stop the tail
    store.unpairPane(orchestratorId)
    // Close panes we opened solely for the feed; leave reused panes as idle shells.
    if (autoId === worker.id) {
      const removed = store.removePane(worker.id)
      if (removed != null) window.electronAPI.killPty(removed)
    }
  }

  return { pending, approve, decline }
}
