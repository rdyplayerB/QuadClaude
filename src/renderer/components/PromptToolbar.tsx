import { useState, useRef, useEffect, memo, useCallback } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { SavedPrompt } from '../../shared/types'

interface PromptToolbarProps {
  onSelectPrompt: (prompt: SavedPrompt) => void
}

interface ContextMenuState {
  promptId: string
  x: number
  y: number
}

const MAX_PROMPT_NAME_LENGTH = 18

// Modal for creating or editing a prompt
function PromptModal({ prompt, onSave, onClose }: {
  prompt?: SavedPrompt
  onSave: (name: string, text: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(prompt?.name ?? '')
  const [text, setText] = useState(prompt?.text ?? '')
  const nameRef = useRef<HTMLInputElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => { nameRef.current?.focus() }, [])

  const handleSave = () => {
    if (name.trim() && text.trim()) {
      onSave(name.trim(), text.trim())
    }
  }

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === backdropRef.current) onClose() }}
    >
      <div className="bg-[--ui-bg-elevated] border border-[--ui-border] rounded-xl shadow-2xl w-[480px] max-w-[90vw]">
        <div className="px-5 pt-4 pb-3 border-b border-white/[0.06]">
          <h2 className="text-sm font-medium text-[--ui-text-primary]">
            {prompt ? 'Edit Prompt' : 'New Prompt'}
          </h2>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-[--ui-text-muted] mb-1.5">Name</label>
            <input
              ref={nameRef}
              type="text"
              placeholder="e.g. Code Review, Summarize, Fix Bug"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
              maxLength={MAX_PROMPT_NAME_LENGTH}
              className="w-full px-3 py-2 text-sm bg-[--ui-bg-primary] border border-[--ui-border] text-[--ui-text-primary] placeholder-[--ui-text-faint] rounded-lg focus:border-[--accent] focus:outline-none"
            />
            <div className="text-[10px] text-[--ui-text-faint] mt-1 text-right">{name.length}/{MAX_PROMPT_NAME_LENGTH}</div>
          </div>
          <div>
            <label className="block text-xs text-[--ui-text-muted] mb-1.5">Prompt Text</label>
            <textarea
              placeholder="The text that will be injected into the active terminal..."
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.metaKey) handleSave()
                if (e.key === 'Escape') onClose()
              }}
              rows={8}
              className="w-full px-3 py-2 text-sm bg-[--ui-bg-primary] border border-[--ui-border] text-[--ui-text-primary] placeholder-[--ui-text-faint] rounded-lg focus:border-[--accent] focus:outline-none resize-y font-mono"
              style={{ minHeight: '120px', maxHeight: '50vh' }}
            />
          </div>
        </div>
        <div className="px-5 pb-4 flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-xs bg-[--ui-bg-active] text-[--ui-text-secondary] rounded-lg hover:bg-[--ui-border] transition-all">Cancel</button>
          <button onClick={handleSave} disabled={!name.trim() || !text.trim()} className="px-4 py-2 text-xs bg-[--accent] text-white rounded-lg hover:opacity-90 disabled:opacity-50 transition-all">
            {prompt ? 'Save Changes' : 'Create Prompt'}
          </button>
        </div>
      </div>
    </div>
  )
}

