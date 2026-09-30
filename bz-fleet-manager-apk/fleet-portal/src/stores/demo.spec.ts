import { AxiosError } from 'axios'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAssignment,
  fetchDemoStory,
  fetchSuggestEquipment,
  postDemoAction,
  resetDemoStory,
  type PlanResult,
} from '../lib/api'
import { useNightShiftStore } from './nightShift'
import { DEFAULT_REPLY_TEXT, useDemoStore } from './demo'
import type { DemoPresenterStageDef, DemoStage, DemoStory, DemoStoryResponse } from '../types/demo'

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

const planFixture = { proposedStart: 0, proposedEnd: 1, deadheadMi: 10, loadedMi: 100, driveMin: 200, onDutyMin: 300, needsBreak: false }
const econFixture = {
  revenueCents: 50000, totalMi: 110, deadheadMi: 10, loadedMi: 100, estCostCents: 30000,
  marginCents: 20000, marginPct: 0.4, ratePerLoadedMiCents: 200, ratePerTotalMiCents: 180,
}
function planResult(overrides: Partial<PlanResult> = {}): PlanResult {
  return { feasible: true, conflicts: [], plan: planFixture, economics: econFixture, ...overrides }
}

/** extractApiErrorMessage (lib/errors.ts) only recognizes a real AxiosError
 *  instance (`instanceof AxiosError`) — a plain `{ isAxiosError: true, ... }`
 *  literal satisfies axios's own duck-typed `isAxiosError()` check but falls
 *  through to the generic fallback here, same convention stores/sim.spec.ts
 *  and aiLab.spec.ts already use for this exact reason. */
