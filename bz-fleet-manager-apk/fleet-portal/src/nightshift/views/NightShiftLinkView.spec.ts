import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NightShiftLinkView from './NightShiftLinkView.vue'
import AppShell from '../../layouts/AppShell.vue'
import { useNightShiftStore, type AgentForLoad, type AgentPolicy } from '../../stores/nightShift'

// Task 10 (the deep link): NightShiftLinkView renders AgentDrawer full-screen
// with NO dispatcher session at all — the auth store is never touched, and
// the drawer's fetch/command calls must go through the injected `linkApi`
// (nightshift/api/linkApi.ts), never the Pinia store's own bearer-authed
// calls. Mocking `useNightShiftStore` (same pattern AgentDrawer.spec.ts
// already uses) proves the store's own agentFor/command are never called —
// only AgentDrawer's *default* injection path would reach them, and this
// view overrides that default.
vi.mock('../../stores/nightShift', async () => {
  const actual = await vi.importActual<typeof import('../../stores/nightShift')>('../../stores/nightShift')
  return { ...actual, useNightShiftStore: vi.fn() }
})

// Fix round 1: AgentDrawer's ✕ button falls back to router navigation
// (see NightShiftLinkView.vue's handleClose) — mocked the same way
// SignupView.spec.ts already mocks vue-router, so `router.back()` is
// observable without a real router instance.
const backMock = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back: backMock }),
}))

const timelineMock = vi.fn()
const commandMock = vi.fn()
const linkApiMock = vi.fn((_orgToken: string) => ({ timeline: timelineMock, command: commandMock }))
vi.mock('../api/linkApi', () => ({
  linkApi: (orgToken: string) => linkApiMock(orgToken),
}))

const mockedUseNightShiftStore = vi.mocked(useNightShiftStore)

const standardPolicy: AgentPolicy = {
  id: 'pol-standard',
  name: 'Standard',
  stopMin: 15,
  delayMin: 30,
  darkMin: 20,
  darkAtStopMin: 60,
  offRouteMi: 3.1,
  offRouteMin: 10,
  rungGapMin: 5,
  maxCalls: 2,
  dispatcherEmail: 'dispatch@fleet.test',
  dispatcherPhone: null,
  customerEmailOn: false,
  shadow: true,
  bossCallOn: true,
  quietFrom: null,
  quietTo: null,
}

function agentState(overrides: Partial<AgentForLoad> = {}): AgentForLoad {
  return {
    enabled: true,
    policy: standardPolicy,
    pill: 'watching',
    line: null,
    timeline: [],
    ...overrides,
  }
}

function mountView(props: Partial<{ orgToken: string; loadId: string }> = {}) {
  return mount(NightShiftLinkView, {
    props: {
      orgToken: 'deadbeefdeadbeefdeadbeefdeadbeef.org-1',
      loadId: 'load-1',
      ...props,
    },
  })
}

describe('NightShiftLinkView', () => {
  beforeEach(() => {
    mockedUseNightShiftStore.mockReset()
    // The drawer's default-transport factory still calls useNightShiftStore()
    // once at setup (even though this view's injected linkApi always wins) —
    // stub it so that call does not throw with no active Pinia instance.
    mockedUseNightShiftStore.mockReturnValue({
      agentFor: vi.fn(),
      command: vi.fn(),
    } as unknown as ReturnType<typeof useNightShiftStore>)
    linkApiMock.mockClear()
    backMock.mockReset()
    timelineMock.mockReset().mockResolvedValue(agentState())
    commandMock.mockReset().mockResolvedValue({ command: { id: 'cmd-1' } })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('mounts with no session and builds the link API from the route token', () => {
    mountView({ orgToken: 'sig123.org-9' })
    expect(linkApiMock).toHaveBeenCalledWith('sig123.org-9')
  })

  it('fetches the timeline through the injected link API, not the dispatcher store', async () => {
    mountView({ loadId: 'load-42' })
    await flushPromises()

    expect(timelineMock).toHaveBeenCalledWith('load-42')
  })

  // Final fix wave, minor: the header shows the sheet's LOAD#, not the uuid.
  it('shows LOAD# from the timeline response in the header, falling back to the uuid only when there is none', async () => {
    timelineMock.mockResolvedValue(agentState({ boardLoadNo: '145219' }))
    const wrapper = mountView({ loadId: 'load-42' })
    await flushPromises()
    expect(wrapper.find('[data-testid="drawer-load-no"]').text()).toBe('145219')

    timelineMock.mockResolvedValue(agentState({ boardLoadNo: null }))
    const bare = mountView({ loadId: 'load-43' })
    await flushPromises()
    expect(bare.find('[data-testid="drawer-load-no"]').text()).toBe('load-43')
  })

  it('renders the pill and the supervision buttons once the timeline resolves', async () => {
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.find('[data-testid="drawer-shadow-badge"]').text()).toBe('Shadow')
    expect(wrapper.find('[data-testid="action-hold"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="action-call"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="action-stop"]').exists()).toBe(true)
  })

  it('pressing "I\'ve got it" posts { kind: "takeover" } through the link API', async () => {
    const wrapper = mountView({ loadId: 'load-42' })
    await flushPromises()

    await wrapper.find('[data-testid="action-hold"]').trigger('click')

    expect(commandMock).toHaveBeenCalledWith('load-42', 'takeover', undefined)
  })

  it('renders no AppShell — no sidebar, top-level page', () => {
    const wrapper = mountView()
    expect(wrapper.findComponent(AppShell).exists()).toBe(false)
    expect(wrapper.find('[data-testid="theme-toggle"]').exists()).toBe(false)
  })

  // Fix round 1: AgentDrawer's ✕ was inert on this route — no listener at
  // all — before handleClose was added.
  describe('closing the drawer (the ✕ button)', () => {
    it('goes back in history when this tab has somewhere to go back to', async () => {
      vi.spyOn(window.history, 'length', 'get').mockReturnValue(2)
      const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
      const wrapper = mountView()
      await flushPromises()

      await wrapper.find('[data-testid="drawer-close"]').trigger('click')

      expect(backMock).toHaveBeenCalledOnce()
      expect(closeSpy).not.toHaveBeenCalled()
      expect(wrapper.find('[data-testid="link-closed-message"]').exists()).toBe(false)
    })

    it('shows a fallback message when there is nowhere to go back to (window.close is refused)', async () => {
      vi.spyOn(window.history, 'length', 'get').mockReturnValue(1)
      const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
      const wrapper = mountView()
      await flushPromises()

      await wrapper.find('[data-testid="drawer-close"]').trigger('click')

      expect(closeSpy).toHaveBeenCalledOnce()
      expect(backMock).not.toHaveBeenCalled()
      expect(wrapper.find('[data-testid="link-closed-message"]').text()).toBe('You can close this tab.')
      expect(wrapper.find('[data-testid="agent-drawer"]').exists()).toBe(false)
    })
  })
})
