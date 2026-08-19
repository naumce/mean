import { DOMWrapper, RouterLinkStub, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDriversStore } from '../stores/drivers'
import { useTripsStore } from '../stores/trips'
import TripsView from './TripsView.vue'

vi.mock('../stores/drivers', () => ({
  useDriversStore: vi.fn(),
}))
vi.mock('../stores/trips', () => ({
  useTripsStore: vi.fn(),
}))

const mockedUseDriversStore = vi.mocked(useDriversStore)
const mockedUseTripsStore = vi.mocked(useTripsStore)

function createDriversStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    items: [{ id: 'drv-1', name: 'Dana Driver', email: 'dana@fleet.test', phone: null, status: 'active', createdAt: '2026-01-01' }],
    loading: false,
    error: null,
    list: vi.fn(),
    ...overrides,
  }
}

function createTripsStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    items: [],
    current: null,
    loading: false,
    error: null,
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn().mockResolvedValue(undefined),
    assign: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

interface ButtonQueryable {
  findAll(selector: string): DOMWrapper<Element>[]
}

function findButtonByText(scope: ButtonQueryable, text: string) {
  const button = scope.findAll('button').find((candidate) => candidate.text().trim() === text)
  if (!button) throw new Error(`No button found with text "${text}"`)
  return button
}

// Modal teleports its content to document.body, outside the mounted
// component's own (detached) DOM subtree, so assertions on the dialog query
// the real document instead of the wrapper.
function body() {
  return new DOMWrapper(document.body)
}

function mountTripsView() {
  return mount(TripsView, {
    global: {
      stubs: { RouterLink: RouterLinkStub },
    },
  })
}

const pendingTrip = {
  id: 't1',
  identifier: 'TRIP-001',
  status: 'pending',
  driverId: null,
  stops: [{ id: 's1', sequence: 1, address: '123 Main St' }],
  createdAt: '2026-01-01',
}

const assignedTrip = {
  id: 't2',
  identifier: 'TRIP-002',
  status: 'assigned',
  driverId: 'drv-1',
  stops: [
    { id: 's2', sequence: 1, address: '1 First Ave' },
    { id: 's3', sequence: 2, address: '2 Second Ave' },
  ],
  createdAt: '2026-01-02',
}

describe('TripsView', () => {
  beforeEach(() => {
    mockedUseDriversStore.mockReset()
    mockedUseTripsStore.mockReset()
    mockedUseDriversStore.mockReturnValue(createDriversStoreStub() as unknown as ReturnType<typeof useDriversStore>)
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loads trips and drivers on mount and renders trips grouped by status', () => {
    const tripsStore = createTripsStoreStub({ items: [pendingTrip, assignedTrip] })
    mockedUseTripsStore.mockReturnValue(tripsStore as unknown as ReturnType<typeof useTripsStore>)

    const wrapper = mountTripsView()

    expect(tripsStore.list).toHaveBeenCalled()
    expect(mockedUseDriversStore().list).toHaveBeenCalled

    const pendingSection = wrapper.find('[data-status-group="pending"]')
    const assignedSection = wrapper.find('[data-status-group="assigned"]')
    expect(pendingSection.text()).toContain('TRIP-001')
    expect(pendingSection.text()).not.toContain('TRIP-002')
    expect(assignedSection.text()).toContain('TRIP-002')
    expect(assignedSection.text()).toContain('Dana Driver')
    expect(assignedSection.text()).toContain('2')
  })

  it('opening "Create trip" shows the create modal with one stop row', async () => {
    mockedUseTripsStore.mockReturnValue(createTripsStoreStub() as unknown as ReturnType<typeof useTripsStore>)
    const wrapper = mountTripsView()

    expect(body().find('[role="dialog"]').exists()).toBe(false)

    await findButtonByText(wrapper, 'Create trip').trigger('click')

    expect(body().find('[role="dialog"]').exists()).toBe(true)
    expect(body().findAll('[data-stop-row]')).toHaveLength(1)
  })

  it('"Add stop" adds another stop row to the create form', async () => {
    mockedUseTripsStore.mockReturnValue(createTripsStoreStub() as unknown as ReturnType<typeof useTripsStore>)
    const wrapper = mountTripsView()

    await findButtonByText(wrapper, 'Create trip').trigger('click')
    await findButtonByText(body(), 'Add stop').trigger('click')

    expect(body().findAll('[data-stop-row]')).toHaveLength(2)
  })

  it('submitting the create form calls store.create with the identifier and stops array', async () => {
    const tripsStore = createTripsStoreStub()
    mockedUseTripsStore.mockReturnValue(tripsStore as unknown as ReturnType<typeof useTripsStore>)
    const wrapper = mountTripsView()

    await findButtonByText(wrapper, 'Create trip').trigger('click')

    await body().find('#trip-identifier').setValue('TRIP-100')
    await body().find('#trip-stop-address-0').setValue('123 Main St')
    await body().findAll('form')[0]?.trigger('submit.prevent')
    await Promise.resolve()

    expect(tripsStore.create).toHaveBeenCalledWith({
      identifier: 'TRIP-100',
      stops: [{ sequence: 1, address: '123 Main St' }],
    })
  })

  it('assigning a driver calls store.assign with the trip id and selected driver', async () => {
    const tripsStore = createTripsStoreStub({ items: [pendingTrip] })
    mockedUseTripsStore.mockReturnValue(tripsStore as unknown as ReturnType<typeof useTripsStore>)
    const wrapper = mountTripsView()

    await findButtonByText(wrapper, 'Assign').trigger('click')
    await body().find('#trip-driver').setValue('drv-1')

    const forms = body().findAll('form')
    await forms[forms.length - 1]?.trigger('submit.prevent')
    await Promise.resolve()

    expect(tripsStore.assign).toHaveBeenCalledWith('t1', 'drv-1')
  })
})
