import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { DISPATCHER_STORAGE_KEY, ORG_STORAGE_KEY, TOKEN_STORAGE_KEY } from '../lib/constants'
import { useAuthStore } from './auth'

vi.mock('../lib/api', () => ({
  api: { post: vi.fn(), get: vi.fn() },
}))

const mockedPost = vi.mocked(api.post)
const mockedGet = vi.mocked(api.get)

describe('useAuthStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    mockedPost.mockReset()
    mockedGet.mockReset()
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

  it('signup stores the token + dispatcher and persists the token to localStorage', async () => {
    mockedPost.mockResolvedValueOnce({
      data: {
        token: 'signup-token',
        refreshToken: 'refresh-token',
        org: { id: 'org1', name: 'Acme Freight', timezone: 'America/Chicago' },
        dispatcher: {
          id: '1', email: 'dana@acme.com', name: 'Dana Ops', createdAt: '2026-01-01', orgId: 'org1',
        },
      },
    })

    const auth = useAuthStore()
    await auth.signup({
      orgName: 'Acme Freight', name: 'Dana Ops', email: 'dana@acme.com',
      password: 'hunter2secret', timezone: 'America/Chicago',
    })

    expect(mockedPost).toHaveBeenCalledWith('/auth/dispatcher/signup', {
      orgName: 'Acme Freight', name: 'Dana Ops', email: 'dana@acme.com',
      password: 'hunter2secret', timezone: 'America/Chicago',
    })
    expect(auth.token).toBe('signup-token')
    expect(auth.dispatcher?.orgId).toBe('org1')
    expect(auth.isAuthenticated).toBe(true)
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('signup-token')
  })

  it('signup surfaces an error and stays unauthenticated on failure', async () => {
    mockedPost.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 409, data: { error: 'An account with this email already exists' } },
    })

    const auth = useAuthStore()
    await expect(auth.signup({
      orgName: 'Acme Freight', name: 'Dana Ops', email: 'dana@acme.com', password: 'hunter2secret',
    })).rejects.toBeTruthy()

    expect(auth.isAuthenticated).toBe(false)
    expect(auth.error).toBeTruthy()
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('login keeps the org so the cockpit can render org-local time', async () => {
    mockedPost.mockResolvedValueOnce({ data: { dispatcher: { id: 'x', email: 'd@x.com', name: 'D', createdAt: '' }, token: 't', refreshToken: 'r', org: { id: 'o1', name: 'Heartland', timezone: 'America/Denver' } } })
    const store = useAuthStore()
    await store.login('d@x.com', 'pass123')
    expect(store.org?.timezone).toBe('America/Denver')
    store.logout()
    expect(store.org).toBeNull()
  })

  it('persists the org through a reload, so a refreshed cockpit keeps the org timezone', async () => {
    // The bug this pins: the token survived a refresh but the org did not, so
    // /cockpit silently fell back to America/Chicago and shifted the whole
    // time axis for a Los Angeles org.
    mockedPost.mockResolvedValueOnce({ data: { dispatcher: { id: 'x', email: 'd@x.com', name: 'D', createdAt: '' }, token: 't', refreshToken: 'r', org: { id: 'o1', name: 'Pacific Freight', timezone: 'America/Los_Angeles' } } })
    await useAuthStore().login('d@x.com', 'pass123')
    expect(JSON.parse(localStorage.getItem(ORG_STORAGE_KEY)!)).toEqual({ id: 'o1', name: 'Pacific Freight', timezone: 'America/Los_Angeles' })

    setActivePinia(createPinia()) // a fresh page load reading the same storage
    expect(useAuthStore().org?.timezone).toBe('America/Los_Angeles')
  })

  it('signup persists the org too, and logout clears it', async () => {
    mockedPost.mockResolvedValueOnce({ data: {
      token: 'signup-token', refreshToken: 'r',
      org: { id: 'org1', name: 'Acme Freight', timezone: 'America/Denver' },
      dispatcher: { id: '1', email: 'dana@acme.com', name: 'Dana Ops', createdAt: '2026-01-01', orgId: 'org1' },
    } })
    const store = useAuthStore()
    await store.signup({ orgName: 'Acme Freight', name: 'Dana Ops', email: 'dana@acme.com', password: 'hunter2secret' })
    expect(localStorage.getItem(ORG_STORAGE_KEY)).toContain('America/Denver')
    store.logout()
    expect(localStorage.getItem(ORG_STORAGE_KEY)).toBeNull()
  })

  it('tolerates a malformed stored org instead of failing to construct the store', () => {
    localStorage.setItem(ORG_STORAGE_KEY, '{not json')
    expect(useAuthStore().org).toBeNull()

    setActivePinia(createPinia())
    localStorage.setItem(ORG_STORAGE_KEY, '"a string, not an org"')
    expect(useAuthStore().org).toBeNull()
  })

  it('persists the dispatcher through a reload, so a resumed session keeps its identity', async () => {
    // The bug this pins: the token survived a refresh but the dispatcher did
    // not, so loadLocks' `theirs` getter treated the resumed session as
    // signed-out and every lock badge silently vanished.
    mockedPost.mockResolvedValueOnce({ data: {
      dispatcher: { id: 'd1', email: 'dana@acme.com', name: 'Dana Ops', createdAt: '2026-01-01' },
      token: 't', refreshToken: 'r', org: null,
    } })
    await useAuthStore().login('dana@acme.com', 'pass123')
    expect(JSON.parse(localStorage.getItem(DISPATCHER_STORAGE_KEY)!)).toEqual({
      id: 'd1', email: 'dana@acme.com', name: 'Dana Ops', createdAt: '2026-01-01',
    })

    setActivePinia(createPinia()) // a fresh page load reading the same storage
    expect(useAuthStore().dispatcher?.id).toBe('d1')
  })

  it('logout clears the dispatcher from storage', async () => {
    mockedPost.mockResolvedValueOnce({ data: {
      dispatcher: { id: 'd1', email: 'dana@acme.com', name: 'Dana Ops', createdAt: '2026-01-01' },
      token: 't', refreshToken: 'r', org: null,
    } })
    const store = useAuthStore()
    await store.login('dana@acme.com', 'pass123')
    expect(localStorage.getItem(DISPATCHER_STORAGE_KEY)).not.toBeNull()

    store.logout()

    expect(localStorage.getItem(DISPATCHER_STORAGE_KEY)).toBeNull()
  })

  it('tolerates a malformed stored dispatcher instead of failing to construct the store', () => {
    localStorage.setItem(DISPATCHER_STORAGE_KEY, '{not json')
    expect(() => useAuthStore()).not.toThrow()
    expect(useAuthStore().dispatcher).toBeNull()

    setActivePinia(createPinia())
    localStorage.setItem(DISPATCHER_STORAGE_KEY, '"a string, not a dispatcher"')
    expect(useAuthStore().dispatcher).toBeNull()
  })

  describe('restoreIdentity', () => {
    it('fetches and persists the dispatcher when a token exists but none is stored', async () => {
      // The bug this closes: a session already signed in when identity
      // persistence shipped has a token but never stored a dispatcher, so
      // `theirs` reads it as signed-out and every lock badge stays off.
      // The real /auth/me route selects an explicit field list — id, email,
      // name, orgId — and never createdAt (routes/dispatcherAuth.ts). This
      // mock must match that exactly: a mock that adds a field the server
      // never sends, or omits one it does, can hide a real type/response
      // mismatch behind a passing test — which is exactly what happened once
      // already in this project (login/signup's mocks are fine — those
      // routes destructure a full Prisma row, createdAt included; orgId used
      // to be missing here too, until fix round 3 put it back on the route).
      localStorage.setItem(TOKEN_STORAGE_KEY, 'preexisting-token')
      mockedGet.mockResolvedValueOnce({
        data: {
          dispatcher: { id: 'd1', email: 'dana@acme.com', name: 'Dana Ops', orgId: 'o1' },
          org: { id: 'o1', name: 'Acme Freight', timezone: 'America/Denver' },
        },
      })

      const auth = useAuthStore()
      await auth.restoreIdentity()

      expect(mockedGet).toHaveBeenCalledWith('/dispatcher/auth/me')
      expect(auth.dispatcher?.id).toBe('d1')
      expect(auth.dispatcher?.orgId).toBe('o1')
      expect(auth.org?.timezone).toBe('America/Denver')
      expect(JSON.parse(localStorage.getItem(DISPATCHER_STORAGE_KEY)!)).toEqual({
        id: 'd1', email: 'dana@acme.com', name: 'Dana Ops', orgId: 'o1',
      })
    })

    it('makes no request when there is no token', async () => {
      const auth = useAuthStore()

      await auth.restoreIdentity()

      expect(mockedGet).not.toHaveBeenCalled()
      expect(auth.dispatcher).toBeNull()
    })

    it('makes no request when a dispatcher is already known', async () => {
      localStorage.setItem(TOKEN_STORAGE_KEY, 'preexisting-token')
      const auth = useAuthStore()
      auth.dispatcher = { id: 'already-here', email: 'a@b.com', name: 'A' }

      await auth.restoreIdentity()

      expect(mockedGet).not.toHaveBeenCalled()
    })

    it('leaves the dispatcher null and the token untouched when the request fails', async () => {
      // A failed identity fetch is not allowed to cost anyone their
      // session — realtime badges are an enhancement, not a login gate.
      localStorage.setItem(TOKEN_STORAGE_KEY, 'preexisting-token')
      mockedGet.mockRejectedValueOnce(new Error('network down'))

      const auth = useAuthStore()
      await auth.restoreIdentity()

      expect(auth.dispatcher).toBeNull()
      expect(auth.token).toBe('preexisting-token')
      expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('preexisting-token')
      expect(localStorage.getItem(DISPATCHER_STORAGE_KEY)).toBeNull()
    })
  })

  describe('tier', () => {
    it('defaults to "tower" when the session has no plan', async () => {
      mockedPost.mockResolvedValueOnce({ data: {
        dispatcher: { id: 'd1', email: 'd@x.com', name: 'D', createdAt: '' },
        token: 't', refreshToken: 'r', org: null,
      } })
      const auth = useAuthStore()
      await auth.login('d@x.com', 'pass123')
      expect(auth.tier).toBe('tower')
    })

    it('picks up "sheet" from the signup response too (not just login)', async () => {
      mockedPost.mockResolvedValueOnce({ data: {
        token: 'signup-token', refreshToken: 'r',
        org: { id: 'org1', name: 'Acme Freight', timezone: 'America/Denver' },
        dispatcher: { id: '1', email: 'dana@acme.com', name: 'Dana Ops', createdAt: '2026-01-01', orgId: 'org1' },
        plan: { tier: 'sheet' },
      } })
      const auth = useAuthStore()
      await auth.signup({ orgName: 'Acme Freight', name: 'Dana Ops', email: 'dana@acme.com', password: 'hunter2secret', product: 'nightshift' })
      expect(auth.tier).toBe('sheet')
    })

    it('picks up "sheet" from the login response', async () => {
      mockedPost.mockResolvedValueOnce({ data: {
        dispatcher: { id: 'd1', email: 'd@x.com', name: 'D', createdAt: '' },
        token: 't', refreshToken: 'r', org: null, plan: { tier: 'sheet' },
      } })
      const auth = useAuthStore()
      await auth.login('d@x.com', 'pass123')
      expect(auth.tier).toBe('sheet')
    })

    it('persists across a reload the same way the org does', async () => {
      mockedPost.mockResolvedValueOnce({ data: {
        dispatcher: { id: 'd1', email: 'd@x.com', name: 'D', createdAt: '' },
        token: 't', refreshToken: 'r',
        org: { id: 'o1', name: 'Sheet Co', timezone: 'America/Chicago' },
        plan: { tier: 'sheet' },
      } })
      await useAuthStore().login('d@x.com', 'pass123')
      expect(useAuthStore().tier).toBe('sheet')

      setActivePinia(createPinia()) // a fresh page load reading the same storage
      expect(useAuthStore().tier).toBe('sheet')
    })

    it('logout clears the persisted tier back to the default', async () => {
      mockedPost.mockResolvedValueOnce({ data: {
        dispatcher: { id: 'd1', email: 'd@x.com', name: 'D', createdAt: '' },
        token: 't', refreshToken: 'r', org: null, plan: { tier: 'sheet' },
      } })
      const auth = useAuthStore()
      await auth.login('d@x.com', 'pass123')
      auth.logout()
      expect(auth.tier).toBe('tower')

      setActivePinia(createPinia())
      expect(useAuthStore().tier).toBe('tower')
    })
  })

  it('logout clears state and localStorage', () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'some-token')
    const auth = useAuthStore()
    auth.dispatcher = { id: '1', email: 'a@b.com', name: 'A' }

    auth.logout()

    expect(auth.token).toBeNull()
    expect(auth.dispatcher).toBeNull()
    expect(auth.isAuthenticated).toBe(false)
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull()
  })
})
