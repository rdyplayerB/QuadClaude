import Store from 'electron-store'
import os from 'os'
import fs from 'fs'
import { WorkspaceState, PaneConfig, WindowBounds, DEFAULT_HOTKEYS, LayoutMode } from '../shared/types'
import { logger } from './logger'

const DEFAULT_PREFERENCES = {
  theme: 'dark' as const,
  fontSize: 14,
  hotkeys: DEFAULT_HOTKEYS,
  savedPrompts: [] as const,
}

function createDefaultPaneConfig(id: number): PaneConfig {
  return {
    id,
    label: `Terminal ${id + 1}`,
    workingDirectory: os.homedir(),
    state: 'shell',
  }
}

function createDefaultWorkspace(): WorkspaceState {
  return {
    layout: 'grid',
    focusPaneId: 0,
    activePaneId: 0,
    splitPaneIds: [0, 1],
    panes: [
      createDefaultPaneConfig(0),
      createDefaultPaneConfig(1),
      createDefaultPaneConfig(2),
      createDefaultPaneConfig(3),
    ],
    preferences: DEFAULT_PREFERENCES,
  }
}

export class WorkspaceManager {
  private store: Store<{ workspace: WorkspaceState; windowBounds?: WindowBounds }>

  constructor() {
    try {
      logger.info('workspace', 'Creating electron-store instance')
      this.store = new Store({
        name: 'workspace',
        defaults: {
          workspace: createDefaultWorkspace(),
        },
      })
      logger.info('workspace', 'Electron-store path', this.store.path)
    } catch (error) {
      logger.error('workspace', 'Failed to create electron-store', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  load(): WorkspaceState {
    try {
      logger.info('workspace', 'Loading workspace from store')
      const workspace = this.store.get('workspace', createDefaultWorkspace())

      // Validate that saved directories still exist
      let directoriesReset = 0
      workspace.panes = workspace.panes.map((pane) => {
        if (!fs.existsSync(pane.workingDirectory)) {
          directoriesReset++
          return {
            ...pane,
            workingDirectory: os.homedir(),
          }
        }
        return pane
      })
      if (directoriesReset > 0) {
        logger.warn('workspace', `Reset ${directoriesReset} pane directories to home (paths no longer exist)`)
      }

      // Ensure we have exactly 4 panes
      while (workspace.panes.length < 4) {
        workspace.panes.push(createDefaultPaneConfig(workspace.panes.length))
      }
      workspace.panes = workspace.panes.slice(0, 4)

      // Ensure splitPaneIds exists (backwards compatibility)
      if (!workspace.splitPaneIds) {
        workspace.splitPaneIds = [0, 1]
      }

      // Ensure hotkeys exist (backwards compatibility)
      if (!workspace.preferences.hotkeys) {
        workspace.preferences.hotkeys = DEFAULT_HOTKEYS
      }

      // Ensure savedPrompts exist (backwards compatibility)
      if (!workspace.preferences.savedPrompts) {
        workspace.preferences.savedPrompts = []
      }

      // Migrate removed layouts to 'grid' (horizontal, vertical, fullscreen removed)
      const validLayouts: LayoutMode[] = ['grid', 'focus', 'split']
      if (!validLayouts.includes(workspace.layout as LayoutMode)) {
        logger.info('workspace', `Migrating removed layout '${workspace.layout}' to 'grid'`)
        workspace.layout = 'grid'
      }

      logger.info('workspace', 'Workspace loaded', `Layout: ${workspace.layout}, Theme: ${workspace.preferences.theme}`)
      return workspace
    } catch (error) {
      logger.error('workspace', 'Error loading workspace, using defaults', error instanceof Error ? error.message : String(error))
      return createDefaultWorkspace()
    }
  }

  save(state: Partial<WorkspaceState>): void {
    const current = this.load()
    const updated = { ...current, ...state }
    this.store.set('workspace', updated)
  }

  getWindowBounds(): WindowBounds | undefined {
    return this.store.get('windowBounds')
  }

  saveWindowBounds(bounds: WindowBounds): void {
    this.store.set('windowBounds', bounds)
  }

  reset(): void {
    this.store.set('workspace', createDefaultWorkspace())
  }

  updatePaneCwds(cwds: Map<number, string>): void {
    if (cwds.size === 0) return

    const current = this.load()
    current.panes = current.panes.map((pane) => {
      const cwd = cwds.get(pane.id)
      if (cwd) {
        return { ...pane, workingDirectory: cwd }
      }
      return pane
    })
    this.store.set('workspace', current)
    logger.info('workspace', 'Updated pane CWDs on quit', `Updated ${cwds.size} pane(s)`)
  }
}
