import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import type { AgentsOverview } from '../types/agents'
import { useAgentsStore } from './agents'

// AI Agents Surface (Task 4): the AI Agents page's store. Mocked the same
// way stores/demo.ts's own spec mocks lib/api — `api.get` is the only call
// this store ever makes.
vi.mock('../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }))
const mockedGet = vi.mocked(api.get)

function overview(overrides: Partial<AgentsOverview> = {}): AgentsOverview {
  return {
    generatedAt: '2026-09-30T12:00:00.000Z',
    dispatch: {
      rules: { available: true },
      model: { configured: false, reachable: null, modelPresent: null, model: null, error: null },
      activity: { running: null, queued: 0, lastRun: null },
    },
    nightShift: {
      service: { configured: false, lastActivityAt: null },
      activity: { watching: 0, waitingReply: 0, escalated: 0, held: 0, attention: 0, delivered: 0, off: 0, total: 0, listed: 0 },
      mode: { shadowLoads: 0, liveLoads: 0, livePolicies: 0 },
      enforcement: { customerEmailOn: 'not_enforced', quietHours: 'not_enforced' },
      loads: [],
    },
    ...overrides,
  }
}

describe('useAgentsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  describe('load()', () => {
    it('calls GET /dispatcher/agents/overview and stores the result', async () => {
      const data = overview()
      mockedGet.mockResolvedValueOnce({ data })
      const store = useAgentsStore()

      await store.load()

      expect(api.get).toHaveBeenCalledWith('/dispatcher/agents/overview')
      expect(store.data).toEqual(data)
      expect(store.error).toBeNull()
    })

    it('records a friendly error and keeps loading false on failure', async () => {
      mockedGet.mockRejectedValueOnce(new Error('network down'))
      const store = useAgentsStore()

      await store.load()

      expect(store.error).toBe('network down')
      expect(store.loading).toBe(false)
    })
  })

  describe('dispatchStatus', () => {
    it('is null before the first load', () => {
      const store = useAgentsStore()
      expect(store.dispatchStatus).toBeNull()
    })

    it('reads "AI not configured" when no model server is set', () => {
      const store = useAgentsStore()
      store.data = overview()
      expect(store.dispatchStatus).toMatchObject({ headline: 'Rules available · AI not configured' })
      expect(store.dispatchStatus?.detail).toContain('dispatch rules')
    })

    it('reads "AI unreachable" and includes the error text when configured but unreachable', () => {
      const store = useAgentsStore()
      store.data = overview({
        dispatch: {
          rules: { available: true },
          model: { configured: true, reachable: false, modelPresent: null, model: 'qwen3:8b', error: 'ECONNREFUSED 127.0.0.1:11434' },
          activity: { running: null, queued: 0, lastRun: null },
        },
      })
      expect(store.dispatchStatus?.headline).toBe('Rules available · AI unreachable')
      expect(store.dispatchStatus?.detail).toContain('ECONNREFUSED 127.0.0.1:11434')
    })

    it('reads "AI model not installed" when reachable but the model is missing', () => {
      const store = useAgentsStore()
      store.data = overview({
        dispatch: {
          rules: { available: true },
          model: { configured: true, reachable: true, modelPresent: false, model: 'qwen3:8b', error: null },
          activity: { running: null, queued: 0, lastRun: null },
        },
      })
      expect(store.dispatchStatus?.headline).toBe('Rules available · AI model not installed')
      expect(store.dispatchStatus?.detail).toContain('qwen3:8b')
    })

    it('reads "AI ready" and shows the load number it is thinking about when a run is in progress', () => {
      const store = useAgentsStore()
      store.data = overview({
        dispatch: {
          rules: { available: true },
          model: { configured: true, reachable: true, modelPresent: true, model: 'qwen3:8b', error: null },
          activity: { running: { runId: 'run-1', loadId: 'load-9', loadNo: '1042', startedAt: null }, queued: 2, lastRun: null },
        },
      })
      expect(store.dispatchStatus?.headline).toBe('Rules available · AI ready')
      expect(store.dispatchStatus?.detail).toBe('Thinking about load 1042')
    })

    it('falls back to "Thinking about a load" — never a raw id — when the running run has no loadNo', () => {
      const store = useAgentsStore()
      store.data = overview({
        dispatch: {
          rules: { available: true },
          model: { configured: true, reachable: true, modelPresent: true, model: 'qwen3:8b', error: null },
          activity: { running: { runId: 'run-1', loadId: 'load-9', loadNo: null, startedAt: null }, queued: 2, lastRun: null },
        },
      })
      expect(store.dispatchStatus?.detail).toBe('Thinking about a load')
      expect(store.dispatchStatus?.detail).not.toContain('load-9')
    })

    it('reads "AI ready" and shows the last run when idle', () => {
      const store = useAgentsStore()
      store.data = overview({
        dispatch: {
          rules: { available: true },
          model: { configured: true, reachable: true, modelPresent: true, model: 'qwen3:8b', error: null },
          activity: {
            running: null,
            queued: 0,
            lastRun: {
              runId: 'run-1', loadId: 'load-9', status: 'accepted', driverId: 'drv-1',
              driverName: 'John Carter', confidence: 0.85, completedAt: '2026-09-30T11:00:00.000Z', promptVersion: 'v1',
            },
          },
        },
      })
      expect(store.dispatchStatus?.headline).toBe('Rules available · AI ready')
      expect(store.dispatchStatus?.detail).toBe('Last run: John Carter (confidence 0.85) · accepted')
    })

    it('reads "AI ready" with an honest idle detail when reachable, present, and no run has ever happened', () => {
      const store = useAgentsStore()
      store.data = overview({
        dispatch: {
          rules: { available: true },
          model: { configured: true, reachable: true, modelPresent: true, model: 'qwen3:8b', error: null },
          activity: { running: null, queued: 0, lastRun: null },
        },
      })
      expect(store.dispatchStatus?.headline).toBe('Rules available · AI ready')
      expect(store.dispatchStatus?.detail).toBe('Drivers are found by the dispatch rules as usual. No AI run has been asked for yet.')
    })

    it('falls back to "no driver" and a dash confidence when the last run has neither', () => {
      const store = useAgentsStore()
      store.data = overview({
        dispatch: {
          rules: { available: true },
          model: { configured: true, reachable: true, modelPresent: true, model: 'qwen3:8b', error: null },
          activity: {
            running: null,
            queued: 0,
            lastRun: {
              runId: 'run-1', loadId: null, status: 'no_reachable_driver', driverId: null,
              driverName: null, confidence: null, completedAt: null, promptVersion: null,
            },
          },
        },
      })
      expect(store.dispatchStatus?.detail).toBe('Last run: no driver (confidence —) · no_reachable_driver')
    })
  })

  describe('nightShiftStatus', () => {
    it('is null before the first load', () => {
      const store = useAgentsStore()
      expect(store.nightShiftStatus).toBeNull()
    })

    it('reads "Not configured" when no worker address is set, without claiming nothing is watched', () => {
      const store = useAgentsStore()
      store.data = overview()
      expect(store.nightShiftStatus).toMatchObject({ headline: 'Not configured' })
      expect(store.nightShiftStatus?.detail).toBe(
        'No worker address is set on this server, so it cannot run or confirm Night Shift. The states below come from the database and may be stale.',
      )
    })

    it('reads "Ready · nothing watched yet" when configured with an empty workload', () => {
      const store = useAgentsStore()
      store.data = overview({
        nightShift: {
          service: { configured: true, lastActivityAt: null },
          activity: { watching: 0, waitingReply: 0, escalated: 0, held: 0, attention: 0, delivered: 0, off: 0, total: 0, listed: 0 },
          mode: { shadowLoads: 0, liveLoads: 0, livePolicies: 1 },
          enforcement: { customerEmailOn: 'not_enforced', quietHours: 'not_enforced' },
          loads: [],
        },
      })
      expect(store.nightShiftStatus?.headline).toBe('Ready · nothing watched yet')
    })

    it('summarizes watching/attention counts, mode split and last report age when there is a workload', () => {
      const store = useAgentsStore()
      const lastActivityAt = new Date(Date.now() - 2 * 60_000).toISOString()
      store.data = overview({
        nightShift: {
          service: { configured: true, lastActivityAt },
          activity: { watching: 2, waitingReply: 1, escalated: 1, held: 0, attention: 1, delivered: 4, off: 0, total: 9, listed: 9 },
          mode: { shadowLoads: 3, liveLoads: 2, livePolicies: 2 },
          enforcement: { customerEmailOn: 'not_enforced', quietHours: 'not_enforced' },
          loads: [],
        },
      })
      expect(store.nightShiftStatus?.headline).toBe('3 watching · 2 need attention')
      expect(store.nightShiftStatus?.detail).toBe('3 in shadow mode (messages recorded, not sent) · 2 live · 4 delivered · Last report 2m')
    })
  })
})
