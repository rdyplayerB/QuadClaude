import { useState, useEffect, useRef, useCallback, memo, MouseEvent as ReactMouseEvent } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { SavedPrompt } from '../../shared/types'

interface PromptPaletteProps {
  isOpen: boolean
  onClose: () => void
  onSelectPrompt: (prompt: SavedPrompt) => void
}

interface Position {
  x: number
  y: number
}

export const PromptPalette = memo(function PromptPalette({
  isOpen,
  onClose,
  onSelectPrompt,
}: PromptPaletteProps) {
  const { preferences, updatePreferences } = useWorkspaceStore()
  const { savedPrompts } = preferences

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isCreatingPrompt, setIsCreatingPrompt] = useState(false)
  const [newPromptName, setNewPromptName] = useState('')
  const [newPromptText, setNewPromptText] = useState('')

  const inputRef = useRef<HTMLInputElement>(null)
  const paletteRef = useRef<HTMLDivElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  // Drag state for movable palette
  const [position, setPosition] = useState<Position | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragOffset = useRef<Position>({ x: 0, y: 0 })

  // Build list of items to show
  const filteredPrompts = savedPrompts.filter(
    (prompt) =>
      prompt.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      prompt.text.toLowerCase().includes(searchQuery.toLowerCase())
  )

  // Items are: filtered prompts + "Create New Prompt"
  const items: { type: 'prompt' | 'action'; prompt?: SavedPrompt; label: string }[] = [
    ...filteredPrompts.map((p) => ({ type: 'prompt' as const, prompt: p, label: p.name })),
    { type: 'action', label: '+ Create New Prompt' },
  ]

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setSearchQuery('')
      setSelectedIndex(0)
      setIsCreatingPrompt(false)
      setNewPromptName('')
      setNewPromptText('')
      setPosition(null) // Reset position to center
      // Focus input after a brief delay to ensure modal is rendered
      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    }
  }, [isOpen])

  // Drag handlers for movable palette
  const handleDragStart = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (!paletteRef.current) return

    const rect = paletteRef.current.getBoundingClientRect()
    dragOffset.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    }
    setIsDragging(true)
  }, [])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      setPosition({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y,
      })
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  // Focus name input when creating prompt
  useEffect(() => {
    if (isCreatingPrompt) {
      requestAnimationFrame(() => {
        nameInputRef.current?.focus()
      })
    }
  }, [isCreatingPrompt])

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isCreatingPrompt) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setIsCreatingPrompt(false)
          inputRef.current?.focus()
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          handleCreatePrompt()
        }
        return
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => Math.max(prev - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          handleSelect(items[selectedIndex])
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    },
    [items, selectedIndex, isCreatingPrompt, onClose]
  )

  const handleSelect = useCallback(
    (item: (typeof items)[0]) => {
      if (item.type === 'prompt' && item.prompt) {
        onSelectPrompt(item.prompt)
        onClose()
      } else if (item.label === '+ Create New Prompt') {
        setIsCreatingPrompt(true)
      }
    },
    [onSelectPrompt, onClose]
  )

  const handleCreatePrompt = useCallback(() => {
    if (!newPromptName.trim() || !newPromptText.trim()) return

    const newPrompt: SavedPrompt = {
      id: crypto.randomUUID(),
      name: newPromptName.trim(),
      text: newPromptText.trim(),
      createdAt: Date.now(),
    }
    updatePreferences({ savedPrompts: [...savedPrompts, newPrompt] })
    setIsCreatingPrompt(false)
    setNewPromptName('')
    setNewPromptText('')
    inputRef.current?.focus()
  }, [newPromptName, newPromptText, savedPrompts, updatePreferences])

  const handleDeletePrompt = useCallback(
    (e: React.MouseEvent, promptId: string) => {
      e.stopPropagation()
      updatePreferences({
        savedPrompts: savedPrompts.filter((p) => p.id !== promptId),
      })
    },
    [savedPrompts, updatePreferences]
  )

  // Close when clicking backdrop
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  // Scroll selected item into view
  useEffect(() => {
    const selectedElement = paletteRef.current?.querySelector(`[data-index="${selectedIndex}"]`)
    selectedElement?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Reset selection when search changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [searchQuery])

  if (!isOpen) return null

  // Calculate style for positioned palette
  const paletteStyle: React.CSSProperties = position
    ? {
        position: 'fixed',
        left: position.x,
        top: position.y,
        transform: 'none',
      }
    : {}

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-start justify-center pt-[15vh] z-50"
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        ref={paletteRef}
        className="bg-terminal-bg border border-terminal-border shadow-xl w-full max-w-md mx-4 font-mono"
        style={paletteStyle}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Prompt Palette"
        onKeyDown={handleKeyDown}
      >
        {/* Header - draggable */}
        <div
          className={`border-b border-terminal-border px-3 py-2 flex items-center justify-between cursor-grab active:cursor-grabbing select-none ${
            isDragging ? 'cursor-grabbing' : ''
          }`}
          onMouseDown={handleDragStart}
        >
          <span className="text-terminal-muted text-xs">Prompt Palette</span>
          <button
            onClick={onClose}
            onMouseDown={(e) => e.stopPropagation()}
            className="text-terminal-muted hover:text-accent transition-colors text-xs"
            aria-label="Close"
          >
            [×]
          </button>
        </div>

        {isCreatingPrompt ? (
          /* Create prompt form */
          <div className="p-3 space-y-2">
            <div className="text-xs text-terminal-muted mb-2">─── NEW PROMPT ───</div>
            <input
              ref={nameInputRef}
              type="text"
              placeholder="Prompt name"
              value={newPromptName}
              onChange={(e) => setNewPromptName(e.target.value)}
              className="w-full px-2 py-1.5 text-xs bg-transparent border border-terminal-border text-terminal-fg placeholder-terminal-muted focus:border-accent focus:outline-none"
            />
            <textarea
              placeholder="Prompt text (press Enter to save)"
              value={newPromptText}
              onChange={(e) => setNewPromptText(e.target.value)}
              rows={3}
              className="w-full px-2 py-1.5 text-xs bg-transparent border border-terminal-border text-terminal-fg placeholder-terminal-muted focus:border-accent focus:outline-none resize-none"
            />
            <div className="flex gap-2">
              <button
                onClick={handleCreatePrompt}
                disabled={!newPromptName.trim() || !newPromptText.trim()}
                className="flex-1 text-xs border border-terminal-border text-terminal-muted hover:border-accent hover:text-accent transition-colors px-2 py-1 disabled:opacity-50"
              >
                [Save]
              </button>
              <button
                onClick={() => setIsCreatingPrompt(false)}
                className="flex-1 text-xs border border-terminal-border text-terminal-muted hover:border-accent hover:text-accent transition-colors px-2 py-1"
              >
                [Cancel]
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Search input */}
            <div className="p-2 border-b border-terminal-border">
              <input
                ref={inputRef}
                type="text"
                placeholder="Search prompts..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-transparent border border-terminal-border text-terminal-fg placeholder-terminal-muted focus:border-accent focus:outline-none"
                aria-label="Search prompts"
              />
            </div>

            {/* Results list */}
            <div className="max-h-[300px] overflow-y-auto">
              {items.map((item, index) => {
                const isSelected = index === selectedIndex
                const isPrompt = item.type === 'prompt'

                return (
                  <div
                    key={isPrompt ? item.prompt?.id : item.label}
                    data-index={index}
                    onClick={() => handleSelect(item)}
                    className={`px-3 py-2 cursor-pointer flex items-center justify-between ${
                      isSelected
                        ? 'bg-accent/10 text-accent'
                        : 'text-terminal-fg hover:bg-terminal-border/30'
                    }`}
                    role="option"
                    aria-selected={isSelected}
                  >
                    <span className="text-xs truncate flex-1">
                      {isPrompt ? (
                        <>
                          <span className="text-terminal-muted">&gt; </span>
                          {item.label}
                        </>
                      ) : (
                        <span className={item.label.startsWith('+') ? 'text-green-500' : 'text-terminal-muted'}>
                          {item.label}
                        </span>
                      )}
                    </span>
                    {isPrompt && item.prompt && (
                      <button
                        onClick={(e) => handleDeletePrompt(e, item.prompt!.id)}
                        className="text-terminal-muted hover:text-accent transition-colors text-xs ml-2 shrink-0"
                        title="Delete prompt"
                      >
                        [x]
                      </button>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Hint */}
            <div className="border-t border-terminal-border px-3 py-2 text-[11px] text-terminal-muted">
              ↑↓ navigate • Enter select • Esc close
            </div>
          </>
        )}
      </div>
    </div>
  )
})
