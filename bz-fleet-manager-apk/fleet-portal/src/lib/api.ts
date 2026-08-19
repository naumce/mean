import axios, { AxiosHeaders, type InternalAxiosRequestConfig } from 'axios'
import { TOKEN_STORAGE_KEY } from './constants'

export const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001/api'

export const api = axios.create({ baseURL: API_BASE_URL })

// Exported standalone so it can be unit-tested without reaching into axios'
// internal interceptor registry. Reads the token straight from localStorage
// (rather than the Pinia store) to avoid a store <-> client import cycle —
// the auth store already keeps localStorage as the source of truth.
export function attachAuthToken(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY)
  if (token) {
    const headers = config.headers ?? new AxiosHeaders()
    headers.set('Authorization', `Bearer ${token}`)
    config.headers = headers
  }
  return config
}

api.interceptors.request.use(attachAuthToken)

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      // Lazy import: stores/auth.ts imports this module, so a static import
      // here would create a cycle.
      const { useAuthStore } = await import('../stores/auth')
      try {
        useAuthStore().logout()
      } catch {
        localStorage.removeItem(TOKEN_STORAGE_KEY)
      }
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  },
)

export default api
