// Shared path helpers. getFolderName / paneName / normalizePath were each
// re-implemented in PaneHeader, FavoritesDropdown and LiveFeedButton with
// slightly different empty-path fallbacks — a "fix it in three places" hazard.

// Human-readable folder name for a path: the repo/folder basename, home dir → "~".
// `fallback` is returned for an empty/unnameable path (callers differ: pane
// headers want "Terminal", menus want "").
export function folderName(path: string, fallback = ''): string {
  if (!path) return fallback
  if (/^\/Users\/[^/]+\/?$/.test(path)) return '~'
  const parts = path.split('/')
  return parts[parts.length - 1] || parts[parts.length - 2] || fallback
}

// Strip trailing slashes so paths compare equal regardless of a trailing "/".
export function normalizePath(p: string): string {
  return p.replace(/\/+$/, '')
}
