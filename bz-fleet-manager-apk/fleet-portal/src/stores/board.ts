import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'
import type { BoardConfig } from '../lib/board/geometry'

export interface BoardLane {
  id: string
  name: string
  status: string
}

export interface BoardTrip {
  id: string
  identifier: string
  status: string
  driverId: string | null
  scheduledStart: string | null
  scheduledEnd: string | null
  stopCount: number
}

interface BoardState {
  fromDate: Date
  toDate: Date
  dayStartHour: number
  dayEndHour: number
  boardWidthPx: number
  lanes: BoardLane[]
  trips: BoardTrip[]
  loading: boolean
  error: string | null
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000)
}

export const useBoardStore = defineStore('board', {
  state: (): BoardState => ({
    fromDate: utcMidnight(new Date()),
    toDate: utcMidnight(new Date()),
    dayStartHour: 6,
    dayEndHour: 20,
    boardWidthPx: 1200,
    lanes: [],
    trips: [],
    loading: false,
    error: null,
  }),

  getters: {
    config: (state): BoardConfig => ({
      fromDate: state.fromDate,
      toDate: state.toDate,
      dayStartHour: state.dayStartHour,
      dayEndHour: state.dayEndHour,
      boardWidthPx: state.boardWidthPx,
    }),
  },

  actions: {
    setBoardWidth(px: number): void {
      if (px > 0) this.boardWidthPx = px
    },

    async load(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const from = utcMidnight(this.fromDate).toISOString()
        const to = addDays(utcMidnight(this.toDate), 1).toISOString()
        const { data } = await api.get<{ lanes: BoardLane[]; trips: BoardTrip[] }>('/dispatcher/board', {
          params: { from, to },
        })
        this.lanes = data.lanes
        this.trips = data.trips
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      } finally {
        this.loading = false
      }
    },
  },
})
