import { useEffect, useRef, useState } from 'react'
import { createOpsView } from '../../plugins/ops-console/opsview'
import { useWorkspaceStore } from '../store/workspace'
import { DEFAULT_BACKGROUND } from '../../shared/types'

// In-app host for the Activity Console. Renders the console NATIVELY in this
// window's renderer process via a Shadow DOM (full style isolation, no iframe →
// no extra process, single-digit MB). The plugin toggles visibility over IPC.
// Nothing is rendered/subscribed while hidden, so it costs nothing when closed.
//
// The console sits on the SAME ground as the terminal panes — the user's
// wallpaper + the same opacity overlay — so it reads as part of QuadClaude, not
// a separate app. The Shadow-DOM panels are translucent glass layered on top.
// Console zoom, persisted like the dashboard's. Same 0.8–1.8 range and 0.1
// step so the two surfaces feel identical to operate.
const OPS_SCALE_KEY = 'qc-ops-scale'
export const clampOpsScale = (n: number) => Math.min(1.8, Math.max(0.8, Math.round(n * 10) / 10))
export const readOpsScale = () => {
  const v = Number(localStorage.getItem(OPS_SCALE_KEY))
  return v >= 0.8 && v <= 1.8 ? v : 1
}

export function OpsOverlay() {
  const [show, setShow] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const background = useWorkspaceStore((s) => s.preferences.background) ?? DEFAULT_BACKGROUND
  const [scale, setScale] = useState(readOpsScale)
  // The view is imperative (shadow DOM), so keep a handle to push Cmd +/−
  // changes into its readout.
  const viewRef = useRef<{ setScale?: (n: number) => void } | null>(null)

  useEffect(() => {
    const unsub = window.electronAPI.onOpsInappShow?.((v: boolean) => setShow(v))
    return () => { if (unsub) unsub() }
  }, [])

  // Cmd +/− while the console is open: App dispatches here rather than to the
  // terminals (see App.tsx's font handlers).
  useEffect(() => {
    if (!show) return
    const onZoom = (e: Event) => {
      const step = (e as CustomEvent<number>).detail
      setScale((s) => {
        const next = step === 0 ? 1 : clampOpsScale(s + step)
        viewRef.current?.setScale?.(next)
        return next
      })
    }
    window.addEventListener('qc-ops-zoom', onZoom)
    return () => window.removeEventListener('qc-ops-zoom', onZoom)
  }, [show])

  useEffect(() => { localStorage.setItem(OPS_SCALE_KEY, String(scale)) }, [scale])

  useEffect(() => {
    if (!show || !hostRef.current) return
    const shadow = hostRef.current.shadowRoot ?? hostRef.current.attachShadow({ mode: 'open' })
    const view = createOpsView(shadow, {
      onMove: (m: unknown) => window.electronAPI.opsReportMove?.(m),
      onRecord: (on: boolean) => window.electronAPI.opsSetRecord?.(on),
      onClose: () => { setShow(false); window.electronAPI.opsClose?.() },
      initialScale: readOpsScale(),
      onScale: (n: number) => setScale(clampOpsScale(n)),
    })
    viewRef.current = view
    const u1 = window.electronAPI.onOpsInappSnapshot?.((s: unknown) => view.update(s))
    const u2 = window.electronAPI.onOpsInappVerify?.((o: unknown) => view.setVerify(o))
    return () => { if (u1) u1(); if (u2) u2(); viewRef.current = null; view.destroy() }
  }, [show])

  if (!show) return null

  const wallpaperOn = background.enabled && !!background.image
  const img = wallpaperOn
    ? (background.image!.startsWith('/') ? `file://${background.image}` : background.image!)
    : null

  return (
    <div
      className="fixed inset-0 z-[60]"
      style={
        img
          ? { backgroundImage: `url(${img})`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }
          : { background: '#0e1013' }
      }
    >
      {/* Same opacity overlay the panes use — dims the wallpaper for readability. */}
      {wallpaperOn && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundColor: `rgba(var(--terminal-bg-rgb), ${background.opacity})` }}
        />
      )}
      {/* Shadow-DOM host: transparent, so the wallpaper ground shows through
          its glass panels. `zoom` scales type and layout together, the same
          way the delegation dashboard scales. */}
      <div ref={hostRef} className="absolute inset-0" style={{ zoom: scale }} />
    </div>
  )
}
