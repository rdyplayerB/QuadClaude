import { useEffect, useState } from 'react'

// Chrome zoom — the scale applied to the app's own UI text (toolbar, pane
// headers, Settings) through --ui-scale on the shared type scale in index.css.
//
// It's deliberately separate from three other sizes: the terminal font (sized
// for reading code), the delegation dashboard's zoom and the Activity
// Console's zoom (both read at a different distance, and both pin --ui-scale
// to 1 on their roots so the two never compound).
//
// State lives here rather than in the workspace store because it's a
// display preference of this window, not workspace data that syncs or
// persists to disk with a project.

const KEY = 'qc-chrome-scale'
const MIN = 0.8
const MAX = 1.8
const EVENT = 'qc-ui-scale'

export const clampUiScale = (n: number) => Math.min(MAX, Math.max(MIN, Math.round(n * 10) / 10))

export function readUiScale(): number {
  const v = Number(localStorage.getItem(KEY))
  return v >= MIN && v <= MAX ? v : 1
}

/** Set the chrome scale, persist it, and notify every subscriber. */
export function applyUiScale(n: number): number {
  const v = clampUiScale(n)
  localStorage.setItem(KEY, String(v))
  document.documentElement.style.setProperty('--ui-scale', String(v))
  window.dispatchEvent(new CustomEvent<number>(EVENT, { detail: v }))
  return v
}

/** Current chrome scale, kept in sync across every component that reads it. */
export function useUiScale(): number {
  const [scale, setScale] = useState(readUiScale)
  useEffect(() => {
    // Apply on mount so a persisted scale survives a reload.
    document.documentElement.style.setProperty('--ui-scale', String(readUiScale()))
    const onChange = (e: Event) => setScale((e as CustomEvent<number>).detail)
    window.addEventListener(EVENT, onChange)
    return () => window.removeEventListener(EVENT, onChange)
  }, [])
  return scale
}
