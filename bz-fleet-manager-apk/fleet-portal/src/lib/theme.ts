// Pure theme logic: no DOM reads, no storage. The store owns persistence and
// the media-query listener; this file owns the decisions so they are testable.
export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'fleet.theme'

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system'
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode
}

/** The toggle flips what the user *sees*, never a hidden "system" state. */
export function nextMode(mode: ThemeMode, systemDark: boolean): ThemeMode {
  return resolveTheme(mode, systemDark) === 'dark' ? 'light' : 'dark'
}

export function applyTheme(
  root: { classList: { toggle(c: string, force?: boolean): boolean } },
  resolved: ResolvedTheme,
): void {
  root.classList.toggle('dark', resolved === 'dark')
}
