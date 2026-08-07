import { DragEvent, memo, useCallback } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { PipCorner, PIP_VW } from '../../shared/types'
import { PANE_COLORS, getFolderName, PANE_DRAG_TYPE } from './PaneHeader'
import { focusTerminal } from './TerminalPane'

// The floating PiP strip shown in duo/solo layouts. This component draws ONLY
// the chrome: the strip frame, per-tile mini-headers, and the click/drag
// capture overlays. The tiles' terminal content is the real TerminalPane
// wrappers, absolutely positioned into the tile rects by TerminalGrid using
// the same geometry — this component never touches xterm.

// ---- Geometry ---------------------------------------------------------------

export const PIP_STRIP_W = 252
const HEADER_H = 24
const TILE_HEADER_H = 18
const GAP = 6
// Space between the header label and the first tile.
const HEADER_GAP = 6
// Inset from the container edge. Matches the grid's p-5 padding (GRID_PAD=20)
// so the strip's top-right corner sits flush with the on-stage window's
// top-right corner instead of overhanging it.
const MARGIN = 20
const TILE_MIN_H = 64
const TILE_MAX_H = 150

export interface PipTileRect {
  // Outer tile rect (mini-header + content), relative to the grid container.
  left: number
  top: number
  width: number
  height: number
  // Content rect: where the pane wrapper's VISUAL (scaled) box goes.
  contentLeft: number
  contentTop: number
  contentWidth: number
  contentHeight: number
  // The wrapper is laid out at virtualWidth×virtualHeight (real, unscaled
  // dimensions — so fits/PTY cols stay sane) and scaled down to the content
  // rect. offsetWidth ignores transforms, so fit paths never see 0×0.
  scale: number
  virtualWidth: number
  virtualHeight: number
}

export interface PipGeometry {
  strip: { left: number; top: number; width: number; height: number }
  tiles: PipTileRect[]
}

export function computePipGeometry(opts: {
  containerW: number
  containerH: number
  corner: PipCorner
  hiddenCount: number
  dragPos: { x: number; y: number } | null
}): PipGeometry {
  const { corner, hiddenCount, dragPos } = opts
  // Before the container is measured, lay out against a nominal size so hidden
  // panes still get real (nonzero) dimensions; the ResizeObserver in
  // TerminalGrid corrects everything one frame later.
  const containerW = opts.containerW > 0 ? opts.containerW : 1200
  const containerH = opts.containerH > 0 ? opts.containerH : 800

  const n = Math.max(1, hiddenCount)
  // Tiles fill the full strip width so their edges land flush over the
  // on-stage window — there's no outer frame to inset them from anymore.
  const tileW = PIP_STRIP_W
  const availForContent =
    containerH - 2 * MARGIN - HEADER_H - HEADER_GAP - n * TILE_HEADER_H - (n - 1) * GAP
  const tileContentH = Math.max(TILE_MIN_H, Math.min(TILE_MAX_H, availForContent / n))
  const stripH = HEADER_H + HEADER_GAP + n * (TILE_HEADER_H + tileContentH) + (n - 1) * GAP

  let left: number
  let top: number
  if (dragPos) {
    left = dragPos.x
    top = dragPos.y
  } else {
    left =
      corner === 'top-left' || corner === 'bottom-left'
        ? MARGIN
        : containerW - MARGIN - PIP_STRIP_W
    top = corner === 'top-left' || corner === 'top-right' ? MARGIN : containerH - MARGIN - stripH
  }

  const scale = tileW / PIP_VW
  const tiles: PipTileRect[] = []
  let y = top + HEADER_H + HEADER_GAP
  for (let i = 0; i < n; i++) {
    const contentTop = y + TILE_HEADER_H
    tiles.push({
      left,
      top: y,
      width: tileW,
      height: TILE_HEADER_H + tileContentH,
      contentLeft: left,
      contentTop,
      contentWidth: tileW,
      contentHeight: tileContentH,
      scale,
      virtualWidth: PIP_VW,
      virtualHeight: tileContentH / scale,
    })
    y = contentTop + tileContentH + GAP
  }

  return { strip: { left, top, width: PIP_STRIP_W, height: stripH }, tiles }
}

