import { memo } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { TerminalPane } from './TerminalPane'
import { getGridStyle, getPaneStyle } from '../layouts'

export const TerminalGrid = memo(function TerminalGrid() {
  const { layout, focusPaneId, activePaneId, panes, isInitialized } = useWorkspaceStore()

  if (!isInitialized || panes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-[--ui-text-dimmed] font-mono text-sm bg-[--ui-bg-base]">
        Loading...
      </div>
    )
  }

  const gridStyle = getGridStyle(layout, focusPaneId, activePaneId)

  return (
    <div style={gridStyle} className="p-2 gap-2 bg-[--ui-bg-base]">
      {panes.map((pane, index) => (
        <div
          key={pane.id}
          style={getPaneStyle(index, pane.id, layout, activePaneId)}
          className="pane-transition min-h-0"
        >
          <TerminalPane paneId={pane.id} />
        </div>
      ))}
    </div>
  )
})
