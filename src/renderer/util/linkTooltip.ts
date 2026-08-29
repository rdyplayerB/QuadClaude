// Link target preview for terminal panes.
//
// xterm underlines a link on hover but never says where it goes, so clicking one
// was the only way to find out — and by then you'd already opened it. This shows
// the resolved target in a small floating label while the mouse is over the link,
// the way a word processor does.
//
// The element is parented to `terminal.element` and carries xterm's `xterm-hover`
// class, which is the documented contract for hover UI: it stops mouse events
// falling through and re-triggering the link underneath.

const tips = new Map<number, HTMLDivElement>()
// Pending "Copied" reverts, so a fast second copy doesn't get its label stolen
// by the first one's timer.
const copyTimers = new Map<number, ReturnType<typeof setTimeout>>()

// Gap between the pointer and the label, and the margin kept from the pane edge.
const CURSOR_GAP = 12
const EDGE_MARGIN = 4

function ensureTip(paneId: number, host: HTMLElement): HTMLDivElement {
  const existing = tips.get(paneId)
  // A pane that was torn down and rebuilt leaves a detached node behind; rebuild
  // rather than writing into an element that's no longer in the document.
  if (existing && existing.isConnected) return existing
  const tip = document.createElement('div')
  tip.className = 'xterm-hover qc-link-tip'
  tip.setAttribute('role', 'tooltip')
  host.appendChild(tip)
  tips.set(paneId, tip)
  return tip
}

/**
 * Show the link target near the pointer. `target` is what the click will
 * actually act on; `hint` describes the available actions.
 */
export function showLinkTip(
  paneId: number,
  hostEl: HTMLElement | undefined,
  event: MouseEvent,
  target: string,
  hint?: string,
): void {
  if (!hostEl) return
  const tip = ensureTip(paneId, hostEl)

  const pending = copyTimers.get(paneId)
  if (pending) {
    clearTimeout(pending)
    copyTimers.delete(paneId)
  }

  tip.replaceChildren()
  const targetEl = document.createElement('span')
  targetEl.className = 'qc-link-tip-target'
  targetEl.textContent = target
  tip.appendChild(targetEl)
  if (hint) {
    const hintEl = document.createElement('span')
    hintEl.className = 'qc-link-tip-hint'
    hintEl.textContent = hint
    tip.appendChild(hintEl)
  }

  position(tip, hostEl, event)
}

// Measure first (hidden but laid out), then place: the label sits above the
// pointer, flipping below when it would clear the top of the pane, and is
// clamped so a long URL near an edge stays fully inside the pane.
function position(tip: HTMLDivElement, hostEl: HTMLElement, event: MouseEvent): void {
  const rect = hostEl.getBoundingClientRect()
  tip.style.visibility = 'hidden'
  tip.style.display = 'block'

  const x = event.clientX - rect.left
  const y = event.clientY - rect.top

  let top = y - tip.offsetHeight - CURSOR_GAP
  if (top < EDGE_MARGIN) top = y + CURSOR_GAP + 6
  const maxLeft = rect.width - tip.offsetWidth - EDGE_MARGIN
  const left = Math.max(EDGE_MARGIN, Math.min(x + CURSOR_GAP, maxLeft))

  tip.style.left = `${left}px`
  tip.style.top = `${Math.max(EDGE_MARGIN, top)}px`
  tip.style.visibility = 'visible'
}

export function hideLinkTip(paneId: number): void {
  const tip = tips.get(paneId)
  if (tip) tip.style.display = 'none'
  const pending = copyTimers.get(paneId)
  if (pending) {
    clearTimeout(pending)
    copyTimers.delete(paneId)
  }
}

/**
 * Copy a link target and acknowledge it in place. The pointer is still over the
 * link at this point, so the label is already on screen — swapping its text is
 * the whole confirmation.
 */
export function copyLinkTarget(paneId: number, target: string): void {
  void navigator.clipboard.writeText(target).then(
    () => flash(paneId, 'Copied'),
    () => flash(paneId, "Couldn't copy"),
  )
}

function flash(paneId: number, message: string): void {
  const tip = tips.get(paneId)
  if (!tip || !tip.isConnected) return
  tip.replaceChildren()
  const el = document.createElement('span')
  el.className = 'qc-link-tip-hint'
  el.textContent = message
  tip.appendChild(el)
  const pending = copyTimers.get(paneId)
  if (pending) clearTimeout(pending)
  copyTimers.set(
    paneId,
    setTimeout(() => {
      hideLinkTip(paneId)
      copyTimers.delete(paneId)
    }, 900),
  )
}

/** Drop a pane's label on teardown, alongside the terminal's own disposal. */
export function disposeLinkTip(paneId: number): void {
  const pending = copyTimers.get(paneId)
  if (pending) clearTimeout(pending)
  copyTimers.delete(paneId)
  tips.get(paneId)?.remove()
  tips.delete(paneId)
}