function nearestCorner(
  strip: { left: number; top: number; width: number; height: number },
  containerW: number,
  containerH: number,
): PipCorner {
  const cx = strip.left + strip.width / 2
  const cy = strip.top + strip.height / 2
  const horiz = cx < containerW / 2 ? 'left' : 'right'
  const vert = cy < containerH / 2 ? 'top' : 'bottom'
  return `${vert}-${horiz}` as PipCorner
}

// ---- Chrome -----------------------------------------------------------------

interface PipStripChromeProps {
  geometry: PipGeometry
  hiddenPaneIds: number[]
  containerW: number
  containerH: number
  // Lifted to TerminalGrid so the terminal wrappers follow the strip mid-drag.
  onDragPos: (pos: { x: number; y: number } | null) => void
}

export const PipStripChrome = memo(function PipStripChrome({
  geometry,
  hiddenPaneIds,
  containerW,
  containerH,
  onDragPos,
}: PipStripChromeProps) {
  const panes = useWorkspaceStore((s) => s.panes)
  const pipCollapsed = useWorkspaceStore((s) => s.pipCollapsed ?? false)
  const setPipCollapsed = useWorkspaceStore((s) => s.setPipCollapsed)
  const setPipCorner = useWorkspaceStore((s) => s.setPipCorner)
  const pipCorner = useWorkspaceStore((s) => s.pipCorner ?? 'bottom-right')
  const promotePane = useWorkspaceStore((s) => s.promotePane)

  // Hidden panes start at this array position; tile colors follow the same
  // position-indexed convention as PaneHeader.
  const hiddenStartIndex = panes.length - hiddenPaneIds.length

  const promote = useCallback(
    (paneId: number) => {
      if (promotePane(paneId) === null) return
      requestAnimationFrame(() => {
        requestAnimationFrame(() => focusTerminal(paneId))
      })
    },
    [promotePane],
  )

  const startMove = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startY = e.clientY
      const orig = { x: geometry.strip.left, y: geometry.strip.top }
      const onMove = (ev: MouseEvent) => {
        onDragPos({ x: orig.x + ev.clientX - startX, y: orig.y + ev.clientY - startY })
      }
      const onUp = (ev: MouseEvent) => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        const final = {
          ...geometry.strip,
          left: orig.x + ev.clientX - startX,
          top: orig.y + ev.clientY - startY,
        }
        setPipCorner(nearestCorner(final, containerW, containerH))
        onDragPos(null)
      }
      document.body.style.cursor = 'grabbing'
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [geometry.strip, containerW, containerH, onDragPos, setPipCorner],
  )

  const anyWaiting = hiddenPaneIds.some(
    (id) => panes.find((p) => p.id === id)?.state === 'claude-waiting',
  )

  // Collapsed: just a pill at the snapped corner showing the hidden count.
  if (pipCollapsed) {
    const pillStyle: React.CSSProperties = { position: 'absolute', zIndex: 31 }
    if (pipCorner === 'top-left' || pipCorner === 'bottom-left') pillStyle.left = MARGIN
    else pillStyle.right = MARGIN
    if (pipCorner === 'top-left' || pipCorner === 'top-right') pillStyle.top = MARGIN
    else pillStyle.bottom = MARGIN
    return (
      <button
        style={pillStyle}
        onClick={() => setPipCollapsed(false)}
        className="glass-modal flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-white/15 shadow-xl font-mono text-body text-[--ui-text-secondary] hover:text-[--ui-text-primary] hover:border-white/30 transition-colors"
        title={`Show ${hiddenPaneIds.length} hidden pane${hiddenPaneIds.length === 1 ? '' : 's'}`}
        aria-label="Expand PiP strip"
      >
        {anyWaiting && <span className="w-2 h-2 rounded-full bg-[--warning] animate-pulse shrink-0" />}
        <span>◫ {hiddenPaneIds.length}</span>
      </button>
    )
  }

  return (
    <>
      {/* No outer frame: the stack is just the header label + the tiles, each
          of which is a real pane carrying its own colored border. An enclosing
          container reads as a redundant "bubble" around bordered tiles. */}
      {/* Strip header: drag handle + count + collapse (z-31, above tiles). */}
      <div
        onMouseDown={startMove}
        className="absolute flex items-center gap-1.5 px-2 cursor-grab active:cursor-grabbing font-mono text-meta text-[--ui-text-dimmed] select-none"
        style={{
          left: geometry.strip.left,
          top: geometry.strip.top,
          width: geometry.strip.width,
          height: HEADER_H,
          zIndex: 31,
          // No frame behind the header now, so shadow the text to keep it
          // legible over whatever window is on stage underneath.
          textShadow: '0 1px 3px rgba(0,0,0,0.85)',
        }}
        title="Drag to move (snaps to a corner)"
      >
        <span aria-hidden>⠿</span>
        <span className="flex-1 truncate">
          {hiddenPaneIds.length} hidden pane{hiddenPaneIds.length === 1 ? '' : 's'}
        </span>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setPipCollapsed(true)}
          className="px-1 text-[--ui-text-dimmed] hover:text-[--ui-text-primary] transition-colors"
          title="Collapse to pill (Cmd+B hides entirely)"
          aria-label="Collapse PiP strip"
        >
          ▾
        </button>
      </div>
      {/* Per-tile capture overlays: mini-header + full-tile click/drag surface.
          These own ALL interaction — the pane wrappers underneath are
          pointer-events:none so xterm can never steal focus. */}
      {hiddenPaneIds.map((paneId, i) => {
        const tile = geometry.tiles[i]
        const pane = panes.find((p) => p.id === paneId)
        if (!tile || !pane) return null
        const color = PANE_COLORS[(hiddenStartIndex + i) % PANE_COLORS.length]
        const waiting = pane.state === 'claude-waiting'
        const label = getFolderName(pane.workingDirectory)
        const handleDragStart = (e: DragEvent<HTMLDivElement>) => {
          // Same MIME as PaneHeader's drag, so the existing drop handler on
          // every visible pane performs the targeted swap. Deliberately does
          // NOT setActivePaneId — a hidden pane must never become active.
          e.dataTransfer.setData(PANE_DRAG_TYPE, paneId.toString())
          e.dataTransfer.effectAllowed = 'move'
        }
        return (
          <div
            key={paneId}
            className="absolute group cursor-pointer"
            style={{ left: tile.left, top: tile.top, width: tile.width, height: tile.height, zIndex: 31 }}
            onClick={() => promote(paneId)}
            draggable
            onDragStart={handleDragStart}
            title={`${label} — click to bring into view, or drag onto a pane`}
            role="button"
            aria-label={`Bring ${label} into view`}
          >
            <div
              className="flex items-center gap-1.5 px-1.5 font-mono text-meta overflow-hidden"
              style={{ height: TILE_HEADER_H }}
            >
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${waiting ? 'animate-pulse' : ''}`}
                style={{ backgroundColor: waiting ? '#fbbf24' : color }}
              />
              <span className={`truncate ${waiting ? 'text-[--warning]' : 'text-[--ui-text-secondary]'}`}>
                {label}
              </span>
              {pane.pairColor && (
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0 ml-auto"
                  style={{ backgroundColor: pane.pairColor }}
                  title="Paired pane"
                />
              )}
            </div>
            {/* Tile outline (pane color, amber while waiting) + hover ring. */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                borderRadius: 'var(--pane-radius)',
                boxShadow: `inset 0 0 0 1px ${waiting ? '#fbbf24aa' : color + '55'}`,
              }}
            />
            <div
              className="absolute inset-0 pointer-events-none border border-transparent group-hover:border-white/50 transition-colors"
              style={{ borderRadius: 'var(--pane-radius)' }}
            />
          </div>
        )
      })}
    </>
  )
})
