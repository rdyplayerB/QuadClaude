import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { sendToTerminal } from './TerminalPane'

interface FavoritesDropdownProps {
  paneId: number
  currentDirectory: string
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '')
}

function getFolderName(path: string): string {
  if (!path) return ''
  const parts = path.split('/')
  const name = parts[parts.length - 1] || parts[parts.length - 2]
  if (path.match(/^\/Users\/[^/]+\/?$/)) return '~'
  return name || path
}

export const FavoritesDropdown = memo(function FavoritesDropdown({ paneId, currentDirectory }: FavoritesDropdownProps) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const { preferences, updatePreferences } = useWorkspaceStore()

  const favorites = preferences.favoriteDirectories
  const normalizedCwd = normalizePath(currentDirectory)
  const isCwdStarred = favorites.some((f) => normalizePath(f) === normalizedCwd)

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const toggleOpen = useCallback(() => setOpen((o) => !o), [])

  const addFavorite = useCallback(() => {
    if (isCwdStarred || !currentDirectory) return
    updatePreferences({ favoriteDirectories: [...favorites, normalizePath(currentDirectory)] })
  }, [isCwdStarred, currentDirectory, favorites, updatePreferences])

  const removeFavorite = useCallback((path: string) => {
    const normalized = normalizePath(path)
    updatePreferences({ favoriteDirectories: favorites.filter((f) => normalizePath(f) !== normalized) })
  }, [favorites, updatePreferences])

  const navigateTo = useCallback((path: string) => {
    sendToTerminal(paneId, `cd "${path}"\n`)
    setOpen(false)
  }, [paneId])

  // Calculate dropdown position
  const getPosition = () => {
    if (!buttonRef.current) return { top: 0, left: 0 }
    const rect = buttonRef.current.getBoundingClientRect()
    return { top: rect.bottom + 4, left: rect.right - 220 }
  }

  return (
    <>
      <button
        ref={buttonRef}
        onClick={toggleOpen}
        className="p-1 text-[--ui-text-muted] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active]/50 transition-all rounded"
        title="Favorite Directories"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill={isCwdStarred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2">
          <path d="M7 1.5l1.76 3.57 3.94.57-2.85 2.78.67 3.93L7 10.5l-3.52 1.85.67-3.93L1.3 5.64l3.94-.57L7 1.5z"/>
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          className="fixed z-50 w-[220px] bg-[--ui-bg-elevated] border border-[#444] rounded-md shadow-lg overflow-hidden"
          style={getPosition()}
        >
          {/* Favorite list */}
          {favorites.length === 0 ? (
            <div className="px-3 py-2 text-xs text-[--ui-text-muted]">No favorites yet</div>
          ) : (
            <div className="max-h-[200px] overflow-y-auto">
              {favorites.map((path) => (
                <div
                  key={path}
                  className="group/fav flex items-center gap-1 px-3 py-1.5 hover:bg-[--ui-bg-active]/50 cursor-pointer text-xs"
                  onClick={() => navigateTo(path)}
                  title={path}
                >
                  <span className="truncate flex-1 text-[--ui-text-primary]">{getFolderName(path)}</span>
                  <button
                    className="shrink-0 p-0.5 text-[--ui-text-muted] hover:text-red-400 opacity-0 group-hover/fav:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeFavorite(path)
                    }}
                    title="Remove"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M2 2l6 6M8 2l-6 6" strokeLinecap="round"/>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Divider */}
          <div className="border-t border-[#444]" />

          {/* Star/Unstar current directory */}
          <button
            className="w-full px-3 py-1.5 text-xs text-left hover:bg-[--ui-bg-active]/50 flex items-center gap-2"
            onClick={() => {
              if (isCwdStarred) {
                removeFavorite(currentDirectory)
              } else {
                addFavorite()
              }
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill={isCwdStarred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1">
              <path d="M6 1l1.5 3.1L11 4.5 8.5 7l.6 3.5L6 8.8 2.9 10.5l.6-3.5L1 4.5l3.5-.4z"/>
            </svg>
            <span className="text-[--ui-text-muted]">
              {isCwdStarred ? 'Unstar current directory' : 'Star current directory'}
            </span>
          </button>
        </div>
      )}
    </>
  )
})
