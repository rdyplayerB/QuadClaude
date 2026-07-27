import { useEffect, useCallback, useState, useRef } from 'react'
import { TerminalGrid } from './components/TerminalGrid'
import { SettingsModal } from './components/SettingsModal'
import { DelegationDashboard } from './components/DelegationDashboard'
import { PromptToolbar } from './components/PromptToolbar'
import { LayoutSelector } from './components/LayoutSelector'
import { clearTerminal, sendToTerminal, focusTerminal, scrollAllTerminalsToBottom, disposeAllTerminals, dumpPaneDiagnostics, checkPaneHealth } from './components/TerminalPane'
import { getFolderName } from './components/PaneHeader'
import { OpsOverlay } from './components/OpsOverlay'
import { useWorkspaceStore } from './store/workspace'
import { useHotkeys } from './hooks/useHotkeys'
import { useUiScale, applyUiScale, readUiScale } from './uiScale'
import { readAppearance, applyAppearance, DEFAULT_TINT_ALPHA, DEFAULT_TINT_COLOR } from './appearance'
import { MenuAction, SavedPrompt, MAX_PANES } from '../shared/types'

// Toolbar "+" to add a pane — works in every layout (the in-grid ghost tile
// only appears when the grid has a blank cell). Hidden at the pane cap.
function AddPaneButton() {
  const count = useWorkspaceStore((s) => s.panes.length)
  const addPane = useWorkspaceStore((s) => s.addPane)
  if (count >= MAX_PANES) return null
  return (
    <button
      onClick={() => addPane()}
      className="flex items-center gap-1 px-2 py-1 text-[--ui-text-dimmed] hover:text-[--ui-text-primary] transition-colors titlebar-no-drag"
      title={`Add terminal (${count}/${MAX_PANES})`}
      aria-label="Add terminal"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M8 3v10M3 8h10" strokeLinecap="round" />
      </svg>
      <span className="text-body leading-none">Add</span>
    </button>
  )
}

