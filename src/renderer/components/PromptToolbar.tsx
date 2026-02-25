import { useState, useRef, useEffect, memo } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { SavedPrompt } from '../../shared/types'

interface PromptToolbarProps {
  onSelectPrompt: (prompt: SavedPrompt) => void
}

export const PromptToolbar = memo(function PromptToolbar({ onSelectPrompt }: PromptToolbarProps) {
  const { preferences, updatePreferences } = useWorkspaceStore()
  const { savedPrompts } = preferences

  const [isExpanded, setIsExpanded] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newText, setNewText] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)

  const nameInputRef = useRef<HTMLInputElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)

  // Focus name input when creating
  useEffect(() => {
    if (isCreating && nameInputRef.current) {
      nameInputRef.current.focus()
    }
  }, [isCreating])

  // Close expanded state when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setIsExpanded(false)
        setIsCreating(false)
        setEditingId(null)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleCreate = () => {
    if (!newName.trim() || !newText.trim()) return

    const newPrompt: SavedPrompt = {
      id: crypto.randomUUID(),
      name: newName.trim(),
      text: newText.trim(),
      createdAt: Date.now(),
    }
    updatePreferences({ savedPrompts: [...savedPrompts, newPrompt] })
    setNewName('')
    setNewText('')
    setIsCreating(false)
  }

  const handleDelete = (id: string) => {
    updatePreferences({ savedPrompts: savedPrompts.filter((p) => p.id !== id) })
  }

  const handlePromptClick = (prompt: SavedPrompt) => {
    onSelectPrompt(prompt)
  }

  return (
    <div
      ref={toolbarRef}
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40"
    >
      {/* Main toolbar */}
      <div className="bg-[--ui-bg-elevated] border border-[--ui-border] rounded-xl shadow-2xl flex items-center gap-1.5 p-2">
        {/* Prompt buttons */}
        {savedPrompts.slice(0, 6).map((prompt) => (
          <button
            key={prompt.id}
            onClick={() => handlePromptClick(prompt)}
            onContextMenu={(e) => {
              e.preventDefault()
              setEditingId(editingId === prompt.id ? null : prompt.id)
            }}
            className="group relative px-3 py-2 text-sm font-medium text-[--ui-text-secondary] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active] rounded-lg transition-all"
            title={prompt.text}
          >
            {prompt.name}
            {/* Delete button on hover */}
            {editingId === prompt.id && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleDelete(prompt.id)
                  setEditingId(null)
                }}
                className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full text-[11px] flex items-center justify-center hover:bg-red-600"
              >
                ×
              </button>
            )}
          </button>
        ))}

        {/* More indicator if > 6 prompts */}
        {savedPrompts.length > 6 && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="px-2 py-2 text-sm text-[--ui-text-muted] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active] rounded-lg transition-all"
          >
            +{savedPrompts.length - 6}
          </button>
        )}

        {/* Divider */}
        {savedPrompts.length > 0 && (
          <div className="w-px h-6 bg-[--ui-border] mx-1" />
        )}

        {/* Add button */}
        <button
          onClick={() => {
            setIsCreating(true)
            setIsExpanded(true)
          }}
          className="p-2 text-[--ui-text-muted] hover:text-[--accent] hover:bg-[--ui-bg-active] rounded-lg transition-all"
          title="Add prompt"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 2v12M2 8h12" strokeLinecap="round" />
          </svg>
        </button>

        {/* Expand/collapse toggle */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="p-2 text-[--ui-text-muted] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active] rounded-lg transition-all"
          title={isExpanded ? 'Collapse' : 'Expand'}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          >
            <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Expanded panel */}
      {isExpanded && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-[--ui-bg-elevated] border border-[--ui-border] rounded-xl shadow-2xl overflow-hidden" style={{ width: '60vw', minWidth: '500px', maxWidth: '1200px' }}>
          {/* Create form */}
          {isCreating ? (
            <div className="p-5 space-y-4">
              <div className="text-sm text-[--ui-text-muted] font-medium mb-2">New Prompt</div>
              <input
                ref={nameInputRef}
                type="text"
                placeholder="Name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate()
                  if (e.key === 'Escape') setIsCreating(false)
                }}
                className="w-full px-3 py-2.5 text-sm bg-[--ui-bg-primary] border border-[--ui-border] text-[--ui-text-primary] placeholder-[--ui-text-muted] rounded-lg focus:border-[--accent] focus:outline-none"
              />
              <textarea
                placeholder="Prompt text..."
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.metaKey) handleCreate()
                  if (e.key === 'Escape') setIsCreating(false)
                }}
                rows={12}
                className="w-full px-3 py-2.5 text-sm bg-[--ui-bg-primary] border border-[--ui-border] text-[--ui-text-primary] placeholder-[--ui-text-muted] rounded-lg focus:border-[--accent] focus:outline-none resize-y"
                style={{ minHeight: '200px', maxHeight: '60vh' }}
              />
              <div className="flex gap-2">
                <button
                  onClick={handleCreate}
                  disabled={!newName.trim() || !newText.trim()}
                  className="flex-1 px-4 py-2 text-sm bg-[--accent] text-white rounded-lg hover:opacity-90 disabled:opacity-50 transition-all"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setIsCreating(false)
                    setNewName('')
                    setNewText('')
                  }}
                  className="flex-1 px-4 py-2 text-sm bg-[--ui-bg-active] text-[--ui-text-secondary] rounded-lg hover:bg-[--ui-border] transition-all"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* All prompts list */}
              {savedPrompts.length > 0 ? (
                <div className="max-h-56 overflow-y-auto">
                  {savedPrompts.map((prompt) => (
                    <div
                      key={prompt.id}
                      className="flex items-center justify-between px-4 py-3 hover:bg-[--ui-bg-active] cursor-pointer group"
                      onClick={() => handlePromptClick(prompt)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-[--ui-text-primary] font-medium truncate">
                          {prompt.name}
                        </div>
                        <div className="text-xs text-[--ui-text-muted] truncate">
                          {prompt.text}
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(prompt.id)
                        }}
                        className="ml-2 p-1.5 text-[--ui-text-muted] hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M3 3l8 8M11 3l-8 8" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-6 text-center">
                  <div className="text-sm text-[--ui-text-muted]">No prompts yet</div>
                  <button
                    onClick={() => setIsCreating(true)}
                    className="mt-2 text-sm text-[--ui-text-primary] hover:text-[--accent] underline"
                  >
                    Create your first prompt
                  </button>
                </div>
              )}

              {/* Footer hint */}
              {savedPrompts.length > 0 && (
                <div className="px-4 py-2 border-t border-[--ui-border] text-xs text-[--ui-text-muted]">
                  Click to inject • Right-click to delete
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
})
