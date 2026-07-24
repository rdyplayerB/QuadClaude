import { createPortal } from 'react-dom'
import { ReactNode, RefObject, useCallback, useEffect, useRef, useState } from 'react'

// Shared anchored-dropdown machinery. Four pane-header menus (Favorites, Fork,
// Live feed, Agent) each hand-rolled the same open-state + refs + click-outside
// + getBoundingClientRect positioning + createPortal panel — and only one of
// them (AgentBadge) clamped into the viewport, so the others could clip
// off-screen with panes near an edge. This centralizes all of it (with the
// clamp) so every menu behaves the same and a new one is a few lines.

export interface AnchoredMenu {
  open: boolean
  setOpen: (v: boolean) => void
  toggle: () => void
  close: () => void
  triggerRef: RefObject<HTMLButtonElement>
  panelRef: RefObject<HTMLDivElement>
  width: number
  position: () => { top: number; left: number }
}

export function useAnchoredMenu(opts: { width?: number; align?: 'left' | 'right'; gap?: number } = {}): AnchoredMenu {
  const { width = 220, align = 'right', gap = 4 } = opts
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on outside click (ignores the trigger + the panel itself).
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Anchor under the trigger; clamp into the viewport so a pane near either
  // edge never pushes the menu off-screen.
  const position = useCallback(() => {
    const el = triggerRef.current
    if (!el) return { top: 0, left: 0 }
    const r = el.getBoundingClientRect()
    const pad = 8
    const raw = align === 'right' ? r.right - width : r.left
    const left = Math.min(Math.max(pad, raw), window.innerWidth - width - pad)
    return { top: r.bottom + gap, left }
  }, [width, align, gap])

  return {
    open,
    setOpen,
    toggle: useCallback(() => setOpen((o) => !o), []),
    close: useCallback(() => setOpen(false), []),
    triggerRef,
    panelRef,
    width,
    position,
  }
}

// The glass dropdown panel, portaled to <body>. Children are the menu's rows.
export function PortalMenu({ menu, className = '', children }: { menu: AnchoredMenu; className?: string; children: ReactNode }) {
  if (!menu.open) return null
  return createPortal(
    <div
      ref={menu.panelRef}
      className={`fixed z-50 bg-[--ui-bg-elevated] border border-[--border] rounded-md shadow-lg overflow-hidden ${className}`}
      style={{ width: menu.width, ...menu.position() }}
    >
      {children}
    </div>,
    document.body,
  )
}