function App() {
  // Atomic selectors: App is the root, so a whole-store subscription here
  // re-renders the entire tree on every pane git/state/cwd update during
  // streaming. Subscribe only to what App actually reacts to.
  const initialize = useWorkspaceStore((s) => s.initialize)
  const layout = useWorkspaceStore((s) => s.layout)
  const activePaneId = useWorkspaceStore((s) => s.activePaneId)
  const setActivePaneId = useWorkspaceStore((s) => s.setActivePaneId)
  const setFocusPaneId = useWorkspaceStore((s) => s.setFocusPaneId)

  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isDashboardOpen, setIsDashboardOpen] = useState(false)

  // Dashboard zoom: a font/layout scale for the delegation dashboard, controlled by the
  // SAME Cmd +/- that sizes terminals — but only while the dashboard is open (see the menu
  // handler below), so it never touches terminal font. Persisted across launches.
  const [dashScale, setDashScale] = useState(() => {
    const v = Number(localStorage.getItem('qc-dash-scale'))
    return v >= 0.8 && v <= 1.8 ? v : 1
  })
  useEffect(() => { localStorage.setItem('qc-dash-scale', String(dashScale)) }, [dashScale])
  const clampScale = (n: number) => Math.min(1.8, Math.max(0.8, Math.round(n * 10) / 10))
  // Read latest open-state inside the (stable) menu-action handler without re-subscribing.
  const isDashboardOpenRef = useRef(isDashboardOpen)
  useEffect(() => { isDashboardOpenRef.current = isDashboardOpen }, [isDashboardOpen])

  // Chrome zoom lives in uiScale.ts so Settings can drive the same value.
  // Mounting the hook applies any persisted scale on load.
  useUiScale()

  // Ground transparency, in two halves that have to move together:
  //   1. the CSS ground behind the panes (`.glass` in index.css), and
  //   2. the NATIVE liquid-glass material behind the entire window.
  // Clearing only (1) exposes (2), whose default `regular` material frosts and
  // brightens the desktop into a flat white sheet — which is exactly what a
  // "fully transparent" window used to look like. Main switches it to `clear`.
  // Appearance is defined in exactly one place (renderer/appearance.ts) and
  // published to the document root, where every surface — panes, the Activity
  // Console's Shadow DOM, and the popped-out console's separate document —
  // reads the same values. Main rebroadcasts them so other windows stay in
  // step live instead of only picking them up at launch.
  const groundOpacity = useWorkspaceStore((s) => s.preferences.groundOpacity ?? 1)
  const windowTint = useWorkspaceStore((s) => s.preferences.windowTint ?? DEFAULT_TINT_ALPHA)
  const windowTintColor = useWorkspaceStore((s) => s.preferences.windowTintColor ?? DEFAULT_TINT_COLOR)
  const prefsLoaded = useWorkspaceStore((s) => s.isInitialized)
  useEffect(() => {
    const appearance = readAppearance({ groundOpacity, windowTint, windowTintColor })
    applyAppearance(document.documentElement, appearance)
    // Wait for the saved preferences to land before telling main anything. The
    // store starts at the fully-opaque default, and pushing that would attach a
    // glass view that startup deliberately skipped — and can never be removed.
    if (prefsLoaded) window.electronAPI?.setAppearance?.(appearance)
  }, [groundOpacity, windowTint, windowTintColor, prefsLoaded])

  // Cmd +/− targets the frontmost surface. The Activity Console owns its own
  // scale (OpsOverlay), so App only needs to know whether it's showing.
  const isOpsOpenRef = useRef(false)
  useEffect(() => {
    const unsub = window.electronAPI.onOpsInappShow?.((v: boolean) => { isOpsOpenRef.current = v })
    return () => { if (unsub) unsub() }
  }, [])
  const zoomOps = (step: number) =>
    window.dispatchEvent(new CustomEvent('qc-ops-zoom', { detail: step }))

  // Handle prompt injection (no newline - just inject text)
  const handlePromptClick = useCallback((prompt: SavedPrompt) => {
    sendToTerminal(activePaneId, prompt.text)
    focusTerminal(activePaneId)
  }, [activePaneId])

  // Initialize workspace on mount
  useEffect(() => {
    initialize()
  }, [initialize])

  // Single shared poll for local servers across all panes (one lsof+ps in
  // main, not per-pane). Visibility-gated so it pauses when hidden.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (document.hidden) return
      try {
        const byPane = await window.electronAPI.detectServers()
        if (cancelled) return
        const store = useWorkspaceStore.getState()
        for (const pane of store.panes) {
          store.setPaneServers(pane.id, byPane[pane.id] ?? [])
        }
      } catch {
        // ignore - transient
      }
    }
    const startDelay = setTimeout(poll, 3000)
    const interval = setInterval(poll, 10000)
    return () => {
      cancelled = true
      clearTimeout(startDelay)
      clearInterval(interval)
    }
  }, [])


  // Prevent Electron from navigating when files are dropped outside a terminal pane
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault()
    document.addEventListener('dragover', prevent)
    document.addEventListener('drop', prevent)
    return () => {
      document.removeEventListener('dragover', prevent)
      document.removeEventListener('drop', prevent)
    }
  }, [])

  // Returning to the app (window focus) or the tab becoming visible can leave the active
  // pane's xterm without keyboard focus — it stays selectable but won't accept typing or
  // Ctrl-C. Re-focus the active terminal so panes stay usable after switching away and back.
  // Skip while a modal is open so we don't steal its focus.
  useEffect(() => {
    const refocus = () => {
      if (isSettingsOpen || isDashboardOpen || document.hidden) return
      requestAnimationFrame(() => focusTerminal(useWorkspaceStore.getState().activePaneId))
    }
    window.addEventListener('focus', refocus)
    document.addEventListener('visibilitychange', refocus)
    return () => {
      window.removeEventListener('focus', refocus)
      document.removeEventListener('visibilitychange', refocus)
    }
  }, [isSettingsOpen, isDashboardOpen])

  // Enable global hotkeys (disabled when settings modal is open)
  useHotkeys(!isSettingsOpen)

  // Shared logic for focusing a terminal (used by both menu actions and hotkeys)
  const handleTerminalFocus = useCallback(
    (paneId: number) => {
      if (layout === 'duo' || layout === 'solo') {
        // The pane may be hidden in the PiP strip — promote it onto the stage
        // (no-op past activating it if already visible).
        const store = useWorkspaceStore.getState()
        if (store.promotePane(paneId) === null) return
        requestAnimationFrame(() => requestAnimationFrame(() => focusTerminal(paneId)))
        return
      }

      setActivePaneId(paneId)

      if (layout === 'focus' || layout === 'focus-right') {
        setFocusPaneId(paneId)
      }

      focusTerminal(paneId)
    },
    [layout, setActivePaneId, setFocusPaneId]
  )

  // Listen for menu actions
  // Uses getState() inside handler to always read latest values, avoiding re-subscriptions
  useEffect(() => {
    const unsubscribe = window.electronAPI.onMenuAction((action: MenuAction) => {
      const store = useWorkspaceStore.getState()
      switch (action) {
        case 'layout-grid':
          store.setLayout('grid')
          break
        case 'layout-focus':
          store.setLayout('focus')
          break
        case 'layout-focus-right':
          store.setLayout('focus-right')
          break
        case 'layout-duo':
          store.setLayout('duo')
          break
        case 'layout-solo':
          store.setLayout('solo')
          break
        case 'toggle-pip':
          store.togglePipVisible()
          break
        case 'cycle-pane': {
          const promoted = store.cyclePane()
          if (promoted !== null) {
            requestAnimationFrame(() => requestAnimationFrame(() => focusTerminal(promoted)))
          }
          break
        }
        case 'focus-pane-1':
          handleTerminalFocus(0)
          break
        case 'focus-pane-2':
          handleTerminalFocus(1)
          break
        case 'focus-pane-3':
          handleTerminalFocus(2)
          break
        case 'focus-pane-4':
          handleTerminalFocus(3)
          break
        case 'clear-pane':
          clearTerminal(store.activePaneId)
          break
        case 'launch-claude':
          sendToTerminal(store.activePaneId, 'claude\n')
          break
        // Cmd +/− goes to the frontmost surface: Activity Console, else the
        // delegation dashboard, else the terminals. Whatever you're looking at
        // is what resizes, so the keys never act on something off-screen.
        case 'increase-font':
          if (isOpsOpenRef.current) zoomOps(+0.1)
          else if (isDashboardOpenRef.current) setDashScale((s) => clampScale(s + 0.1))
          else store.updatePreferences({ fontSize: Math.min(24, store.preferences.fontSize + 1) })
          break
        case 'decrease-font':
          if (isOpsOpenRef.current) zoomOps(-0.1)
          else if (isDashboardOpenRef.current) setDashScale((s) => clampScale(s - 0.1))
          else store.updatePreferences({ fontSize: Math.max(10, store.preferences.fontSize - 1) })
          break
        case 'increase-ui':
          applyUiScale(readUiScale() + 0.1)
          break
        case 'decrease-ui':
          applyUiScale(readUiScale() - 0.1)
          break
        case 'reset-ui':
          applyUiScale(1)
          break
        case 'open-settings':
          setIsSettingsOpen(true)
          break
        case 'toggle-prompt-bar':
          store.updatePreferences({ showPromptBar: store.preferences.showPromptBar === false })
          break
        case 'dump-diagnostics':
          dumpPaneDiagnostics()
          break
      }
    })

    return unsubscribe
  }, [handleTerminalFocus])

  // Push a compact live workspace snapshot to main for plugins that observe
  // pane state (e.g. the Activity Console). Pane states (claude-active/waiting)
  // live only in this store; main can't see them otherwise. STRICTLY GATED: the
  // store subscription only checks a boolean and returns unless a plugin with
  // the "read:workspace" capability is enabled — so with all such plugins off
  // (the default) this costs nothing beyond that boolean check.
  useEffect(() => {
    let observers = false      // any plugin observing pane state (→ snapshot push)
    let verifyOn = false       // Ops Console verification mode (→ emit transitions)
    let accountLabels: Record<string, string> = {}
    let timer: ReturnType<typeof setTimeout> | null = null
    let seq = 0
    const prevStates = new Map<number, string>()
    const push = () => {
      if (!observers) return
      const st = useWorkspaceStore.getState()
      const snap = {
        activePaneId: st.activePaneId,
        panes: st.panes.map((p, i) => {
          const parts = p.workingDirectory.split('/').filter(Boolean)
          return {
            id: p.id,
            pos: i,
            folder: getFolderName(p.workingDirectory),
            proj: parts.length >= 2 ? parts[parts.length - 2] : (parts[0] ?? ''),
            cwd: p.workingDirectory,
            state: p.state,
            account: p.claudeAccountId ? (accountLabels[p.claudeAccountId] ?? '@account') : '@login',
            model: 'Opus 4.8',
          }
        }),
      }
      window.electronAPI.pushWorkspaceSnapshot?.(snap)
    }
    // Runs on every store change. Cheap when off (early boolean returns).
    const onChange = () => {
      if (verifyOn) {
        // ground truth: emit a transition event the instant a pane state flips.
        // t0 = now (this fires synchronously after the store setState).
        const st = useWorkspaceStore.getState()
        for (const p of st.panes) {
          const prev = prevStates.get(p.id)
          if (prev !== undefined && prev !== p.state) {
            window.electronAPI.pushOpsTransition?.({ seq: ++seq, paneId: p.id, from: prev, to: p.state, t0: Date.now() })
          }
          prevStates.set(p.id, p.state)
        }
      }
      if (observers) { if (timer) clearTimeout(timer); timer = setTimeout(push, 400) }
    }
    const evalPlugins = (descriptors: Array<{ enabled: boolean; manifest: { capabilities?: string[] }; settings?: Record<string, unknown> }>) => {
      const ds = descriptors ?? []
      const nowObs = ds.some((d) => d.enabled && d.manifest.capabilities?.includes('read:workspace'))
      const nowVerify = ds.some((d) => d.enabled && !!d.settings?.verificationMode)
      const obsTurnedOn = nowObs && !observers
      if (nowVerify && !verifyOn) {
        // seed prevStates so we don't emit phantom transitions for existing states
        prevStates.clear()
        for (const p of useWorkspaceStore.getState().panes) prevStates.set(p.id, p.state)
      }
      observers = nowObs; verifyOn = nowVerify
      if (obsTurnedOn) {
        window.electronAPI.claudeAccountsList?.().then((accts: Array<{ id: string; label: string }>) => {
          accountLabels = Object.fromEntries((accts ?? []).map((a: { id: string; label: string }) => [a.id, '@' + a.label]))
          onChange()
        }).catch(() => onChange())
      }
    }
    window.electronAPI.listPlugins?.().then(evalPlugins).catch(() => {})
    const unsubPlugins = window.electronAPI.onPluginChanged?.(evalPlugins)
    const unsub = useWorkspaceStore.subscribe(onChange)
    return () => { if (timer) clearTimeout(timer); unsub(); if (unsubPlugins) unsubPlugins() }
  }, [])

  // Lightweight, anomaly-gated pane health sweep. Every 15s (skipped while the
  // window is hidden) it logs ONLY panes that are sized + have content but whose
  // canvas isn't painting — the blank-pane signature. Near-zero cost; a healthy
  // app logs nothing. This is what captures the intermittent blank-pane bug in
  // the wild without needing a repro.
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) checkPaneHealth()
    }, 15000)
    return () => clearInterval(id)
  }, [])

  // Scroll all terminals to bottom when system resumes from sleep
  useEffect(() => {
    const unsubscribe = window.electronAPI.onSystemResume(() => {
      // Small delay to ensure terminals are ready after resume
      setTimeout(() => {
        scrollAllTerminalsToBottom()
      }, 100)
    })

    return unsubscribe
  }, [])

  // Cleanup terminals on window close to prevent memory leaks
  useEffect(() => {
    const handleBeforeUnload = () => {
      disposeAllTerminals()
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])

  return (
    // The window's rounded corners came from the native glass view's
    // cornerRadius. A see-through window has no such view, so the shape has to
    // come from the content instead — same 12px, clipped by overflow-hidden.
    <div
      className="h-screen w-screen flex flex-col bg-transparent overflow-hidden relative font-mono"
      style={{ borderRadius: 12 }}
    >
      {/* Title bar - glass effect */}
      <div className="h-9 titlebar-drag-region border-b border-white/[0.06] flex items-center justify-between px-3 glass-header chrome-legible">
        {/* Left side - after traffic lights */}
        <div className="flex items-center gap-2 pl-[72px]">
          <span
            className="text-body font-medium text-[--ui-text-secondary]"
            title="QuadClaude — the ADHD workspace for Claude Code"
          >
            QuadClaude
          </span>
          <span className="text-[--ui-text-faint]">│</span>
          <span className="text-meta text-[--ui-text-secondary]">v1.31.13</span>
        </div>

        {/* Center - layout selector + add pane */}
        <div className="flex items-center gap-1">
          <LayoutSelector />
          <AddPaneButton />
        </div>

        {/* Right side - utility buttons (per-account usage now lives in each pane's status line) */}
        <div className="flex items-center gap-0.5">
          {/* Activity Console — live ops view of every pane */}
          <button
            onClick={async () => {
              await window.electronAPI.togglePlugin?.('ops-console', true)
              window.electronAPI.openPlugin?.('ops-console')
            }}
            className="px-1.5 py-1 text-[--ui-text-secondary] hover:text-[--accent] transition-colors titlebar-no-drag"
            title="Activity Console — live view of every pane (⌘⇧A)"
            aria-label="Open Activity Console"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 8h2.5l1.8-4.5 3 9 1.8-4.5H16" />
            </svg>
          </button>
          {/* Delegation dashboard */}
          <button
            onClick={() => setIsDashboardOpen(true)}
            className="px-1.5 py-1 text-[--ui-text-secondary] hover:text-[--ui-text-primary] transition-colors titlebar-no-drag"
            title="Delegation dashboard"
            aria-label="Open delegation dashboard"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 13.5V2.5M2 13.5h12" />
              <rect x="4" y="8" width="2.2" height="3.5" /><rect x="7.4" y="5.5" width="2.2" height="6" /><rect x="10.8" y="3" width="2.2" height="8.5" />
            </svg>
          </button>
          {/* Settings */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="px-1.5 py-1 text-[--ui-text-secondary] hover:text-[--ui-text-primary] transition-colors titlebar-no-drag"
            title="Settings (Cmd+,)"
            aria-label="Open settings"
          >
            <svg width="14" height="14" viewBox="0 0 18 18" fill="currentColor">
              <path d="M9 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/>
              <path fillRule="evenodd" d="M7.25 1a.75.75 0 0 0-.75.75v1.15a5.5 5.5 0 0 0-1.62.67l-.82-.82a.75.75 0 0 0-1.06 0L1.69 4.06a.75.75 0 0 0 0 1.06l.82.82A5.5 5.5 0 0 0 1.84 7.5H.75a.75.75 0 0 0-.75.75v2a.75.75 0 0 0 .75.75h1.1a5.5 5.5 0 0 0 .67 1.62l-.82.82a.75.75 0 0 0 0 1.06l1.36 1.36a.75.75 0 0 0 1.06 0l.82-.82a5.5 5.5 0 0 0 1.56.66v1.05a.75.75 0 0 0 .75.75h2a.75.75 0 0 0 .75-.75v-1.05a5.5 5.5 0 0 0 1.56-.66l.82.82a.75.75 0 0 0 1.06 0l1.36-1.36a.75.75 0 0 0 0-1.06l-.82-.82a5.5 5.5 0 0 0 .66-1.56h1.06a.75.75 0 0 0 .75-.75v-2a.75.75 0 0 0-.75-.75h-1.06a5.5 5.5 0 0 0-.66-1.56l.82-.82a.75.75 0 0 0 0-1.06l-1.36-1.36a.75.75 0 0 0-1.06 0l-.82.82a5.5 5.5 0 0 0-1.56-.66V1.75a.75.75 0 0 0-.75-.75h-2ZM9 12.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" clipRule="evenodd"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Prompt bookmarks bar */}
      <PromptToolbar onSelectPrompt={handlePromptClick} />

      {/* Main content area */}
      <div className="flex-1 overflow-hidden flex">
        {/* Terminal grid - always mounted to preserve terminal state */}
        <div className="overflow-hidden flex-1">
          <TerminalGrid />
        </div>
      </div>

      {/* Settings modal */}
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

      {/* Dedicated delegation dashboard */}
      <DelegationDashboard isOpen={isDashboardOpen} onClose={() => setIsDashboardOpen(false)} scale={dashScale} onScaleChange={(n) => setDashScale(clampScale(n))} />

      {/* Activity Console — in-app overlay (plugin, low-memory native render) */}
      <OpsOverlay />

    </div>
  )
}

export default App
