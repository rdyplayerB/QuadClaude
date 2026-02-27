import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { HistoryPanel } from './HistoryPanel'

export function HistoryReviewView() {
  const {
    panes,
    historyReviewPaneId,
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
  const getFolderName = (path: string) => {
    if (!path) return 'Unknown'
    if (path.match(/^\/Users\/[^/]+\/?$/)) return '~'
    const parts = path.split('/')
    return parts[parts.length - 1] || parts[parts.length - 2] || 'Root'
  }

  return (
    <div className="h-full flex flex-col bg-[--ui-bg-primary]">
      {/* Header with project info and close button */}
      <div className="px-4 py-3 border-b border-[--ui-border-subtle] flex items-center justify-between shrink-0">
        <div>
          <div className="text-sm text-[--ui-text-primary] font-medium">
            {getFolderName(currentPane?.workingDirectory || '')} History
          </div>
          <div className="text-xs text-[--ui-text-muted] mt-0.5" title={currentPane?.workingDirectory}>
            {currentPane?.workingDirectory.replace(/^\/Users\/[^/]+/, '~')}
          </div>
        </div>
        <button
          onClick={exitHistoryReview}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-[--ui-text-secondary] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active]/50 transition-all"
          title="Close (Escape)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l8 8M11 3l-8 8" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* History content */}
      <div className="flex-1 overflow-hidden">
        <HistoryPanel
          isOpen={true}
          onClose={exitHistoryReview}
          projectId={projectId}
          embedded={true}
        />
      </div>
    </div>
  )
}
