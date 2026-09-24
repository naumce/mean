import axios from 'axios'
import { defineStore } from 'pinia'
import {
  fetchSimState,
  postSimDriverMode,
  postSimReset,
  postSimStart,
  postSimStop,
  postSimTick,
  type SimDriverModeBody,
  type SimState,
} from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'

// Simulation controls (AI Dispatch Foundation, Task 8 backend / Task 10 UI):
// a thin wrapper over dispatcherSim.ts's clock. The whole feature is
// GATED BY DEMO_MODE server-side — `available` tracks whether the last probe
// found the endpoint at all, so SimControls.vue can render nothing on a
// real (non-demo) tenant instead of showing a control that 404s.

interface SimStoreState {
  available: boolean | null
  state: SimState | null
  busy: boolean
  error: string | null
  /** Epoch ms of the last successful tick() — a plain counter other stores
   *  (Driver Supply) can `watch()` to know "the world just moved, reload." */
  lastTickAt: number | null
}

export const useSimStore = defineStore('sim', {
  state: (): SimStoreState => ({
    available: null,
    state: null,
    busy: false,
    error: null,
    lastTickAt: null,
  }),

  actions: {
    /** A 404 means "not a demo server" — expected and silent, same
     *  convention as lib/api.ts's own fetchDemoShiftPlan. Any other failure
     *  still fails closed (hide the control) but records why. */
    async probe(): Promise<void> {
      try {
        const state = await fetchSimState()
        this.state = state
        this.available = true
        this.error = null
      } catch (error) {
        this.available = false
        this.state = null
        if (!(axios.isAxiosError(error) && error.response?.status === 404)) {
          this.error = extractApiErrorMessage(error, 'Unable to read simulation state right now.')
        }
      }
    },

    async tick(minutes: number): Promise<void> {
      this.busy = true
      this.error = null
      try {
        await postSimTick(minutes)
        this.lastTickAt = Date.now()
        await this.probe()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to advance the simulation right now.')
      } finally {
        this.busy = false
      }
    },

    async start(speed: number): Promise<void> {
      this.busy = true
      this.error = null
      try {
        await postSimStart(speed)
        await this.probe()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to start the simulation right now.')
      } finally {
        this.busy = false
      }
    },

    async stop(): Promise<void> {
      this.busy = true
      this.error = null
      try {
        await postSimStop()
        await this.probe()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to stop the simulation right now.')
      } finally {
        this.busy = false
      }
    },

    async reset(): Promise<void> {
      this.busy = true
      this.error = null
      try {
        await postSimReset()
        await this.probe()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to reset the demo world right now.')
      } finally {
        this.busy = false
      }
    },

    async setDriverMode(driverId: string, body: SimDriverModeBody): Promise<boolean> {
      this.busy = true
      this.error = null
      try {
        await postSimDriverMode(driverId, body)
        await this.probe()
        return true
      } catch (error) {
        this.error = extractApiErrorMessage(error, "Unable to update this driver's simulation mode right now.")
        return false
      } finally {
        this.busy = false
      }
    },
  },
})
