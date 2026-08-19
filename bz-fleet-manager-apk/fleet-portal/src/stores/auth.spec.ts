import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { TOKEN_STORAGE_KEY } from '../lib/constants'
import { useAuthStore } from './auth'

vi.mock('../lib/api', () => ({
  api: { post: vi.fn() },
}))

const mockedPost = vi.mocked(api.post)

describe('useAuthStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    mockedPost.mockReset()
  })

  it('starts unauthenticated when localStorage has no token', () => {
    const auth = useAuthStore()

    expect(auth.isAuthenticated).toBe(false)
    expect(auth.token).toBeNull()
  })

  it('initializes the token from localStorage on creation', () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'preexisting-token')

    const auth = useAuthStore()

    expect(auth.token).toBe('preexisting-token')
    expect(auth.isAuthenticated).toBe(true)
  })

  it('login stores the token + dispatcher and persists the token to localStorage', async () => {
    mockedPost.mockResolvedValueOnce({
      data: {
        token: 'new-token',
        refreshToken: 'refresh-token',
        dispatcher: { id: '1', email: 'dispatch@fleet.test', name: 'Dana Dispatcher', createdAt: '2026-01-01' },
      },
    })

    const auth = useAuthStore()
    await auth.login('dispatch@fleet.test', 'hunter2')

    expect(mockedPost).toHaveBeenCalledWith('/auth/dispatcher/login', {
      email: 'dispatch@fleet.test',
      password: 'hunter2',
    })
    expect(auth.token).toBe('new-token')
    expect(auth.dispatcher?.name).toBe('Dana Dispatcher')
    expect(auth.isAuthenticated).toBe(true)
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('new-token')
  })

  it('login surfaces an error and stays unauthenticated on failure', async () => {
    mockedPost.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 401, data: { error: 'Invalid email or password' } },
    })

    const auth = useAuthStore()
    await expect(auth.login('dispatch@fleet.test', 'wrong')).rejects.toBeTruthy()

    expect(auth.isAuthenticated).toBe(false)
    expect(auth.token).toBeNull()
    expect(auth.error).toBeTruthy()
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('logout clears state and localStorage', () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'some-token')
    const auth = useAuthStore()
    auth.dispatcher = { id: '1', email: 'a@b.com', name: 'A', createdAt: '2026-01-01' }

    auth.logout()

    expect(auth.token).toBeNull()
    expect(auth.dispatcher).toBeNull()
    expect(auth.isAuthenticated).toBe(false)
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull()
  })
})
