import { DOMWrapper, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApprovalsStore } from '../stores/approvals'
import ApprovalsView from './ApprovalsView.vue'

vi.mock('../stores/approvals', () => ({
  useApprovalsStore: vi.fn(),
}))

const mockedUseApprovalsStore = vi.mocked(useApprovalsStore)

const pendingTrip = {
  id: 't1',
  identifier: 'TRIP-001',
  status: 'pending',
  driverId: null,
  stops: [{ id: 's1', sequence: 1, address: '123 Main St' }],
  createdAt: '2026-01-01',
}

const pendingProof = {
  id: 'p1',
  tripId: 't1',
  stopId: 's1',
  proofType: 'signature',
  fileUrl: 'https://example.test/proof.png',
  status: 'pending',
  createdAt: '2026-01-01',
}

function createApprovalsStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    pendingTrips: [],
    pendingProofs: [],
    loading: false,
    error: null,
    listTrips: vi.fn(),
    listSignsProof: vi.fn(),
    approveTrip: vi.fn().mockResolvedValue(undefined),
    rejectTrip: vi.fn().mockResolvedValue(undefined),
    approveProof: vi.fn().mockResolvedValue(undefined),
    rejectProof: vi.fn().mockResolvedValue(undefined),
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

describe('ApprovalsView', () => {
  beforeEach(() => {
    mockedUseApprovalsStore.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loads pending trips and proofs on mount and renders them', () => {
    const store = createApprovalsStoreStub({ pendingTrips: [pendingTrip], pendingProofs: [pendingProof] })
    mockedUseApprovalsStore.mockReturnValue(store as unknown as ReturnType<typeof useApprovalsStore>)

    const wrapper = mount(ApprovalsView)

    expect(store.listTrips).toHaveBeenCalled()
    expect(store.listSignsProof).toHaveBeenCalled()
    expect(wrapper.text()).toContain('TRIP-001')
    expect(wrapper.text()).toContain('signature')
  })

  it('clicking Approve on a pending trip calls approveTrip', async () => {
    const store = createApprovalsStoreStub({ pendingTrips: [pendingTrip] })
    mockedUseApprovalsStore.mockReturnValue(store as unknown as ReturnType<typeof useApprovalsStore>)
    const wrapper = mount(ApprovalsView)

    await findButtonByText(wrapper, 'Approve').trigger('click')
    await Promise.resolve()

    expect(store.approveTrip).toHaveBeenCalledWith('t1')
  })

  it('clicking Approve on a pending proof calls approveProof', async () => {
    const store = createApprovalsStoreStub({ pendingProofs: [pendingProof] })
    mockedUseApprovalsStore.mockReturnValue(store as unknown as ReturnType<typeof useApprovalsStore>)
    const wrapper = mount(ApprovalsView)

    await findButtonByText(wrapper, 'Approve').trigger('click')
    await Promise.resolve()

    expect(store.approveProof).toHaveBeenCalledWith('p1')
  })

  it('clicking Reject on a pending trip opens the reason modal and submits {reason}', async () => {
    const store = createApprovalsStoreStub({ pendingTrips: [pendingTrip] })
    mockedUseApprovalsStore.mockReturnValue(store as unknown as ReturnType<typeof useApprovalsStore>)
    const wrapper = mount(ApprovalsView)

    expect(body().find('[role="dialog"]').exists()).toBe(false)

    await findButtonByText(wrapper, 'Reject').trigger('click')

    expect(body().find('[role="dialog"]').exists()).toBe(true)

    await body().find('#reject-reason').setValue('Missing stop details')
    await body().find('form').trigger('submit.prevent')
    await Promise.resolve()

    expect(store.rejectTrip).toHaveBeenCalledWith('t1', 'Missing stop details')
  })

  it('clicking Reject on a pending proof opens the reason modal and submits {reason}', async () => {
    const store = createApprovalsStoreStub({ pendingProofs: [pendingProof] })
    mockedUseApprovalsStore.mockReturnValue(store as unknown as ReturnType<typeof useApprovalsStore>)
    const wrapper = mount(ApprovalsView)

    await findButtonByText(wrapper, 'Reject').trigger('click')
    await body().find('#reject-reason').setValue('Blurry photo')
    await body().find('form').trigger('submit.prevent')
    await Promise.resolve()

    expect(store.rejectProof).toHaveBeenCalledWith('p1', 'Blurry photo')
  })
})
