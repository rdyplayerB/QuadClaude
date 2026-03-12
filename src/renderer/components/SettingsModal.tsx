import { useState, useEffect, useRef, KeyboardEvent, memo } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { HotkeyBindings, DEFAULT_HOTKEYS, DEFAULT_BACKGROUND, BackgroundMode } from '../../shared/types'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

type HotkeyField = keyof HotkeyBindings

export const SettingsModal = memo(function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { preferences, updatePreferences, updateBackground } = useWorkspaceStore()
  const { hotkeys, fontSize } = preferences
  const background = preferences.background ?? DEFAULT_BACKGROUND
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

  const terminalHotkeyLabels: Partial<Record<HotkeyField, string>> = {
    focusTerminal1: 'Terminal 1',
    focusTerminal2: 'Terminal 2',
    focusTerminal3: 'Terminal 3',
    focusTerminal4: 'Terminal 4',
  }

  const layoutHotkeyLabels: Partial<Record<HotkeyField, string>> = {
    layoutGrid: 'Grid',
    layoutFocus: 'Focus Left',
    layoutFocusRight: 'Focus Right',
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        ref={modalRef}
        className="glass-elevated glass-border rounded-xl shadow-2xl w-full max-w-md mx-4 backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b glass-border">
          <h2 id="settings-title" className="text-lg font-semibold text-[--ui-text-primary]">Settings</h2>
          <button
            ref={firstFocusableRef}
            onClick={onClose}
            className="p-1.5 text-[--ui-text-muted] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active]/50 rounded-lg transition-all"
            aria-label="Close settings"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-6 max-h-[60vh] overflow-y-auto">
          {/* Appearance Section */}
          <div role="group" aria-labelledby="appearance-heading">
            <h3 id="appearance-heading" className="text-sm font-medium text-[--ui-text-muted] uppercase tracking-wide mb-4">
              Appearance
            </h3>
            <div className="space-y-4">
              {/* Font Size */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-[--ui-text-primary]" id="font-size-label">Font Size</span>
                <div className="flex items-center gap-2" role="group" aria-labelledby="font-size-label">
                  <button
                    onClick={() => updatePreferences({ fontSize: Math.max(10, fontSize - 1) })}
                    className="w-8 h-8 flex items-center justify-center text-sm glass-control text-[--ui-text-secondary] hover:border-[--accent] hover:text-[--accent] transition-all rounded-lg"
                    aria-label="Decrease font size"
                  >
                    −
                  </button>
                  <span className="w-10 text-center text-sm font-medium text-[--ui-text-primary]" aria-live="polite">
                    {fontSize}
                  </span>
                  <button
                    onClick={() => updatePreferences({ fontSize: Math.min(24, fontSize + 1) })}
                    className="w-8 h-8 flex items-center justify-center text-sm glass-control text-[--ui-text-secondary] hover:border-[--accent] hover:text-[--accent] transition-all rounded-lg"
                    aria-label="Increase font size"
                  >
                    +
                  </button>
                </div>
              </div>

            </div>
          </div>

          {/* Background Section */}
          <div role="group" aria-labelledby="background-heading">
            <h3 id="background-heading" className="text-sm font-medium text-[--ui-text-muted] uppercase tracking-wide mb-4">
              Background
            </h3>
            <div className="space-y-4">
              {/* Enable toggle */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-[--ui-text-primary]">Show Background</span>
                <button
                  onClick={() => updateBackground({ enabled: !background.enabled })}
                  className={`w-10 h-6 rounded-full transition-all relative ${
                    background.enabled ? 'bg-[--accent]' : 'glass-control'
                  }`}
                  role="switch"
                  aria-checked={background.enabled}
                  aria-label="Toggle background"
                >
                  <div className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-all ${
                    background.enabled ? 'left-5' : 'left-1'
                  }`} />
                </button>
              </div>

              {background.enabled && (
                <>
                  {/* Mode */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-[--ui-text-primary]" id="bg-mode-label">Mode</span>
                    <div className="flex items-center glass-control rounded-lg p-1" role="radiogroup" aria-labelledby="bg-mode-label">
                      {(['unified', 'per-pane'] as BackgroundMode[]).map((m) => (
                        <button
                          key={m}
                          onClick={() => updateBackground({ mode: m })}
                          className={`px-3 py-1.5 text-sm rounded-md transition-all ${
                            background.mode === m
                              ? 'glass-control-active text-[--ui-text-primary] font-medium'
                              : 'text-[--ui-text-muted] hover:text-[--ui-text-secondary]'
                          }`}
                          role="radio"
                          aria-checked={background.mode === m}
                        >
                          {m === 'unified' ? 'All Windows' : 'Per Window'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Wallpaper gallery */}
                  <div>
                    <span className="text-sm text-[--ui-text-primary] mb-2 block">Wallpaper</span>
                    <div className="grid grid-cols-3 gap-2">
                      {/* Bundled wallpapers */}
                      {[
                        { src: 'backgrounds/bg.png', label: 'Rooftop' },
                      ].map((wp) => (
                        <button
                          key={wp.src}
                          onClick={() => updateBackground({ image: wp.src })}
                          className={`relative aspect-video rounded-lg overflow-hidden border-2 transition-all ${
                            background.image === wp.src
                              ? 'border-[--accent] shadow-lg shadow-[--accent]/20'
                              : 'glass-border hover:border-[--ui-text-muted]'
                          }`}
                          title={wp.label}
                        >
                          <img
                            src={wp.src}
                            alt={wp.label}
                            className="w-full h-full object-cover"
                            draggable={false}
                          />
                          <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 py-1">
                            <span className="text-[10px] text-white/80">{wp.label}</span>
                          </div>
                          {background.image === wp.src && (
                            <div className="absolute top-1 right-1 w-4 h-4 bg-[--accent] rounded-full flex items-center justify-center">
                              <svg width="10" height="10" viewBox="0 0 16 16" fill="white">
                                <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
                              </svg>
                            </div>
                          )}
                        </button>
                      ))}
                      {/* Custom wallpapers from user */}
                      {(preferences.background?.customWallpapers ?? []).map((wp) => (
                        <div
                          key={wp}
                          onClick={() => updateBackground({ image: wp })}
                          className={`relative aspect-video rounded-lg overflow-hidden border-2 transition-all group cursor-pointer ${
                            background.image === wp
                              ? 'border-[--accent] shadow-lg shadow-[--accent]/20'
                              : 'glass-border hover:border-[--ui-text-muted]'
                          }`}
                          title={wp.split('/').pop()}
                        >
                          <img
                            src={`file://${wp}`}
                            alt={wp.split('/').pop()}
                            className="w-full h-full object-cover"
                            draggable={false}
                          />
                          <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 py-1">
                            <span className="text-[10px] text-white/80 truncate block">{wp.split('/').pop()}</span>
                          </div>
                          {background.image === wp && (
                            <div className="absolute top-1 right-1 w-4 h-4 bg-[--accent] rounded-full flex items-center justify-center">
                              <svg width="10" height="10" viewBox="0 0 16 16" fill="white">
                                <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
                              </svg>
                            </div>
                          )}
                          {/* Remove button */}
                          <div
                            onClick={(e) => {
                              e.stopPropagation()
                              const customs = (preferences.background?.customWallpapers ?? []).filter(w => w !== wp)
                              updateBackground({
                                customWallpapers: customs,
                                ...(background.image === wp ? { image: DEFAULT_BACKGROUND.image } : {}),
                              })
                            }}
                            className="absolute top-1 left-1 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500 cursor-pointer"
                            title="Remove wallpaper"
                          >
                            <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                              <path d="M4 4l8 8M12 4l-8 8" stroke="white" strokeWidth="2.5" strokeLinecap="round"/>
                            </svg>
                          </div>
                        </div>
                      ))}
                      {/* Add custom wallpaper button */}
                      <button
                        onClick={async () => {
                          const filePath = await window.electronAPI.openImageDialog()
                          if (filePath) {
                            const customs = [...(preferences.background?.customWallpapers ?? []), filePath]
                            updateBackground({ image: filePath, customWallpapers: customs })
                          }
                        }}
                        className="aspect-video rounded-lg border-2 border-dashed glass-border hover:border-[--accent] flex flex-col items-center justify-center gap-1 transition-all text-[--ui-text-muted] hover:text-[--accent]"
                        title="Add custom wallpaper"
                      >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M8 3v10M3 8h10"/>
                        </svg>
                        <span className="text-[10px]">Add</span>
                      </button>
                    </div>
                  </div>

                  {/* Opacity slider */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-[--ui-text-primary]" id="bg-opacity-label">Opacity</span>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.02"
                        value={background.opacity}
                        onChange={(e) => updateBackground({ opacity: parseFloat(e.target.value) })}
                        className="w-28 accent-[--accent]"
                        aria-labelledby="bg-opacity-label"
                      />
                      <span className="text-xs text-[--ui-text-muted] w-10 text-right">
                        {Math.round(background.opacity * 100)}%
                      </span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Hotkeys Section */}
          <div role="group" aria-labelledby="hotkeys-heading">
            <div className="flex items-center justify-between mb-4">
              <h3 id="hotkeys-heading" className="text-sm font-medium text-[--ui-text-muted] uppercase tracking-wide">
                Keyboard Shortcuts
              </h3>
              <button
                onClick={handleResetHotkeys}
                className="text-xs text-[--ui-text-muted] hover:text-[--accent] transition-colors"
                aria-label="Reset hotkeys to defaults"
              >
                Reset to defaults
              </button>
            </div>

            {/* Terminal Focus Hotkeys */}
            <div className="mb-4">
              <span className="text-xs text-[--ui-text-muted] mb-2 block">Focus Terminal</span>
              <div className="space-y-2">
                {(Object.keys(terminalHotkeyLabels) as HotkeyField[]).map((field) => (
                  <div key={field} className="flex items-center justify-between">
                    <span className="text-sm text-[--ui-text-primary]" id={`hotkey-label-${field}`}>
                      {terminalHotkeyLabels[field]}
                    </span>
                    <button
                      onClick={() => setEditingHotkey(field)}
                      onKeyDown={(e) => editingHotkey === field && handleHotkeyKeyDown(e, field)}
                      onBlur={() => setEditingHotkey(null)}
                      className={`px-3 py-1.5 min-w-[100px] text-sm text-center rounded-lg transition-all ${
                        editingHotkey === field
                          ? 'bg-[--accent]/10 border-2 border-[--accent] text-[--accent]'
                          : 'glass-control text-[--ui-text-secondary] hover:border-[--accent] hover:text-[--ui-text-primary]'
                      }`}
                      aria-labelledby={`hotkey-label-${field}`}
                    >
                      {editingHotkey === field ? 'Press key...' : hotkeys[field]}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Layout Hotkeys */}
            <div>
              <span className="text-xs text-[--ui-text-muted] mb-2 block">Switch Layout</span>
              <div className="space-y-2">
                {(Object.keys(layoutHotkeyLabels) as HotkeyField[]).map((field) => (
                  <div key={field} className="flex items-center justify-between">
                    <span className="text-sm text-[--ui-text-primary]" id={`hotkey-label-${field}`}>
                      {layoutHotkeyLabels[field]}
                    </span>
                    <button
                      onClick={() => setEditingHotkey(field)}
                      onKeyDown={(e) => editingHotkey === field && handleHotkeyKeyDown(e, field)}
                      onBlur={() => setEditingHotkey(null)}
                      className={`px-3 py-1.5 min-w-[100px] text-sm text-center rounded-lg transition-all ${
                        editingHotkey === field
                          ? 'bg-[--accent]/10 border-2 border-[--accent] text-[--accent]'
                          : 'glass-control text-[--ui-text-secondary] hover:border-[--accent] hover:text-[--ui-text-primary]'
                      }`}
                      aria-labelledby={`hotkey-label-${field}`}
                    >
                      {editingHotkey === field ? 'Press key...' : hotkeys[field]}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t glass-border">
          <div className="text-xs text-[--ui-text-muted] text-center">
            crafted by{' '}
            <a
              href="https://birudo.studio"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[--accent] hover:underline"
            >
              ビルド studio
            </a>
            {' '}·{' '}
            <a
              href="https://github.com/rdyplayerB/QuadClaude"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[--accent] hover:underline"
            >
              GitHub
            </a>
            {' '}· v{appVersion}
          </div>
        </div>
      </div>
    </div>
  )
})
