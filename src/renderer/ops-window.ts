// Entry point for the POPPED-OUT Activity Console window.
//
// Deliberately tiny: it mounts only the console view — no zustand store, no
// React, no TerminalPane. That matters for two reasons. First, this is a second
// renderer process, so every module it pulls in is paid for in RAM until the
// window is destroyed. Second, it structurally cannot attach to a PTY, so a
// popped-out console can never fight the main window over a terminal.
//
// The snapshot/verify stream is the same IPC the in-app overlay uses; main
// routes it to whichever surface is currently hosting the console.
import { createOpsView } from '../plugins/ops-console/opsview'

const host = document.getElementById('ops')
if (host) {
  const shadow = host.attachShadow({ mode: 'open' })
  try {
    const view = createOpsView(shadow, {
      popped: true,
      onMove: (m: unknown) => window.electronAPI?.opsReportMove?.(m),
      onRecord: (on: boolean) => window.electronAPI?.opsSetRecord?.(on),
      // Closing from the popped window closes the console outright.
      onClose: () => window.electronAPI?.opsClose?.(),
      // Hand the console back to the main window; main destroys this window.
      onPopIn: () => window.electronAPI?.opsPopIn?.(),
      initialScale: 1,
      onScale: () => {},
    })

    // A throw while rendering one frame must not kill the window — keep the
    // last good frame, same policy as the in-app overlay.
    window.electronAPI?.onOpsInappSnapshot?.((s: unknown) => {
      try { view.update(s) } catch (e) { console.warn('[ops] snapshot render failed', e) }
    })
    window.electronAPI?.onOpsInappVerify?.((o: unknown) => {
      try { view.setVerify(o) } catch (e) { console.warn('[ops] verify render failed', e) }
    })
    // Ask main to (re)start streaming now that this surface is listening.
    window.electronAPI?.opsRequestState?.()
  } catch (e) {
    console.error('[ops] failed to mount popped-out console', e)
  }
}
