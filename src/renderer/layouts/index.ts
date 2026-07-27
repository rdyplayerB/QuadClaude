import {
  LayoutMode,
  FOCUS_SMALL_RATIO_DEFAULT,
  FOCUS_SMALL_RATIO_MIN,
  FOCUS_SMALL_RATIO_MAX,
  DUO_RATIO_DEFAULT,
  DUO_RATIO_MIN,
  DUO_RATIO_MAX,
} from '../../shared/types'

// Clamp the focus splitter to its allowed range (default == min).
export function clampFocusRatio(r: number): number {
  if (!Number.isFinite(r)) return FOCUS_SMALL_RATIO_DEFAULT
  return Math.min(FOCUS_SMALL_RATIO_MAX, Math.max(FOCUS_SMALL_RATIO_MIN, r))
}

// Clamp the duo divider (left pane's width fraction) to its allowed range.
export function clampDuoRatio(r: number): number {
  if (!Number.isFinite(r)) return DUO_RATIO_DEFAULT
  return Math.min(DUO_RATIO_MAX, Math.max(DUO_RATIO_MIN, r))
}

// How many panes a layout shows on the main stage. Panes at array positions
// >= this count are hidden — in duo/solo they render as floating PiP tiles.
// Array order stays the single source of truth for "where is this pane".
export function visiblePaneCount(layout: LayoutMode, count: number): number {
  if (layout === 'solo') return Math.min(1, count)
  if (layout === 'duo') return Math.min(2, count)
  return count
}

export interface LayoutConfig {
  name: string
  icon: string
}

export const LAYOUTS: Record<LayoutMode, LayoutConfig> = {
  grid: { name: 'Grid', icon: '⊞' },
  focus: { name: 'Focus', icon: '◱' },
  'focus-right': { name: 'Focus Right', icon: '◰' },
  duo: { name: 'Duo', icon: '◫' },
  solo: { name: 'Solo', icon: '□' },
}

// Auto-balanced grid dimensions for N panes: the most square-ish layout that
// fits, biased to a fixed 2 rows in the app's 4-6 pane range (4→2x2, 5-6→3x2).
export function gridDimensions(count: number): { cols: number; rows: number } {
  const n = Math.max(1, count)
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  return { cols, rows }
}

// Number of empty trailing cells in the grid (where the "+" ghost tile goes).
// Only the grid layout has these; focus layouts stack exactly count-1 panes.
export function gridBlanks(count: number): number {
  if (count <= 0) return 0
  const { cols, rows } = gridDimensions(count)
  return cols * rows - count
}

export function getGridStyle(
  layout: LayoutMode,
  count: number,
  focusSmallRatio: number = FOCUS_SMALL_RATIO_DEFAULT,
  duoRatio: number = DUO_RATIO_DEFAULT,
): React.CSSProperties {
  // The gap is the floating effect: it is where the ground (and, when cleared,
  // the desktop) shows between panes. 2px read as a hairline seam; this reads
  // as separate tiles. Set inline, so it wins over the container's gap-* class
  // — keep it equal to GRID_PAD in TerminalGrid so the outer margin matches the
  // inner gutters and the tiles sit evenly on the ground.
  const base: React.CSSProperties = { display: 'grid', gap: '20px', height: '100%' }

  // Duo: two panes split the full area at the (draggable, persisted) ratio.
  // Solo: one pane fills everything. Both are position:relative to anchor the
  // absolutely-positioned PiP tiles + strip chrome (and duo's divider).
  if (layout === 'duo') {
    const r = clampDuoRatio(duoRatio)
    return {
      ...base,
      position: 'relative',
      gridTemplateColumns: `${r}fr ${1 - r}fr`,
      gridTemplateRows: '1fr',
    }
  }
  if (layout === 'solo') {
    return {
      ...base,
      position: 'relative',
      gridTemplateColumns: '1fr',
      gridTemplateRows: '1fr',
    }
  }

  // Focus layouts: one large pane spanning all rows, the rest stacked in a
  // narrow column beside it. Rows = number of small panes (count - 1). The
  // big/small split is driven by the (draggable, persisted) ratio; fr units
  // keep the 2px gap from causing overflow. position:relative anchors the
  // splitter overlay rendered by TerminalGrid.
  if (layout === 'focus' || layout === 'focus-right') {
    const smallRows = Math.max(1, count - 1)
    const r = clampFocusRatio(focusSmallRatio)
    const big = 1 - r
    return {
      ...base,
      position: 'relative',
      gridTemplateColumns: layout === 'focus' ? `${big}fr ${r}fr` : `${r}fr ${big}fr`,
      gridTemplateRows: `repeat(${smallRows}, 1fr)`,
    }
  }

  // Grid: auto-balanced columns/rows, panes auto-placed in DOM (array) order.
  const { cols, rows } = gridDimensions(count)
  return {
    ...base,
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
    gridTemplateRows: `repeat(${rows}, 1fr)`,
  }
}

export function getPaneStyle(
  position: number,
  layout: LayoutMode,
  count: number,
): React.CSSProperties {
  // overflow is deliberately NOT hidden here. This wrapper used to clip at its
  // own edge, which made an outer box-shadow impossible — the reason every pane
  // outline in the app was drawn inset and nothing ever looked like it floated.
  // The pane itself still clips its own content (see TerminalPane's rounded
  // overflow-hidden root), and min-width/height:0 is what actually stops a
  // terminal from blowing out its grid track.
  const base: React.CSSProperties = { minWidth: 0, minHeight: 0 }

  // Duo/solo place only the visible panes; hidden positions (>= visible count)
  // are styled by TerminalGrid as floating PiP tiles, not by this function.
  if (layout === 'duo') {
    return { ...base, gridColumn: position === 0 ? 1 : 2, gridRow: 1 }
  }
  if (layout === 'solo') {
    return { ...base, gridColumn: 1, gridRow: 1 }
  }

  // Focus layouts place panes explicitly: position 0 is the big pane (spanning
  // every row), positions 1..n-1 stack in the narrow column.
  if (layout === 'focus' || layout === 'focus-right') {
    const smallRows = Math.max(1, count - 1)
    const bigCol = layout === 'focus' ? 1 : 2
    const smallCol = layout === 'focus' ? 2 : 1
    if (position === 0) {
      return { ...base, gridColumn: bigCol, gridRow: `1 / span ${smallRows}` }
    }
    return { ...base, gridColumn: smallCol, gridRow: position }
  }

  // Grid layout relies on auto-placement (row-major in array order).
  return base
}
