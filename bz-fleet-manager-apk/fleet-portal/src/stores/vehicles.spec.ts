import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useVehiclesStore } from './vehicles'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}))

const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const mockedPut = vi.mocked(api.put)

const sampleVehicle = {
  id: '1',
  plate: 'ABC-123',
  model: 'Ford Transit',
  driverId: null,
  createdAt: '2026-01-01',
}

describe('useVehiclesStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPost.mockReset()
    mockedPut.mockReset()
  })

  it('starts with no vehicles, not loading, no error', () => {
    const store = useVehiclesStore()

    expect(store.items).toEqual([])
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('list fetches vehicles from the dispatcher endpoint and populates items', async () => {
    mockedGet.mockResolvedValueOnce({ data: [sampleVehicle] })

    const store = useVehiclesStore()
    await store.list()

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/vehicles')
    expect(store.items).toEqual([sampleVehicle])
    expect(store.error).toBeNull()
  })

  it('list sets an error and leaves items empty on failure', async () => {
    mockedGet.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })

    const store = useVehiclesStore()
    await store.list()

    expect(store.items).toEqual([])
    expect(store.error).toBeTruthy()
    expect(store.loading).toBe(false)
  })

  it('create posts the payload to the dispatcher endpoint and refreshes the list', async () => {
    mockedPost.mockResolvedValueOnce({ data: sampleVehicle })
    mockedGet.mockResolvedValueOnce({ data: [sampleVehicle] })

    const store = useVehiclesStore()
    const payload = { plate: 'ABC-123', model: 'Ford Transit' }
    await store.create(payload)

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/vehicles', payload)
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/vehicles')
    expect(store.items).toEqual([sampleVehicle])
  })

  it('create surfaces an error and does not refresh the list on failure', async () => {
    mockedPost.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 400, data: { error: 'Plate already registered' } },
    })

    const store = useVehiclesStore()
    await expect(store.create({ plate: 'ABC-123' })).rejects.toBeTruthy()

    expect(store.error).toBeTruthy()
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('update puts the payload to the vehicle endpoint and refreshes the list', async () => {
    mockedPut.mockResolvedValueOnce({ data: sampleVehicle })
    mockedGet.mockResolvedValueOnce({ data: [sampleVehicle] })

    const store = useVehiclesStore()
    await store.update('1', { model: 'Ford Transit Custom' })

    expect(mockedPut).toHaveBeenCalledWith('/dispatcher/vehicles/1', { model: 'Ford Transit Custom' })
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/vehicles')
  })

  it('assign posts {driverId} to the assign endpoint and refreshes the list', async () => {
    mockedPost.mockResolvedValueOnce({ data: { ...sampleVehicle, driverId: 'drv-1' } })
    mockedGet.mockResolvedValueOnce({ data: [{ ...sampleVehicle, driverId: 'drv-1' }] })

    const store = useVehiclesStore()
    await store.assign('1', 'drv-1')

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/vehicles/1/assign', { driverId: 'drv-1' })
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/vehicles')
    expect(store.items[0].driverId).toBe('drv-1')
  })

  it('assign surfaces an error and does not refresh the list on failure', async () => {
    mockedPost.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 404, data: { error: 'Driver not found' } },
    })

    const store = useVehiclesStore()
    await expect(store.assign('1', 'missing-driver')).rejects.toBeTruthy()

    expect(store.error).toBeTruthy()
    expect(mockedGet).not.toHaveBeenCalled()
  })
})
