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
  'focus-right': {
    name: 'Focus Right',
    icon: '◰',
    gridTemplate: '1fr 1fr 1fr / 1fr 3fr',
    areas: [
      ['pane1', 'pane0'],
      ['pane2', 'pane0'],
      ['pane3', 'pane0'],
    ],
    visiblePanes: [0, 1, 2, 3],
  },
}

export function getGridStyle(
  layout: LayoutMode,
  _focusPaneId: number,
  _activePaneId: number = 0
): React.CSSProperties {
  const config = LAYOUTS[layout]

  // For focus layout, position 0 is always the large focus area (on left)
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

  // For focus-right layout, position 0 is the large focus area (on right)
  if (layout === 'focus-right') {
    return {
      display: 'grid',
      gridTemplate: config.gridTemplate,
      gridTemplateAreas: `
        "pane1 pane0"
        "pane2 pane0"
        "pane3 pane0"
      `,
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
  _activePaneId: number = 0
): React.CSSProperties {
  const config = LAYOUTS[layout]

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
