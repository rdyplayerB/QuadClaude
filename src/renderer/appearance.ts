// The ONE definition of how QuadClaude's surfaces look.
//
// Every window reads its appearance from here: the main window, the in-app
// Activity Console, and the popped-out console — which is a separate renderer
// with its own document and would otherwise drift the moment either side
// changed. Two things are published as CSS custom properties on the document
// root, and every surface in the app derives from them rather than carrying its
// own colour:
//
//   --window-tint-rgb   the tint's COLOUR, as "r, g, b"
//   --window-tint       how much of it there is (its alpha)
//   --ground-opacity    how solid the ground BETWEEN windows is
//
// Custom properties inherit through shadow boundaries, so the console's
// Shadow-DOM styles read the same values without any plumbing.
import { WorkspacePreferences } from '../shared/types'

export interface Appearance {
  /** Ground between windows: 1 = the standard glass tint, 0 = fully clear. */
  groundOpacity: number
  /** Tint colour as an "r, g, b" triplet, ready to drop into rgba(). */
  tintRgb: string
  /** How much of that colour the surfaces carry. */
  tintAlpha: number
}

export const DEFAULT_TINT_COLOR = '#1e1e1e'
export const DEFAULT_TINT_ALPHA = 0.85

// "#1e1e1e" | "#1ee" → "30, 30, 30". Falls back to the neutral default rather
// than throwing: a malformed value in saved preferences should look wrong, not
// take the window down.
export function hexToRgbTriplet(hex: string): string {
  const raw = (hex || '').trim().replace(/^#/, '')
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return '30, 30, 30'
  const n = parseInt(full, 16)
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}

/** Read appearance out of whatever slice of preferences a surface has. */
export function readAppearance(
  prefs: Pick<WorkspacePreferences, 'groundOpacity' | 'windowTint' | 'windowTintColor'> | undefined,
): Appearance {
  return {
    groundOpacity: prefs?.groundOpacity ?? 1,
    tintRgb: hexToRgbTriplet(prefs?.windowTintColor ?? DEFAULT_TINT_COLOR),
    tintAlpha: prefs?.windowTint ?? DEFAULT_TINT_ALPHA,
  }
}

/** Publish onto a document root. The only place these variables are written. */
export function applyAppearance(root: HTMLElement, a: Appearance): void {
  root.style.setProperty('--ground-opacity', String(a.groundOpacity))
  root.style.setProperty('--window-tint-rgb', a.tintRgb)
  root.style.setProperty('--window-tint', String(a.tintAlpha))
}
