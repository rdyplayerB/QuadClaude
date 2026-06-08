import { memo, useCallback, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useWorkspaceStore } from '../store/workspace'
import { TerminalPane } from './TerminalPane'
import { getGridStyle, getPaneStyle, gridBlanks, clampFocusRatio } from '../layouts'
import { MAX_PANES, FOCUS_SMALL_RATIO_DEFAULT } from '../../shared/types'

// Matches the grid container's `p-2` (8px) padding — the content box the
// columns actually lay out in is inset by this on each side.
const GRID_PAD = 8

export const TerminalGrid = memo(function TerminalGrid() {
  const layout = useWorkspaceStore((s) => s.layout)
  const isInitialized = useWorkspaceStore((s) => s.isInitialized)
  const addPane = useWorkspaceStore((s) => s.addPane)
  const focusSmallRatio = useWorkspaceStore((s) => s.focusSmallRatio ?? FOCUS_SMALL_RATIO_DEFAULT)
  const setFocusSmallRatio = useWorkspaceStore((s) => s.setFocusSmallRatio)
  // Only the pane IDs/order matter here; useShallow keeps this from
  // re-rendering when a pane's state/git/cwd changes (only on add/swap).
  const paneIds = useWorkspaceStore(useShallow((s) => s.panes.map((p) => p.id)))

  const containerRef = useRef<HTMLDivElement>(null)

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

  if (!isInitialized || paneIds.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-[--ui-text-dimmed] font-mono text-sm bg-[--ui-bg-base]">
        Loading...
      </div>
    )
  }

  const count = paneIds.length
  const gridStyle = getGridStyle(layout, count, focusSmallRatio)
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

  return (
    <div ref={containerRef} style={gridStyle} className="p-2 gap-2 glass">
      {paneIds.map((id, index) => (
        <div
          key={id}
          style={getPaneStyle(index, layout, count)}
          className="pane-transition min-h-0"
        >
          <TerminalPane paneId={id} />
        </div>
      ))}
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
          <span className="text-[11px] font-mono">Add terminal</span>
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
    </div>
  )
})
