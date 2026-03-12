import { useState, useEffect, memo } from 'react'
import { UsageData } from '../../shared/types'

function usageColor(pct: number): string {
  if (pct <= 30) return 'var(--git-green)'
  if (pct <= 60) return 'var(--git-cyan)'
  if (pct <= 80) return 'var(--git-yellow)'
  return 'var(--git-orange)'
}

function formatCountdown(iso: string | null): string {
  if (!iso) return ''
  try {
    const now = Date.now()
    const reset = new Date(iso).getTime()
    const diffMs = reset - now
    if (diffMs <= 0) return 'now'
    const totalMin = Math.ceil(diffMs / 60_000)
    const hrs = Math.floor(totalMin / 60)
    const mins = totalMin % 60
    if (hrs > 0) return `${hrs}h ${mins}m`
    return `${mins}m`
  } catch {
    return ''
  }
}

function formatResetTime(iso: string | null): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

function formatAge(fetchedAt: number): string {
  const ageMin = Math.floor((Date.now() - fetchedAt) / 60_000)
  if (ageMin < 1) return 'just now'
  if (ageMin < 60) return `${ageMin}m ago`
  const hrs = Math.floor(ageMin / 60)
  return `${hrs}h ${ageMin % 60}m ago`
}

export const UsageIndicator = memo(function UsageIndicator() {
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [showTooltip, setShowTooltip] = useState(false)
  const [countdown, setCountdown] = useState('')
  const [isStale, setIsStale] = useState(false)
  const [ageText, setAgeText] = useState('')

  useEffect(() => {
    // Get initial data (includes cached data from previous successful fetch)
    window.electronAPI.fetchUsage().then((data) => {
      if (data) setUsage(data)
    })

    // Subscribe to updates
    const unsubscribe = window.electronAPI.onUsageUpdate((data) => {
      setUsage(data)
    })

    return unsubscribe
  }, [])

  // Update countdown and staleness every 30s
  useEffect(() => {
    if (!usage) return

    const update = () => {
      setCountdown(formatCountdown(usage.fiveHour.resetsAt))
      // Stale if data is older than 10 minutes
      const ageMs = Date.now() - usage.fetchedAt
      setIsStale(ageMs > 10 * 60_000)
      setAgeText(formatAge(usage.fetchedAt))
    }
    update()
    const interval = setInterval(update, 30_000)
    return () => clearInterval(interval)
  }, [usage])

  if (!usage) return null

  const pct = usage.fiveHour.utilization
  const color = usageColor(pct)
  const resetTime = formatResetTime(usage.fiveHour.resetsAt)

  return (
    <div
      className={`relative flex items-center gap-1.5 px-2 py-1 titlebar-no-drag rounded-md cursor-default ${isStale ? 'opacity-60' : ''}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {/* Mini bar */}
      <div className="flex gap-px">
        {Array.from({ length: 10 }, (_, i) => (
          <div
            key={i}
            className="w-[3px] h-[10px] rounded-[1px]"
            style={{
              backgroundColor: i < Math.round(pct / 10) ? color : 'var(--ui-border)',
            }}
          />
        ))}
      </div>
      <span className="text-[11px] font-medium tabular-nums" style={{ color }}>
        {Math.round(pct)}%
      </span>
      {/* Countdown */}
      {countdown && (
        <span className="text-[10px] text-[--ui-text-muted] tabular-nums">
          {countdown}
        </span>
      )}

      {/* Tooltip */}
      {showTooltip && (
        <div className="absolute top-full right-0 mt-2 px-3 py-2 bg-[--ui-bg-elevated] border border-[--ui-border] rounded-lg shadow-xl text-xs whitespace-nowrap z-50">
          <div className="text-[--ui-text-primary] font-medium mb-1.5">Usage</div>
          <div className="space-y-1">
            <div className="flex justify-between gap-4">
              <span className="text-[--ui-text-muted]">5-hour</span>
              <span style={{ color: usageColor(usage.fiveHour.utilization) }}>
                {Math.round(usage.fiveHour.utilization)}%
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-[--ui-text-muted]">Weekly</span>
              <span style={{ color: usageColor(usage.weekly.utilization) }}>
                {Math.round(usage.weekly.utilization)}%
              </span>
            </div>
            {countdown && (
              <div className="flex justify-between gap-4 pt-1 border-t border-[--ui-border]">
                <span className="text-[--ui-text-muted]">Resets in</span>
                <span className="text-[--ui-text-secondary]">{countdown}</span>
              </div>
            )}
            {resetTime && (
              <div className="flex justify-between gap-4">
                <span className="text-[--ui-text-muted]">Reset at</span>
                <span className="text-[--ui-text-secondary]">{resetTime}</span>
              </div>
            )}
            <div className="flex justify-between gap-4 pt-1 border-t border-[--ui-border]">
              <span className="text-[--ui-text-muted]">Updated</span>
              <span className={isStale ? 'text-[--git-yellow]' : 'text-[--ui-text-secondary]'}>{ageText}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
