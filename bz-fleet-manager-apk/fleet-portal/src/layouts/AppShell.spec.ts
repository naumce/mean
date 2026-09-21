import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onMounted, onUnmounted } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { TOKEN_STORAGE_KEY } from '../lib/constants'
import { useAuthStore } from '../stores/auth'
import { useThemeStore } from '../stores/theme'
import AppShell from './AppShell.vue'
import SidebarNavItem from './SidebarNavItem.vue'

const Stub = { template: '<div />' }

// A superset of the real router's child paths, kept as plain (unnamed)
// stubs — only 'cockpit' needs a name, since the realtime describe block
// below and the guard-adjacent nav both only ever assert on labels/paths,
// not route names.
function shellRoutes() {
  return [
    {
      path: '/',
      component: AppShell,
      children: [
        { path: 'cockpit', name: 'cockpit', component: Stub },
        { path: 'board/broker', component: Stub },
        { path: 'board', component: Stub },
        { path: 'night-shift', component: Stub },
        { path: 'import', component: Stub },
        { path: 'brokers', component: Stub },
        { path: 'money', component: Stub },
        { path: 'fleet', component: Stub },
        { path: 'messages', component: Stub },
        { path: 'tracking', component: Stub },
        { path: 'approvals', component: Stub },
        { path: 'drivers', component: Stub },
        { path: 'vehicles', component: Stub },
        { path: 'trips', component: Stub },
        { path: 'overview', component: Stub },
      ],
    },
    { path: '/login', name: 'login', component: Stub },
  ]
}

async function mountShell() {
  const router = createRouter({ history: createMemoryHistory(), routes: shellRoutes() })
  await router.push('/cockpit')
  await router.isReady()
  return mount(AppShell, { global: { plugins: [router] } })
}

// AppShell is the component under test, mounted directly (not resolved
// through the router's own matched tree) — but AppShell also renders its
// own `<RouterView />` internally. If the router's '/' record's component
// were AppShell itself, that inner RouterView would have no ancestor
// RouterView to inherit a depth from, so vue-router would treat it as
// depth 0 and render the '/' record's component *again* inside it — a
// nested duplicate AppShell (and so duplicate SidebarNavItems), which
// `mountShell()` above never noticed because none of its assertions count
// components. A trivial `<RouterView />` passthrough at '/' keeps AppShell
// out of the matched chain entirely, so its own RouterView renders the
// child page exactly once.
function shellRoutesForDirectMount() {
  const RouterViewPassthrough = { template: '<RouterView />' }
  return [
    {
      path: '/',
      component: RouterViewPassthrough,
      children: [
        { path: 'cockpit', name: 'cockpit', component: Stub },
        { path: 'board/broker', component: Stub },
        { path: 'night-shift', component: Stub },
        { path: 'messages', component: Stub },
      ],
    },
  ]
}

async function mountShellWithTier(tier: 'sheet' | 'tower') {
  const auth = useAuthStore()
  auth.setSession({
    token: 't',
    dispatcher: {
      id: 'd1',
      name: tier === 'sheet' ? 'Ana' : 'Bo',
      email: tier === 'sheet' ? 'ana@sheet.co' : 'bo@tower.co',
      orgId: tier === 'sheet' ? 'o1' : 'o2',
    },
    org: {
      id: tier === 'sheet' ? 'o1' : 'o2',
      name: tier === 'sheet' ? 'Sheet Co' : 'Tower Co',
      timezone: 'America/Chicago',
    },
    plan: { tier },
  })
  const router = createRouter({ history: createMemoryHistory(), routes: shellRoutesForDirectMount() })
  await router.push('/cockpit')
  await router.isReady()
  return mount(AppShell, { global: { plugins: [router] } })
}

describe('AppShell', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  it('renders the theme toggle and flips the theme store', async () => {
    const wrapper = await mountShell()
    const theme = useThemeStore()
    theme.setMode('light')
    // The default is now dark, so this genuinely changes the rendered label —
    // previously it matched the mount state and the missing tick was invisible.
    await wrapper.vm.$nextTick()
    const toggle = wrapper.find('[data-testid="theme-toggle"]')
    expect(toggle.attributes('aria-label')).toBe('Switch to dark mode')
    await toggle.trigger('click')
    expect(theme.mode).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(wrapper.find('[data-testid="theme-toggle"]').attributes('aria-label')).toBe('Switch to light mode')
    await wrapper.find('[data-testid="theme-toggle"]').trigger('click')
    expect(theme.mode).toBe('light')
  })

  it('uses semantic token classes for the chrome (no hard-coded light greys)', async () => {
    const wrapper = await mountShell()
    const html = wrapper.html()
    expect(html).toContain('bg-surface')
    expect(html).toContain('border-line')
    expect(html).not.toContain('bg-[#f8fafc]')
    expect(html).not.toContain('bg-white')
    expect(html).not.toMatch(/\b(?:bg|text|border|ring|divide)-gray-\d/)
  })
})

