import { memo } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { LayoutMode } from '../../shared/types'

// Minimal layout icons - smaller for terminal aesthetic
const GridIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="1" width="6" height="6" rx="0.5" opacity="0.9"/>
    <rect x="9" y="1" width="6" height="6" rx="0.5" opacity="0.9"/>
    <rect x="1" y="9" width="6" height="6" rx="0.5" opacity="0.9"/>
    <rect x="9" y="9" width="6" height="6" rx="0.5" opacity="0.9"/>
  </svg>
)

const FocusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="1" width="9" height="14" rx="0.5" opacity="0.9"/>
    <rect x="11.5" y="1" width="3.5" height="4" rx="0.5" opacity="0.5"/>
    <rect x="11.5" y="6" width="3.5" height="4" rx="0.5" opacity="0.5"/>
    <rect x="11.5" y="11" width="3.5" height="4" rx="0.5" opacity="0.5"/>
  </svg>
)

const FocusRightIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="1" width="3.5" height="4" rx="0.5" opacity="0.5"/>
    <rect x="1" y="6" width="3.5" height="4" rx="0.5" opacity="0.5"/>
    <rect x="1" y="11" width="3.5" height="4" rx="0.5" opacity="0.5"/>
    <rect x="6" y="1" width="9" height="14" rx="0.5" opacity="0.9"/>
  </svg>
)

const layoutIcons: Record<LayoutMode, React.ReactNode> = {
  grid: <GridIcon />,
  focus: <FocusIcon />,
  'focus-right': <FocusRightIcon />,
}

const layoutLabels: Record<LayoutMode, string> = {
  grid: 'Grid',
  focus: 'Left Focus',
  'focus-right': 'Right Focus',
}

const layoutTitles: Record<LayoutMode, string> = {
  grid: 'Grid (Cmd+1)',
  focus: 'Focus Left (Cmd+2)',
  'focus-right': 'Focus Right (Cmd+3)',
}

export const LayoutSelector = memo(function LayoutSelector() {
  const { layout, setLayout } = useWorkspaceStore()

  const layouts: LayoutMode[] = ['grid', 'focus', 'focus-right']

  return (
    <div className="flex items-center gap-0">
      {layouts.map((layoutMode, i) => {
        const isActive = layout === layoutMode

        return (
          <div key={layoutMode} className="flex items-center">
            {i > 0 && <span className="text-[--ui-text-faint] text-xs px-1">│</span>}
            <button
              onClick={() => setLayout(layoutMode)}
              className={`flex items-center gap-1.5 px-2 py-1 transition-colors titlebar-no-drag ${
                isActive
                  ? 'text-[--ui-text-primary]'
                  : 'text-[--ui-text-dimmed] hover:text-[--ui-text-secondary]'
              }`}
              title={layoutTitles[layoutMode]}
              aria-label={`Switch to ${layoutMode} layout`}
              aria-pressed={isActive}
            >
              {layoutIcons[layoutMode]}
              <span className="text-[11px] leading-none">{layoutLabels[layoutMode]}</span>
            </button>
          </div>
        )
      })}
    </div>
  )
})
