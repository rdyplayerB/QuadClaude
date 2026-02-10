import { useState, useRef, useEffect, DragEvent, memo } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { focusTerminal, clearTerminal } from './TerminalPane'

// Custom MIME type for pane drag operations
export const PANE_DRAG_TYPE = 'application/x-quadclaude-pane'

interface PaneHeaderProps {
  paneId: number
}

export const PaneHeader = memo(function PaneHeader({ paneId }: PaneHeaderProps) {
  const { panes, activePaneId, splitPaneIds, setSplitPaneId, setPaneLabel, setActivePaneId, swapPanes, layout } =
    useWorkspaceStore()

  const pane = panes.find((p) => p.id === paneId)
  const isActive = activePaneId === paneId
  const splitPosition = layout === 'split' ? splitPaneIds.indexOf(paneId) as (0 | 1 | -1) : -1

  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [showSwapSelector, setShowSwapSelector] = useState(false)
  const [isLabelHovered, setIsLabelHovered] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  // Close swap selector when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setShowSwapSelector(false)
      }
    }
    if (showSwapSelector) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showSwapSelector])

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

  const handleSwapPane = (targetPaneId: number) => {
    if (layout === 'split' && splitPosition !== -1) {
      // In split view, replace this pane's slot with the target pane
      setSplitPaneId(splitPosition as 0 | 1, targetPaneId)
    } else {
      // In grid/focus view, swap positions in the panes array
      swapPanes(paneId, targetPaneId)
    }
    // Make the selected pane the active window and focus its terminal
    setActivePaneId(targetPaneId)
    // Use requestAnimationFrame to ensure DOM has updated before focusing
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        focusTerminal(targetPaneId)
      })
    })
    setShowSwapSelector(false)
  }

  // Get available panes to swap to (all panes except this one)
  const availablePanesForSwap = panes.filter((p) => p.id !== paneId)

  // Drag handlers for pane reordering
  const handleDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(PANE_DRAG_TYPE, paneId.toString())
    e.dataTransfer.effectAllowed = 'move'
    // Make the dragged pane the active pane
    setActivePaneId(paneId)
  }

  // ASCII state indicators
  const stateIndicator = () => {
    switch (pane.state) {
      case 'claude-active':
        return <span className="text-claude-pink animate-pulse" title="Claude Active">[*]</span>
      case 'claude-exited':
        return <span className="text-yellow-600" title="Claude Exited">[·]</span>
      default:
        return <span className="text-terminal-muted" title="Shell">[·]</span>
    }
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      className={`pane-header overflow-hidden px-3 flex items-center gap-2 font-mono text-xs border-b titlebar-no-drag cursor-grab active:cursor-grabbing ${
        isActive
          ? 'border-claude-pink/50 text-terminal-fg'
          : 'border-terminal-border text-terminal-muted'
      }`}
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
          className="flex-1 bg-terminal-bg text-terminal-fg text-xs px-1 py-0.5 outline-none border border-claude-pink font-mono"
        />
      ) : (
        <span
          className={`flex-1 truncate cursor-pointer select-none group ${isActive ? 'text-claude-pink' : ''}`}
          onDoubleClick={handleDoubleClick}
          onMouseEnter={() => setIsLabelHovered(true)}
          onMouseLeave={() => setIsLabelHovered(false)}
          title="Double-click to rename"
        >
          {pane.label}
          {isLabelHovered && (
            <span className="ml-1 text-terminal-muted opacity-60">[edit]</span>
          )}
        </span>
      )}

      {/* Working directory indicator */}
      <span className="text-terminal-muted/50 truncate max-w-[200px]">
        {pane.workingDirectory.replace(/^\/Users\/[^/]+/, '~')}
      </span>

      {/* Separator */}
      <span className="text-terminal-border">|</span>

      {/* Clear terminal button */}
      <button
        onClick={() => clearTerminal(paneId)}
        className="text-terminal-muted hover:text-claude-pink transition-colors"
        title="Clear terminal"
      >
        [clear]
      </button>

      {/* Separator */}
      <span className="text-terminal-border">|</span>

      {/* Swap pane selector - fixed at far right */}
      {availablePanesForSwap.length > 0 && (
        <div className="relative" ref={selectorRef}>
          <button
            onClick={() => setShowSwapSelector(!showSwapSelector)}
            className="text-terminal-muted hover:text-claude-pink transition-colors"
            title="Swap terminal"
          >
            [swap]
          </button>
          {showSwapSelector && (
            <div className="absolute top-full right-0 mt-1 bg-terminal-bg border border-terminal-border z-50 min-w-[120px] font-mono">
              <div className="text-terminal-muted text-xs px-2 py-1 border-b border-terminal-border">─ swap to ─</div>
              {availablePanesForSwap.map((p) => (
                <button
                  key={p.id}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleSwapPane(p.id)
                  }}
                  className="w-full text-left px-2 py-1 text-xs text-terminal-fg hover:text-claude-pink hover:bg-terminal-border/30 transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
