import { app, Menu, shell } from 'electron'
import { MenuAction } from '../shared/types'
import { logger } from './logger'
import { getPluginMenuItems } from './pluginHost'
import { addMarker, revealPerfLogs, requestRendererFlush } from './perfMonitor'
import { openPerfViewer } from './perfViewer'

// Build + install the macOS application menu. The two callbacks are the only
// things that touch index.ts module state: sendMenuAction (routes an action to
// the renderer via the main window) and openLogViewer (owns the log window).
// Everything else is imported directly. The params are named exactly as the
// template used them, so the template body is a verbatim move — no call-site edits.
export function buildApplicationMenu(
  sendMenuAction: (action: MenuAction) => void,
  openLogViewer: () => void,
): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        {
          label: 'About QuadClaude',
          click: () => {
            app.setAboutPanelOptions({
              applicationName: 'QuadClaude',
              applicationVersion: app.getVersion(),
              version: 'Build ' + new Date().toISOString().split('T')[0],
              copyright: '© 2024-2026 rdyplayerB',
              credits: 'The ADHD workspace for Claude Code\n\nCrafted by ビルド studio · https://birudo.studio',
            })
            app.showAboutPanel()
          }
        },
        { type: 'separator' },
        {
          label: 'Settings...',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendMenuAction('open-settings')
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        // Explicitly register refresh shortcuts to block Electron's default reload behavior
        // These must be enabled for the accelerator to be "claimed" and prevent default
        {
          label: 'Reload (Disabled)',
          accelerator: 'CmdOrCtrl+R',
          visible: false,
          click: () => {
            // Intentionally do nothing - blocks page refresh
            logger.info('window', 'Blocked Cmd+R from menu')
          }
        },
        {
          label: 'Force Reload (Disabled)',
          accelerator: 'CmdOrCtrl+Shift+R',
          visible: false,
          click: () => {
            // Intentionally do nothing - blocks force refresh
            logger.info('window', 'Blocked Cmd+Shift+R from menu')
          }
        },
        {
          label: 'Reload F5 (Disabled)',
          accelerator: 'F5',
          visible: false,
          click: () => {
            // Intentionally do nothing - blocks F5 refresh
            logger.info('window', 'Blocked F5 from menu')
          }
        },
        {
          label: 'Always Show Prompt Bar',
          accelerator: 'CmdOrCtrl+P',
          type: 'checkbox',
          checked: true,
          click: (menuItem) => {
            sendMenuAction('toggle-prompt-bar')
            // Menu item checked state toggles automatically
          }
        },
        { type: 'separator' },
        {
          label: 'Grid Layout',
          accelerator: 'CmdOrCtrl+1',
          click: () => sendMenuAction('layout-grid')
        },
        {
          label: 'Focus Left Layout',
          accelerator: 'CmdOrCtrl+2',
          click: () => sendMenuAction('layout-focus')
        },
        {
          label: 'Focus Right Layout',
          accelerator: 'CmdOrCtrl+3',
          click: () => sendMenuAction('layout-focus-right')
        },
        {
          label: 'Duo Layout',
          accelerator: 'CmdOrCtrl+4',
          click: () => sendMenuAction('layout-duo')
        },
        {
          label: 'Solo Layout',
          accelerator: 'CmdOrCtrl+5',
          click: () => sendMenuAction('layout-solo')
        },
        { type: 'separator' },
        {
          label: 'Toggle PiP Strip',
          accelerator: 'CmdOrCtrl+B',
          click: () => sendMenuAction('toggle-pip')
        },
        {
          label: 'Cycle Pane Into View',
          accelerator: 'Ctrl+Tab',
          click: () => sendMenuAction('cycle-pane')
        },
        { type: 'separator' },
        // Cmd +/- targets whichever surface is frontmost — Activity Console,
        // else the delegation dashboard, else the terminals (see App.tsx).
        {
          label: 'Increase Font Size',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => sendMenuAction('increase-font')
        },
        {
          label: 'Decrease Font Size',
          accelerator: 'CmdOrCtrl+-',
          click: () => sendMenuAction('decrease-font')
        },
        { type: 'separator' },
        // The app's own UI text (toolbar, pane headers, Settings), separate
        // from terminal font so each can be sized for how it's read.
        {
          label: 'Increase UI Size',
          accelerator: 'CmdOrCtrl+Shift+Plus',
          click: () => sendMenuAction('increase-ui')
        },
        {
          label: 'Decrease UI Size',
          accelerator: 'CmdOrCtrl+Shift+-',
          click: () => sendMenuAction('decrease-ui')
        },
        {
          label: 'Reset UI Size',
          accelerator: 'CmdOrCtrl+Shift+0',
          click: () => sendMenuAction('reset-ui')
        },
        { type: 'separator' },
        // Plugin-contributed items (e.g. Activity Console). Generic — any
        // enabled window-kind plugin with a menu entry appears here.
        ...getPluginMenuItems(),
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'Focus Terminal 1',
          accelerator: 'CmdOrCtrl+Shift+1',
          click: () => sendMenuAction('focus-pane-1')
        },
        {
          label: 'Focus Terminal 2',
          accelerator: 'CmdOrCtrl+Shift+2',
          click: () => sendMenuAction('focus-pane-2')
        },
        {
          label: 'Focus Terminal 3',
          accelerator: 'CmdOrCtrl+Shift+3',
          click: () => sendMenuAction('focus-pane-3')
        },
        {
          label: 'Focus Terminal 4',
          accelerator: 'CmdOrCtrl+Shift+4',
          click: () => sendMenuAction('focus-pane-4')
        },
        { type: 'separator' },
        {
          label: 'Clear Terminal',
          accelerator: 'CmdOrCtrl+K',
          click: () => sendMenuAction('clear-pane')
        },
        {
          label: 'Launch Claude',
          accelerator: 'CmdOrCtrl+L',
          click: () => sendMenuAction('launch-claude')
        },
        { type: 'separator' },
        {
          label: 'Reset Current Pane',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => sendMenuAction('reset-pane')
        }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    },
    {
      label: 'Performance',
      submenu: [
        {
          label: 'Mark Slowdown Now',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => {
            requestRendererFlush()
            addMarker('user-reported-slowdown')
          }
        },
        {
          label: 'Add Marker',
          click: () => {
            requestRendererFlush()
            addMarker('manual-marker')
          }
        },
        {
          label: 'Dump Pane Diagnostics',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => sendMenuAction('dump-diagnostics')
        },
        { type: 'separator' },
        {
          label: 'Open Performance Timeline',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => openPerfViewer()
        },
        {
          label: 'Reveal Performance Logs',
          click: () => revealPerfLogs()
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'View Error Log...',
          click: () => openLogViewer()
        },
        {
          label: 'Open Log File in Finder',
          click: async () => {
            const logPath = logger.getLogFilePath()
            logger.info('app', 'Opening log file location', logPath)
            await shell.showItemInFolder(logPath)
          }
        },
        { type: 'separator' },
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://github.com/rdyplayerB/QuadClaude')
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
