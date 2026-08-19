import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { authGuard } from './guards'
import { routes } from './index'

// A fresh router (memory history, no shared state) per test avoids
// vue-router's "duplicate navigation" quirks that show up when reusing one
// router instance across assertions that target the same path.
function createTestRouter() {
  const router = createRouter({ history: createMemoryHistory(), routes })
  router.beforeEach(authGuard)
  return router
}

describe('router auth guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('redirects an unauthenticated visitor from a protected route to /login', async () => {
    const router = createTestRouter()

    await router.push('/')

    expect(router.currentRoute.value.name).toBe('login')
  })

  it('redirects an authenticated dispatcher away from /login to /', async () => {
    const auth = useAuthStore()
    auth.token = 'a-valid-token'
    const router = createTestRouter()

    await router.push('/login')

    expect(router.currentRoute.value.name).toBe('dashboard')
  })

  it('lets an authenticated dispatcher reach a protected route', async () => {
    const auth = useAuthStore()
    auth.token = 'a-valid-token'
    const router = createTestRouter()

    await router.push('/')

    expect(router.currentRoute.value.name).toBe('dashboard')
  })
})
