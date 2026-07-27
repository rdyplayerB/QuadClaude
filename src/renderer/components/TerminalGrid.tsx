import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useWorkspaceStore } from '../store/workspace'
import { TerminalPane } from './TerminalPane'
import { PipStripChrome, computePipGeometry } from './PipStrip'
import {
  getGridStyle,
  getPaneStyle,
  gridBlanks,
  clampFocusRatio,
  clampDuoRatio,
  visiblePaneCount,
} from '../layouts'
import { MAX_PANES, FOCUS_SMALL_RATIO_DEFAULT, DUO_RATIO_DEFAULT } from '../../shared/types'

// Matches the grid container's `p-5` (20px) padding — the content box the
// columns actually lay out in is inset by this on each side. Kept generous on
// purpose: the ground shows through here, so the gutter IS the floating
// effect. At 8px a cleared ground was a hairline nobody could see.
const GRID_PAD = 20

export const TerminalGrid = memo(function TerminalGrid() {
  const layout = useWorkspaceStore((s) => s.layout)
  const isInitialized = useWorkspaceStore((s) => s.isInitialized)
  const addPane = useWorkspaceStore((s) => s.addPane)
  const focusSmallRatio = useWorkspaceStore((s) => s.focusSmallRatio ?? FOCUS_SMALL_RATIO_DEFAULT)
  const setFocusSmallRatio = useWorkspaceStore((s) => s.setFocusSmallRatio)
  const duoRatio = useWorkspaceStore((s) => s.duoRatio ?? DUO_RATIO_DEFAULT)
  const setDuoRatio = useWorkspaceStore((s) => s.setDuoRatio)
  const pipCorner = useWorkspaceStore((s) => s.pipCorner ?? 'bottom-right')
  const pipCollapsed = useWorkspaceStore((s) => s.pipCollapsed ?? false)
  const pipVisible = useWorkspaceStore((s) => s.pipVisible ?? true)
  // Only the pane IDs/order matter here; useShallow keeps this from
  // re-rendering when a pane's state/git/cwd changes (only on add/swap).
  const paneIds = useWorkspaceStore(useShallow((s) => s.panes.map((p) => p.id)))

  const containerRef = useRef<HTMLDivElement>(null)

  // Container size drives the PiP strip geometry (tile heights, corner
  // anchoring). Tracked from a ResizeObserver so window resizes re-anchor the
  // strip; the effect re-runs on isInitialized because the ref'd element only
  // exists once the loading placeholder is gone.
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setContainerSize((prev) => {
        const w = el.clientWidth
        const h = el.clientHeight
        return prev.w === w && prev.h === h ? prev : { w, h }
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [isInitialized])

  // While the strip header is being dragged, its free position lives here so
  // the terminal wrappers (positioned by this component) follow the chrome.
  const [pipDragPos, setPipDragPos] = useState<{ x: number; y: number } | null>(null)

  // Drag the focus splitter: convert the cursor's X within the grid's content
  // box into a small-column width fraction. In 'focus' the small column is on
  // the right (so a smaller cursor fraction => larger small column); in
  // 'focus-right' it's on the left. The content box is inset by the grid's
  // p-2 padding, so subtract it to keep the handle on the actual seam.
  const startSplitDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const el = containerRef.current
      if (!el) return
      const isRight = useWorkspaceStore.getState().layout === 'focus-right'
      const onMove = (ev: MouseEvent) => {
        const rect = el.getBoundingClientRect()
        const content = rect.width - 2 * GRID_PAD
        if (content <= 0) return
        const frac = (ev.clientX - rect.left - GRID_PAD) / content
        setFocusSmallRatio(clampFocusRatio(isRight ? frac : 1 - frac))
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [setFocusSmallRatio],
  )

  // Drag the duo divider: cursor X fraction == left pane's width fraction.
  const startDuoDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const el = containerRef.current
      if (!el) return
      const onMove = (ev: MouseEvent) => {
        const rect = el.getBoundingClientRect()
        const content = rect.width - 2 * GRID_PAD
        if (content <= 0) return
        setDuoRatio(clampDuoRatio((ev.clientX - rect.left - GRID_PAD) / content))
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [setDuoRatio],
  )

  if (!isInitialized || paneIds.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-[--ui-text-dimmed] font-mono text-body bg-[--ui-bg-base]">
        Loading...
      </div>
    )
  }

  const count = paneIds.length
  const gridStyle = getGridStyle(layout, count, focusSmallRatio, duoRatio)
  // In grid layout, the auto-balanced grid can leave a trailing empty cell
  // (e.g. 5 panes in a 3x2 grid). Offer it as a "+" tile to add the next pane.
  const showGhost = layout === 'grid' && count < MAX_PANES && gridBlanks(count) > 0
  // Splitter is only meaningful in the focus layouts (one big pane vs column).
  const isFocus = layout === 'focus' || layout === 'focus-right'
  const r = clampFocusRatio(focusSmallRatio)
  // Boundary as a fraction of the CONTENT box (inside the p-2 padding): in
  // 'focus' the big pane is on the left (boundary at 1-r); in 'focus-right'
  // the small column is on the left (boundary at r).
  const boundaryFrac = layout === 'focus-right' ? r : 1 - r
  const dividerLeft = `calc(${GRID_PAD}px + ${boundaryFrac} * (100% - ${2 * GRID_PAD}px))`

  const isDuo = layout === 'duo'
  const duoR = clampDuoRatio(duoRatio)
  const duoDividerLeft = `calc(${GRID_PAD}px + ${duoR} * (100% - ${2 * GRID_PAD}px))`

  // PiP strip: panes past the layout's visible count render as floating live
  // tiles. Their wrappers stay in THIS grid container (same React keys, no
  // remount) — they just get absolute scaled-tile styles instead of grid
  // placements. Collapsed/toggled-off tiles keep their geometry and go
  // visibility:hidden (NEVER display:none — fit paths bail at offsetWidth 0
  // and the beta canvas addon blanks at 0×0).
  const vc = visiblePaneCount(layout, count)
  const hiddenCount = count - vc
  const isPipLayout = (layout === 'duo' || layout === 'solo') && hiddenCount > 0
  const pipGeometry = isPipLayout
    ? computePipGeometry({
        containerW: containerSize.w,
        containerH: containerSize.h,
        corner: pipCorner,
        hiddenCount,
        dragPos: pipDragPos,
      })
    : null
  const tilesVisible = isPipLayout && pipVisible && !pipCollapsed

  return (
    <div ref={containerRef} style={gridStyle} className="p-5 gap-5 glass terminal-grid-root">
      {paneIds.map((id, index) => {
        const tile = pipGeometry && index >= vc ? pipGeometry.tiles[index - vc] : null
        return (
          <div
            key={id}
            style={
              tile
                ? {
                    position: 'absolute',
                    left: tile.contentLeft,
                    top: tile.contentTop,
                    width: tile.virtualWidth,
                    height: tile.virtualHeight,
                    transform: `scale(${tile.scale})`,
                    transformOrigin: 'top left',
                    zIndex: 30,
                    visibility: tilesVisible ? 'visible' : 'hidden',
                    minWidth: 0,
                    minHeight: 0,
                    overflow: 'hidden',
                    // This wrapper clips the tile, so a square clip would shear
                    // the corners off the rounded pane inside it. Match the pane.
                    borderRadius: 'var(--pane-radius)',
                  }
                : getPaneStyle(index, layout, count)
            }
            className={tile ? 'pip-wrapper min-h-0' : 'pane-transition min-h-0'}
          >
            <TerminalPane paneId={id} />
          </div>
        )
      })}
      {showGhost && (
        <button
          onClick={() => addPane()}
          style={getPaneStyle(count, layout, count)}
          className="pane-transition min-h-0 flex flex-col items-center justify-center gap-2 rounded border border-dashed border-white/10 text-[--ui-text-dimmed] hover:text-[--ui-text-primary] hover:border-white/25 hover:bg-white/[0.02] transition-colors"
          title="Add terminal"
          aria-label="Add terminal"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" />
          </svg>
          <span className="text-body font-mono">Add terminal</span>
        </button>
      )}
      {isFocus && (
        <div
          onMouseDown={startSplitDrag}
          className="group absolute top-2 bottom-2 z-20 flex items-center justify-center cursor-col-resize"
          style={{ left: dividerLeft, width: 12, transform: 'translateX(-50%)' }}
          title="Drag to resize"
          role="separator"
          aria-orientation="vertical"
        >
          {/* Slim handle that brightens on hover/drag */}
          <div className="h-full w-px bg-white/10 group-hover:bg-[--accent]/60 transition-colors" />
        </div>
      )}
      {isDuo && (
        <div
          onMouseDown={startDuoDrag}
          className="group absolute top-2 bottom-2 z-20 flex items-center justify-center cursor-col-resize"
          style={{ left: duoDividerLeft, width: 12, transform: 'translateX(-50%)' }}
          title="Drag to resize"
          role="separator"
          aria-orientation="vertical"
        >
          <div className="h-full w-px bg-white/10 group-hover:bg-[--accent]/60 transition-colors" />
        </div>
      )}
      {isPipLayout && pipVisible && pipGeometry && (
        <PipStripChrome
          geometry={pipGeometry}
          hiddenPaneIds={paneIds.slice(vc)}
          containerW={containerSize.w || 1200}
          containerH={containerSize.h || 800}
          onDragPos={setPipDragPos}
        />
      )}
    </div>
  )
})
