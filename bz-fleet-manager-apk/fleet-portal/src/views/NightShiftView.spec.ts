import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNightShiftStore, type AgentPolicy } from '../stores/nightShift'
import NightShiftView from './NightShiftView.vue'

vi.mock('../stores/nightShift', async () => {
  const actual = await vi.importActual<typeof import('../stores/nightShift')>('../stores/nightShift')
  return { ...actual, useNightShiftStore: vi.fn() }
})

// Task 11: NightShiftView now reads `?tab=` via useRoute() to pick its
// initial tab. No test in this file exercises Connect/Usage/Settings (those
// live in ConnectSheet.spec.ts and this file's own tab tests below) — the
// rest mount with an empty query, which resolves to the "policies" tab, same
// as every one of these tests already assumed before Task 11 existed.
let routeQuery: Record<string, string> = {}
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery }),
}))

// The Connect tab (Task 11) mounts ConnectSheet, which owns a real
// useSheetStore() — mocked here at the shared axios client (not the store)
// purely so switching to that tab in these tests never fires a real network
// request; ConnectSheet's own behavior is covered by ConnectSheet.spec.ts.
vi.mock('../lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: { binding: null } }), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
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

const hazmatPolicy: AgentPolicy = {
  ...standardPolicy,
  id: 'pol-hazmat',
  name: 'Hazmat',
  shadow: false,
}

function createStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    policies: [standardPolicy],
    loadsByPolicy: { 'pol-standard': 2 },
    loading: false,
    error: null,
    loadPolicies: vi.fn().mockResolvedValue(undefined),
    savePolicy: vi.fn().mockResolvedValue(standardPolicy),
    deletePolicy: vi.fn().mockResolvedValue(undefined),
    agentFor: vi.fn(),
    setSwitch: vi.fn(),
    timeline: vi.fn(),
    command: vi.fn(),
    ...overrides,
  }
}

// Modal teleports to <body>, outside the mounted component's own subtree.
function body() {
  return new DOMWrapper(document.body)
}

interface ButtonQueryable {
  findAll(selector: string): DOMWrapper<Element>[]
}

function findButtonByText(scope: ButtonQueryable, text: string) {
  const button = scope.findAll('button').find((candidate) => candidate.text().trim() === text)
  if (!button) throw new Error(`No button found with text "${text}"`)
  return button
}

