import { DOMWrapper, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDriversStore } from '../stores/drivers'
import DriversView from './DriversView.vue'

vi.mock('../stores/drivers', () => ({
  useDriversStore: vi.fn(),
}))

const mockedUseDriversStore = vi.mocked(useDriversStore)

function createStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    items: [],
    loading: false,
    error: null,
    list: vi.fn(),
    create: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
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

describe('DriversView', () => {
  beforeEach(() => {
    mockedUseDriversStore.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loads drivers on mount and renders a row per driver', () => {
    const store = createStoreStub({
      items: [
        { id: '1', name: 'Dana Driver', email: 'dana@fleet.test', phone: '555-0100', status: 'active', createdAt: '2026-01-01' },
      ],
    })
    mockedUseDriversStore.mockReturnValue(store as unknown as ReturnType<typeof useDriversStore>)

    const wrapper = mount(DriversView)

    expect(store.list).toHaveBeenCalled()
    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
    expect(wrapper.text()).toContain('Dana Driver')
    expect(wrapper.text()).toContain('dana@fleet.test')
  })

  it('opening "Add driver" shows the create modal', async () => {
    mockedUseDriversStore.mockReturnValue(createStoreStub() as unknown as ReturnType<typeof useDriversStore>)
    const wrapper = mount(DriversView)

    expect(body().find('[role="dialog"]').exists()).toBe(false)

    await findButtonByText(wrapper, 'Add driver').trigger('click')

    expect(body().find('[role="dialog"]').exists()).toBe(true)
  })

  it('submitting the create form calls store.create with the entered driver', async () => {
    const store = createStoreStub()
    mockedUseDriversStore.mockReturnValue(store as unknown as ReturnType<typeof useDriversStore>)
    const wrapper = mount(DriversView)

    await findButtonByText(wrapper, 'Add driver').trigger('click')

    await body().find('#driver-name').setValue('New Driver')
    await body().find('#driver-email').setValue('new@fleet.test')
    await body().find('#driver-phone').setValue('555-0199')
    await body().find('#driver-password').setValue('hunter2')

    await body().find('form').trigger('submit.prevent')
    await Promise.resolve()

    expect(store.create).toHaveBeenCalledWith({
      name: 'New Driver',
      email: 'new@fleet.test',
      phone: '555-0199',
      password: 'hunter2',
    })
  })
})
