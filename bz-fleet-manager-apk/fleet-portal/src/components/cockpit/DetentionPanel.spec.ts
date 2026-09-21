import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchDetention, type StopDetention } from '../../lib/api'
import { useCockpitStore } from '../../stores/cockpit'
import DetentionPanel from './DetentionPanel.vue'

vi.mock('../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
  fetchDetention: vi.fn(),
}))
const mockedFetchDetention = vi.mocked(fetchDetention)

interface EvidenceOverride {
  pingCount?: number
  maxGapMin?: number
  firstSeenMs?: number
  lastSeenMs?: number
  departureObserved?: boolean
}
const evidence = (over: EvidenceOverride = {}) => ({
  pingCount: 14,
  maxGapMin: 6,
  firstSeenMs: 1000,
  lastSeenMs: 9000,
  departureObserved: true,
  ...over,
})

const stop = (over: Partial<StopDetention>): StopDetention => ({
  loadId: 'l1',
  loadRef: 'L-51217',
  stopId: 's1',
  stopLabel: 'Kroger DC 42',
  stopType: 'delivery',
  driverId: 'd1',
  driverName: 'Jake Morrow',
  claim: null,
  noClaimReason: null,
  observedMin: null,
  ...over,
})

async function mountLoaded(items: StopDetention[]) {
  mockedFetchDetention.mockResolvedValueOnce(items)
  const w = mount(DetentionPanel)
  await flushPromises()
  return w
}

describe('DetentionPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedFetchDetention.mockReset()
  })

  it('fetches on mount with a 72h window', async () => {
    mockedFetchDetention.mockResolvedValueOnce([])
    mount(DetentionPanel)
    await flushPromises()
    expect(mockedFetchDetention).toHaveBeenCalledWith(72)
  })

  it('a clean claim (needsReview: false) shows billable minutes and the evidence summary, with no review marker', async () => {
    const row = stop({
      claim: { clockStartMs: 0, freeMin: 120, billableMin: 45, evidence: evidence({ pingCount: 14, maxGapMin: 6, departureObserved: true }), needsReview: false, reviewReasons: [] },
    })
    const w = await mountLoaded([row])

    const el = w.find('[data-stop="s1"]')
    expect(el.attributes('data-state')).toBe('claim')
    expect(el.find('[data-testid="detention-billable"]').text()).toContain('45 min billable')
    expect(el.find('[data-testid="detention-evidence"]').text()).toContain('14 pings')
    expect(el.find('[data-testid="detention-evidence"]').text()).toContain('largest gap 6 min')
    expect(el.find('[data-testid="detention-evidence"]').text()).toContain('departure observed')
    expect(el.find('[data-testid="detention-review-marker"]').exists()).toBe(false)
    expect(el.find('[data-testid="detention-review-reasons"]').exists()).toBe(false)
  })

  it('a claim needing review shows the same info, plus every reviewReasons string verbatim, plus a review marker', async () => {
    const reasons = ['Free-time window inferred from load type, not the rate confirmation.', 'Departure was never observed — window closed on the last ping before pings stopped.']
    const row = stop({
      claim: { clockStartMs: 0, freeMin: 120, billableMin: 300, evidence: evidence({ pingCount: 3, maxGapMin: 55, departureObserved: false }), needsReview: true, reviewReasons: reasons },
    })
    const w = await mountLoaded([row])

    const el = w.find('[data-stop="s1"]')
    expect(el.attributes('data-state')).toBe('review')
    expect(el.find('[data-testid="detention-billable"]').text()).toContain('300 min billable')
    expect(el.find('[data-testid="detention-review-marker"]').exists()).toBe(true)
    expect(el.find('[data-testid="detention-review-marker"]').text()).toMatch(/review/i)
    const reasonItems = el.find('[data-testid="detention-review-reasons"]').findAll('li')
    expect(reasonItems.map((li) => li.text())).toEqual(reasons) // verbatim, in order
  })

  it('claim: null stops get no row — they are counted as checked in the one-line summary, never shown as $0', async () => {
    const row = stop({ claim: null, noClaimReason: 'No appointment on file for this stop — free time cannot be computed without a scheduled window.', observedMin: 187 })
    const w = await mountLoaded([row])

    expect(w.find('[data-stop="s1"]').exists()).toBe(false)
    expect(w.find('[data-testid="detention-list"]').exists()).toBe(false)
    expect(w.find('[data-testid="detention-empty"]').text()).toContain('1 stops checked')
    expect(w.text()).not.toContain('$0')
    expect(w.text()).not.toContain('187 min')
  })

  it('mixed results: only the owed stop gets a row, the badge counts both', async () => {
    const owed = stop({ stopId: 's-owed', claim: { clockStartMs: 0, freeMin: 120, billableMin: 45, evidence: evidence(), needsReview: false, reviewReasons: [] } })
    const refused = stop({ stopId: 's-refused', claim: null, noClaimReason: 'no pings', observedMin: 5 })
    const w = await mountLoaded([owed, refused])

    expect(w.find('[data-stop="s-owed"]').exists()).toBe(true)
    expect(w.find('[data-stop="s-refused"]').exists()).toBe(false)
    expect(w.text()).toContain('1 owed · 2 checked')
  })

  it('a store fetch failure renders "could not load detention", never an empty list', async () => {
    mockedFetchDetention.mockRejectedValueOnce(new Error('network down'))
    const w = mount(DetentionPanel)
    await flushPromises()

    expect(w.find('[data-testid="detention-error"]').text().toLowerCase()).toContain('could not load detention')
    expect(w.find('[data-testid="detention-error"]').text()).toContain('network down')
    expect(w.find('[data-testid="detention-empty"]').exists()).toBe(false)
    expect(w.find('[data-testid="detention-list"]').exists()).toBe(false)
  })

  it('an empty-but-successful fetch shows the empty state, distinct from an error', async () => {
    const w = await mountLoaded([])
    expect(w.find('[data-testid="detention-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="detention-error"]').exists()).toBe(false)
  })

  it('surfaces a stale error over stale items without pretending nothing changed', async () => {
    // Regression guard for the store's own contract (stores/cockpit.ts's
    // `detention` doc): a failed refetch leaves `items` untouched rather than
    // clearing them, so the panel must still read the error branch, not fall
    // through to rendering the stale rows as if the fetch had succeeded.
    const ck = useCockpitStore()
    ck.detention = { items: [stop({ claim: null, noClaimReason: 'stale reason', observedMin: 10 })], loading: false, error: 'timeout' }
    mockedFetchDetention.mockResolvedValueOnce(ck.detention.items) // mount's own onMounted fetch — irrelevant to this assertion
    const w = mount(DetentionPanel)
    expect(w.find('[data-testid="detention-error"]').exists()).toBe(true)
  })
})
