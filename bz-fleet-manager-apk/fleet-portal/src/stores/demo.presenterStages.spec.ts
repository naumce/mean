import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAssignment,
  fetchDemoStory,
  fetchSuggestEquipment,
  postDemoAction,
  resetDemoStory,
} from '../lib/api'
import { useNightShiftStore } from './nightShift'
import { useDemoStore } from './demo'
import type { DemoPresenterStageDef, DemoStory, DemoStoryResponse } from '../types/demo'

// Split out of demo.spec.ts (Task 7 fix round 1: that file hit the repo's
// 800-line cap) — same setup (mocks, fixtures, withStage helper) as
// demo.spec.ts, scoped down to just the `presenterStages` getter's tests.

vi.mock('../lib/api', () => ({
  fetchDemoStory: vi.fn(),
  resetDemoStory: vi.fn(),
  postDemoAction: vi.fn(),
  fetchSuggestEquipment: vi.fn(),
  createAssignment: vi.fn(),
}))
vi.mock('./nightShift', () => ({ useNightShiftStore: vi.fn() }))

const mockedFetchDemoStory = vi.mocked(fetchDemoStory)
const mockedResetDemoStory = vi.mocked(resetDemoStory)
const mockedPostDemoAction = vi.mocked(postDemoAction)
const mockedFetchSuggestEquipment = vi.mocked(fetchSuggestEquipment)
const mockedCreateAssignment = vi.mocked(createAssignment)
const mockedUseNightShiftStore = vi.mocked(useNightShiftStore)

const STAGES: DemoPresenterStageDef[] = [
  { id: 'uncovered', title: 'Uncovered load', narration: 'The load has no driver yet.' },
  { id: 'ai_recommendation', title: 'AI recommendation', narration: 'AI is thinking.' },
  { id: 'awaiting_approval', title: 'Human approval', narration: 'Approve the recommended driver.' },
  { id: 'in_transit', title: 'In transit', narration: 'The truck is moving.' },
  { id: 'breakdown_detected', title: 'Breakdown detected', narration: 'The truck stopped.' },
  { id: 'driver_contacted', title: 'Driver contacted', narration: 'Night Shift contacted the driver.' },
  { id: 'escalated', title: 'Escalated', narration: 'Night Shift escalated.' },
  { id: 'customer_updated', title: 'Customer update', narration: 'The customer was updated.' },
  { id: 'resolved', title: 'Resolved', narration: 'The issue is resolved.' },
  { id: 'delivered', title: 'Delivered', narration: 'The load was delivered.' },
]

function story(overrides: Partial<DemoStory> = {}): DemoStory {
  return {
    orgId: 'org-1',
    stage: 'uncovered',
    loadId: 'load-1',
    driverId: null,
    assignmentId: null,
    runId: null,
    experimentId: null,
    policyId: null,
    customerId: null,
    recommendedDriverId: null,
    recommendationSource: null,
    breakdownAtFraction: 0.4,
    breakdownTriggeredAt: null,
    holdStartedAt: null,
    log: [],
    error: null,
    startedAt: null,
    updatedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  }
}

function response(
  storyOverrides: Partial<DemoStory> = {},
  topOverrides: Partial<Omit<DemoStoryResponse, 'story'>> = {},
): DemoStoryResponse {
  return {
    story: story(storyOverrides),
    stages: STAGES,
    waitingOn: null,
    links: { cockpitLoadId: null, aiRunId: null, driverId: null, agentTimelineLoadId: null },
    worker: { configured: true },
    sim: { running: false, speed: null, simNowMs: 1_000 },
    pill: null,
    ...topOverrides,
  }
}

