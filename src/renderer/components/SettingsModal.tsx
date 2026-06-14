import { useState, useEffect, useRef, KeyboardEvent, memo, ReactNode } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { HotkeyBindings, DEFAULT_HOTKEYS, DEFAULT_BACKGROUND, BackgroundMode } from '../../shared/types'
import { AgentsSettings } from './AgentsSettings'
import { ModelRouterSettings } from './ModelRouterSettings'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

type HotkeyField = keyof HotkeyBindings
type TabId = 'general' | 'models' | 'agents' | 'background' | 'shortcuts' | 'about'

// One toggle, defined once so every switch in Settings looks and behaves identically.
function Toggle({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <button
      onClick={onChange}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`shrink-0 w-10 h-6 rounded-full transition-all relative ${on ? 'bg-[--accent]' : 'glass-control'}`}
    >
      <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${on ? 'left-5' : 'left-1'}`} />
    </button>
  )
}

// A labelled settings row: title (+ optional caption) on the left, control on the right.
function SettingRow({ title, caption, children }: { title: string; caption?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm text-[--ui-text-primary]">{title}</span>
        {caption && <span className="text-[11px] text-[--ui-text-dimmed]">{caption}</span>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

const TAB_ICONS: Record<TabId, ReactNode> = {
  general: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M2 4.5h8M12.5 4.5H14M2 11.5h3.5M8 11.5h6" />
      <circle cx="11" cy="4.5" r="1.6" /><circle cx="6.5" cy="11.5" r="1.6" />
    </svg>
  ),
  models: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5l1.6 3.4 3.4 1.6-3.4 1.6L8 11.5 6.4 8.1 3 6.5l3.4-1.6L8 1.5zM12.5 11l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7.7-1.6z" />
    </svg>
  ),
  agents: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M4 6l2 2-2 2M8 10h4" />
    </svg>
  ),
  background: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><circle cx="5.5" cy="6" r="1.2" /><path d="M2 11l3.5-3 3 2.5L11 7l3 3" />
    </svg>
  ),
  shortcuts: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" /><path d="M4 6h.01M7 6h.01M10 6h.01M5 9h6" />
    </svg>
  ),
  about: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="8" cy="8" r="6.5" /><path d="M8 7.2v3.4M8 5.2v.01" />
    </svg>
  ),
}

const TABS: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models' },
  { id: 'agents', label: 'Agents' },
  { id: 'background', label: 'Background' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'about', label: 'About' },
]

export const SettingsModal = memo(function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { preferences, updatePreferences, updateBackground } = useWorkspaceStore()
  const { hotkeys, fontSize } = preferences
  const background = preferences.background ?? DEFAULT_BACKGROUND
  const modalRef = useRef<HTMLDivElement>(null)
  const firstFocusableRef = useRef<HTMLButtonElement>(null)

  const [tab, setTab] = useState<TabId>('general')
  const [editingHotkey, setEditingHotkey] = useState<HotkeyField | null>(null)
  const [appVersion, setAppVersion] = useState<string>('')

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

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  // Handle hotkey capture
  const handleHotkeyKeyDown = (e: KeyboardEvent<HTMLButtonElement>, field: HotkeyField) => {
    e.preventDefault()
    e.stopPropagation()
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
    const parts: string[] = []
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey) parts.push(isMac ? 'Cmd' : 'Win')

    let key = e.key
    if (key.length === 1) {
      key = key.toUpperCase()
    } else if (key.startsWith('F') && key.length <= 3) {
      key = key.toUpperCase()
    }
    parts.push(key)

    updatePreferences({ hotkeys: { ...hotkeys, [field]: parts.join('+') } })
    setEditingHotkey(null)
  }

  const handleResetHotkeys = () => updatePreferences({ hotkeys: DEFAULT_HOTKEYS })

  const terminalHotkeyLabels: Partial<Record<HotkeyField, string>> = {
    focusTerminal1: 'Pane 1',
    focusTerminal2: 'Pane 2',
    focusTerminal3: 'Pane 3',
    focusTerminal4: 'Pane 4',
  }

  const layoutHotkeyLabels: Partial<Record<HotkeyField, string>> = {
    layoutGrid: 'Grid',
    layoutFocus: 'Focus left',
    layoutFocusRight: 'Focus right',
  }

  if (!isOpen) return null

  const renderHotkeyRow = (field: HotkeyField, label: string) => (
    <div key={field} className="flex items-center justify-between">
      <span className="text-sm text-[--ui-text-primary]" id={`hotkey-label-${field}`}>{label}</span>
      <button
        onClick={() => setEditingHotkey(field)}
        onKeyDown={(e) => editingHotkey === field && handleHotkeyKeyDown(e, field)}
        onBlur={() => setEditingHotkey(null)}
        className={`px-3 py-1.5 min-w-[104px] text-sm text-center rounded-lg transition-all ${
          editingHotkey === field
            ? 'bg-[--accent]/10 border-2 border-[--accent] text-[--accent]'
            : 'glass-control text-[--ui-text-secondary] hover:border-[--accent] hover:text-[--ui-text-primary]'
        }`}
        aria-labelledby={`hotkey-label-${field}`}
      >
        {editingHotkey === field ? 'Press keys…' : hotkeys[field]}
      </button>
    </div>
  )

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        ref={modalRef}
        className="glass-elevated glass-border rounded-xl shadow-2xl w-full max-w-3xl mx-4 h-[34rem] max-h-[88vh] flex flex-col backdrop-blur-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b glass-border shrink-0">
          <h2 id="settings-title" className="text-base font-semibold text-[--ui-text-primary]">Settings</h2>
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

        {/* Body: nav rail + content */}
        <div className="flex flex-1 min-h-0">
          {/* Nav rail */}
          <nav className="w-44 shrink-0 border-r glass-border p-2 space-y-0.5" aria-label="Settings sections">
            {TABS.map((t) => {
              const active = tab === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-all ${
                    active
                      ? 'bg-[--accent]/12 text-[--accent] font-medium'
                      : 'text-[--ui-text-muted] hover:text-[--ui-text-primary] hover:bg-[--ui-bg-active]/40'
                  }`}
                >
                  <span className={active ? 'text-[--accent]' : 'text-[--ui-text-dimmed]'}>{TAB_ICONS[t.id]}</span>
                  {t.label}
                </button>
              )
            })}
          </nav>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
            {tab === 'general' && (
              <div className="space-y-1">
                <SettingRow title="Font size">
                  <div className="flex items-center gap-2" role="group" aria-label="Font size">
                    <button
                      onClick={() => updatePreferences({ fontSize: Math.max(10, fontSize - 1) })}
                      className="w-8 h-8 flex items-center justify-center text-sm glass-control text-[--ui-text-secondary] hover:border-[--accent] hover:text-[--accent] transition-all rounded-lg"
                      aria-label="Decrease font size"
                    >
                      −
                    </button>
                    <span className="w-8 text-center text-sm font-medium text-[--ui-text-primary]" aria-live="polite">
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
                </SettingRow>

                <SettingRow title="Prompt bar" caption="Floating toolbar for your saved prompts">
                  <Toggle
                    on={preferences.showPromptBar !== false}
                    onChange={() => updatePreferences({ showPromptBar: preferences.showPromptBar === false })}
                    label="Prompt bar"
                  />
                </SettingRow>

                <SettingRow title="Decision chime" caption="Play a sound when a pane needs a yes/no answer">
                  <Toggle
                    on={preferences.decisionSoundEnabled !== false}
                    onChange={() => updatePreferences({ decisionSoundEnabled: preferences.decisionSoundEnabled === false })}
                    label="Decision chime"
                  />
                </SettingRow>

                <SettingRow title="Skip permission prompts" caption="Launch Claude with --dangerously-skip-permissions · Claude Code only">
                  <Toggle
                    on={!!preferences.dangerouslySkipPermissions}
                    onChange={() => updatePreferences({ dangerouslySkipPermissions: !preferences.dangerouslySkipPermissions })}
                    label="Skip permission prompts"
                  />
                </SettingRow>
              </div>
            )}

            {tab === 'models' && <ModelRouterSettings />}

            {tab === 'agents' && <AgentsSettings />}

            {tab === 'background' && (
              <div className="space-y-4">
                <SettingRow title="Show background" caption="Wallpaper behind every pane">
                  <Toggle
                    on={background.enabled}
                    onChange={() => updateBackground({ enabled: !background.enabled })}
                    label="Show background"
                  />
                </SettingRow>

                {background.enabled && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-[--ui-text-primary]" id="bg-mode-label">Apply to</span>
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
                            {m === 'unified' ? 'All panes' : 'Per pane'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <span className="text-sm text-[--ui-text-primary] mb-2 block">Wallpaper</span>
                      <div className="grid grid-cols-4 gap-2">
                        {[{ src: 'backgrounds/bg.png', label: 'Rooftop' }].map((wp) => (
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
                            <img src={wp.src} alt={wp.label} className="w-full h-full object-cover" draggable={false} />
                            <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 py-1">
                              <span className="text-[10px] text-white/80">{wp.label}</span>
                            </div>
                            {background.image === wp.src && (
                              <div className="absolute top-1 right-1 w-4 h-4 bg-[--accent] rounded-full flex items-center justify-center">
                                <svg width="10" height="10" viewBox="0 0 16 16" fill="white">
                                  <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
                                </svg>
                              </div>
                            )}
                          </button>
                        ))}
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
                            <img src={`file://${wp}`} alt={wp.split('/').pop()} className="w-full h-full object-cover" draggable={false} />
                            <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 py-1">
                              <span className="text-[10px] text-white/80 truncate block">{wp.split('/').pop()}</span>
                            </div>
                            {background.image === wp && (
                              <div className="absolute top-1 right-1 w-4 h-4 bg-[--accent] rounded-full flex items-center justify-center">
                                <svg width="10" height="10" viewBox="0 0 16 16" fill="white">
                                  <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
                                </svg>
                              </div>
                            )}
                            <div
                              onClick={(e) => {
                                e.stopPropagation()
                                const customs = (preferences.background?.customWallpapers ?? []).filter((w) => w !== wp)
                                updateBackground({
                                  customWallpapers: customs,
                                  ...(background.image === wp ? { image: DEFAULT_BACKGROUND.image } : {}),
                                })
                              }}
                              className="absolute top-1 left-1 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500 cursor-pointer"
                              title="Remove wallpaper"
                            >
                              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                                <path d="M4 4l8 8M12 4l-8 8" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
                              </svg>
                            </div>
                          </div>
                        ))}
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
                            <path d="M8 3v10M3 8h10" />
                          </svg>
                          <span className="text-[10px]">Add</span>
                        </button>
                      </div>
                    </div>

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
                          className="w-40 accent-[--accent]"
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
            )}

            {tab === 'shortcuts' && (
              <div>
                <div className="flex items-center justify-end -mt-1 mb-4">
                  <button
                    onClick={handleResetHotkeys}
                    className="text-xs text-[--ui-text-muted] hover:text-[--accent] transition-colors"
                    aria-label="Reset shortcuts to defaults"
                  >
                    Reset to defaults
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-x-8 gap-y-2">
                  <div>
                    <span className="text-xs text-[--ui-text-muted] mb-2 block uppercase tracking-wide">Focus pane</span>
                    <div className="space-y-2">
                      {(Object.keys(terminalHotkeyLabels) as HotkeyField[]).map((field) =>
                        renderHotkeyRow(field, terminalHotkeyLabels[field]!),
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-[--ui-text-muted] mb-2 block uppercase tracking-wide">Switch layout</span>
                    <div className="space-y-2">
                      {(Object.keys(layoutHotkeyLabels) as HotkeyField[]).map((field) =>
                        renderHotkeyRow(field, layoutHotkeyLabels[field]!),
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {tab === 'about' && (
              <div className="h-full flex flex-col items-center justify-center text-center gap-2">
                <div className="text-sm font-medium text-[--ui-text-primary]">QuadClaude</div>
                <div className="text-xs text-[--ui-text-secondary]">The ADHD workspace for Claude Code</div>
                <div className="text-xs text-[--ui-text-muted]">
                  crafted by{' '}
                  <a href="https://birudo.studio" target="_blank" rel="noopener noreferrer" className="text-[--accent] hover:underline">
                    ビルド studio
                  </a>
                  {' '}·{' '}
                  <a href="https://github.com/rdyplayerB/QuadClaude" target="_blank" rel="noopener noreferrer" className="text-[--accent] hover:underline">
                    GitHub
                  </a>
                  {' '}· v{appVersion}
                </div>
                <div className="text-[10px] text-[--ui-text-faint] leading-snug mt-2 max-w-xs">
                  Not affiliated with Anthropic. Claude is a trademark of Anthropic PBC.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
