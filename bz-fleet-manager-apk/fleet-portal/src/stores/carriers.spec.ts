import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchCarriers, type Carrier } from '../lib/api'
import { useCarriersStore } from './carriers'

vi.mock('../lib/api', () => ({
  fetchCarriers: vi.fn(),
}))

const mockedFetchCarriers = vi.mocked(fetchCarriers)

const carrierFor = (id: string, over: Partial<Carrier> = {}): Carrier => ({
  id,
  name: `Carrier ${id}`,
  mcNumber: 'MC123',
  dotNumber: 'DOT456',
  status: 'active',
  mpg: 6.5,
  dieselCentsPerGal: 410,
  driverPayCentsPerMi: 60,
  fixedCentsPerMi: 15,
  ...over,
})

describe('useCarriersStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedFetchCarriers.mockReset()
  })

  it('starts with an empty roster, no selection, not loading, no error', () => {
    const store = useCarriersStore()

    expect(store.list).toEqual([])
    expect(store.byId).toEqual({})
    expect(store.selectedCarrierId).toBeNull()
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  describe('load()', () => {
    it('populates list and indexes byId', async () => {
      const carrierA = carrierFor('c1')
      const carrierB = carrierFor('c2')
      mockedFetchCarriers.mockResolvedValueOnce([carrierA, carrierB])

      const store = useCarriersStore()
      await store.load()

      expect(mockedFetchCarriers).toHaveBeenCalledOnce()
      expect(store.list).toEqual([carrierA, carrierB])
      expect(store.byId).toEqual({ c1: carrierA, c2: carrierB })
      expect(store.loading).toBe(false)
      expect(store.error).toBeNull()
    })

    // The cockpit renders whether or not carriers resolve — an unhandled
    // rejection here would blank a working board, so load() must swallow
    // the failure rather than let it propagate to the caller.
    it('leaves the list empty and does not throw when the request fails', async () => {
      mockedFetchCarriers.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })

      const store = useCarriersStore()
      await expect(store.load()).resolves.toBeUndefined()

      expect(store.list).toEqual([])
      expect(store.byId).toEqual({})
      expect(store.error).toBeTruthy()
      expect(store.loading).toBe(false)
    })

    // §6/I1: null is the explicit "inherit the org's value" signal (never
    // zero, never the org's own number) and the store must carry exactly
    // what the server said — a `?? 0` here would silently claim a carrier
    // charges nothing.
    it('keeps a null cost field null rather than defaulting it to 0 or an inherited value', async () => {
      const inheriting = carrierFor('c1', {
        mpg: null,
        dieselCentsPerGal: null,
        driverPayCentsPerMi: null,
        fixedCentsPerMi: null,
      })
      mockedFetchCarriers.mockResolvedValueOnce([inheriting])

      const store = useCarriersStore()
      await store.load()

      const stored = store.byId.c1
      expect(stored.mpg).toBeNull()
      expect(stored.dieselCentsPerGal).toBeNull()
      expect(stored.driverPayCentsPerMi).toBeNull()
      expect(stored.fixedCentsPerMi).toBeNull()
      // Not merely falsy-but-absent-checked — pin the exact value, so a
      // `?? 0` regression (which would also read "falsy") is caught.
      expect(stored.mpg).not.toBe(0)
    })
  })

  describe('select()', () => {
    it('reflects the selected carrier id', async () => {
      mockedFetchCarriers.mockResolvedValueOnce([carrierFor('c1'), carrierFor('c2')])
      const store = useCarriersStore()
      await store.load()

      store.select('c2')

      expect(store.selectedCarrierId).toBe('c2')
    })

    it('clears the selection when given null', () => {
      const store = useCarriersStore()
      store.select('c1')

      store.select(null)

      expect(store.selectedCarrierId).toBeNull()
    })
  })
})
