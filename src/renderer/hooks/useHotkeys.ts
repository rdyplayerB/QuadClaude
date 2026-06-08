import { useEffect, useCallback } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { focusTerminal } from '../components/TerminalPane'
import { LayoutMode } from '../../shared/types'

/**
 * Hook to handle global hotkey bindings for terminal focus and layout switching
 *
 * @param enabled - Whether hotkeys are currently enabled (default: true)
 */
export function useHotkeys(enabled: boolean = true) {
  // Subscribe ONLY to hotkeys (not the whole preferences object), so editing
  // font size / background / prompts doesn't tear down & re-register the
  // global keydown listener.
  const hotkeys = useWorkspaceStore((s) => s.preferences.hotkeys)
  const setLayout = useWorkspaceStore((s) => s.setLayout)

  // Stable callback: reads activePaneId via getState() so it doesn't change
  // identity on every pane focus (which would re-register the listener).
  const handleTerminalFocus = useCallback((terminalIndex: number) => {
    const targetPaneId = terminalIndex // 0-indexed (Terminal 1 = paneId 0)
    const store = useWorkspaceStore.getState()
    const activePaneId = store.activePaneId

    // Ctrl+5/6 only do something when that extra pane exists.
    if (!store.panes.some((p) => p.id === targetPaneId)) return

    // Don't do anything if selecting the already active pane
    if (targetPaneId === activePaneId) {
      focusTerminal(targetPaneId)
      return
    }

    // Swap positions in the panes array
    store.swapPanes(activePaneId, targetPaneId)

    // Make the target pane active and focus it
    store.setActivePaneId(targetPaneId)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        focusTerminal(targetPaneId)
      })
    })
  }, [])

  useEffect(() => {
    if (!enabled) return

    // Parse a hotkey string like "Ctrl+1" or "F1" into parts
    const parseHotkey = (hotkey: string) => {
      const parts = hotkey.toLowerCase().split('+')
      const key = parts.pop() || ''
      const modifiers = {
        ctrl: parts.includes('ctrl'),
        alt: parts.includes('alt'),
        shift: parts.includes('shift'),
        meta: parts.includes('meta') || parts.includes('cmd') || parts.includes('win'),
      }
      return { key, modifiers }
    }

    // Build parsed hotkey configs for terminal swap. Ctrl+5/6 for the extra
    // panes are fixed (not user-rebindable) and no-op when the pane is absent.
    const terminalHotkeyConfigs = [
      { ...parseHotkey(hotkeys.focusTerminal1), index: 0 },
      { ...parseHotkey(hotkeys.focusTerminal2), index: 1 },
      { ...parseHotkey(hotkeys.focusTerminal3), index: 2 },
      { ...parseHotkey(hotkeys.focusTerminal4), index: 3 },
      { ...parseHotkey('Ctrl+5'), index: 4 },
      { ...parseHotkey('Ctrl+6'), index: 5 },
    ]

    // Build parsed hotkey configs for layout switching
    const layoutHotkeyConfigs: { key: string; modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }; layout: LayoutMode }[] = [
      { ...parseHotkey(hotkeys.layoutGrid), layout: 'grid' },
      { ...parseHotkey(hotkeys.layoutFocus), layout: 'focus' },
      { ...parseHotkey(hotkeys.layoutFocusRight), layout: 'focus-right' },
    ]

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in an input field
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      const pressedKey = e.key.toLowerCase()

      // Check for layout switching hotkeys
      for (const config of layoutHotkeyConfigs) {
        const modifiersMatch =
          e.ctrlKey === config.modifiers.ctrl &&
          e.altKey === config.modifiers.alt &&
          e.shiftKey === config.modifiers.shift &&
          e.metaKey === config.modifiers.meta

        if (pressedKey === config.key && modifiersMatch) {
          e.preventDefault()
          e.stopPropagation()
          setLayout(config.layout)
          return
        }
      }

      // Check each terminal focus hotkey config for a match
      for (const config of terminalHotkeyConfigs) {
        const modifiersMatch =
          e.ctrlKey === config.modifiers.ctrl &&
          e.altKey === config.modifiers.alt &&
          e.shiftKey === config.modifiers.shift &&
          e.metaKey === config.modifiers.meta

        if (pressedKey === config.key && modifiersMatch) {
          e.preventDefault()
          e.stopPropagation()
          handleTerminalFocus(config.index)
          return
        }
      }
    }

    // Handle custom event from xterm's key handler
    const handleTerminalHotkey = (e: Event) => {
      const customEvent = e as CustomEvent<{ index: number }>
      handleTerminalFocus(customEvent.detail.index)
    }

    // Use capture phase to intercept before xterm handles the event
    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('terminal-hotkey', handleTerminalHotkey)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('terminal-hotkey', handleTerminalHotkey)
    }
  }, [enabled, hotkeys, handleTerminalFocus, setLayout])
}
