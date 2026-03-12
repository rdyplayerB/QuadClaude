import { create } from 'zustand'
import {
  LayoutMode,
  PaneConfig,
  PaneState,
  WorkspacePreferences,
  WorkspaceState,
  DEFAULT_HOTKEYS,
  DEFAULT_BACKGROUND,
  GitStatus,
  BackgroundConfig,
} from '../../shared/types'

interface WorkspaceStore extends WorkspaceState {
  // Initialization
  initialize: () => Promise<void>
  isInitialized: boolean

  // Layout actions
  setLayout: (layout: LayoutMode) => void
  setFocusPaneId: (id: number) => void
  setActivePaneId: (id: number) => void
  swapPanes: (paneId1: number, paneId2: number) => void

  // Pane actions
  updatePane: (id: number, updates: Partial<PaneConfig>) => void
  setPaneState: (id: number, state: PaneState) => void
  setPaneLabel: (id: number, label: string) => void
  setPaneCwd: (id: number, cwd: string) => void
  setPaneGitStatus: (id: number, gitStatus: GitStatus) => void

  // Background
  updateBackground: (updates: Partial<BackgroundConfig>) => void

  // Preferences
  updatePreferences: (updates: Partial<WorkspacePreferences>) => void

  // Persistence
  saveWorkspace: () => void
}

// Array size limits to prevent unbounded memory growth
const MAX_SAVED_PROMPTS = 100
const MAX_FAVORITE_DIRS = 50
const MAX_CUSTOM_WALLPAPERS = 30

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
  panes: [],
  preferences: {
    theme: 'dark',
    fontSize: 14,
    hotkeys: DEFAULT_HOTKEYS,
    savedPrompts: [],
    favoriteDirectories: [],
    background: DEFAULT_BACKGROUND,
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
      const savedPrompts = (savedState.preferences?.savedPrompts ?? []).slice(-MAX_SAVED_PROMPTS)
      const favoriteDirectories = (savedState.preferences?.favoriteDirectories ?? []).slice(-MAX_FAVORITE_DIRS)
      const background = { ...DEFAULT_BACKGROUND, ...savedState.preferences?.background }
      if (background.customWallpapers && background.customWallpapers.length > MAX_CUSTOM_WALLPAPERS) {
        background.customWallpapers = background.customWallpapers.slice(-MAX_CUSTOM_WALLPAPERS)
      }

      // Migrate removed layouts to 'grid'
      let layout = savedState.layout
      if (layout === 'horizontal' || layout === 'vertical' || layout === 'fullscreen' || layout === 'split' || layout === 'history') {
        layout = 'grid'
      }

      // Reset all pane states to 'shell' on startup - Claude sessions don't survive app restart
      const panes = savedState.panes?.map((pane: PaneConfig) => ({
        ...pane,
        state: 'shell' as PaneState,
      })) ?? []

      set({
        ...savedState,
        layout,
        panes,
        preferences: {
          ...savedState.preferences,
          hotkeys: mergedHotkeys,
          savedPrompts,
          favoriteDirectories,
          background,
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
        panes: [0, 1, 2, 3].map((id) => ({
          id,
          label: `Terminal ${id + 1}`,
          workingDirectory: homeDir,
          state: 'shell' as PaneState,
        })),
        preferences: {
          theme: 'dark',
          fontSize: 14,
          hotkeys: DEFAULT_HOTKEYS,
          savedPrompts: [],
          favoriteDirectories: [],
          background: DEFAULT_BACKGROUND,
        },
        isInitialized: true,
      })
    }
  },

  // Layout actions
  setLayout: (layout) => {
    // When switching to a focus layout, swap the active pane to position 0 (the large pane)
    if (layout === 'focus' || layout === 'focus-right') {
      const activePaneId = get().activePaneId
      const panes = [...get().panes]
      const activeIndex = panes.findIndex((p) => p.id === activePaneId)
      if (activeIndex > 0) {
        ;[panes[0], panes[activeIndex]] = [panes[activeIndex], panes[0]]
        set({ panes, focusPaneId: activePaneId })
      }
    }
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
    // Avoid unnecessary re-renders if state hasn't changed
    const currentPane = get().panes.find((p) => p.id === id)
    if (currentPane?.state === paneState) return

    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.id === id ? { ...pane, state: paneState } : pane
      ),
    }))
    // Don't save on pane state changes - too frequent during terminal activity
  },

  setPaneLabel: (id, label) => {
    // Avoid unnecessary re-renders if label hasn't changed
    const currentPane = get().panes.find((p) => p.id === id)
    if (currentPane?.label === label) return

    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.id === id ? { ...pane, label } : pane
      ),
    }))
    debouncedSave(() => get().saveWorkspace())
  },

  setPaneCwd: (id, cwd) => {
    // Avoid unnecessary re-renders if cwd hasn't changed
    const currentPane = get().panes.find((p) => p.id === id)
    if (currentPane?.workingDirectory === cwd) return

    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.id === id ? { ...pane, workingDirectory: cwd } : pane
      ),
    }))
    debouncedSave(() => get().saveWorkspace())
  },

  setPaneGitStatus: (id, gitStatus) => {
    // Avoid unnecessary re-renders - shallow compare known fields
    const current = get().panes.find((p) => p.id === id)?.gitStatus
    if (current && gitStatus &&
      current.isGitRepo === gitStatus.isGitRepo &&
      current.branch === gitStatus.branch &&
      current.ahead === gitStatus.ahead &&
      current.behind === gitStatus.behind &&
      current.dirty === gitStatus.dirty) return

    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.id === id ? { ...pane, gitStatus } : pane
      ),
    }))
    // Don't save on git status changes - too frequent and not worth persisting
  },

  // Background
  updateBackground: (updates) => {
    if (updates.customWallpapers && updates.customWallpapers.length > MAX_CUSTOM_WALLPAPERS) {
      updates = { ...updates, customWallpapers: updates.customWallpapers.slice(-MAX_CUSTOM_WALLPAPERS) }
    }
    set((state) => ({
      preferences: {
        ...state.preferences,
        background: { ...state.preferences.background ?? DEFAULT_BACKGROUND, ...updates },
      },
    }))
    debouncedSave(() => get().saveWorkspace())
  },

  // Preferences
  updatePreferences: (updates) => {
    // Enforce array size limits
    if (updates.savedPrompts && updates.savedPrompts.length > MAX_SAVED_PROMPTS) {
      updates = { ...updates, savedPrompts: updates.savedPrompts.slice(-MAX_SAVED_PROMPTS) }
    }
    if (updates.favoriteDirectories && updates.favoriteDirectories.length > MAX_FAVORITE_DIRS) {
      updates = { ...updates, favoriteDirectories: updates.favoriteDirectories.slice(-MAX_FAVORITE_DIRS) }
    }
    set((state) => ({
      preferences: { ...state.preferences, ...updates },
    }))
    debouncedSave(() => get().saveWorkspace())
  },

  // Save to disk (debounced calls converge here)
  saveWorkspace: () => {
    const { layout, focusPaneId, activePaneId, panes, preferences } = get()
    // Strip transient data (gitStatus) from panes before persisting
    const cleanPanes = panes.map(({ gitStatus: _, ...rest }) => rest)
    window.electronAPI.saveWorkspace({
      layout,
      focusPaneId,
      activePaneId,
      panes: cleanPanes,
      preferences,
    })
  },
}))
