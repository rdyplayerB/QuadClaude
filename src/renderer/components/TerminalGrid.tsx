import { memo } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { TerminalPane } from './TerminalPane'
import { getGridStyle, getPaneStyle } from '../layouts'

export const TerminalGrid = memo(function TerminalGrid() {
  const { layout, focusPaneId, splitPaneIds, activePaneId, panes, isInitialized } = useWorkspaceStore()

  if (!isInitialized || panes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-terminal-muted font-mono text-sm">
        [ loading... ]
      </div>
    )
  }

  const gridStyle = getGridStyle(layout, focusPaneId, splitPaneIds, activePaneId)

  return (
    <div style={gridStyle} className="p-1 bg-terminal-border">
      {panes.map((pane, index) => (
        <div
          key={pane.id}
          style={getPaneStyle(index, pane.id, layout, splitPaneIds, activePaneId)}
          className="pane-transition min-h-0"
        >
          <TerminalPane paneId={pane.id} />
        </div>
      ))}
    </div>
  )
})
