import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { THEME_STORAGE_KEY } from '../lib/theme'
import { __resetThemeMedia, useThemeStore } from './theme'

function stubMatchMedia(dark: boolean) {
  const listeners: Array<(e: { matches: boolean }) => void> = []
  const mql = {
    matches: dark,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.push(fn),
    removeEventListener: vi.fn(),
  }
  vi.stubGlobal('matchMedia', vi.fn(() => mql))
  return { fire: (matches: boolean) => listeners.forEach((fn) => fn({ matches })) }
}

describe('theme store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    vi.unstubAllGlobals()
    __resetThemeMedia()
  })

  // First run defaults to DARK, not `system`: the cockpit's accent palette does
  // not yet meet AA in light mode, so a light-mode machine would otherwise land
  // on the unfinished look with no warning. Revert once the contrast pass lands.
  it('defaults to dark on first run, regardless of the OS preference', () => {
    stubMatchMedia(false) // OS says light — the default must still be dark
    const store = useThemeStore()
    store.init()
    expect(store.mode).toBe('dark')
    expect(store.resolved).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('still follows the OS preference once the user explicitly chooses system', () => {
    stubMatchMedia(true)
    const store = useThemeStore()
    store.init()
    store.setMode('system')
    expect(store.resolved).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('setMode persists and applies; toggle flips the resolved look', () => {
    stubMatchMedia(false)
    const store = useThemeStore()
    store.init()
    store.setMode('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    store.toggle()
    expect(store.mode).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('reads a stored mode on creation and ignores garbage', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    expect(useThemeStore().mode).toBe('dark')
    setActivePinia(createPinia())
    localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    expect(useThemeStore().mode).toBe('dark') // garbage falls back to the default
  })

  it('re-applies when the OS preference changes while in system mode', () => {
    const mm = stubMatchMedia(false)
    const store = useThemeStore()
    store.init()
    store.setMode('system') // no longer the default, so opt in explicitly
    expect(store.isDark).toBe(false)
    mm.fire(true)
    expect(store.isDark).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('survives a missing matchMedia (older jsdom / SSR)', () => {
    const store = useThemeStore()
    expect(() => store.init()).not.toThrow()
    expect(store.resolved).toBe('dark') // the default no longer depends on matchMedia
  })
})
