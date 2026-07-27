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
// The shared design tokens. This window does NOT load the app bundle, so
// without this the console's `var(--fs-*)` / `var(--text-*)` lookups would all
// be undefined here and the popped-out console would render at browser-default
// type — visibly different from the in-app one.
import './tokens.css'
import { createOpsView } from '../plugins/ops-console/opsview'

// Paint the same ground the in-app overlay uses: the user's wallpaper, dimmed by
// their opacity setting. Without this the popped-out window is a flat dark slab
// while the in-app console shows the wallpaper through its glass panels — the
// console looks like a different app depending on where it's hosted.
async function applyWallpaperGround() {
  try {
    const ws = await window.electronAPI?.loadWorkspace?.()
    const bg = ws?.preferences?.background
    const ground = ws?.preferences?.groundOpacity ?? 1
    const root = document.documentElement
    const body = document.body

    // Popped out, this window gets the SAME transparency as the main one — main
    // already created it with transparent:true when the ground is cleared, so
    // everything here has to stay see-through for that to mean anything.
    root.style.setProperty('--ground-opacity', String(ground))
    root.style.borderRadius = '12px'
    body.style.background = ground > 0 ? `rgba(26, 26, 28, ${0.86 * ground})` : 'transparent'

    // The wallpaper is handed to the console's panels as one shared,
    // viewport-anchored canvas (same as in-app and same as the terminal grid),
    // NOT painted full-bleed behind everything — that is what keeps the gaps
    // between panels clear instead of turning the window into a solid slab.
    const host = document.getElementById('ops')
    const wallpaperOn = !!(bg?.enabled && bg.image)
    const url = wallpaperOn
      ? (bg!.image!.startsWith('/') ? `file://${bg!.image}` : bg!.image!)
      : null
    if (host) {
      host.style.setProperty('--ops-wallpaper', url ? `url(${url})` : 'none')
      host.style.setProperty(
        '--ops-tint',
        wallpaperOn
          ? `rgba(30, 30, 30, ${bg!.opacity ?? 0.85})`
          : `rgba(40, 40, 42, ${0.72 * Math.max(0.75, ground)})`,
      )
    }
  } catch { /* no wallpaper — the flat ground is a fine fallback */ }
}
applyWallpaperGround()

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
