import { useState, useEffect, useRef, KeyboardEvent, memo } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { HotkeyBindings, DEFAULT_HOTKEYS } from '../../shared/types'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

type HotkeyField = keyof HotkeyBindings

export const SettingsModal = memo(function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { preferences, updatePreferences } = useWorkspaceStore()
  const { hotkeys, fontSize, theme } = preferences
  const modalRef = useRef<HTMLDivElement>(null)
  const firstFocusableRef = useRef<HTMLButtonElement>(null)

  // Track which hotkey field is being edited
  const [editingHotkey, setEditingHotkey] = useState<HotkeyField | null>(null)

  // App version
  const [appVersion, setAppVersion] = useState<string>('')

  // Fetch app version on mount
  useEffect(() => {
    window.electronAPI.getAppVersion().then(setAppVersion)
  }, [])

  // Focus first element when modal opens
  useEffect(() => {
    if (isOpen && firstFocusableRef.current) {
      firstFocusableRef.current.focus()
    }
  }, [isOpen])

  // Close on Escape and trap focus
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !editingHotkey) {
        onClose()
      }
      // Trap focus within modal
      if (e.key === 'Tab' && modalRef.current) {
        const focusableElements = modalRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        const firstElement = focusableElements[0] as HTMLElement
        const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement

        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault()
          lastElement.focus()
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault()
          firstElement.focus()
        }
      }
    }

    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose, editingHotkey])

  // Close when clicking outside modal
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  // Handle hotkey capture
  const handleHotkeyKeyDown = (e: KeyboardEvent<HTMLButtonElement>, field: HotkeyField) => {
    e.preventDefault()
    e.stopPropagation()

    // Ignore modifier-only keys
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
      return
    }

    // Build the key string with modifiers
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
    const parts: string[] = []
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey) parts.push(isMac ? 'Cmd' : 'Win')

    // Add the actual key
    let key = e.key
    // Normalize key display (uppercase for letters/numbers, keep F-keys as-is)
    if (key.length === 1) {
      key = key.toUpperCase()
    } else if (key.startsWith('F') && key.length <= 3) {
      key = key.toUpperCase()
    }
    parts.push(key)

    const hotkeyString = parts.join('+')

    // Update the hotkey
    updatePreferences({
      hotkeys: {
        ...hotkeys,
        [field]: hotkeyString,
      },
    })

    setEditingHotkey(null)
  }

  const handleResetHotkeys = () => {
    updatePreferences({ hotkeys: DEFAULT_HOTKEYS })
  }

  // Keyboard navigation for theme buttons
  const themes = ['dark', 'light', 'system'] as const
  const handleThemeKeyDown = (e: React.KeyboardEvent, currentTheme: typeof themes[number]) => {
    const currentIndex = themes.indexOf(currentTheme)
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      const nextIndex = (currentIndex + 1) % themes.length
      updatePreferences({ theme: themes[nextIndex] })
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      const prevIndex = (currentIndex - 1 + themes.length) % themes.length
      updatePreferences({ theme: themes[prevIndex] })
    }
  }

  const terminalHotkeyLabels: Partial<Record<HotkeyField, string>> = {
    focusTerminal1: 'Terminal 1',
    focusTerminal2: 'Terminal 2',
    focusTerminal3: 'Terminal 3',
    focusTerminal4: 'Terminal 4',
  }

  const layoutHotkeyLabels: Partial<Record<HotkeyField, string>> = {
    layoutGrid: 'Grid',
    layoutFocus: 'Focus',
    layoutSplit: 'Split',
    layoutHorizontal: 'Horizontal',
    layoutVertical: 'Vertical',
    layoutFullscreen: 'Fullscreen',
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        ref={modalRef}
        className="bg-terminal-bg border border-terminal-border shadow-xl w-full max-w-md mx-4 font-mono"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        {/* Header with ASCII border */}
        <div className="border-b border-terminal-border">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-terminal-muted text-xs" aria-hidden="true">┌──</span>
            <h2 id="settings-title" className="text-sm text-claude-pink">[ SETTINGS ]</h2>
            <button
              ref={firstFocusableRef}
              onClick={onClose}
              className="text-terminal-muted hover:text-claude-pink transition-colors text-xs"
              aria-label="Close settings"
            >
              [×]
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-4 space-y-5">
          {/* Appearance Section */}
          <div role="group" aria-labelledby="appearance-heading">
            <div className="mb-3">
              <span id="appearance-heading" className="text-terminal-muted text-xs">─── APPEARANCE ───</span>
            </div>
            <div className="space-y-3">
              {/* Font Size */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-terminal-fg" id="font-size-label">Font Size</span>
                <div className="flex items-center gap-1" role="group" aria-labelledby="font-size-label">
                  <button
                    onClick={() => updatePreferences({ fontSize: Math.max(10, fontSize - 1) })}
                    className="w-6 h-6 flex items-center justify-center text-xs border border-terminal-border text-terminal-muted hover:border-claude-pink hover:text-claude-pink transition-colors"
                    aria-label="Decrease font size"
                  >
                    [-]
                  </button>
                  <span className="w-8 text-center text-xs text-terminal-fg" aria-live="polite">
                    {fontSize}
                  </span>
                  <button
                    onClick={() => updatePreferences({ fontSize: Math.min(24, fontSize + 1) })}
                    className="w-6 h-6 flex items-center justify-center text-xs border border-terminal-border text-terminal-muted hover:border-claude-pink hover:text-claude-pink transition-colors"
                    aria-label="Increase font size"
                  >
                    [+]
                  </button>
                </div>
              </div>

              {/* Theme */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-terminal-fg" id="theme-label">Theme</span>
                <div className="flex items-center gap-1" role="radiogroup" aria-labelledby="theme-label">
                  {themes.map((t) => (
                    <button
                      key={t}
                      onClick={() => updatePreferences({ theme: t })}
                      onKeyDown={(e) => handleThemeKeyDown(e, t)}
                      className={`px-2 py-1 text-xs border transition-colors ${
                        theme === t
                          ? 'border-claude-pink text-claude-pink'
                          : 'border-terminal-border text-terminal-muted hover:border-claude-pink hover:text-terminal-fg'
                      }`}
                      role="radio"
                      aria-checked={theme === t}
                      aria-label={`${t} theme`}
                    >
                      [{t}]
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Hotkeys Section */}
          <div role="group" aria-labelledby="hotkeys-heading">
            <div className="flex items-center justify-between mb-3">
              <span id="hotkeys-heading" className="text-terminal-muted text-xs">─── HOTKEYS ───</span>
              <button
                onClick={handleResetHotkeys}
                className="text-xs text-terminal-muted hover:text-claude-pink transition-colors"
                aria-label="Reset hotkeys to defaults"
              >
                [reset]
              </button>
            </div>

            {/* Terminal Swap Hotkeys */}
            <div className="mb-3">
              <span className="text-terminal-muted text-[10px]">Terminal Swap</span>
            </div>
            <div className="space-y-2 mb-4">
              {(Object.keys(terminalHotkeyLabels) as HotkeyField[]).map((field) => (
                <div key={field} className="flex items-center justify-between">
                  <span className="text-xs text-terminal-fg" id={`hotkey-label-${field}`}>
                    {terminalHotkeyLabels[field]}
                  </span>
                  <button
                    onClick={() => setEditingHotkey(field)}
                    onKeyDown={(e) => editingHotkey === field && handleHotkeyKeyDown(e, field)}
                    onBlur={() => setEditingHotkey(null)}
                    className={`px-2 py-1 min-w-[100px] text-xs text-center border transition-colors ${
                      editingHotkey === field
                        ? 'border-claude-pink bg-claude-pink/10 text-claude-pink'
                        : 'border-terminal-border text-terminal-muted hover:border-claude-pink hover:text-terminal-fg'
                    }`}
                    aria-labelledby={`hotkey-label-${field}`}
                    aria-describedby={editingHotkey === field ? 'hotkey-edit-hint' : undefined}
                  >
                    {editingHotkey === field ? '[ press key... ]' : `[ ${hotkeys[field]} ]`}
                  </button>
                </div>
              ))}
            </div>

            {/* Layout Hotkeys */}
            <div className="mb-3">
              <span className="text-terminal-muted text-[10px]">Layout Switch</span>
            </div>
            <div className="space-y-2">
              {(Object.keys(layoutHotkeyLabels) as HotkeyField[]).map((field) => (
                <div key={field} className="flex items-center justify-between">
                  <span className="text-xs text-terminal-fg" id={`hotkey-label-${field}`}>
                    {layoutHotkeyLabels[field]}
                  </span>
                  <button
                    onClick={() => setEditingHotkey(field)}
                    onKeyDown={(e) => editingHotkey === field && handleHotkeyKeyDown(e, field)}
                    onBlur={() => setEditingHotkey(null)}
                    className={`px-2 py-1 min-w-[100px] text-xs text-center border transition-colors ${
                      editingHotkey === field
                        ? 'border-claude-pink bg-claude-pink/10 text-claude-pink'
                        : 'border-terminal-border text-terminal-muted hover:border-claude-pink hover:text-terminal-fg'
                    }`}
                    aria-labelledby={`hotkey-label-${field}`}
                    aria-describedby={editingHotkey === field ? 'hotkey-edit-hint' : undefined}
                  >
                    {editingHotkey === field ? '[ press key... ]' : `[ ${hotkeys[field]} ]`}
                  </button>
                </div>
              ))}
              <span id="hotkey-edit-hint" className="sr-only">
                Press any key combination to set the hotkey
              </span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-terminal-border px-4 py-3">
          <div className="text-[10px] text-terminal-muted text-center">
            built by{' '}
            <a
              href="https://x.com/rdyplayerB"
              target="_blank"
              rel="noopener noreferrer"
              className="text-claude-pink hover:underline"
            >
              @rdyplayerB
            </a>
            {' '}|{' '}
            <a
              href="https://github.com/rdyplayerB/QuadClaude"
              target="_blank"
              rel="noopener noreferrer"
              className="text-claude-pink hover:underline"
            >
              GitHub
            </a>
            {' '}| MIT License | v{appVersion}
          </div>
        </div>
      </div>
    </div>
  )
})
