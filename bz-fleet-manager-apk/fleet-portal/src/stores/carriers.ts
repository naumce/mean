import { defineStore } from 'pinia'
import { fetchCarriers, type Carrier } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'

// T1 Carrier Layer, Task 6: the client-company roster behind the cost model.
// A thin, read-mostly store (the list, an id index, and the current
// selection) — carrier CRUD is a later task; this one just gets the roster
// onto the cockpit so T7-T9 can group/filter/badge lanes by carrier.

export type { Carrier }

interface CarriersState {
  list: Carrier[]
  selectedCarrierId: string | null
  loading: boolean
  error: string | null
}

export const useCarriersStore = defineStore('carriers', {
  state: (): CarriersState => ({
    list: [],
    selectedCarrierId: null,
    loading: false,
    error: null,
  }),

  getters: {
    /** O(1) lookup by id, derived from `list` on every access — never a
     *  second copy that could drift out of sync with it. */
    byId(state): Record<string, Carrier> {
      const map: Record<string, Carrier> = {}
      for (const carrier of state.list) map[carrier.id] = carrier
      return map
    },
  },

  actions: {
    /** Load the caller org's carriers. Auxiliary, like loadboard's
     *  alerts/kpis/yard: the cockpit renders whether or not carriers
     *  resolve, so a failure is recorded in `error` and swallowed here
     *  instead of thrown into the view — it must never blank a working
     *  board. `list` is simply never assigned on failure, so it stays
     *  whatever it already was (empty, on a first load). */
    async load(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        this.list = await fetchCarriers()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load carriers right now.')
      } finally {
        this.loading = false
      }
    },

    /** Set (or clear, with null) the carrier a filter/group surface has picked. */
    select(id: string | null): void {
      this.selectedCarrierId = id
    },
  },
})
