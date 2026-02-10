import { LayoutMode } from '../../shared/types'

export interface LayoutConfig {
  name: string
  icon: string
  gridTemplate: string
  areas: string[][]
  visiblePanes: number[]
}

export const LAYOUTS: Record<LayoutMode, LayoutConfig> = {
  grid: {
    name: 'Grid',
    icon: '⊞',
    gridTemplate: '1fr 1fr / 1fr 1fr',
    areas: [
      ['pane0', 'pane1'],
      ['pane2', 'pane3'],
    ],
    visiblePanes: [0, 1, 2, 3],
  },
  focus: {
    name: 'Focus',
    icon: '◱',
    gridTemplate: '1fr 1fr 1fr / 3fr 1fr',
    areas: [
      ['pane0', 'pane1'],
      ['pane0', 'pane2'],
      ['pane0', 'pane3'],
    ],
    visiblePanes: [0, 1, 2, 3],
  },
  split: {
    name: 'Split',
    icon: '◫',
    gridTemplate: '1fr / 1fr 1fr',
    areas: [['pane0', 'pane1']],
    visiblePanes: [0, 1],
  },
  horizontal: {
    name: 'Horizontal',
    icon: '≡',
    gridTemplate: '1fr / 1fr 1fr 1fr 1fr',
    areas: [['pane0', 'pane1', 'pane2', 'pane3']],
    visiblePanes: [0, 1, 2, 3],
  },
  vertical: {
    name: 'Vertical',
    icon: '☰',
    gridTemplate: '1fr 1fr 1fr 1fr / 1fr',
    areas: [['pane0'], ['pane1'], ['pane2'], ['pane3']],
    visiblePanes: [0, 1, 2, 3],
  },
  fullscreen: {
    name: 'Fullscreen',
    icon: '□',
    gridTemplate: '1fr / 1fr',
    areas: [['pane0']],
    visiblePanes: [0],
  },
}

export function getGridStyle(
  layout: LayoutMode,
  _focusPaneId: number,
  _splitPaneIds: [number, number] = [0, 1],
  _activePaneId: number = 0
): React.CSSProperties {
  const config = LAYOUTS[layout]

  // For fullscreen layout, show only position 0 (active pane should be swapped there)
  if (layout === 'fullscreen') {
    return {
      display: 'grid',
      gridTemplate: '1fr / 1fr',
      gridTemplateAreas: `"pane0"`,
      gap: '0',
      height: '100%',
    }
  }

  // For focus layout, position 0 is always the large focus area
  if (layout === 'focus') {
    return {
      display: 'grid',
      gridTemplate: config.gridTemplate,
      gridTemplateAreas: `
        "pane0 pane1"
        "pane0 pane2"
        "pane0 pane3"
      `,
      gap: '2px',
      height: '100%',
    }
  }

  // For split layout, use positions 0 and 1
  if (layout === 'split') {
    return {
      display: 'grid',
      gridTemplate: config.gridTemplate,
      gridTemplateAreas: `"pane0 pane1"`,
      gap: '2px',
      height: '100%',
    }
  }

  const areasString = config.areas.map((row) => `"${row.join(' ')}"`).join(' ')

  return {
    display: 'grid',
    gridTemplate: config.gridTemplate,
    gridTemplateAreas: areasString,
    gap: '2px',
    height: '100%',
  }
}

export function getPaneStyle(
  position: number,
  _paneId: number,
  layout: LayoutMode,
  _splitPaneIds: [number, number] = [0, 1],
  _activePaneId: number = 0
): React.CSSProperties {
  const config = LAYOUTS[layout]

  // For fullscreen layout, only show position 0
  if (layout === 'fullscreen') {
    if (position !== 0) {
      return { display: 'none' }
    }
    return {
      gridArea: `pane0`,
      minWidth: 0,
      minHeight: 0,
      overflow: 'hidden',
    }
  }

  // For split layout, only show panes in positions 0 and 1
  if (layout === 'split') {
    if (position > 1) {
      return { display: 'none' }
    }
    return {
      gridArea: `pane${position}`,
      minWidth: 0,
      minHeight: 0,
      overflow: 'hidden',
    }
  }

  if (!config.visiblePanes.includes(position)) {
    return { display: 'none' }
  }

  return {
    gridArea: `pane${position}`,
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
  }
}
