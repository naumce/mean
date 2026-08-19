import { DOMWrapper, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDriversStore } from '../stores/drivers'
import { useVehiclesStore } from '../stores/vehicles'
import VehiclesView from './VehiclesView.vue'

vi.mock('../stores/drivers', () => ({
  useDriversStore: vi.fn(),
}))
vi.mock('../stores/vehicles', () => ({
  useVehiclesStore: vi.fn(),
}))

const mockedUseDriversStore = vi.mocked(useDriversStore)
const mockedUseVehiclesStore = vi.mocked(useVehiclesStore)

function createDriversStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    items: [{ id: 'drv-1', name: 'Dana Driver', email: 'dana@fleet.test', phone: null, status: 'active', createdAt: '2026-01-01' }],
    loading: false,
    error: null,
    list: vi.fn(),
    create: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function createVehiclesStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    items: [],
    loading: false,
    error: null,
    list: vi.fn(),
    create: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    assign: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// Accepts both VueWrapper (from mount) and DOMWrapper (from body(), below) —
// they share the findAll shape used here but aren't otherwise compatible types.
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

describe('VehiclesView', () => {
  beforeEach(() => {
    mockedUseDriversStore.mockReset()
    mockedUseVehiclesStore.mockReset()
    mockedUseDriversStore.mockReturnValue(createDriversStoreStub() as unknown as ReturnType<typeof useDriversStore>)
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loads vehicles and drivers on mount and renders a row per vehicle', () => {
    const vehiclesStore = createVehiclesStoreStub({
      items: [{ id: '1', plate: 'ABC-123', model: 'Ford Transit', driverId: null, createdAt: '2026-01-01' }],
    })
    mockedUseVehiclesStore.mockReturnValue(vehiclesStore as unknown as ReturnType<typeof useVehiclesStore>)

    const wrapper = mount(VehiclesView)

    expect(vehiclesStore.list).toHaveBeenCalled()
    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
    expect(wrapper.text()).toContain('ABC-123')
    expect(wrapper.text()).toContain('Unassigned')
  })

  it('shows the assigned driver name for a vehicle with a driverId', () => {
    const vehiclesStore = createVehiclesStoreStub({
      items: [{ id: '1', plate: 'ABC-123', model: 'Ford Transit', driverId: 'drv-1', createdAt: '2026-01-01' }],
    })
    mockedUseVehiclesStore.mockReturnValue(vehiclesStore as unknown as ReturnType<typeof useVehiclesStore>)

    const wrapper = mount(VehiclesView)

    expect(wrapper.text()).toContain('Dana Driver')
  })

  it('opening "Add vehicle" shows the create modal', async () => {
    mockedUseVehiclesStore.mockReturnValue(createVehiclesStoreStub() as unknown as ReturnType<typeof useVehiclesStore>)
    const wrapper = mount(VehiclesView)

    expect(body().find('[role="dialog"]').exists()).toBe(false)

    await findButtonByText(wrapper, 'Add vehicle').trigger('click')

    expect(body().find('[role="dialog"]').exists()).toBe(true)
  })

  it('submitting the create form calls store.create with the entered vehicle', async () => {
    const vehiclesStore = createVehiclesStoreStub()
    mockedUseVehiclesStore.mockReturnValue(vehiclesStore as unknown as ReturnType<typeof useVehiclesStore>)
    const wrapper = mount(VehiclesView)

    await findButtonByText(wrapper, 'Add vehicle').trigger('click')

    await body().find('#vehicle-plate').setValue('XYZ-987')
    await body().find('#vehicle-model').setValue('Sprinter')
    await body().findAll('form')[0]?.trigger('submit.prevent')
    await Promise.resolve()

    expect(vehiclesStore.create).toHaveBeenCalledWith({ plate: 'XYZ-987', model: 'Sprinter' })
  })

  it('assigning a driver calls store.assign with the vehicle id and selected driver', async () => {
    const vehiclesStore = createVehiclesStoreStub({
      items: [{ id: '1', plate: 'ABC-123', model: 'Ford Transit', driverId: null, createdAt: '2026-01-01' }],
    })
    mockedUseVehiclesStore.mockReturnValue(vehiclesStore as unknown as ReturnType<typeof useVehiclesStore>)
    const wrapper = mount(VehiclesView)

    await findButtonByText(wrapper, 'Assign').trigger('click')
    await body().find('#vehicle-driver').setValue('drv-1')

    const forms = body().findAll('form')
    await forms[forms.length - 1]?.trigger('submit.prevent')
    await Promise.resolve()

    expect(vehiclesStore.assign).toHaveBeenCalledWith('1', 'drv-1')
  })
})
