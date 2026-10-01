import { defineStore } from 'pinia'
import { applyTheme, isThemeMode, nextMode, resolveTheme, THEME_STORAGE_KEY, type ThemeMode } from '../lib/theme'

// App-wide light/dark. `mode` is the user's choice (persisted); `systemDark`
// mirrors the OS. The resolved look is applied as `<html class="dark">` so
// every token-based class flips at once (tailwind darkMode: 'class').
interface ThemeState {
  mode: ThemeMode
  systemDark: boolean
}

/** First-run default is `system`; a stored explicit choice always wins. */
function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeMode(v) ? v : 'system'
  } catch {
    return 'system'
  }
}

function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
}

// Module scope: the media query is plumbing, not reactive state.
let mediaQuery: MediaQueryList | null = null

/** Test-only: clears the module-scope media query singleton between specs. */
export function __resetThemeMedia(): void {
  mediaQuery = null
}

export const useThemeStore = defineStore('theme', {
  state: (): ThemeState => ({
    mode: readStoredMode(),
    systemDark: systemPrefersDark(),
  }),

  getters: {
    resolved: (state) => resolveTheme(state.mode, state.systemDark),
    isDark(): boolean {
      return this.resolved === 'dark'
    },
  },

  actions: {
    /** Call once at app start: subscribes to OS changes and paints the root. */
    init(): void {
      if (typeof matchMedia === 'function' && !mediaQuery) {
        mediaQuery = matchMedia('(prefers-color-scheme: dark)')
        this.systemDark = mediaQuery.matches
        mediaQuery.addEventListener('change', (e) => {
          this.systemDark = e.matches
          this.apply()
        })
      }
      this.apply()
    },

    setMode(mode: ThemeMode): void {
      this.mode = mode
      try {
        localStorage.setItem(THEME_STORAGE_KEY, mode)
      } catch {
        // storage unavailable (private mode) — the choice lives for the session
      }
      this.apply()
    },

    toggle(): void {
      this.setMode(nextMode(this.mode, this.systemDark))
    },

    apply(): void {
      applyTheme(document.documentElement, this.resolved)
    },
  },
})