describe('useDemoStore', () => {
  let nightShiftCommand: ReturnType<typeof vi.fn>

  /** Primes the next probe() with the given stage and mounts it — the
   *  cheapest realistic way to get the store into a given stage without
   *  reaching into its state directly. */
  async function withStage(
    storyOverrides: Partial<DemoStory>,
    topOverrides: Partial<Omit<DemoStoryResponse, 'story'>> = {},
  ) {
    mockedFetchDemoStory.mockResolvedValueOnce(response(storyOverrides, topOverrides))
    const store = useDemoStore()
    await store.probe()
    return store
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    for (const m of [mockedFetchDemoStory, mockedResetDemoStory, mockedPostDemoAction, mockedFetchSuggestEquipment, mockedCreateAssignment]) {
      m.mockReset()
    }
    nightShiftCommand = vi.fn().mockResolvedValue({ command: {} })
    mockedUseNightShiftStore.mockReturnValue({ command: nightShiftCommand } as unknown as ReturnType<typeof useNightShiftStore>)
  })

  afterEach(() => {
    useDemoStore().stopPolling()
    vi.useRealTimers()
  })

  describe('presenterStages', () => {
    it('is empty before the first load', () => {
      const store = useDemoStore()
      expect(store.presenterStages).toEqual([])
    })

    it('marks tiles before the current stage done, the matching tile current, the rest upcoming', async () => {
      const store = await withStage({ stage: 'breakdown_detected' })
      expect(store.presenterStages.map((s) => [s.id, s.status])).toEqual([
        ['uncovered', 'done'],
        ['ai_recommendation', 'done'],
        ['awaiting_approval', 'done'],
        ['in_transit', 'done'],
        ['breakdown_detected', 'current'],
        ['driver_contacted', 'upcoming'],
        ['escalated', 'upcoming'],
        ['customer_updated', 'upcoming'],
        ['resolved', 'upcoming'],
        ['delivered', 'upcoming'],
      ])
    })

    it('maps awaiting_driver_reply onto the driver_contacted tile', async () => {
      const store = await withStage({ stage: 'awaiting_driver_reply' })
      expect(store.presenterStages.find((s) => s.status === 'current')?.id).toBe('driver_contacted')
    })

    it('maps awaiting_customer_update onto the escalated tile', async () => {
      const store = await withStage({ stage: 'awaiting_customer_update' })
      expect(store.presenterStages.find((s) => s.status === 'current')?.id).toBe('escalated')
    })

    it('maps delivering onto the delivered tile, titled "(in progress)"', async () => {
      const store = await withStage({ stage: 'delivering' })
      const current = store.presenterStages.find((s) => s.status === 'current')
      expect(current?.id).toBe('delivered')
      expect(current?.title).toBe('Delivered (in progress)')
    })

    it('leaves every tile upcoming when the stage is error (no tile guessed as current)', async () => {
      const store = await withStage({ stage: 'error' })
      expect(store.presenterStages.every((s) => s.status === 'upcoming')).toBe(true)
    })

    it('badges the ai_recommendation tile "AI" when the recommendation came from the AI', async () => {
      const store = await withStage({ stage: 'awaiting_approval', recommendationSource: 'ai' })
      const tile = store.presenterStages.find((s) => s.id === 'ai_recommendation')
      expect(tile?.badge).toBe('AI')
    })

    it('badges the ai_recommendation tile "Dispatch rules" when the recommendation came from the engine fallback', async () => {
      const store = await withStage({ stage: 'awaiting_approval', recommendationSource: 'engine' })
      const tile = store.presenterStages.find((s) => s.id === 'ai_recommendation')
      expect(tile?.badge).toBe('Dispatch rules')
    })

    it('leaves the ai_recommendation tile unbadged before any recommendation exists', async () => {
      const store = await withStage({ stage: 'uncovered', recommendationSource: null })
      const tile = store.presenterStages.find((s) => s.id === 'ai_recommendation')
      expect(tile?.badge).toBeUndefined()
    })

    it('never badges any other tile', async () => {
      const store = await withStage({ stage: 'awaiting_approval', recommendationSource: 'ai' })
      const others = store.presenterStages.filter((s) => s.id !== 'ai_recommendation')
      expect(others.every((s) => s.badge === undefined)).toBe(true)
    })
  })
})