function axiosError(status: number, data: unknown): AxiosError {
  const err = new AxiosError('Request failed')
  err.response = { status, data, statusText: '', headers: {}, config: {} as never }
  return err
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

  it('starts unprobed, with no data', () => {
    const store = useDemoStore()
    expect(store.available).toBeNull()
    expect(store.data).toBeNull()
    expect(store.busy).toBe(false)
    expect(store.error).toBeNull()
    expect(store.autoRun).toBe(false)
  })

  describe('probe', () => {
    it('sets available=true and stores the response on success', async () => {
      mockedFetchDemoStory.mockResolvedValueOnce(response())
      const store = useDemoStore()
      await store.probe()
      expect(store.available).toBe(true)
      expect(store.data?.story?.loadId).toBe('load-1')
      expect(store.error).toBeNull()
    })

    it('a 404 sets available=false silently (no error)', async () => {
      mockedFetchDemoStory.mockRejectedValueOnce(axiosError(404, {}))
      const store = useDemoStore()
      await store.probe()
      expect(store.available).toBe(false)
      expect(store.data).toBeNull()
      expect(store.error).toBeNull()
    })

    it('any other failure sets available=false and records an error', async () => {
      mockedFetchDemoStory.mockRejectedValueOnce(new Error('network down'))
      const store = useDemoStore()
      await store.probe()
      expect(store.available).toBe(false)
      expect(store.error).toBe('network down')
    })

    // reachable-fix-brief.md #5: the AI Lab run is worth showing whenever it
    // exists, even when the story fell back to the dispatch recommendation
    // (e.g. the AI's own pick had no phone on file) — the link must not be
    // withheld just because recommendationSource isn't 'ai'.
    it('carries the AI Lab run link through even when the story fell back to the dispatch recommendation', async () => {
      const store = await withStage(
        { stage: 'awaiting_approval', recommendationSource: 'engine', runId: 'run-1' },
        { links: { cockpitLoadId: null, aiRunId: 'run-1', driverId: null, agentTimelineLoadId: null } },
      )
      expect(store.data?.links.aiRunId).toBe('run-1')
    })
  })

  describe('load', () => {
    it('refreshes data without ever setting available back to true or false', async () => {
      mockedFetchDemoStory.mockRejectedValueOnce(axiosError(404, {}))
      const store = useDemoStore()
      await store.probe()
      expect(store.available).toBe(false)

      mockedFetchDemoStory.mockResolvedValueOnce(response({ stage: 'in_transit' }))
      await store.load()
      expect(store.data?.story?.stage).toBe('in_transit')
      expect(store.available).toBe(false) // load() never touches it
    })

    it('records a friendly error on failure and leaves prior data alone', async () => {
      mockedFetchDemoStory.mockResolvedValueOnce(response())
      const store = useDemoStore()
      await store.load()

      mockedFetchDemoStory.mockRejectedValueOnce(new Error('boom'))
      await store.load()
      expect(store.error).toBe('boom')
      expect(store.data?.story?.loadId).toBe('load-1')
    })
  })

  describe('polling', () => {
    it('does nothing until startPolling is called', () => {
      const store = useDemoStore()
      expect(store.pollTimerId).toBeNull()
    })

    it('defaults to a 3000ms interval, and stopPolling halts it', async () => {
      vi.useFakeTimers()
      mockedFetchDemoStory.mockResolvedValue(response())
      const store = useDemoStore()

      store.startPolling()
      expect(store.pollTimerId).not.toBeNull()

      await vi.advanceTimersByTimeAsync(2999)
      expect(mockedFetchDemoStory).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(mockedFetchDemoStory).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(3000)
      expect(mockedFetchDemoStory).toHaveBeenCalledTimes(2)

      store.stopPolling()
      await vi.advanceTimersByTimeAsync(9000)
      expect(mockedFetchDemoStory).toHaveBeenCalledTimes(2)
      expect(store.pollTimerId).toBeNull()
    })
  })

  describe('autoRun', () => {
    it('toggleAutoRun flips the flag', () => {
      const store = useDemoStore()
      expect(store.autoRun).toBe(false)
      store.toggleAutoRun()
      expect(store.autoRun).toBe(true)
      store.toggleAutoRun()
      expect(store.autoRun).toBe(false)
    })

    // next() (fleet-backend/src/lib/demoStory/actions.ts) only ever advances
    // "uncovered" and "customer_updated" — every other stage 409s. Auto-run
    // has to match that exactly, stage for stage, rather than infer it from
    // `waitingOn` (which names a pending human action on six DIFFERENT
    // stages, including these same two — it cannot tell "next() works here"
    // apart from "there's a button here").
    it('calls next() after a poll tick while uncovered', async () => {
      vi.useFakeTimers()
      const store = useDemoStore()
      store.toggleAutoRun()
      mockedFetchDemoStory.mockResolvedValue(response({ stage: 'uncovered' }, { waitingOn: 'ask_ai' }))
      mockedPostDemoAction.mockResolvedValue({ story: story({ stage: 'ai_recommendation' }) })

      store.startPolling(3000)
      await vi.advanceTimersByTimeAsync(3000)

      expect(mockedPostDemoAction).toHaveBeenCalledWith({ action: 'next' })
    })

    it('calls next() after a poll tick while customer_updated', async () => {
      vi.useFakeTimers()
      const store = useDemoStore()
      store.toggleAutoRun()
      mockedFetchDemoStory.mockResolvedValue(response({ stage: 'customer_updated' }, { waitingOn: 'resolve' }))
      mockedPostDemoAction.mockResolvedValue({ story: story({ stage: 'resolved' }) })

      store.startPolling(3000)
      await vi.advanceTimersByTimeAsync(3000)

      expect(mockedPostDemoAction).toHaveBeenCalledWith({ action: 'next' })
    })

    it('never calls next() on any of the three human stages', async () => {
      vi.useFakeTimers()
      const store = useDemoStore()
      store.toggleAutoRun()

      for (const stage of ['awaiting_approval', 'awaiting_driver_reply', 'awaiting_customer_update'] as const) {
        mockedFetchDemoStory.mockResolvedValue(response({ stage }))
        store.startPolling(3000)
        await vi.advanceTimersByTimeAsync(3000)
      }

      expect(mockedPostDemoAction).not.toHaveBeenCalled()
    })

    it('never calls next() on a stage next() does not support (would just 409)', async () => {
      vi.useFakeTimers()
      const store = useDemoStore()
      store.toggleAutoRun()
      mockedFetchDemoStory.mockResolvedValue(response({ stage: 'in_transit' }))

      store.startPolling(3000)
      await vi.advanceTimersByTimeAsync(3000)

      expect(mockedPostDemoAction).not.toHaveBeenCalled()
    })

    it('does nothing when autoRun is off, even on an eligible stage', async () => {
      vi.useFakeTimers()
      const store = useDemoStore()
      mockedFetchDemoStory.mockResolvedValue(response({ stage: 'uncovered' }, { waitingOn: 'ask_ai' }))

      store.startPolling(3000)
      await vi.advanceTimersByTimeAsync(3000)

      expect(mockedPostDemoAction).not.toHaveBeenCalled()
    })

    // Fix round 4, P13: a slow in-flight action (busy: true) must stop the
    // 3-second poll from posting a second next() on top of it — the
    // backend's own stage guard would 409 that second post.
    it('does nothing when busy, even on an eligible stage', async () => {
      vi.useFakeTimers()
      const store = useDemoStore()
      store.toggleAutoRun()
      mockedFetchDemoStory.mockResolvedValue(response({ stage: 'uncovered' }, { waitingOn: 'ask_ai' }))
      store.busy = true

      store.startPolling(3000)
      await vi.advanceTimersByTimeAsync(3000)

      expect(mockedPostDemoAction).not.toHaveBeenCalled()
    })

    it('does nothing when there is no story yet (never reset for this org)', async () => {
      vi.useFakeTimers()
      const store = useDemoStore()
      store.toggleAutoRun()
      mockedFetchDemoStory.mockResolvedValue({ ...response(), story: null })

      store.startPolling(3000)
      await vi.advanceTimersByTimeAsync(3000)

      expect(mockedPostDemoAction).not.toHaveBeenCalled()
    })
  })

  describe('reset', () => {
    it('resets then reloads, returning true', async () => {
      mockedResetDemoStory.mockResolvedValueOnce({ story: story() })
      mockedFetchDemoStory.mockResolvedValueOnce(response())
      const store = useDemoStore()

      const ok = await store.reset()

      expect(ok).toBe(true)
      expect(mockedResetDemoStory).toHaveBeenCalled()
      expect(store.data?.story?.loadId).toBe('load-1')
      expect(store.busy).toBe(false)
    })

    it('records a friendly error on failure', async () => {
      mockedResetDemoStory.mockRejectedValueOnce(new Error('reset failed'))
      const store = useDemoStore()

      const ok = await store.reset()

      expect(ok).toBe(false)
      expect(store.error).toBe('reset failed')
      expect(store.busy).toBe(false)
    })
  })

  describe('plain post-action-then-reload actions', () => {
    it('askAi posts ask_ai then reloads', async () => {
      mockedPostDemoAction.mockResolvedValueOnce({ story: story() })
      mockedFetchDemoStory.mockResolvedValueOnce(response({ stage: 'ai_recommendation' }))
      const store = useDemoStore()

      const ok = await store.askAi()

      expect(ok).toBe(true)
      expect(mockedPostDemoAction).toHaveBeenCalledWith({ action: 'ask_ai' })
      expect(store.data?.story?.stage).toBe('ai_recommendation')
    })

    it('resolve posts resolve then reloads', async () => {
      mockedPostDemoAction.mockResolvedValueOnce({ story: story() })
      mockedFetchDemoStory.mockResolvedValueOnce(response({ stage: 'resolved' }))
      const store = useDemoStore()

      const ok = await store.resolve()

      expect(ok).toBe(true)
      expect(mockedPostDemoAction).toHaveBeenCalledWith({ action: 'resolve' })
    })

    it('skipArrival posts skip_arrival then reloads', async () => {
      mockedPostDemoAction.mockResolvedValueOnce({ story: story() })
      mockedFetchDemoStory.mockResolvedValueOnce(response({ stage: 'delivered' }))
      const store = useDemoStore()

      const ok = await store.skipArrival()

      expect(ok).toBe(true)
      expect(mockedPostDemoAction).toHaveBeenCalledWith({ action: 'skip_arrival' })
    })

    it('next posts next then reloads', async () => {
      mockedPostDemoAction.mockResolvedValueOnce({ story: story() })
      mockedFetchDemoStory.mockResolvedValueOnce(response({ stage: 'ai_recommendation' }))
      const store = useDemoStore()

      const ok = await store.next()

      expect(ok).toBe(true)
      expect(mockedPostDemoAction).toHaveBeenCalledWith({ action: 'next' })
    })

    it('driverReply posts driver_reply with the given text then reloads', async () => {
      mockedPostDemoAction.mockResolvedValueOnce({ story: story() })
      mockedFetchDemoStory.mockResolvedValueOnce(response({ stage: 'escalated' }))
      const store = useDemoStore()

      const ok = await store.driverReply(DEFAULT_REPLY_TEXT)

      expect(ok).toBe(true)
      expect(mockedPostDemoAction).toHaveBeenCalledWith({ action: 'driver_reply', text: DEFAULT_REPLY_TEXT })
    })

    it('a rejected action resets busy and records the error', async () => {
      mockedPostDemoAction.mockRejectedValueOnce(new Error('server exploded'))
      const store = useDemoStore()

      const ok = await store.resolve()

      expect(ok).toBe(false)
      expect(store.busy).toBe(false)
      expect(store.error).toBe('server exploded')
    })

    it('prefers a 503 WORKER_UNAVAILABLE message over the machine code', async () => {
      mockedPostDemoAction.mockRejectedValueOnce(
        axiosError(503, { error: 'WORKER_UNAVAILABLE', message: 'Night Shift worker is offline.' }),
      )
      const store = useDemoStore()

      const ok = await store.driverReply(DEFAULT_REPLY_TEXT)

      expect(ok).toBe(false)
      expect(store.error).toBe('Night Shift worker is offline.')
    })

    it('gives a plain-language line for a WRONG_STAGE 409, which carries no message field', async () => {
      mockedPostDemoAction.mockRejectedValueOnce(axiosError(409, { error: 'WRONG_STAGE', stage: 'in_transit' }))
      const store = useDemoStore()

      const ok = await store.resolve()

      expect(ok).toBe(false)
      expect(store.error).toBe('This step already moved on.')
    })
  })

  describe('approve', () => {
    it('calls suggest, then createAssignment, then the demo action with the ids, then reloads', async () => {
      const store = await withStage({ stage: 'awaiting_approval', loadId: 'load-1', recommendedDriverId: 'drv-1' })

      mockedFetchSuggestEquipment.mockResolvedValueOnce({ tractorId: 'trk-1', trailerId: 'trl-1' })
      mockedCreateAssignment.mockResolvedValueOnce(
        planResult({ assignment: { id: 'asg-1' } as unknown as PlanResult['assignment'] }),
      )
      mockedPostDemoAction.mockResolvedValueOnce({ story: story({ stage: 'in_transit' }) })
      mockedFetchDemoStory.mockResolvedValueOnce(response({ stage: 'in_transit' }))

      const ok = await store.approve()

      expect(ok).toBe(true)
      expect(mockedFetchSuggestEquipment).toHaveBeenCalledWith('load-1')
      expect(mockedCreateAssignment).toHaveBeenCalledWith({
        loadId: 'load-1', driverId: 'drv-1', tractorId: 'trk-1', trailerId: 'trl-1',
      })
      expect(mockedPostDemoAction).toHaveBeenCalledWith({ action: 'approve', assignmentId: 'asg-1', driverId: 'drv-1' })
      expect(store.data?.story?.stage).toBe('in_transit')
    })

    it('fails without calling anything when there is no recommended driver yet', async () => {
      const store = await withStage({ stage: 'ai_recommendation', recommendedDriverId: null })

      const ok = await store.approve()

      expect(ok).toBe(false)
      expect(mockedFetchSuggestEquipment).not.toHaveBeenCalled()
    })

    it('fails when suggest has no equipment to offer, without calling createAssignment', async () => {
      const store = await withStage({ stage: 'awaiting_approval', recommendedDriverId: 'drv-1' })
      mockedFetchSuggestEquipment.mockResolvedValueOnce({ tractorId: null, trailerId: null })

      const ok = await store.approve()

      expect(ok).toBe(false)
      expect(store.error).toMatch(/equipment/i)
      expect(mockedCreateAssignment).not.toHaveBeenCalled()
    })

    it('surfaces the message from a 409 raised by createAssignment, without posting the demo action', async () => {
      const store = await withStage({ stage: 'awaiting_approval', recommendedDriverId: 'drv-1' })
      mockedFetchSuggestEquipment.mockResolvedValueOnce({ tractorId: 'trk-1', trailerId: 'trl-1' })
      mockedCreateAssignment.mockRejectedValueOnce(axiosError(409, { error: 'Load already has an active assignment.' }))

      const ok = await store.approve()

      expect(ok).toBe(false)
      expect(store.error).toBe('Load already has an active assignment.')
      expect(mockedPostDemoAction).not.toHaveBeenCalled()
    })
  })

  describe('sendCustomerUpdate', () => {
    it('sends send_customer_email, then the demo action, then reloads', async () => {
      const store = await withStage({ stage: 'awaiting_customer_update', loadId: 'load-1' })
      mockedPostDemoAction.mockResolvedValueOnce({ story: story({ stage: 'customer_updated' }) })
      mockedFetchDemoStory.mockResolvedValueOnce(response({ stage: 'customer_updated' }))

      const ok = await store.sendCustomerUpdate()

      expect(ok).toBe(true)
      expect(nightShiftCommand).toHaveBeenCalledWith('load-1', 'send_customer_email')
      expect(mockedPostDemoAction).toHaveBeenCalledWith({ action: 'customer_update_sent' })
      expect(store.data?.story?.stage).toBe('customer_updated')
    })

    it('fails without sending anything when there is no load yet', async () => {
      const store = useDemoStore()

      const ok = await store.sendCustomerUpdate()

      expect(ok).toBe(false)
      expect(nightShiftCommand).not.toHaveBeenCalled()
    })
  })

  describe('isHumanStage', () => {
    it('is true only for the three human stages', async () => {
      for (const stage of ['awaiting_approval', 'awaiting_driver_reply', 'awaiting_customer_update'] as const) {
        const store = await withStage({ stage })
        expect(store.isHumanStage).toBe(true)
      }
    })

    it('is false for every other stage', async () => {
      for (const stage of ['uncovered', 'in_transit', 'resolved', 'error'] as const) {
        const store = await withStage({ stage })
        expect(store.isHumanStage).toBe(false)
      }
    })
  })

  // presenterStages tests moved to demo.presenterStages.spec.ts (repo's
  // 800-line-per-file cap — Task 7 fix round 1).

  describe('currentPresenterStage', () => {
    it('is null before the first load', () => {
      const store = useDemoStore()
      expect(store.currentPresenterStage).toBeNull()
    })

    it('returns the tile matching the (aliased) current stage', async () => {
      const store = await withStage({ stage: 'awaiting_driver_reply' })
      expect(store.currentPresenterStage?.id).toBe('driver_contacted')
    })
  })

  describe('actionForStage', () => {
    it('uncovered offers "Ask AI for a driver"', async () => {
      const store = await withStage({ stage: 'uncovered' })
      expect(store.actionForStage).toEqual({ kind: 'ask_ai', label: 'Ask AI for a driver' })
    })

    // There is no `recommendedDriverName` field on the wire — the name and
    // the confidence both come out of the SAME log line observe.ts writes
    // on the transition into "awaiting_approval" (fleet-backend/src/lib/
    // demoStory/observe.ts's handleAiRecommendation).
    it('awaiting_approval names the recommended driver and credits AI with its confidence', async () => {
      const store = await withStage({
        stage: 'awaiting_approval',
        recommendationSource: 'ai',
        log: [{ atMs: 1, stage: 'awaiting_approval', text: 'AI recommends John Carter (confidence 0.85).' }],
      })
      expect(store.actionForStage).toEqual({
        kind: 'approve',
        label: 'Approve John Carter',
        subline: 'Recommended by AI (confidence 0.85)',
      })
    })

    it('awaiting_approval keeps Approve disabled with a plain reason while Night Shift is still releasing the previous demo', async () => {
      const store = await withStage(
        {
          stage: 'awaiting_approval',
          recommendationSource: 'ai',
          log: [{ atMs: 1, stage: 'awaiting_approval', text: 'AI recommends John Carter (confidence 0.85).' }],
        },
        { waitingOn: 'night_shift_releasing' },
      )
      expect(store.actionForStage).toEqual({
        kind: 'approve',
        label: 'Approve John Carter',
        subline: 'Night Shift is still releasing the previous demo — about a minute',
        disabled: true,
      })
    })

    it('awaiting_approval credits the dispatch rules and still names the driver when the source is the engine', async () => {
      const store = await withStage({
        stage: 'awaiting_approval',
        recommendationSource: 'engine',
        log: [{ atMs: 1, stage: 'awaiting_approval', text: 'AI unavailable — using the dispatch recommendation: John Carter.' }],
      })
      expect(store.actionForStage).toEqual({
        kind: 'approve',
        label: 'Approve John Carter',
        subline: 'Recommended by the dispatch rules — AI unavailable',
      })
    })

    // reachable-fix-brief.md: the AI's own pick had no phone on file, so
    // observe.ts fell back to a reachable dispatch recommendation while
    // still naming the AI's original (unreachable) pick — the presenter
    // must name the driver actually being recommended (the fallback), not
    // the one Night Shift cannot reach. reachable-fix-review.md #f: this
    // blended shape must not say "AI unavailable" (it was available — its
    // pick just wasn't reachable), so it gets its own subline.
    it('awaiting_approval names the fallback driver, not the unreachable AI pick, when the AI recommendation had no phone', async () => {
      const store = await withStage({
        stage: 'awaiting_approval',
        recommendationSource: 'engine',
        log: [{
          atMs: 1, stage: 'awaiting_approval',
          text: 'AI recommends Marcus Webb (confidence 0.95), but Night Shift has no phone on file for them — using the dispatch recommendation instead: John Carter.',
        }],
      })
      expect(store.actionForStage).toEqual({
        kind: 'approve',
        label: 'Approve John Carter',
        subline: "Recommended by the dispatch rules — the AI's pick had no phone on file",
      })
    })

    // reachable-fix-review.md HIGH: when the AI's pick is unreachable AND no
    // reachable dispatch fallback exists either, observe.ts sets
    // recommendedDriverId: null and names only the unreachable AI pick in
    // the log. Naming Marcus Webb here would render "Approve Marcus Webb"
    // while nothing is actually recommended — clicking it fails against
    // approve()'s own "No recommended driver yet." guard. Must degrade to
    // the same generic label the plain engine-only "no reachable driver"
    // line already gets.
    it('awaiting_approval falls back to a generic name (not the unreachable AI pick) when the AI recommendation had no phone and no fallback exists either', async () => {
      const store = await withStage({
        stage: 'awaiting_approval',
        recommendationSource: 'engine',
        log: [{
          atMs: 1, stage: 'awaiting_approval',
          text: 'AI recommends Marcus Webb (confidence 0.95), but Night Shift has no phone on file for them — no reachable driver is available.',
        }],
      })
      expect(store.actionForStage?.label).toBe('Approve the recommended driver')
    })

    it('awaiting_approval falls back to a generic name when the log names no one (no reachable driver)', async () => {
      const store = await withStage({
        stage: 'awaiting_approval',
        recommendationSource: 'engine',
        log: [{ atMs: 1, stage: 'awaiting_approval', text: 'AI unavailable — no reachable driver is available.' }],
      })
      expect(store.actionForStage).toEqual({
        kind: 'approve',
        label: 'Approve the recommended driver',
        subline: 'Recommended by the dispatch rules — AI unavailable',
      })
    })

    it('awaiting_approval falls back to a generic name and no confidence when the log is empty', async () => {
      const store = await withStage({ stage: 'awaiting_approval', recommendationSource: 'ai', log: [] })
      expect(store.actionForStage).toEqual({ kind: 'approve', label: 'Approve the recommended driver', subline: 'Recommended by AI' })
    })

    it("awaiting_driver_reply offers \"Send John's reply\"", async () => {
      const store = await withStage({ stage: 'awaiting_driver_reply' })
      expect(store.actionForStage).toEqual({ kind: 'driver_reply', label: "Send John's reply" })
    })

    // waitingOnFor() (fleet-backend/src/lib/demoStory/waitingOn.ts) answers
    // "resolve" instead of the send token when the escalation carried no
    // draft — showing "Send customer update" there would fire a real
    // send_customer_email command that was never actually recommended.
    it('awaiting_customer_update offers the sink-safe send button when the backend says there is something to send', async () => {
      const store = await withStage({ stage: 'awaiting_customer_update' }, { waitingOn: 'customer_update' })
      expect(store.actionForStage).toEqual({
        kind: 'customer_update_sent',
        label: 'Send customer update',
        subline: 'Demo sink — nothing leaves the system',
      })
    })

    it('awaiting_customer_update offers a plain Continue — never the send command — when the backend says there is nothing to send', async () => {
      const store = await withStage({ stage: 'awaiting_customer_update' }, { waitingOn: 'resolve' })
      expect(store.actionForStage).toEqual({ kind: 'resolve', label: 'Continue — no customer update was needed' })
    })

    it('awaiting_customer_update defaults to the send button when waitingOn is null (unknown/not yet observed)', async () => {
      const store = await withStage({ stage: 'awaiting_customer_update' }, { waitingOn: null })
      expect(store.actionForStage?.kind).toBe('customer_update_sent')
    })

    it('customer_updated offers "Continue"', async () => {
      const store = await withStage({ stage: 'customer_updated' })
      expect(store.actionForStage).toEqual({ kind: 'resolve', label: 'Continue' })
    })

    it('delivering offers "Skip wait"', async () => {
      const store = await withStage({ stage: 'delivering' })
      expect(store.actionForStage).toEqual({ kind: 'skip_arrival', label: 'Skip wait' })
    })

    it('is null for every stage with no pending human action', async () => {
      const automatic: readonly DemoStage[] = [
        'ai_recommendation', 'in_transit', 'breakdown_detected', 'driver_contacted',
        'escalated', 'resolved', 'delivered', 'error',
      ]
      for (const stage of automatic) {
        const store = await withStage({ stage })
        expect(store.actionForStage).toBeNull()
      }
    })
  })
})
