import { memo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useWorkspaceStore } from '../store/workspace'
import { TerminalPane } from './TerminalPane'
import { getGridStyle, getPaneStyle } from '../layouts'

export const TerminalGrid = memo(function TerminalGrid() {
  const layout = useWorkspaceStore((s) => s.layout)
  const isInitialized = useWorkspaceStore((s) => s.isInitialized)
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

  const gridStyle = getGridStyle(layout)

  return (
    <div style={gridStyle} className="p-2 gap-2 glass">
      {paneIds.map((id, index) => (
        <div
          key={id}
          style={getPaneStyle(index, layout)}
          className="pane-transition min-h-0"
        >
          <TerminalPane paneId={id} />
        </div>
      ))}
    </div>
  )
})
