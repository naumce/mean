import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../stores/auth'
import SignupView from './SignupView.vue'

const pushMock = vi.fn()
// Mutable so individual tests can point it at a different `?product=` query
// without re-mocking the module; reset to "no query" in beforeEach.
let routeQuery: Record<string, unknown> = {}
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
  useRoute: () => ({ query: routeQuery }),
}))

vi.mock('../stores/auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('../stores/auth')>()
  return { ...original, useAuthStore: vi.fn() }
})
const mockedUse = vi.mocked(useAuthStore)

function stubAuth(overrides: Record<string, unknown> = {}) {
  return {
    error: null,
    signup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

const mountView = () =>
  mount(SignupView, {
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  })

async function fillAndSubmit(wrapper: ReturnType<typeof mountView>) {
  await wrapper.find('#orgName').setValue('Acme Freight')
  await wrapper.find('#name').setValue('Dana Ops')
  await wrapper.find('#email').setValue('dana@acme.com')
  await wrapper.find('#password').setValue('hunter2secret')
  await wrapper.find('#timezone').setValue('America/New_York')
  await wrapper.find('form').trigger('submit')
}

describe('SignupView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedUse.mockReset()
    pushMock.mockReset()
    routeQuery = {}
  })

  it('submits the org + dispatcher details and lets the tier-aware redirect route it', async () => {
    const auth = stubAuth()
    mockedUse.mockReturnValue(auth as unknown as ReturnType<typeof useAuthStore>)
    const wrapper = mountView()
    await fillAndSubmit(wrapper)

    expect(auth.signup).toHaveBeenCalledWith({
      orgName: 'Acme Freight',
      name: 'Dana Ops',
      email: 'dana@acme.com',
      password: 'hunter2secret',
      timezone: 'America/New_York',
    })
    // Not '/cockpit': the store now holds this session's `plan` from the
    // signup response, and pushing '/' lets the router's tier-aware
    // redirect (src/router/index.ts, exercised end-to-end in
    // router/guard.spec.ts) send a sheet-tier signup to the broker board
    // and a tower-tier one to the cockpit. `vue-router` is fully mocked in
    // this file, so there is no real redirect to assert the far end of
    // here — that's what guard.spec.ts's own tests are for.
    expect(pushMock).toHaveBeenCalledWith('/')
  })

  it('pushes to "/" after a nightshift signup too, so the sheet-tier redirect (proven in guard.spec.ts) takes it to the broker board', async () => {
    routeQuery = { product: 'nightshift' }
    const auth = stubAuth()
    mockedUse.mockReturnValue(auth as unknown as ReturnType<typeof useAuthStore>)
    const wrapper = mountView()
    await fillAndSubmit(wrapper)

    expect(pushMock).toHaveBeenCalledWith('/')
  })

  it('sends product: "nightshift" when the signup link carries ?product=nightshift', async () => {
    routeQuery = { product: 'nightshift' }
    const auth = stubAuth()
    mockedUse.mockReturnValue(auth as unknown as ReturnType<typeof useAuthStore>)
    const wrapper = mountView()
    await fillAndSubmit(wrapper)

    expect(auth.signup).toHaveBeenCalledWith({
      orgName: 'Acme Freight',
      name: 'Dana Ops',
      email: 'dana@acme.com',
      password: 'hunter2secret',
      timezone: 'America/New_York',
      product: 'nightshift',
    })
  })

  it('omits product for any other or missing ?product= value, so the server default (tower) applies', async () => {
    routeQuery = { product: 'tower' }
    const auth = stubAuth()
    mockedUse.mockReturnValue(auth as unknown as ReturnType<typeof useAuthStore>)
    const wrapper = mountView()
    await fillAndSubmit(wrapper)

    expect(auth.signup).toHaveBeenCalledWith({
      orgName: 'Acme Freight',
      name: 'Dana Ops',
      email: 'dana@acme.com',
      password: 'hunter2secret',
      timezone: 'America/New_York',
    })
  })

  it('shows the store error and stays put when signup fails', async () => {
    const auth = stubAuth({
      error: 'An account with this email already exists',
      signup: vi.fn().mockRejectedValue(new Error('409')),
    })
    mockedUse.mockReturnValue(auth as unknown as ReturnType<typeof useAuthStore>)
    const wrapper = mountView()
    await fillAndSubmit(wrapper)
    await wrapper.vm.$nextTick()

    expect(pushMock).not.toHaveBeenCalled()
    expect(wrapper.find('[role="alert"]').text()).toContain('already exists')
  })

  it('links back to sign-in', () => {
    mockedUse.mockReturnValue(stubAuth() as unknown as ReturnType<typeof useAuthStore>)
    const wrapper = mountView()
    expect(wrapper.text()).toContain('Already have an account?')
  })
})
