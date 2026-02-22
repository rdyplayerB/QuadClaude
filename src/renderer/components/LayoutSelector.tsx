import { memo } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { LayoutMode } from '../../shared/types'

// Minimal layout icons
const GridIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="1" width="6" height="6" rx="1" opacity="0.9"/>
    <rect x="9" y="1" width="6" height="6" rx="1" opacity="0.9"/>
    <rect x="1" y="9" width="6" height="6" rx="1" opacity="0.9"/>
    <rect x="9" y="9" width="6" height="6" rx="1" opacity="0.9"/>
  </svg>
)

const FocusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="1" width="9" height="14" rx="1" opacity="0.9"/>
    <rect x="11.5" y="1" width="3.5" height="4" rx="0.5" opacity="0.6"/>
    <rect x="11.5" y="6" width="3.5" height="4" rx="0.5" opacity="0.6"/>
    <rect x="11.5" y="11" width="3.5" height="4" rx="0.5" opacity="0.6"/>
  </svg>
)

const layoutIcons: Record<LayoutMode, React.ReactNode> = {
  grid: <GridIcon />,
  focus: <FocusIcon />,
}

const layoutTitles: Record<LayoutMode, string> = {
  grid: 'Grid (Cmd+1)',
  focus: 'Focus (Cmd+2)',
}

export const LayoutSelector = memo(function LayoutSelector() {
  const { layout, setLayout } = useWorkspaceStore()

  const layouts: LayoutMode[] = ['grid', 'focus']

  return (
    <div className="flex items-center bg-[--ui-bg-elevated] rounded-lg p-1 border border-[--ui-border]">
      {layouts.map((layoutMode) => {
        const isActive = layout === layoutMode

        return (
          <button
            key={layoutMode}
            onClick={() => setLayout(layoutMode)}
            className={`flex items-center justify-center w-10 h-8 transition-all titlebar-no-drag rounded-md ${
              isActive
                ? 'text-[--ui-text-primary] bg-[--ui-bg-active]'
                : 'text-[--ui-text-muted] hover:text-[--ui-text-secondary]'
            }`}
            title={layoutTitles[layoutMode]}
            aria-label={`Switch to ${layoutMode} layout`}
            aria-pressed={isActive}
          >
            {layoutIcons[layoutMode]}
          </button>
        )
      })}
    </div>
  )
})
