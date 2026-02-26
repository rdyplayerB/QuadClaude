import { useState, useRef, useEffect, DragEvent, memo } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { clearTerminal } from './TerminalPane'

// Custom MIME type for pane drag operations
export const PANE_DRAG_TYPE = 'application/x-quadclaude-pane'

interface PaneHeaderProps {
  paneId: number
  onHistoryClick?: () => void
  showHistoryButton?: boolean
}

// Unique colors for each terminal's indicator (work well in dark & light modes)
const PANE_COLORS = [
  '#22d3ee', // Cyan (Terminal 1)
  '#4ade80', // Green (Terminal 2)
  '#fbbf24', // Amber (Terminal 3)
  '#a78bfa', // Purple (Terminal 4)
]

export const PaneHeader = memo(function PaneHeader({ paneId, onHistoryClick, showHistoryButton = true }: PaneHeaderProps) {
  const { panes, activePaneId, setPaneLabel, setActivePaneId } = useWorkspaceStore()

  const pane = panes.find((p) => p.id === paneId)
  const paneIndex = panes.findIndex((p) => p.id === paneId)
  const isActive = activePaneId === paneId
  const paneColor = PANE_COLORS[paneIndex % PANE_COLORS.length]

  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  if (!pane) return null

  const handleDoubleClick = () => {
    setEditValue(pane.label)
    setIsEditing(true)
  }

  const handleBlur = () => {
    if (editValue.trim()) {
      setPaneLabel(paneId, editValue.trim())
    }
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleBlur()
    } else if (e.key === 'Escape') {
      setIsEditing(false)
    }
  }

  // Drag handlers for pane reordering
  const handleDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(PANE_DRAG_TYPE, paneId.toString())
    e.dataTransfer.effectAllowed = 'move'
    // Make the dragged pane the active pane
    setActivePaneId(paneId)
  }

  // State indicators - each pane gets its own unique color
  const stateIndicator = () => {
    if (pane.state === 'claude-active') {
      return (
        <span
          className="w-2 h-2 rounded-full animate-pulse"
          style={{ backgroundColor: paneColor }}
          title="Claude Active"
        />
      )
    }
    return null // Don't show indicator for normal shell
  }

  return (
    <div
      className={`pane-header overflow-hidden flex items-center font-mono text-[14px] titlebar-no-drag transition-all h-10 border-b border-[#444] ${
        isActive
          ? 'bg-[--ui-bg-elevated] text-[--ui-text-primary]'
          : 'bg-[--ui-bg-elevated] text-[--ui-text-secondary]'
      }`}
    >
      {/* Draggable zone */}
      <div
        draggable
        onDragStart={handleDragStart}
        className="flex-1 flex items-center gap-2 px-3 cursor-grab active:cursor-grabbing overflow-hidden h-full"
      >
        {/* State indicator */}
        {stateIndicator()}

        {/* Label */}
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-[--terminal-bg] text-[--ui-text-primary] text-[14px] px-2 py-1 outline-none border border-[--accent] rounded font-mono"
          />
        ) : (
          <span
            className="truncate cursor-pointer select-none"
            onDoubleClick={handleDoubleClick}
            title="Double-click to rename"
          >
            {pane.label}
          </span>
        )}
      </div>

      {/* Action buttons - only visible on hover via group */}
      <div
        className="flex items-center gap-1 pr-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ cursor: 'default' }}
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={(e) => e.preventDefault()}
        draggable={false}
      >
        {showHistoryButton && onHistoryClick && (
          <button
            onClick={onHistoryClick}
            className="p-1 text-[--ui-text-muted] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active]/50 transition-all rounded"
            title="View History"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <path d="M7 1.17a5.83 5.83 0 1 0 0 11.66A5.83 5.83 0 0 0 7 1.17ZM0 7a7 7 0 1 1 14 0A7 7 0 0 1 0 7Z"/>
              <path d="M7 3.5a.58.58 0 0 1 .58.58v2.67l1.58 1.58a.58.58 0 1 1-.82.82l-1.75-1.75A.58.58 0 0 1 6.42 7V4.08A.58.58 0 0 1 7 3.5Z"/>
            </svg>
          </button>
        )}
        <button
          onClick={() => clearTerminal(paneId)}
          className="p-1 text-[--ui-text-muted] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active]/50 transition-all rounded"
          title="Clear (Cmd+K)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l8 8M11 3l-8 8" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  )
})
