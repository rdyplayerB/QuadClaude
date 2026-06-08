import { memo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useWorkspaceStore } from '../store/workspace'
import { TerminalPane } from './TerminalPane'
import { getGridStyle, getPaneStyle, gridBlanks } from '../layouts'
import { MAX_PANES } from '../../shared/types'

export const TerminalGrid = memo(function TerminalGrid() {
  const layout = useWorkspaceStore((s) => s.layout)
  const isInitialized = useWorkspaceStore((s) => s.isInitialized)
  const addPane = useWorkspaceStore((s) => s.addPane)
  // Only the pane IDs/order matter here; useShallow keeps this from
  // re-rendering when a pane's state/git/cwd changes (only on add/swap).
  const paneIds = useWorkspaceStore(useShallow((s) => s.panes.map((p) => p.id)))

  if (!isInitialized || paneIds.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-[--ui-text-dimmed] font-mono text-sm bg-[--ui-bg-base]">
        Loading...
      </div>
    )
  }

  const count = paneIds.length
  const gridStyle = getGridStyle(layout, count)
  // In grid layout, the auto-balanced grid can leave a trailing empty cell
  // (e.g. 5 panes in a 3x2 grid). Offer it as a "+" tile to add the next pane.
  const showGhost = layout === 'grid' && count < MAX_PANES && gridBlanks(count) > 0

  return (
    <div style={gridStyle} className="p-2 gap-2 glass">
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
    </div>
  )
})
