import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { TOKEN_STORAGE_KEY } from '../lib/constants'
import { extractApiErrorMessage } from '../lib/errors'
import type { Dispatcher } from '../types/dispatcher'

interface LoginResponse {
  dispatcher: Dispatcher
  token: string
  refreshToken: string
}

interface AuthState {
  token: string | null
  dispatcher: Dispatcher | null
  error: string | null
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    token: localStorage.getItem(TOKEN_STORAGE_KEY),
    dispatcher: null,
    error: null,
  }),

  getters: {
    isAuthenticated: (state): boolean => !!state.token,
  },

  actions: {
    async login(email: string, password: string): Promise<void> {
      this.error = null
      try {
        const { data } = await api.post<LoginResponse>('/auth/dispatcher/login', { email, password })
        this.token = data.token
        this.dispatcher = data.dispatcher
        localStorage.setItem(TOKEN_STORAGE_KEY, data.token)
      } catch (error) {
        this.token = null
        this.dispatcher = null
        this.error = extractApiErrorMessage(error, 'Invalid email or password')
        throw error
      }
    },

    logout(): void {
      this.token = null
      this.dispatcher = null
      this.error = null
      localStorage.removeItem(TOKEN_STORAGE_KEY)
    },
  },
})
