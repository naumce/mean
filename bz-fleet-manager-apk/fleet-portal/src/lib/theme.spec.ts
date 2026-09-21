import { describe, expect, it } from 'vitest'
import { applyTheme, isThemeMode, nextMode, resolveTheme, THEME_STORAGE_KEY } from './theme'

describe('theme helpers', () => {
  it('resolves explicit modes as-is and system by the OS preference', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('nextMode flips the *resolved* look, so toggling from system-dark lands on light', () => {
    expect(nextMode('light', false)).toBe('dark')
    expect(nextMode('dark', true)).toBe('light')
    expect(nextMode('system', true)).toBe('light')
    expect(nextMode('system', false)).toBe('dark')
  })

  it('applyTheme sets or clears the dark class on the root', () => {
    const classes = new Set<string>()
    const root = { classList: { toggle: (c: string, force?: boolean) => { if (force) classes.add(c); else classes.delete(c); return !!force } } }
    applyTheme(root, 'dark')
    expect(classes.has('dark')).toBe(true)
    applyTheme(root, 'light')
    expect(classes.has('dark')).toBe(false)
  })

  it('guards stored values', () => {
    expect(isThemeMode('dark')).toBe(true)
    expect(isThemeMode('blue')).toBe(false)
    expect(isThemeMode(null)).toBe(false)
    expect(THEME_STORAGE_KEY).toBe('fleet.theme')
  })
})
