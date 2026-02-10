import { useState, memo } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { LayoutMode } from '../../shared/types'

// Text labels for layouts
const layoutLabels: Record<LayoutMode, string> = {
  grid: '[2x2]',
  focus: '[1x3]',
  split: '[1x1]',
  horizontal: '[col]',
  vertical: '[row]',
  fullscreen: '[full]',
}

const layoutNames: Record<LayoutMode, string> = {
  grid: 'Grid (2x2)',
  focus: 'Focus (1+3)',
  split: 'Split (1|1)',
  horizontal: '4 Columns',
  vertical: '4 Rows',
  fullscreen: 'Fullscreen',
}

export const LayoutSwitcher = memo(function LayoutSwitcher() {
  const { layout, setLayout, resetPaneOrder } = useWorkspaceStore()
  const [hoveredLayout, setHoveredLayout] = useState<LayoutMode | null>(null)
  const [isResetHovered, setIsResetHovered] = useState(false)

  const layouts: LayoutMode[] = ['grid', 'focus', 'split', 'horizontal', 'vertical', 'fullscreen']

  return (
    <div className="flex flex-col items-center font-mono text-xs">
      {/* Top border */}
      <div className="text-terminal-muted mb-2">────</div>

      <div className="flex flex-col items-center gap-3">
        {layouts.map((layoutMode) => {
          const isActive = layout === layoutMode
          const isHovered = hoveredLayout === layoutMode

          return (
            <button
              key={layoutMode}
              onClick={() => setLayout(layoutMode)}
              onMouseEnter={() => setHoveredLayout(layoutMode)}
              onMouseLeave={() => setHoveredLayout(null)}
              className={`px-2 py-1.5 transition-colors ${
                isActive
                  ? 'text-claude-pink'
                  : isHovered
                    ? 'text-terminal-fg'
                    : 'text-terminal-muted'
              }`}
              title={layoutNames[layoutMode]}
              aria-label={`Switch to ${layoutNames[layoutMode]} layout`}
              aria-pressed={isActive}
              role="button"
            >
              {layoutLabels[layoutMode]}
            </button>
          )
        })}
      </div>

      {/* Bottom border */}
      <div className="text-terminal-muted mt-2">────</div>

      {/* Reset order button */}
      <button
        onClick={resetPaneOrder}
        onMouseEnter={() => setIsResetHovered(true)}
        onMouseLeave={() => setIsResetHovered(false)}
        className={`mt-3 px-2 py-1.5 transition-colors ${
          isResetHovered ? 'text-claude-pink' : 'text-terminal-muted'
        }`}
        title="Reset terminal order to 1-2-3-4"
        aria-label="Reset terminal order"
      >
        [reset]
      </button>
    </div>
  )
})