describe('NightShiftView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedUseNightShiftStore.mockReset()
    routeQuery = {}
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loads policies on mount and lists each with its load count', async () => {
    const store = createStoreStub({
      policies: [standardPolicy, hazmatPolicy],
      loadsByPolicy: { 'pol-standard': 2, 'pol-hazmat': 5 },
    })
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)

    const wrapper = mount(NightShiftView)
    await flushPromises()

    expect(store.loadPolicies).toHaveBeenCalled()
    expect(wrapper.text()).toContain('Standard')
    expect(wrapper.text()).toContain('2 loads')
    expect(wrapper.text()).toContain('Hazmat')
    expect(wrapper.text()).toContain('5 loads')
  })

  it('explains what the night shift is and that shadow means watch only', async () => {
    mockedUseNightShiftStore.mockReturnValue(createStoreStub() as unknown as ReturnType<typeof useNightShiftStore>)

    const wrapper = mount(NightShiftView)
    await flushPromises()

    expect(wrapper.text().toLowerCase()).toContain('watch only')
  })

  it('editing Standard\'s stopMin and saving calls savePolicy (PUT) with the whole policy', async () => {
    const store = createStoreStub()
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)

    const wrapper = mount(NightShiftView)
    await flushPromises()

    await wrapper.find('#policy-stop-min').setValue(25)
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    expect(store.savePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'pol-standard',
        name: 'Standard',
        stopMin: 25,
        delayMin: standardPolicy.delayMin,
        darkMin: standardPolicy.darkMin,
        darkAtStopMin: standardPolicy.darkAtStopMin,
        offRouteMi: standardPolicy.offRouteMi,
        offRouteMin: standardPolicy.offRouteMin,
        rungGapMin: standardPolicy.rungGapMin,
        maxCalls: standardPolicy.maxCalls,
        dispatcherEmail: standardPolicy.dispatcherEmail,
        shadow: true,
      }),
    )
  })

  it('Standard has no delete button', async () => {
    mockedUseNightShiftStore.mockReturnValue(createStoreStub() as unknown as ReturnType<typeof useNightShiftStore>)

    const wrapper = mount(NightShiftView)
    await flushPromises()

    expect(wrapper.find('[data-testid="delete-policy"]').exists()).toBe(false)
  })

  it('a non-Standard policy shows a delete button', async () => {
    const store = createStoreStub({
      policies: [standardPolicy, hazmatPolicy],
      loadsByPolicy: {},
    })
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)

    const wrapper = mount(NightShiftView)
    await flushPromises()

    await wrapper.find('[data-testid="policy-row-pol-hazmat"]').trigger('click')

    expect(wrapper.find('[data-testid="delete-policy"]').exists()).toBe(true)
  })

  it('choosing Live shows a confirmation naming what going live means, and cancelling leaves it in shadow', async () => {
    const store = createStoreStub()
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)

    const wrapper = mount(NightShiftView)
    await flushPromises()

    expect(body().find('[role="dialog"]').exists()).toBe(false)

    await wrapper.find('[data-testid="choose-live"]').trigger('click')

    expect(body().find('[role="dialog"]').exists()).toBe(true)
    expect(body().text()).toContain('the agent will text and call drivers and email you')

    await findButtonByText(body(), 'Cancel').trigger('click')
    expect(body().find('[role="dialog"]').exists()).toBe(false)

    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    expect(store.savePolicy).toHaveBeenCalledWith(expect.objectContaining({ shadow: true }))
  })

  it('confirming go-live flips the policy to live on save', async () => {
    const store = createStoreStub()
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)

    const wrapper = mount(NightShiftView)
    await flushPromises()

    await wrapper.find('[data-testid="choose-live"]').trigger('click')
    await body().find('[data-testid="confirm-go-live"]').trigger('click')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    expect(store.savePolicy).toHaveBeenCalledWith(expect.objectContaining({ shadow: false }))
  })

  it('"New policy" starts a second policy from Standard\'s values', async () => {
    const store = createStoreStub()
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)

    const wrapper = mount(NightShiftView)
    await flushPromises()

    await wrapper.find('[data-testid="new-policy"]').trigger('click')

    expect((wrapper.find('#policy-name').element as HTMLInputElement).value).toBe('')
    expect((wrapper.find('#policy-stop-min').element as HTMLInputElement).valueAsNumber).toBe(standardPolicy.stopMin)
    expect((wrapper.find('#policy-max-calls').element as HTMLInputElement).valueAsNumber).toBe(standardPolicy.maxCalls)

    await wrapper.find('#policy-name').setValue('Hazmat')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    expect(store.savePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ id: undefined, name: 'Hazmat', stopMin: standardPolicy.stopMin }),
    )
  })

  describe('tabs (Task 11)', () => {
    it('defaults to the Policies tab and keeps the existing editor untouched', async () => {
      mockedUseNightShiftStore.mockReturnValue(createStoreStub() as unknown as ReturnType<typeof useNightShiftStore>)
      const wrapper = mount(NightShiftView)
      await flushPromises()
      expect(wrapper.find('[data-testid="tab-policies"]').classes().join(' ')).toContain('border-brand')
      expect(wrapper.find('[data-testid="policy-list"]').exists()).toBe(true)
    })

    it('?tab=connect opens the Connect tab instead of Policies', async () => {
      routeQuery = { tab: 'connect' }
      mockedUseNightShiftStore.mockReturnValue(createStoreStub() as unknown as ReturnType<typeof useNightShiftStore>)
      const wrapper = mount(NightShiftView)
      await flushPromises()
      expect(wrapper.find('[data-testid="connect-sheet"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="policy-list"]').exists()).toBe(false)
    })

    it('?tab=usage and ?tab=settings show a one-line "Coming next" panel', async () => {
      routeQuery = { tab: 'usage' }
      mockedUseNightShiftStore.mockReturnValue(createStoreStub() as unknown as ReturnType<typeof useNightShiftStore>)
      const usageWrapper = mount(NightShiftView)
      await flushPromises()
      expect(usageWrapper.get('[data-testid="coming-next"]').text()).toContain('usage')

      routeQuery = { tab: 'settings' }
      const settingsWrapper = mount(NightShiftView)
      await flushPromises()
      expect(settingsWrapper.get('[data-testid="coming-next"]').text()).toContain('settings')
    })

    it('clicking the Connect tab button switches views without a query param', async () => {
      mockedUseNightShiftStore.mockReturnValue(createStoreStub() as unknown as ReturnType<typeof useNightShiftStore>)
      const wrapper = mount(NightShiftView)
      await flushPromises()
      await wrapper.find('[data-testid="tab-connect"]').trigger('click')
      expect(wrapper.find('[data-testid="connect-sheet"]').exists()).toBe(true)
    })
  })
})
