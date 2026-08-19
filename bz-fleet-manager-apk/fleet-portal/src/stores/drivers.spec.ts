import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useDriversStore } from './drivers'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}))

const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const mockedPut = vi.mocked(api.put)

const sampleDriver = {
  id: '1',
  email: 'dana@fleet.test',
  name: 'Dana Driver',
  phone: '555-0100',
  status: 'active',
  createdAt: '2026-01-01',
}

describe('useDriversStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPost.mockReset()
    mockedPut.mockReset()
  })

  it('starts with no drivers, not loading, no error', () => {
    const store = useDriversStore()

    expect(store.items).toEqual([])
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('list fetches drivers from the dispatcher endpoint and populates items', async () => {
    mockedGet.mockResolvedValueOnce({ data: [sampleDriver] })

    const store = useDriversStore()
    await store.list()

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/drivers')
    expect(store.items).toEqual([sampleDriver])
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('list sets an error and leaves items empty on failure', async () => {
    mockedGet.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })

    const store = useDriversStore()
    await store.list()

    expect(store.items).toEqual([])
    expect(store.error).toBeTruthy()
    expect(store.loading).toBe(false)
  })

  it('create posts the payload to the dispatcher endpoint and refreshes the list', async () => {
    mockedPost.mockResolvedValueOnce({ data: sampleDriver })
    mockedGet.mockResolvedValueOnce({ data: [sampleDriver] })

    const store = useDriversStore()
    const payload = { email: 'dana@fleet.test', name: 'Dana Driver', phone: '555-0100', password: 'hunter2' }
    await store.create(payload)

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/drivers', payload)
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/drivers')
    expect(store.items).toEqual([sampleDriver])
  })

  it('create surfaces an error and does not refresh the list on failure', async () => {
    mockedPost.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 400, data: { error: 'Email already in use' } },
    })

    const store = useDriversStore()
    await expect(
      store.create({ email: 'dana@fleet.test', name: 'Dana Driver', password: 'hunter2' }),
    ).rejects.toBeTruthy()

    expect(store.error).toBeTruthy()
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('update puts the payload to the driver endpoint and refreshes the list', async () => {
    mockedPut.mockResolvedValueOnce({ data: sampleDriver })
    mockedGet.mockResolvedValueOnce({ data: [sampleDriver] })

    const store = useDriversStore()
    await store.update('1', { name: 'Dana D. Driver' })

    expect(mockedPut).toHaveBeenCalledWith('/dispatcher/drivers/1', { name: 'Dana D. Driver' })
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/drivers')
  })

  it('update surfaces an error and does not refresh the list on failure', async () => {
    mockedPut.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 404, data: { error: 'Driver not found' } },
    })

    const store = useDriversStore()
    await expect(store.update('missing', { name: 'X' })).rejects.toBeTruthy()

    expect(store.error).toBeTruthy()
    expect(mockedGet).not.toHaveBeenCalled()
  })
})
