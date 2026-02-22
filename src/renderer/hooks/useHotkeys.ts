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
  const {
    preferences,
    layout,
    activePaneId,
    splitPaneIds,
    setActivePaneId,
    setLayout,
    setSplitPaneId,
    swapPanes,
  } = useWorkspaceStore()

  const handleTerminalFocus = useCallback(
    (terminalIndex: number) => {
      const targetPaneId = terminalIndex // 0-indexed (Terminal 1 = paneId 0)

      // Don't do anything if selecting the already active pane
      if (targetPaneId === activePaneId) {
        focusTerminal(targetPaneId)
        return
      }

      // Swap the active pane with the target pane (same as swap button)
      if (layout === 'split') {
        // In split view, replace the active pane's slot with the target pane
        const activePosition = splitPaneIds.indexOf(activePaneId)
        if (activePosition !== -1) {
          setSplitPaneId(activePosition as 0 | 1, targetPaneId)
        }
      } else {
        // In grid/focus/horizontal/vertical views, swap positions in the panes array
        swapPanes(activePaneId, targetPaneId)
      }

      // Make the target pane active and focus it
      setActivePaneId(targetPaneId)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          focusTerminal(targetPaneId)
        })
      })
    },
    [layout, activePaneId, splitPaneIds, setActivePaneId, setSplitPaneId, swapPanes]
  )

  useEffect(() => {
    if (!enabled) return

    const { hotkeys } = preferences

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

    // Build parsed hotkey configs for terminal swap
    const terminalHotkeyConfigs = [
      { ...parseHotkey(hotkeys.focusTerminal1), index: 0 },
      { ...parseHotkey(hotkeys.focusTerminal2), index: 1 },
      { ...parseHotkey(hotkeys.focusTerminal3), index: 2 },
      { ...parseHotkey(hotkeys.focusTerminal4), index: 3 },
    ]

    // Build parsed hotkey configs for layout switching
    const layoutHotkeyConfigs: { key: string; modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }; layout: LayoutMode }[] = [
      { ...parseHotkey(hotkeys.layoutGrid), layout: 'grid' },
      { ...parseHotkey(hotkeys.layoutFocus), layout: 'focus' },
      { ...parseHotkey(hotkeys.layoutSplit), layout: 'split' },
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
  }, [enabled, preferences, handleTerminalFocus, setLayout])
}
