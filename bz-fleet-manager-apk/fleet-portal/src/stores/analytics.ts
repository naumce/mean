import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { triggerDownload } from '../lib/download'
import { extractApiErrorMessage } from '../lib/errors'

// Broker/customer profitability (V2 analytics): committed economics per
// freight relationship, served by /dispatcher/analytics/brokers.

export interface BrokerRow {
  broker: string
  loads: number
  revenueCents: number
  estCostCents: number
  marginCents: number
  loadedMi: number
  deadheadMi: number
  totalMi: number
  avgMarginPct: number
  ratePerLoadedMiCents: number
  deadheadPct: number
}

export interface LaneRow {
  lane: string
  origin: string
  destination: string
  runs: number
  revenueCents: number
  marginCents: number
  topDriver: string | null
}

export interface SettlementRow {
  driverId: string
  driverName: string
  loads: number
  loadedMi: number
  deadheadMi: number
  totalMi: number
  revenueCents: number
  marginCents: number
  estPayCents: number
  rpmLoadedCents: number
  /** This driver's own carrier pay rate. Per-row since T1: with carriers on
   *  different rates there is no single org-wide number, which is why the
   *  payload's old top-level `driverPayCentsPerMi` was dropped rather than
   *  kept as a figure that would be wrong for most rows. */
  driverPayCentsPerMi?: number
}

export interface SettlementTotals {
  loads: number
  loadedMi: number
  deadheadMi: number
  totalMi: number
  revenueCents: number
  marginCents: number
  estPayCents: number
}

interface SettlementsPayload {
  from: string
  to: string
  drivers: SettlementRow[]
  totals: SettlementTotals
}

interface AnalyticsState {
  brokers: BrokerRow[]
  lanes: LaneRow[]
  settlements: SettlementRow[]
  settlementTotals: SettlementTotals | null
  settlementRange: { from: string; to: string } | null
  loading: boolean
  error: string | null
}

export const useAnalyticsStore = defineStore('analytics', {
  state: (): AnalyticsState => ({
    brokers: [],
    lanes: [],
    settlements: [],
    settlementTotals: null,
    settlementRange: null,
    loading: false,
    error: null,
  }),

  actions: {
    async loadBrokers(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { data } = await api.get<{ brokers: BrokerRow[] }>('/dispatcher/analytics/brokers')
        this.brokers = data.brokers
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      } finally {
        this.loading = false
      }
    },

    /** Recurring lanes: the fleet's repeat freight, most-run first. */
    async loadLanes(): Promise<void> {
      try {
        const { data } = await api.get<{ lanes: LaneRow[] }>('/dispatcher/analytics/lanes')
        this.lanes = data.lanes
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      }
    },

    /** Per-driver completed-work rollup (the Friday-payroll view). Defaults
     *  to the server's trailing week when no range is given. */
    async loadSettlements(range?: { from?: string; to?: string }): Promise<void> {
      try {
        const { data } = await api.get<SettlementsPayload>('/dispatcher/settlements', {
          params: { ...range },
        })
        this.settlements = data.drivers
        this.settlementTotals = data.totals
        this.settlementRange = { from: data.from, to: data.to }
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      }
    },

    /** Download a rollup as CSV — the server renders it, we just save it. */
    async exportCsv(which: 'brokers' | 'lanes' | 'settlements'): Promise<void> {
      this.error = null
      try {
        const url = which === 'settlements' ? '/dispatcher/settlements' : `/dispatcher/analytics/${which}`
        const params: Record<string, string> = { format: 'csv' }
        if (which === 'settlements' && this.settlementRange) {
          params.from = this.settlementRange.from
          params.to = this.settlementRange.to
        }
        const { data } = await api.get<string>(url, { params, responseType: 'text' })
        const name =
          which === 'brokers' ? 'broker-profitability' : which === 'lanes' ? 'recurring-lanes' : 'driver-settlements'
        triggerDownload(`${name}-${new Date().toISOString().slice(0, 10)}.csv`, data)
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      }
    },
  },
})
