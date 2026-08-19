import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useApprovalsStore } from './approvals'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))

const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)

const samplePendingTrip = {
  id: 't1',
  identifier: 'TRIP-001',
  status: 'pending',
  driverId: null,
  stops: [{ id: 's1', sequence: 1, address: '123 Main St' }],
  createdAt: '2026-01-01',
}

const samplePendingProof = {
  id: 'p1',
  tripId: 't1',
  stopId: 's1',
  proofType: 'signature',
  fileUrl: 'https://example.test/proof.png',
  status: 'pending',
  createdAt: '2026-01-01',
}

describe('useApprovalsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPost.mockReset()
  })

  it('starts empty, not loading, no error', () => {
    const store = useApprovalsStore()

    expect(store.pendingTrips).toEqual([])
    expect(store.pendingProofs).toEqual([])
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('listTrips fetches pending trip approvals and populates pendingTrips', async () => {
    mockedGet.mockResolvedValueOnce({ data: [samplePendingTrip] })

    const store = useApprovalsStore()
    await store.listTrips()

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/approvals/trips')
    expect(store.pendingTrips).toEqual([samplePendingTrip])
    expect(store.error).toBeNull()
  })

  it('listTrips sets an error on failure', async () => {
    mockedGet.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })

    const store = useApprovalsStore()
    await store.listTrips()

    expect(store.pendingTrips).toEqual([])
    expect(store.error).toBeTruthy()
  })

  it('approveTrip posts to the approve endpoint and refreshes pendingTrips', async () => {
    mockedPost.mockResolvedValueOnce({ data: {} })
    mockedGet.mockResolvedValueOnce({ data: [] })

    const store = useApprovalsStore()
    await store.approveTrip('t1')

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/trips/t1/approve')
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/approvals/trips')
    expect(store.pendingTrips).toEqual([])
  })

  it('approveTrip surfaces an error and does not refresh on failure', async () => {
    mockedPost.mockRejectedValueOnce({ isAxiosError: true, response: { status: 400, data: {} } })

    const store = useApprovalsStore()
    await expect(store.approveTrip('t1')).rejects.toBeTruthy()

    expect(store.error).toBeTruthy()
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('rejectTrip posts {reason} to the reject endpoint and refreshes pendingTrips', async () => {
    mockedPost.mockResolvedValueOnce({ data: {} })
    mockedGet.mockResolvedValueOnce({ data: [] })

    const store = useApprovalsStore()
    await store.rejectTrip('t1', 'Missing stop details')

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/trips/t1/reject', { reason: 'Missing stop details' })
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/approvals/trips')
  })

  it('rejectTrip surfaces an error and does not refresh on failure', async () => {
    mockedPost.mockRejectedValueOnce({ isAxiosError: true, response: { status: 400, data: {} } })

    const store = useApprovalsStore()
    await expect(store.rejectTrip('t1', 'bad')).rejects.toBeTruthy()

    expect(store.error).toBeTruthy()
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('listSignsProof fetches pending proof approvals and populates pendingProofs', async () => {
    mockedGet.mockResolvedValueOnce({ data: [samplePendingProof] })

    const store = useApprovalsStore()
    await store.listSignsProof()

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/approvals/signs-proof')
    expect(store.pendingProofs).toEqual([samplePendingProof])
  })

  it('listSignsProof sets an error on failure', async () => {
    mockedGet.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })

    const store = useApprovalsStore()
    await store.listSignsProof()

    expect(store.pendingProofs).toEqual([])
    expect(store.error).toBeTruthy()
  })

  it('approveProof posts to the approve endpoint and refreshes pendingProofs', async () => {
    mockedPost.mockResolvedValueOnce({ data: {} })
    mockedGet.mockResolvedValueOnce({ data: [] })

    const store = useApprovalsStore()
    await store.approveProof('p1')

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/signs-proof/p1/approve')
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/approvals/signs-proof')
  })

  it('approveProof surfaces an error and does not refresh on failure', async () => {
    mockedPost.mockRejectedValueOnce({ isAxiosError: true, response: { status: 400, data: {} } })

    const store = useApprovalsStore()
    await expect(store.approveProof('p1')).rejects.toBeTruthy()

    expect(store.error).toBeTruthy()
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('rejectProof posts {reason} to the reject endpoint and refreshes pendingProofs', async () => {
    mockedPost.mockResolvedValueOnce({ data: {} })
    mockedGet.mockResolvedValueOnce({ data: [] })

    const store = useApprovalsStore()
    await store.rejectProof('p1', 'Blurry photo')

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/signs-proof/p1/reject', { reason: 'Blurry photo' })
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/approvals/signs-proof')
  })

  it('rejectProof surfaces an error and does not refresh on failure', async () => {
    mockedPost.mockRejectedValueOnce({ isAxiosError: true, response: { status: 400, data: {} } })

    const store = useApprovalsStore()
    await expect(store.rejectProof('p1', 'bad')).rejects.toBeTruthy()

    expect(store.error).toBeTruthy()
    expect(mockedGet).not.toHaveBeenCalled()
  })
})
