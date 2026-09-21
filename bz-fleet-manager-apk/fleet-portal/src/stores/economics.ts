import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { triggerDownload } from '../lib/download'
import { extractApiErrorMessage } from '../lib/errors'

// Money screen: per-load committed economics (worst margin first, served by
// /dispatcher/economics) plus the org cost model that prices every future
// dispatch (/dispatcher/settings/cost-model).

export interface EconomicsRow {
  loadId: string
  ref: string
  broker: string | null
  commodity: string | null
  status: string
  driverName: string | null
  plannedStart: string | null
  revenueCents: number
  loadedMi: number
  deadheadMi: number
  totalMi: number
  rpmLoadedCents: number
  rpmAllCents: number
  estCostCents: number
  marginCents: number
  marginPct: number
}

export interface EconomicsTotals {
  loads: number
  revenueCents: number
  estCostCents: number
  marginCents: number
  marginPct: number
  loadedMi: number
  deadheadMi: number
  totalMi: number
  deadheadPct: number
  rpmLoadedCents: number
}

export interface CostModel {
  mpg: number
  dieselCentsPerGal: number
  driverPayCentsPerMi: number
  fixedCentsPerMi: number
  allInCentsPerMi: number
}

interface EconomicsState {
  rows: EconomicsRow[]
  totals: EconomicsTotals | null
  costModel: CostModel | null
  /** dispatch-date window last applied; export reuses it so the file matches the screen */
  range: { from?: string; to?: string } | null
  loading: boolean
  saving: boolean
  error: string | null
  /** transient "Saved" confirmation after a cost-model write */
  saved: boolean
}

export const useEconomicsStore = defineStore('economics', {
  state: (): EconomicsState => ({
    rows: [],
    totals: null,
    costModel: null,
    range: null,
    loading: false,
    saving: false,
    error: null,
    saved: false,
  }),

  actions: {
    async loadEconomics(range?: { from?: string; to?: string }): Promise<void> {
      this.loading = true
      this.error = null
      this.range = range ?? null
      try {
        const { data } = await api.get<{ loads: EconomicsRow[]; totals: EconomicsTotals }>('/dispatcher/economics', {
          params: { ...range },
        })
        this.rows = data.loads
        this.totals = data.totals
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      } finally {
        this.loading = false
      }
    },

    /** Download the per-load table as CSV (server renders it, worst-first). */
    async exportCsv(): Promise<void> {
      this.error = null
      try {
        const { data } = await api.get<string>('/dispatcher/economics', {
          params: { format: 'csv', ...this.range },
          responseType: 'text',
        })
        triggerDownload(`money-per-load-${new Date().toISOString().slice(0, 10)}.csv`, data)
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      }
    },

    async loadCostModel(): Promise<void> {
      try {
        const { data } = await api.get<CostModel>('/dispatcher/settings/cost-model')
        this.costModel = data
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      }
    },

    /** Persist edited knobs; the server echoes the full config back. */
    async saveCostModel(update: Partial<Omit<CostModel, 'allInCentsPerMi'>>): Promise<void> {
      this.saving = true
      this.saved = false
      this.error = null
      try {
        const { data } = await api.patch<CostModel>('/dispatcher/settings/cost-model', update)
        this.costModel = data
        this.saved = true
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      } finally {
        this.saving = false
      }
    },
  },
})
