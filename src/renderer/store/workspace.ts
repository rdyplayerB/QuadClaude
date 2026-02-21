import { create } from 'zustand'
import {
  LayoutMode,
  PaneConfig,
  PaneState,
  WorkspacePreferences,
  WorkspaceState,
  DEFAULT_HOTKEYS,
  GitStatus,
} from '../../shared/types'

interface WorkspaceStore extends WorkspaceState {
  // Initialization
  initialize: () => Promise<void>
  isInitialized: boolean

  // Layout actions
  setLayout: (layout: LayoutMode) => void
  setFocusPaneId: (id: number) => void
  setActivePaneId: (id: number) => void
  setSplitPaneId: (position: 0 | 1, paneId: number) => void
  swapPanes: (paneId1: number, paneId2: number) => void
  resetPaneOrder: () => void

  // Pane actions
  updatePane: (id: number, updates: Partial<PaneConfig>) => void
  setPaneState: (id: number, state: PaneState) => void
  setPaneLabel: (id: number, label: string) => void
  setPaneCwd: (id: number, cwd: string) => void
  setPaneGitStatus: (id: number, gitStatus: GitStatus) => void

  // Preferences
  updatePreferences: (updates: Partial<WorkspacePreferences>) => void

  // Persistence
  saveWorkspace: () => void
}

// Debounce helper
let saveTimeout: ReturnType<typeof setTimeout> | null = null
const debouncedSave = (saveFn: () => void) => {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(saveFn, 500) // Debounce by 500ms
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  // Initial state
  layout: 'grid',
  focusPaneId: 0,
  activePaneId: 0,
  splitPaneIds: [0, 1] as [number, number],
  panes: [],
  preferences: {
    restoreMode: 'cold',
    theme: 'dark',
    fontSize: 14,
    hotkeys: DEFAULT_HOTKEYS,
    savedPrompts: [],
  },
  isInitialized: false,

  // Initialize from saved state
  initialize: async () => {
    try {
      const savedState = await window.electronAPI.loadWorkspace()
      // Merge saved hotkeys with defaults to handle new hotkey fields
      const mergedHotkeys = {
        ...DEFAULT_HOTKEYS,
        ...savedState.preferences?.hotkeys,
      }
      // Ensure new preference fields have defaults
      const savedPrompts = savedState.preferences?.savedPrompts ?? []

      // Migrate removed layouts to 'grid'
      let layout = savedState.layout
      if (layout === 'horizontal' || layout === 'vertical' || layout === 'fullscreen') {
        layout = 'grid'
      }

      set({
        ...savedState,
        layout,
        preferences: {
          ...savedState.preferences,
          hotkeys: mergedHotkeys,
          savedPrompts,
        },
        isInitialized: true,
      })
    } catch (error) {
      console.error('Failed to load workspace:', error)
      // Create default state
      const homeDir = await window.electronAPI.getHomeDir()
      set({
        layout: 'grid',
        focusPaneId: 0,
        activePaneId: 0,
        splitPaneIds: [0, 1] as [number, number],
        panes: [0, 1, 2, 3].map((id) => ({
          id,
          label: `Terminal ${id + 1}`,
          workingDirectory: homeDir,
          state: 'shell' as PaneState,
          wasClaudeActive: false,
        })),
        preferences: {
          restoreMode: 'cold',
          theme: 'dark',
          fontSize: 14,
          hotkeys: DEFAULT_HOTKEYS,
          savedPrompts: [],
        },
        isInitialized: true,
      })
    }
  },

  // Layout actions
  setLayout: (layout) => {
    set({ layout })
    debouncedSave(() => get().saveWorkspace())
  },

  setFocusPaneId: (focusPaneId) => {
    // Swap the target pane to position 0 (the focus position)
    const panes = [...get().panes]
    const currentIndex = panes.findIndex((p) => p.id === focusPaneId)
    if (currentIndex > 0) {
      // Swap with position 0
      ;[panes[0], panes[currentIndex]] = [panes[currentIndex], panes[0]]
      set({ panes, focusPaneId })
    } else {
      set({ focusPaneId })
    }
    debouncedSave(() => get().saveWorkspace())
  },

  setActivePaneId: (activePaneId) => {
    set({ activePaneId })
    // Don't save on active pane change - too frequent
  },

  setSplitPaneId: (position, paneId) => {
    const current = get().splitPaneIds
    const newSplitPaneIds: [number, number] = [...current] as [number, number]
    newSplitPaneIds[position] = paneId
    set({ splitPaneIds: newSplitPaneIds })
    debouncedSave(() => get().saveWorkspace())
  },

  swapPanes: (paneId1, paneId2) => {
    set((state) => {
      const panes = [...state.panes]
      const index1 = panes.findIndex((p) => p.id === paneId1)
      const index2 = panes.findIndex((p) => p.id === paneId2)
      if (index1 !== -1 && index2 !== -1) {
        // Swap positions in array
        ;[panes[index1], panes[index2]] = [panes[index2], panes[index1]]
      }
      return { panes }
    })
    debouncedSave(() => get().saveWorkspace())
  },

  resetPaneOrder: () => {
    set((state) => {
      // Sort panes by their ID to restore sequential order
      const panes = [...state.panes].sort((a, b) => a.id - b.id)
      return { panes, activePaneId: panes[0]?.id ?? 0 }
    })
    debouncedSave(() => get().saveWorkspace())
  },

  // Pane actions
  updatePane: (id, updates) => {
    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.id === id ? { ...pane, ...updates } : pane
      ),
    }))
    debouncedSave(() => get().saveWorkspace())
  },

  setPaneState: (id, paneState) => {
    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.id === id
          ? {
              ...pane,
              state: paneState,
              wasClaudeActive: paneState === 'claude-active' ? true : pane.wasClaudeActive,
            }
          : pane
      ),
    }))
    // Don't save on pane state changes - too frequent during terminal activity
  },

  setPaneLabel: (id, label) => {
    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.id === id ? { ...pane, label } : pane
      ),
    }))
    debouncedSave(() => get().saveWorkspace())
  },

  setPaneCwd: (id, cwd) => {
    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.id === id ? { ...pane, workingDirectory: cwd } : pane
      ),
    }))
    debouncedSave(() => get().saveWorkspace())
  },

  setPaneGitStatus: (id, gitStatus) => {
    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.id === id ? { ...pane, gitStatus } : pane
      ),
    }))
    // Don't save on git status changes - too frequent and not worth persisting
  },

  // Preferences
  updatePreferences: (updates) => {
    set((state) => ({
      preferences: { ...state.preferences, ...updates },
    }))
    debouncedSave(() => get().saveWorkspace())
  },

  // Save to disk (debounced calls converge here)
  saveWorkspace: () => {
    const { layout, focusPaneId, activePaneId, splitPaneIds, panes, preferences } = get()
    window.electronAPI.saveWorkspace({
      layout,
      focusPaneId,
      activePaneId,
      splitPaneIds,
      panes,
      preferences,
    })
  },
}))
