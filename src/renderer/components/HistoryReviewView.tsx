import { useEffect, useState, useCallback } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { HistoryPanel } from './HistoryPanel'

// Terminal tab colors matching PaneHeader
const PANE_COLORS = [
  '#22d3ee', // Cyan (Terminal 1)
  '#4ade80', // Green (Terminal 2)
  '#fbbf24', // Amber (Terminal 3)
  '#a78bfa', // Purple (Terminal 4)
]

export function HistoryReviewView() {
  const {
    panes,
    historyReviewPaneId,
    setHistoryReviewPane,
    exitHistoryReview,
  } = useWorkspaceStore()

  const [projectId, setProjectId] = useState<string | null>(null)
  const currentPaneId = historyReviewPaneId ?? 0
  const currentPane = panes.find((p) => p.id === currentPaneId)

  // Get project ID based on the current pane's working directory
  useEffect(() => {
    const fetchProjectId = async () => {
      if (!currentPane?.workingDirectory) return
      const id = await window.electronAPI.getProjectId(currentPane.workingDirectory)
      setProjectId(id)
    }
    fetchProjectId()
  }, [currentPane?.workingDirectory])

  // Handle escape key to exit
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        exitHistoryReview()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [exitHistoryReview])

  // Get folder name from path for display
  const getFolderName = useCallback((path: string) => {
    if (!path) return 'Unknown'
    // Check if home directory
    if (path.match(/^\/Users\/[^/]+\/?$/)) {
      return '~'
    }
    const parts = path.split('/')
    return parts[parts.length - 1] || parts[parts.length - 2] || 'Root'
  }, [])

  return (
    <div className="h-full flex flex-col bg-[--ui-bg-primary]">
      {/* Top bar with terminal tabs */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-[--ui-border-subtle] bg-[--ui-bg-primary]">
        {/* Terminal tabs */}
        <div className="flex items-center gap-1">
          {panes.map((pane, index) => {
            const isActive = pane.id === currentPaneId
            const paneColor = PANE_COLORS[index % PANE_COLORS.length]
            const folderName = getFolderName(pane.workingDirectory)

            return (
              <button
                key={pane.id}
                onClick={() => setHistoryReviewPane(pane.id)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${
                  isActive
                    ? 'bg-[--ui-bg-active] text-[--ui-text-primary]'
                    : 'text-[--ui-text-secondary] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active]/50'
                }`}
                title={pane.workingDirectory}
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: paneColor }}
                />
                <span>{pane.label}</span>
                <span className="text-xs text-[--ui-text-muted]">({folderName})</span>
              </button>
            )
          })}
        </div>

        {/* Exit button */}
        <button
          onClick={exitHistoryReview}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-[--ui-text-secondary] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active]/50 transition-all"
          title="Exit (Escape)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l8 8M11 3l-8 8" strokeLinecap="round"/>
          </svg>
          Back to Terminals
        </button>
      </div>

      {/* Current project info */}
      <div className="px-4 py-3 border-b border-[--ui-border-subtle] bg-[--ui-bg-secondary]">
        <div className="text-sm text-[--ui-text-primary] font-medium">
          {currentPane?.label} History
        </div>
        <div className="text-xs text-[--ui-text-muted] mt-0.5" title={currentPane?.workingDirectory}>
          {currentPane?.workingDirectory.replace(/^\/Users\/[^/]+/, '~')}
        </div>
      </div>

      {/* History content - full width */}
      <div className="flex-1 overflow-hidden">
        <HistoryPanel
          isOpen={true}
          onClose={() => {}}
          projectId={projectId}
          embedded={true}
        />
      </div>
    </div>
  )
}
