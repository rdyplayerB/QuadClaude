import { memo, useMemo } from 'react'
import { useWorkspaceStore } from '../store/workspace'

const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0

// Format a hotkey string for display (e.g., "Ctrl+1" -> "⌃1" on Mac, "Ctrl+1" on Windows)
function formatHotkey(hotkey: string): string {
  if (isMac) {
    return hotkey
      .replace(/Ctrl\+/gi, '⌃')
      .replace(/Alt\+/gi, '⌥')
      .replace(/Shift\+/gi, '⇧')
      .replace(/Meta\+|Cmd\+|Win\+/gi, '⌘')
  } else {
    return hotkey
      .replace(/Meta\+|Cmd\+|Win\+/gi, 'Win+')
  }
}

export const ShortcutHints = memo(function ShortcutHints() {
  const { preferences } = useWorkspaceStore()
  const { hotkeys } = preferences

  // Format terminal hotkey range (e.g., "⌃1-4" for Ctrl+1 through Ctrl+4)
  const terminalFirst = formatHotkey(hotkeys.focusTerminal1)
  const terminalLastKey = hotkeys.focusTerminal4.split('+').pop() || '4'
  const terminalRange = `${terminalFirst}-${terminalLastKey}`

  // Format layout hotkey range (e.g., "⌘1-6" for Cmd+1 through Cmd+6)
  const layoutFirst = formatHotkey(hotkeys.layoutGrid)
  const layoutLastKey = hotkeys.layoutFullscreen.split('+').pop() || '6'
  const layoutRange = `${layoutFirst}-${layoutLastKey}`

  const hints = useMemo(() => [
    { key: layoutRange, label: 'Layout' },
    { key: terminalRange, label: 'Terminal' },
  ], [layoutRange, terminalRange])

  return (
    <div className="flex items-center gap-4 text-[10px] text-terminal-muted titlebar-no-drag font-mono">
      {hints.map(({ key, label }) => (
        <div key={label} className="flex items-center gap-1">
          <span className="text-terminal-fg">{key}</span>
          <span>{label}</span>
        </div>
      ))}
    </div>
  )
})
