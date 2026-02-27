import { useState, useEffect, useCallback, memo } from 'react'
import type { HistoryExchangeEntry } from '../../shared/types'

interface HistorySession {
  date: string
  file: string
  size: number
  preview: string
  exchangeCount: number
}

interface HistorySearchResult {
  date: string
  matches: string[]
}

interface HistoryPanelProps {
  isOpen: boolean
  onClose: () => void
  projectId: string | null
  embedded?: boolean  // When true, renders inline without modal/backdrop
}

export const HistoryPanel = memo(function HistoryPanel({ isOpen, onClose, projectId, embedded = false }: HistoryPanelProps) {
  const [sessions, setSessions] = useState<HistorySession[]>([])
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [exchanges, setExchanges] = useState<HistoryExchangeEntry[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<HistorySearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [view, setView] = useState<'sessions' | 'content' | 'search'>('sessions')
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  // Load sessions when panel opens
  useEffect(() => {
    if (isOpen && projectId) {
      loadSessions()
    }
  }, [isOpen, projectId])

  const loadSessions = async () => {
    if (!projectId) return
    const result = await window.electronAPI.getHistorySessions(projectId)
    setSessions(result)
  }

  const loadDayContent = async (date: string) => {
    if (!projectId) return
    setSelectedDate(date)
    const result = await window.electronAPI.getHistoryDayExchanges(projectId, date)
    setExchanges(result)
    setView('content')
  }

  const handleSearch = useCallback(async () => {
    if (!projectId || !searchQuery.trim()) return
    setIsSearching(true)
    const results = await window.electronAPI.searchHistory(projectId, searchQuery.trim(), 50)
    setSearchResults(results)
    setIsSearching(false)
    setView('search')
  }, [projectId, searchQuery])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch()
    }
    if (e.key === 'Escape') {
      if (view !== 'sessions') {
        setView('sessions')
        setSelectedDate(null)
        setSearchResults([])
      } else {
        onClose()
      }
    }
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr + 'T12:00:00')
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    if (dateStr === today.toISOString().split('T')[0]) {
      return 'Today'
    }
    if (dateStr === yesterday.toISOString().split('T')[0]) {
      return 'Yesterday'
    }

    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    })
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const deleteDay = async (date: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!projectId) return
    const ok = await window.electronAPI.deleteHistoryDay(projectId, date)
    if (ok) {
      setSessions(prev => prev.filter(s => s.date !== date))
      if (selectedDate === date) {
        setView('sessions')
        setSelectedDate(null)
        setExchanges([])
      }
    }
  }

  const copyExchange = (index: number) => {
    const ex = exchanges[index]
    if (!ex) return
    navigator.clipboard.writeText(ex.content)
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(null), 1500)
  }

  const copyAllExchanges = () => {
    const text = exchanges.map(ex =>
      `[${ex.time}] Terminal ${ex.paneId + 1} - ${ex.type}\n${ex.content}`
    ).join('\n\n')
    navigator.clipboard.writeText(text)
  }

  // Shared exchange card renderer
  const renderExchangeCards = () => (
    <div className="p-4 space-y-2">
      <div className="flex justify-end gap-1 mb-2">
        <button
          onClick={copyAllExchanges}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[--ui-text-muted] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active] rounded-md transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H4zm0 1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>
            <path d="M10 0H2a2 2 0 0 0-2 2v8h1V2a1 1 0 0 1 1-1h8V0z"/>
          </svg>
          Copy all
        </button>
        {selectedDate && (
          <button
            onClick={() => deleteDay(selectedDate)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[--ui-text-muted] hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M2 4h12M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M6 7v5M10 7v5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M3 4l1 10a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-10" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Delete
          </button>
        )}
      </div>
      {exchanges.length === 0 ? (
        <div className="py-8 text-center text-[--ui-text-muted] text-sm">
          No exchanges for this day.
        </div>
      ) : (
        exchanges.map((ex, i) => (
          <div
            key={i}
            className="group rounded-lg border border-[--ui-border-subtle] overflow-hidden"
          >
            {/* Header row */}
            <div className={`flex items-center justify-between px-3 py-1.5 ${
              ex.type === 'input'
                ? 'bg-[--accent]/8'
                : 'bg-[--ui-bg-primary]/60'
            }`}>
              <div className="flex items-center gap-2 text-xs text-[--ui-text-muted]">
                <span>{ex.time}</span>
                <span className="opacity-40">·</span>
                <span>Terminal {ex.paneId + 1}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ${
                  ex.type === 'input'
                    ? 'text-[--accent] bg-[--accent]/15'
                    : 'text-[--ui-text-muted] bg-[--ui-bg-active]/50'
                }`}>
                  {ex.type}
                </span>
                <button
                  onClick={() => copyExchange(i)}
                  className="p-1 text-[--ui-text-muted] hover:text-[--ui-text-primary] opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={`Copy ${ex.type}`}
                >
                  {copiedIndex === i ? (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 8l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M4 2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H4zm0 1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>
                      <path d="M10 0H2a2 2 0 0 0-2 2v8h1V2a1 1 0 0 1 1-1h8V0z"/>
                    </svg>
                  )}
                </button>
              </div>
            </div>
            {/* Content */}
            <pre className="px-3 py-2 text-xs text-[--ui-text-secondary] font-mono whitespace-pre-wrap break-words leading-relaxed bg-[--ui-bg-primary]/30">
              {ex.content}
            </pre>
          </div>
        ))
      )}
    </div>
  )

  if (!isOpen) return null

  // Embedded mode - render without modal wrapper
  if (embedded) {
    return (
      <div className="flex flex-col h-full">
        {/* Search bar - always visible in embedded mode */}
        <div className="px-4 py-3 border-b border-[--ui-border-subtle] shrink-0">
          <div className="flex items-center gap-2">
            {view !== 'sessions' && (
              <button
                onClick={() => {
                  setView('sessions')
                  setSelectedDate(null)
                  setSearchResults([])
                }}
                className="p-1 text-[--ui-text-muted] hover:text-[--ui-text-primary] transition-colors shrink-0"
                aria-label="Back to sessions"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 4L6 8L10 12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            <div className="relative flex-1">
              <input
                type="text"
                placeholder="Search history..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full px-3 py-1.5 pl-8 text-sm bg-[--ui-bg-primary] border border-[--ui-border-subtle] rounded-md text-[--ui-text-primary] placeholder-[--ui-text-muted] focus:outline-none focus:border-[--accent]"
              />
              <svg
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[--ui-text-muted]"
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="6.5" cy="6.5" r="5" />
                <path d="M10 10l4 4" strokeLinecap="round" />
              </svg>
            </div>
          </div>
          {view !== 'sessions' && (
            <div className="text-xs text-[--ui-text-muted] mt-2">
              {view === 'content' && formatDate(selectedDate || '')}
              {view === 'search' && `Searching: "${searchQuery}"`}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Sessions list */}
          {view === 'sessions' && (
            <div className="p-2">
              {!projectId ? (
                <div className="py-12 text-center text-[--ui-text-muted] text-sm">
                  <p>Not a git repository</p>
                  <p className="mt-1 text-xs">History is only tracked for git projects.</p>
                </div>
              ) : sessions.length === 0 ? (
                <div className="py-12 text-center text-[--ui-text-muted] text-sm">
                  <p>No history yet.</p>
                  <p className="mt-1 text-xs">Conversations will appear here.</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {sessions.map((session) => (
                    <div
                      key={session.date}
                      className="group/row flex items-center rounded-lg hover:bg-[--ui-bg-active]/50 transition-colors"
                    >
                      <button
                        onClick={() => loadDayContent(session.date)}
                        className="flex-1 p-3 text-left"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-[--ui-text-primary]">
                            {formatDate(session.date)}
                          </span>
                          <span className="text-xs text-[--ui-text-muted]">
                            {session.exchangeCount} exchanges
                          </span>
                        </div>
                        <div className="text-xs text-[--ui-text-muted] truncate">
                          {session.preview || 'No preview available'}
                        </div>
                      </button>
                      <button
                        onClick={(e) => deleteDay(session.date, e)}
                        className="p-2 mr-1 text-[--ui-text-muted] hover:text-red-400 opacity-0 group-hover/row:opacity-100 transition-all shrink-0"
                        aria-label="Delete day"
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M2 4h12M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M6 7v5M10 7v5" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M3 4l1 10a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-10" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Day content view */}
          {view === 'content' && renderExchangeCards()}

          {/* Search results view */}
          {view === 'search' && (
            <div className="p-4">
              {isSearching ? (
                <div className="py-8 text-center text-[--ui-text-muted] text-sm">
                  Searching...
                </div>
              ) : searchResults.length === 0 ? (
                <div className="py-8 text-center text-[--ui-text-muted] text-sm">
                  No results found
                </div>
              ) : (
                <div className="space-y-3">
                  {searchResults.map((result, i) => (
                    <div key={`${result.date}-${i}`} className="border border-[--ui-border-subtle] rounded-lg overflow-hidden">
                      <button
                        onClick={() => loadDayContent(result.date)}
                        className="w-full px-3 py-2 text-left text-sm font-medium text-[--ui-text-primary] bg-[--ui-bg-primary]/50 hover:bg-[--ui-bg-active]/50 transition-colors"
                      >
                        {formatDate(result.date)}
                      </button>
                      <div className="p-2 space-y-1">
                        {result.matches.slice(0, 2).map((match, j) => (
                          <div
                            key={j}
                            className="text-xs text-[--ui-text-secondary] font-mono bg-[--ui-bg-primary]/50 p-2 rounded whitespace-pre-wrap break-words"
                          >
                            {match.slice(0, 200)}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // Modal mode - original implementation
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-lg bg-[--ui-bg-elevated] border-l border-[--ui-border] shadow-2xl flex flex-col h-full animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[--ui-border] shrink-0">
          <div className="flex items-center gap-3">
            {view !== 'sessions' && (
              <button
                onClick={() => {
                  setView('sessions')
                  setSelectedDate(null)
                  setSearchResults([])
                }}
                className="p-1 text-[--ui-text-muted] hover:text-[--ui-text-primary] transition-colors"
                aria-label="Back to sessions"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 4L6 8L10 12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            <h2 className="text-base font-medium text-[--ui-text-primary]">
              {view === 'sessions' && 'Conversation History'}
              {view === 'content' && formatDate(selectedDate || '')}
              {view === 'search' && `Search: "${searchQuery}"`}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-[--ui-text-muted] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active] rounded-lg transition-all"
            aria-label="Close history panel"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Search bar */}
        {view === 'sessions' && (
          <div className="px-4 py-3 border-b border-[--ui-border] shrink-0">
            <div className="relative">
              <input
                type="text"
                placeholder="Search history..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full px-3 py-2 pl-9 text-sm bg-[--ui-bg-primary] border border-[--ui-border] rounded-lg text-[--ui-text-primary] placeholder-[--ui-text-muted] focus:outline-none focus:border-[--accent]"
              />
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[--ui-text-muted]"
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="6.5" cy="6.5" r="5" />
                <path d="M10 10l4 4" strokeLinecap="round" />
              </svg>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[--ui-text-muted] hover:text-[--ui-text-primary]"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Sessions list */}
          {view === 'sessions' && (
            <div className="p-2">
              {!projectId ? (
                <div className="py-12 text-center text-[--ui-text-muted] text-sm">
                  <p>Not a git repository</p>
                  <p className="mt-1 text-xs">History is only tracked for git projects.</p>
                </div>
              ) : sessions.length === 0 ? (
                <div className="py-12 text-center text-[--ui-text-muted] text-sm">
                  <p>No history yet.</p>
                  <p className="mt-1 text-xs">Conversations will appear here as you use Claude.</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {sessions.map((session) => (
                    <div
                      key={session.date}
                      className="group/row flex items-center rounded-lg hover:bg-[--ui-bg-active] transition-colors"
                    >
                      <button
                        onClick={() => loadDayContent(session.date)}
                        className="flex-1 p-3 text-left"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-[--ui-text-primary]">
                            {formatDate(session.date)}
                          </span>
                          <span className="text-xs text-[--ui-text-muted]">
                            {session.exchangeCount} exchanges
                          </span>
                        </div>
                        <div className="text-xs text-[--ui-text-muted] truncate">
                          {session.preview || 'No preview available'}
                        </div>
                        <div className="text-xs text-[--ui-text-faint] mt-1">
                          {formatFileSize(session.size)}
                        </div>
                      </button>
                      <button
                        onClick={(e) => deleteDay(session.date, e)}
                        className="p-2 mr-2 text-[--ui-text-muted] hover:text-red-400 opacity-0 group-hover/row:opacity-100 transition-all shrink-0"
                        aria-label="Delete day"
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M2 4h12M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M6 7v5M10 7v5" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M3 4l1 10a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-10" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Day content view */}
          {view === 'content' && renderExchangeCards()}

          {/* Search results view */}
          {view === 'search' && (
            <div className="p-4">
              {isSearching ? (
                <div className="py-12 text-center text-[--ui-text-muted] text-sm">
                  Searching...
                </div>
              ) : searchResults.length === 0 ? (
                <div className="py-12 text-center text-[--ui-text-muted] text-sm">
                  No results found for "{searchQuery}"
                </div>
              ) : (
                <div className="space-y-4">
                  {searchResults.map((result, i) => (
                    <div key={`${result.date}-${i}`} className="border border-[--ui-border] rounded-lg overflow-hidden">
                      <button
                        onClick={() => loadDayContent(result.date)}
                        className="w-full px-3 py-2 text-left text-sm font-medium text-[--ui-text-primary] bg-[--ui-bg-primary] hover:bg-[--ui-bg-active] transition-colors flex items-center justify-between"
                      >
                        <span>{formatDate(result.date)}</span>
                        <span className="text-xs text-[--ui-text-muted]">{result.matches.length} matches</span>
                      </button>
                      <div className="p-3 space-y-2">
                        {result.matches.slice(0, 3).map((match, j) => (
                          <div
                            key={j}
                            className="text-xs text-[--ui-text-secondary] font-mono bg-[--ui-bg-primary] p-2 rounded whitespace-pre-wrap break-words"
                          >
                            {match}
                          </div>
                        ))}
                        {result.matches.length > 3 && (
                          <div className="text-xs text-[--ui-text-muted] text-center">
                            +{result.matches.length - 3} more matches
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[--ui-border] shrink-0">
          <div className="text-xs text-[--ui-text-muted] text-center">
            {sessions.length > 0
              ? `${sessions.length} day${sessions.length === 1 ? '' : 's'} of history`
              : 'History is saved automatically'}
          </div>
        </div>
      </div>
    </div>
  )
})