export const PromptToolbar = memo(function PromptToolbar({ onSelectPrompt }: PromptToolbarProps) {
  const { preferences, updatePreferences } = useWorkspaceStore()
  const { savedPrompts } = preferences
  const showPromptBar = preferences.showPromptBar !== false

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState<SavedPrompt | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [showOverflow, setShowOverflow] = useState(false)
  const [visibleCount, setVisibleCount] = useState(savedPrompts.length)

  const contextMenuRef = useRef<HTMLDivElement>(null)
  const overflowRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // Measure how many prompts fit in the bar
  useEffect(() => {
    if (!barRef.current) return
    const observer = new ResizeObserver(() => {
      if (!barRef.current) return
      const barWidth = barRef.current.clientWidth
      // Reserve space for: add button (~32px) + overflow button (~28px) + hide button (~20px) + padding (~16px)
      const reserved = 96
      const available = barWidth - reserved
      // Each prompt button is roughly 120px average
      const fits = Math.max(1, Math.floor(available / 120))
      setVisibleCount(fits)
    })
    observer.observe(barRef.current)
    return () => observer.disconnect()
  }, [])

  const visiblePrompts = savedPrompts.slice(0, visibleCount)
  const overflowPrompts = savedPrompts.slice(visibleCount)
  const hasOverflow = overflowPrompts.length > 0

  // Close popups on outside click
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (contextMenu && contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
      if (showOverflow && overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setShowOverflow(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [contextMenu, showOverflow])

  const handleCreate = (name: string, text: string) => {
    updatePreferences({
      savedPrompts: [...savedPrompts, {
        id: crypto.randomUUID(),
        name: name.slice(0, MAX_PROMPT_NAME_LENGTH),
        text,
        createdAt: Date.now(),
      }]
    })
    setShowCreateModal(false)
  }

  const handleSaveEdit = (name: string, text: string) => {
    if (!editingPrompt) return
    updatePreferences({
      savedPrompts: savedPrompts.map(p =>
        p.id === editingPrompt.id ? { ...p, name: name.slice(0, MAX_PROMPT_NAME_LENGTH), text } : p
      )
    })
    setEditingPrompt(null)
  }

  const handleDelete = (id: string) => {
    updatePreferences({ savedPrompts: savedPrompts.filter(p => p.id !== id) })
    setContextMenu(null)
  }

  const handleContextMenu = useCallback((e: React.MouseEvent, prompt: SavedPrompt) => {
    e.preventDefault()
    setContextMenu({ promptId: prompt.id, x: e.clientX, y: e.clientY })
  }, [])

  if (!showPromptBar) return null

  const promptButton = (prompt: SavedPrompt, inDropdown = false) => (
    <button
      key={prompt.id}
      onClick={() => { onSelectPrompt(prompt); setShowOverflow(false) }}
      onContextMenu={(e) => handleContextMenu(e, prompt)}
      className={inDropdown
        ? "flex items-center gap-2.5 w-full px-3 py-2 text-[13px] text-[--ui-text-primary] hover:bg-white/[0.06] text-left transition-colors"
        : "flex items-center gap-1.5 px-2.5 py-0.5 text-[12px] text-white/80 hover:text-white bg-white/[0.08] hover:bg-white/[0.14] rounded-[4px] transition-all shrink-0"
      }
      title={prompt.text}
    >
      <svg width={inDropdown ? 14 : 11} height={inDropdown ? 14 : 11} viewBox="0 0 16 16" fill="currentColor" className={inDropdown ? "shrink-0 opacity-30" : "shrink-0 opacity-30"}>
        <path d="M4.5 2A2.5 2.5 0 0 0 2 4.5v7A2.5 2.5 0 0 0 4.5 14h7a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 11.5 2h-7ZM5 5.5A.5.5 0 0 1 5.5 5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5ZM5.5 8a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1h-3Z"/>
      </svg>
      <span className={inDropdown ? "" : "truncate"}>{prompt.name}</span>
    </button>
  )

  return (
    <>
      <div ref={barRef} className="h-7 shrink-0 flex items-center gap-1 px-2 border-b border-white/[0.06] glass-pane-header overflow-hidden">
        {/* Visible prompt buttons */}
        {visiblePrompts.map((prompt) => promptButton(prompt))}

        {/* Overflow chevron - Chrome-style >> button */}
        {hasOverflow && (
          <div ref={overflowRef} className="relative shrink-0">
            <button
              onClick={() => setShowOverflow(!showOverflow)}
              className="flex items-center px-1.5 py-1 text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors"
              title={`${overflowPrompts.length} more prompt${overflowPrompts.length > 1 ? 's' : ''}`}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 4l4 4-4 4M8 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {showOverflow && (
              <div className="absolute top-full right-0 mt-1 bg-[--ui-bg-elevated] border border-[--ui-border] rounded-lg shadow-2xl z-50 py-1 min-w-[200px] max-w-[300px]">
                {overflowPrompts.map((prompt) => promptButton(prompt, true))}
              </div>
            )}
          </div>
        )}

        {/* Add button */}
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-1 px-2 py-1 text-[12px] text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors shrink-0"
          title="Add prompt"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 2v12M2 8h12" strokeLinecap="round" />
          </svg>
        </button>

        <div className="flex-1" />
      </div>

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed bg-[--ui-bg-elevated] border border-[--ui-border] rounded-lg shadow-2xl z-[100] py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => { setShowCreateModal(true); setContextMenu(null) }}
            className="w-full px-3 py-1.5 text-xs text-[--ui-text-primary] hover:bg-white/[0.08] text-left transition-colors"
          >
            Add Prompt...
          </button>
          <button
            onClick={() => {
              const p = savedPrompts.find(p => p.id === contextMenu.promptId)
              if (p) { setEditingPrompt(p); setContextMenu(null) }
            }}
            className="w-full px-3 py-1.5 text-xs text-[--ui-text-primary] hover:bg-white/[0.08] text-left transition-colors"
          >
            Edit...
          </button>
          <div className="my-1 border-t border-white/[0.06]" />
          <button
            onClick={() => handleDelete(contextMenu.promptId)}
            className="w-full px-3 py-1.5 text-xs text-red-400 hover:bg-white/[0.08] text-left transition-colors"
          >
            Delete
          </button>
        </div>
      )}

      {/* Create modal */}
      {showCreateModal && (
        <PromptModal onSave={handleCreate} onClose={() => setShowCreateModal(false)} />
      )}

      {/* Edit modal */}
      {editingPrompt && (
        <PromptModal prompt={editingPrompt} onSave={handleSaveEdit} onClose={() => setEditingPrompt(null)} />
      )}
    </>
  )
})