describe('AppShell nav by plan tier', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  it('sheet tier shows Board, Night Shift, Usage, Settings and nothing else', async () => {
    const w = await mountShellWithTier('sheet')
    const labels = w.findAllComponents(SidebarNavItem).map((c) => c.props('label'))
    expect(labels).toEqual(['Board', 'Night Shift', 'Usage', 'Settings'])
  })

  it('sheet tier hides the "More" section entirely', async () => {
    const w = await mountShellWithTier('sheet')
    expect(w.find('[data-testid="nav-more-toggle"]').exists()).toBe(false)
  })

  it('tower tier shows the full nav, unchanged, including "More"', async () => {
    const w = await mountShellWithTier('tower')
    const labels = w.findAllComponents(SidebarNavItem).map((c) => c.props('label'))
    expect(labels.slice(0, 3)).toEqual(['Their Board', 'Control Tower', 'Night Shift'])
    expect(labels).toContain('Fleet')
    expect(w.find('[data-testid="nav-more-toggle"]').exists()).toBe(true)
  })

  it('tower tier highlights the "More" toggle when the current route is one of its items', async () => {
    const auth = useAuthStore()
    auth.setSession({
      token: 't',
      dispatcher: { id: 'd1', name: 'Bo', email: 'bo@tower.co', orgId: 'o2' },
      org: { id: 'o2', name: 'Tower Co', timezone: 'America/Chicago' },
      plan: { tier: 'tower' },
    })
    const router = createRouter({ history: createMemoryHistory(), routes: shellRoutesForDirectMount() })
    await router.push('/messages') // a moreNav-only path, not in primaryNav
    await router.isReady()
    const w = mount(AppShell, { global: { plugins: [router] } })

    expect(w.find('[data-testid="nav-more-toggle"]').classes()).toContain('bg-surface-2')
  })
})

// M5 (ruling A4-R14): the shell holds one subscription for the life of the
// session so the shared socket's handler count never hits zero between
// views. Isolated with its own module registry (vi.resetModules, same
// harness as lib/realtime.spec.ts) so this test's fake WebSocket and the
// AppShell/realtime modules it exercises are the same instances, independent
// of the other describe block above (which never sets a token and so never
// opens a socket at all).
describe('AppShell realtime session (M5)', () => {
  class FakeSocket {
    static instances: FakeSocket[] = []
    url: string
    onmessage: ((ev: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    onopen: (() => void) | null = null
    closed = false
    constructor(url: string) { this.url = url; FakeSocket.instances.push(this) }
    close() { this.closed = true; this.onclose?.() }
  }

  beforeEach(() => {
    vi.resetModules()
    setActivePinia(createPinia())
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
    localStorage.setItem(TOKEN_STORAGE_KEY, 'tok')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('constructs the socket once and never closes it while navigating between views', async () => {
    const { default: FreshAppShell } = await import('./AppShell.vue')
    const rt = await import('../lib/realtime')

    // A stand-in for a real view's own store subscription (loadLocks.ts,
    // brokerBoard.ts, loadboard.ts all do this): subscribes on mount,
    // unsubscribes on unmount. Before the fix, the outgoing view's unmount
    // dropped the shared handler count to zero — with nothing else holding
    // it open — and lib/realtime.ts closed the socket on every navigation.
    const ViewA = {
      setup() {
        let off: (() => void) | null = null
        onMounted(() => { off = rt.subscribe('load_changed', () => {}) })
        onUnmounted(() => { off?.() })
        return () => null
      },
    }
    const ViewB = {
      setup() {
        let off: (() => void) | null = null
        onMounted(() => { off = rt.subscribe('board_update', () => {}) })
        onUnmounted(() => { off?.() })
        return () => null
      },
    }

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/',
          component: FreshAppShell,
          children: [
            { path: 'a', name: 'a', component: ViewA },
            { path: 'b', name: 'b', component: ViewB },
          ],
        },
      ],
    })
    await router.push('/a')
    await router.isReady()
    const wrapper = mount(FreshAppShell, { global: { plugins: [router] } })
    await wrapper.vm.$nextTick()

    expect(FakeSocket.instances).toHaveLength(1)
    expect(rt.__state().open).toBe(true)

    await router.push('/b')
    await wrapper.vm.$nextTick()

    expect(FakeSocket.instances).toHaveLength(1) // never re-constructed
    expect(FakeSocket.instances[0].closed).toBe(false) // never closed by the navigation
    expect(rt.__state().open).toBe(true)

    await router.push('/a')
    await wrapper.vm.$nextTick()
    expect(FakeSocket.instances).toHaveLength(1)
    expect(FakeSocket.instances[0].closed).toBe(false)

    wrapper.unmount()
  })
})
