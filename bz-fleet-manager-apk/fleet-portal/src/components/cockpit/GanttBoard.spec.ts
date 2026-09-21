import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { proposeDrop, proposeMove, proposeResize } from '../../lib/cockpit/drag'
import { brickSpan } from '../../lib/cockpit/geometry'
import { useAuthStore } from '../../stores/auth'
import { useCockpitStore } from '../../stores/cockpit'
import { useLoadboardStore, type BoardLoad } from '../../stores/loadboard'
import { useLoadLocksStore } from '../../stores/loadLocks'
import GanttBoard from './GanttBoard.vue'

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() }, API_BASE_URL: 'http://localhost:3001/api' }))

const NOW = Date.UTC(2026, 7, 28, 19, 32) // Fri 14:32 CDT
const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()
const load = (over: Partial<BoardLoad>): BoardLoad => ({
  id: 'l', reference: 'L', status: 'assigned', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 100000, stopCount: 2, origin: 'A', destination: 'B', assignment: null, ...over,
})

// Lane hit-boxes for the pointer-gesture tests below. jsdom has no layout, so
// GanttBoard's `laneRects` prop stands in for measured row rects — see the
// prop's own doc comment in GanttBoard.vue. d1 is the top lane, d7 below it.
const LANE_RECTS = [
  { id: 'd1', top: 0, height: 64 },
  { id: 'd7', top: 64, height: 64 },
]
/** jsdom implements the PointerEvent constructor but not element pointer
 *  capture — dispatching real PointerEvents (rather than vue-test-utils'
 *  generic `.trigger()`, which doesn't set clientX/clientY/pointerId) is what
 *  exercises GanttBoard's actual gesture code. */
function firePointer(target: Element | Window, type: string, opts: Partial<PointerEventInit> = {}): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...opts }))
}

describe('GanttBoard', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const lb = useLoadboardStore()
    lb.lanes = [
      { id: 'd1', name: 'Jake Morrow', status: 'active', hosKnown: true, driveRemainingMin: 495, currentTractorId: 't1', currentTrailerId: 'r1' },
      { id: 'd7', name: 'Chuck Baker', status: 'active', hosKnown: true, driveRemainingMin: 660 },
    ]
    lb.tractors = [{ id: 't1', unit: '1207', make: 'Peterbilt 579', cab: 'Sleeper', status: 'active', inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null, currentDriverId: 'd1' }]
    lb.trailers = [{ id: 'r1', unit: 'RF-2201', type: 'Reefer', length: "53'", status: 'active', features: null, inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null, currentDriverId: 'd1' }]
    lb.loads = [
      // starts Fri 14:00 CDT exactly (NOW is 14:32) -> (14 - 6) h × 22 px = 176 px
      load({ id: 'l1', reference: 'L-1', status: 'in_progress', origin: 'Kansas City', destination: 'Chicago', assignment: { id: 'a1', driverId: 'd1', tractorId: 't1', trailerId: 'r1', status: 'in_progress', plannedStart: iso(NOW - (32 / 60) * H), plannedEnd: iso(NOW + 18 * H), marginCents: 1, deadheadMi: 0, loadedMi: 497 } }),
      load({ id: 'l2', reference: 'L-2', hazmatClass: '8', origin: 'Indianapolis', destination: 'Columbus', assignment: { id: 'a2', driverId: 'd1', tractorId: 't1', trailerId: 'r1', status: 'assigned', plannedStart: iso(NOW + 40 * H), plannedEnd: iso(NOW + 44 * H), marginCents: 1, deadheadMi: 198, deadheadMin: 238, loadedMi: 180 } }),
      load({ id: 'l3', reference: 'L-3', status: 'open' }),
    ]
    useCockpitStore().init('America/Chicago', NOW)
  })

  it('renders one row per lane with positioned bricks, deadhead connectors and the now-line', () => {
    const w = mount(GanttBoard, { props: { nowMs: NOW } })
    expect(w.findAll('[data-lane]')).toHaveLength(2)
    const b1 = w.find('[data-load="l1"]')
    expect(b1.exists()).toBe(true)
    expect(b1.attributes('style')).toContain('left: 176px') // (14.0 - 6) h × 22 px
    expect(w.find('[data-load="l3"]').exists()).toBe(false) // backlog is not on the board
    expect(w.findAll('.ck-dh')).toHaveLength(1) // Chicago -> Indianapolis
    expect(w.text()).toContain('DH ~198 mi')
    expect(w.find('.ck-laser').exists()).toBe(true)
    expect(w.find('[data-testid="tag-mismatch"]').exists()).toBe(true) // Reefer hooked, DryVan required
  })

  // A4 Task 8: GanttBoard reads useLoadLocksStore().theirs — the one source
  // of lock truth (see that store's own doc) — and hands each brick its
  // holder's name, same prop-down shape as breakPlan/fuelPlan/detention.
  it('marks a brick whose load another dispatcher is holding', () => {
    useAuthStore().dispatcher = { id: 'me', email: 'me@x.com', name: 'Me' } as never
    // theirs is a getter over byLoad — seed it through the real applyEvent
    // path (same as loadLocks.spec.ts) rather than assigning the getter
    // directly, which Vue's computed setter warns on and silently ignores.
    useLoadLocksStore().applyEvent({ type: 'load_lock', loadId: 'l1', dispatcherId: 'maria', by: 'Maria' })
    const w = mount(GanttBoard, { props: { nowMs: NOW } })
    const brick = w.find('[data-load="l1"]')
    expect(brick.attributes('data-locked')).toBe('Maria')
    expect(brick.text()).toContain('Maria')
    // The badge is information, not a barrier: the Cockpit's own writes are
    // already refused server-side by the lock, and a brick that silently
    // stopped responding would read as a bug rather than as someone else's edit.
    expect(w.find('[data-load="l2"]').attributes('data-locked')).toBeUndefined()
  })

  // T3 Break and Rest Planning, Task 9 (Ruling 8): GanttBoard hands each
  // brick its own slice of `breakPlanByLoadId` — the same store map the live
  // map's marker layer reads (mapData.ts's `breakMarkers`) — so the board
  // and the map can never disagree about whether a load needs a break.
  it('threads breakPlanByLoadId into each brick\'s own break glyph', () => {
    // Both bricks wide enough to clear LegBrick's `mid` tier (>=110px at
    // 22px/h => >=5h) so the glyph's absence below is actually because of
    // `known: false`, not because the badge row itself never rendered.
    useLoadboardStore().loads = [
      load({ id: 'lw1', reference: 'LW-1', origin: 'A', destination: 'B', assignment: { id: 'aw1', driverId: 'd1', tractorId: 't1', trailerId: 'r1', status: 'assigned', plannedStart: iso(NOW), plannedEnd: iso(NOW + 10 * H), marginCents: 1, deadheadMi: 0, loadedMi: 300 } }),
      load({ id: 'lw2', reference: 'LW-2', origin: 'C', destination: 'D', assignment: { id: 'aw2', driverId: 'd7', status: 'assigned', plannedStart: iso(NOW), plannedEnd: iso(NOW + 10 * H), marginCents: 1, deadheadMi: 0, loadedMi: 300 } }),
    ]
    useCockpitStore().breakPlanByLoadId = {
      lw1: { entries: [{ atMs: NOW + 2 * H, at: { lat: 39.1, lng: -94.58 }, precision: 'estimated', hasCoverage: true, options: [] }], known: true },
      // lw2 has a cached entry but the driver's HOS was never imported — no glyph.
      lw2: { entries: [{ atMs: NOW + 2 * H, at: null, precision: 'estimated', hasCoverage: false, options: [] }], known: false },
    }
    const w = mount(GanttBoard, { props: { nowMs: NOW } })

    expect(w.find('[data-load="lw1"]').find('[data-testid="tag-break"]').exists()).toBe(true)
    expect(w.find('[data-load="lw2"]').find('[data-testid="tag-break"]').exists()).toBe(false)
  })

  // T4 Fuel and Stops, Task 9: GanttBoard hands each brick its own slice of
  // `fuelPlanByLoadId`, the same wiring as breakPlanByLoadId above.
  it('threads fuelPlanByLoadId into each brick\'s own fuel chip', () => {
    useLoadboardStore().loads = [
      load({ id: 'lf1', reference: 'LF-1', origin: 'A', destination: 'B', assignment: { id: 'af1', driverId: 'd1', tractorId: 't1', trailerId: 'r1', status: 'assigned', plannedStart: iso(NOW), plannedEnd: iso(NOW + 10 * H), marginCents: 1, deadheadMi: 0, loadedMi: 300 } }),
      load({ id: 'lf2', reference: 'LF-2', origin: 'C', destination: 'D', assignment: { id: 'af2', driverId: 'd7', status: 'assigned', plannedStart: iso(NOW), plannedEnd: iso(NOW + 10 * H), marginCents: 1, deadheadMi: 0, loadedMi: 300 } }),
    ]
    useCockpitStore().fuelPlanByLoadId = {
      lf1: {
        burn: { deadheadGal: 1, loadedGal: 19, totalGal: 20, mpgUsed: 6.4 },
        advice: { atSequence: 1, atLabel: "Love's #402", state: 'MO', gallons: 20, centsPerGal: 389, vsLabel: 'fleet avg', vsCentsPerGal: 412, savingCents: 4700 },
        ifta: { byState: [], unattributedGal: 0, complete: true },
        known: true,
      },
      // lf2 has a cached plan but the engine found nowhere cheaper worth naming.
      lf2: { burn: { deadheadGal: 1, loadedGal: 19, totalGal: 20, mpgUsed: 6.4 }, advice: null, ifta: { byState: [], unattributedGal: 0, complete: true }, known: true },
    }
    const w = mount(GanttBoard, { props: { nowMs: NOW } })

    expect(w.find('[data-load="lf1"]').find('[data-testid="tag-fuel"]').exists()).toBe(true)
    expect(w.find('[data-load="lf2"]').find('[data-testid="tag-fuel"]').exists()).toBe(false)
  })

  // T5 Dwell and Detention, Task 8: `detention.items` is a flat array, not a
  // map like breakPlanByLoadId/fuelPlanByLoadId — GanttBoard derives its own
  // `detentionByLoadId` and hands each brick its own row.
  it('derives detentionByLoadId from the flat detention.items and threads it into each brick\'s marker', () => {
    useLoadboardStore().loads = [
      load({ id: 'ld1', reference: 'LD-1', origin: 'A', destination: 'B', assignment: { id: 'ad1', driverId: 'd1', tractorId: 't1', trailerId: 'r1', status: 'assigned', plannedStart: iso(NOW), plannedEnd: iso(NOW + 10 * H), marginCents: 1, deadheadMi: 0, loadedMi: 300 } }),
      load({ id: 'ld2', reference: 'LD-2', origin: 'C', destination: 'D', assignment: { id: 'ad2', driverId: 'd7', status: 'assigned', plannedStart: iso(NOW), plannedEnd: iso(NOW + 10 * H), marginCents: 1, deadheadMi: 0, loadedMi: 300 } }),
    ]
    const evidence = { pingCount: 10, maxGapMin: 5, firstSeenMs: NOW - H, lastSeenMs: NOW, departureObserved: true }
    useCockpitStore().detention = {
      items: [
        // ld1 has two billable stops -> the row with the larger claim wins (60 > 20), not the sum.
        { loadId: 'ld1', loadRef: 'LD-1', stopId: 'sa', stopLabel: 'Pickup', stopType: 'pickup', driverId: 'd1', driverName: 'Jake Morrow', claim: { clockStartMs: NOW, freeMin: 120, billableMin: 20, evidence, needsReview: false, reviewReasons: [] }, noClaimReason: null, observedMin: 140 },
        { loadId: 'ld1', loadRef: 'LD-1', stopId: 'sb', stopLabel: 'Delivery', stopType: 'delivery', driverId: 'd1', driverName: 'Jake Morrow', claim: { clockStartMs: NOW, freeMin: 120, billableMin: 60, evidence, needsReview: false, reviewReasons: [] }, noClaimReason: null, observedMin: 180 },
        // ld2 has a detention row but no billable claim -> no marker.
        { loadId: 'ld2', loadRef: 'LD-2', stopId: 'sc', stopLabel: 'Delivery', stopType: 'delivery', driverId: 'd7', driverName: 'Chuck Baker', claim: null, noClaimReason: 'No appointment on file.', observedMin: null },
      ],
      loading: false,
      error: null,
    }
    const w = mount(GanttBoard, { props: { nowMs: NOW } })

    const tag1 = w.find('[data-load="ld1"]').find('[data-testid="tag-detention"]')
    expect(tag1.exists()).toBe(true)
    expect(tag1.attributes('title')).toContain('60 min billable') // the larger of the two claims, not the sum (20 + 60)
    expect(w.find('[data-load="ld2"]').find('[data-testid="tag-detention"]').exists()).toBe(false)
  })

  it('reflects grouping, filters and spotting from the store', async () => {
    const ck = useCockpitStore()
    const w = mount(GanttBoard, { props: { nowMs: NOW } })
    ck.setGroupBy('tractor')
    await w.vm.$nextTick()
    expect(w.findAll('[data-lane]')).toHaveLength(1)
    expect(w.text()).toContain('#1207')
    ck.setGroupBy('driver')
    ck.setFilter('haz')
    await w.vm.$nextTick()
    expect(w.find('[data-load="l1"]').classes()).toContain('opacity-40')
    expect(w.find('[data-load="l2"]').classes()).not.toContain('opacity-40')
    ck.setFilter('all')
    ck.setSearch('chicago')
    await w.vm.$nextTick()
    expect(w.find('[data-load="l1"]').classes()).toContain('ck-spot')
    expect(w.find('[data-load="l2"]').classes()).toContain('opacity-40')
  })

  it('groups by carrier with a heading per carrier, including a "No carrier" heading for the unassigned driver — and drops no lane', async () => {
    const lb = useLoadboardStore()
    lb.lanes = lb.lanes.map((l) => (l.id === 'd1' ? { ...l, carrierId: 'c-acme', carrierName: 'Acme Logistics' } : { ...l, carrierId: null, carrierName: null }))
    const ck = useCockpitStore()
    const w = mount(GanttBoard, { props: { nowMs: NOW } })
    ck.setGroupBy('carrier')
    await w.vm.$nextTick()

    // Both driver lanes are still rendered — carrier grouping reorders/labels, never drops.
    expect(w.findAll('[data-lane]')).toHaveLength(2)
    const groupEls = w.findAll('[data-carrier-group]')
    expect(groupEls).toHaveLength(2)
    expect(groupEls.map((el) => el.text())).toEqual(['Acme Logistics (1)', 'No carrier (1)'])

    // d1 (carried) renders under the Acme heading, d7 (uncarried) under "No carrier".
    const acmeHeader = w.find('[data-carrier-group="c-acme"]')
    const noneHeader = w.find('[data-carrier-group="none"]')
    expect(acmeHeader.element.nextElementSibling?.getAttribute('data-lane')).toBe('d1')
    expect(noneHeader.element.nextElementSibling?.getAttribute('data-lane')).toBe('d7')
  })

  it('bubbles brick and lane-name clicks', async () => {
    const w = mount(GanttBoard, { props: { nowMs: NOW } })
    await w.find('[data-load="l1"]').trigger('click')
    expect(w.emitted('open')![0]).toEqual(['l1'])
    await w.find('[data-lane="d1"] [data-testid="lane-name"]').trigger('click')
    expect(w.emitted('openDriver')![0]).toEqual(['d1'])
  })

  describe('pointer gestures', () => {
    const startMs = () => Date.parse(iso(NOW - (32 / 60) * H)) // l1's plannedStart: Fri 14:00 CDT exactly
    const endMs = () => Date.parse(iso(NOW + 18 * H)) // l1's plannedEnd

    it('a 44px drag at 22px/h proposes +2h, and the ghost renders at the proposed x', async () => {
      const ck = useCockpitStore()
      const w = mount(GanttBoard, { props: { nowMs: NOW, laneRects: LANE_RECTS } })
      const brick = w.get('[data-load="l1"]')

      firePointer(brick.element, 'pointerdown', { clientX: 500, clientY: 10 })
      firePointer(window, 'pointermove', { clientX: 544, clientY: 10 }) // +44px, same lane (d1, y 0-64)
      await w.vm.$nextTick()

      const proposal = proposeMove(startMs(), endMs(), 44, ck.config)
      const span = brickSpan(proposal.startMs, proposal.endMs, ck.config)!
      const ghostEl = w.get('[data-testid="drag-ghost"]')
      expect(ghostEl.attributes('style')).toContain(`left: ${Math.round(span.x)}px`)
      expect(span.x).toBe(220) // 176 (l1's rest x) + 44

      firePointer(window, 'pointerup', { clientX: 544, clientY: 10 })
      await w.vm.$nextTick()
      expect(w.emitted('gesture-move')![0][0]).toEqual({ loadId: 'l1', assignmentId: 'a1', driverId: 'd1', availableAt: proposal.startMs })
      // the real brick never moved during the gesture
      expect(w.get('[data-load="l1"]').attributes('style')).toContain('left: 176px')
    })

    it('resizing the right edge proposes a new plannedEnd and emits gesture-resize', async () => {
      const ck = useCockpitStore()
      const w = mount(GanttBoard, { props: { nowMs: NOW, laneRects: LANE_RECTS } })
      const handle = w.get('[data-load="l1"][data-h="r"]')

      firePointer(handle.element, 'pointerdown', { clientX: 700, clientY: 10 })
      firePointer(window, 'pointermove', { clientX: 722, clientY: 10 }) // +22px = +1h before snapping
      await w.vm.$nextTick()
      expect(w.find('[data-testid="drag-ghost"]').exists()).toBe(true)

      firePointer(window, 'pointerup', { clientX: 722, clientY: 10 })
      await w.vm.$nextTick()
      const expected = proposeResize(startMs(), endMs(), 22, 'r', ck.config)!
      expect(w.emitted('gesture-resize')![0][0]).toEqual({ loadId: 'l1', assignmentId: 'a1', plannedEnd: expected.endMs })
    })

    it('resizing the left edge proposes a new availableAt (no plannedEnd)', async () => {
      const ck = useCockpitStore()
      const w = mount(GanttBoard, { props: { nowMs: NOW, laneRects: LANE_RECTS } })
      const handle = w.get('[data-load="l1"][data-h="l"]')

      firePointer(handle.element, 'pointerdown', { clientX: 400, clientY: 10 })
      firePointer(window, 'pointermove', { clientX: 378, clientY: 10 }) // -22px = -1h
      await w.vm.$nextTick()
      firePointer(window, 'pointerup', { clientX: 378, clientY: 10 })
      await w.vm.$nextTick()

      const expected = proposeResize(startMs(), endMs(), -22, 'l', ck.config)!
      expect(w.emitted('gesture-resize')![0][0]).toEqual({ loadId: 'l1', assignmentId: 'a1', availableAt: expected.startMs })
    })

    it('Escape cancels mid-drag and emits nothing', async () => {
      const w = mount(GanttBoard, { props: { nowMs: NOW, laneRects: LANE_RECTS } })
      const brick = w.get('[data-load="l1"]')

      firePointer(brick.element, 'pointerdown', { clientX: 500, clientY: 10 })
      firePointer(window, 'pointermove', { clientX: 560, clientY: 10 })
      await w.vm.$nextTick()
      expect(w.find('[data-testid="drag-ghost"]').exists()).toBe(true)

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await w.vm.$nextTick()
      expect(w.find('[data-testid="drag-ghost"]').exists()).toBe(false)

      // a stray pointerup after Escape is a no-op — the gesture is already gone
      firePointer(window, 'pointerup', { clientX: 560, clientY: 10 })
      await w.vm.$nextTick()
      expect(w.emitted('gesture-move')).toBeFalsy()
      expect(w.emitted('gesture-resize')).toBeFalsy()
      expect(w.emitted('open')).toBeFalsy()
    })

    it('pointerup outside every lane cancels a move instead of guessing a target', async () => {
      const w = mount(GanttBoard, { props: { nowMs: NOW, laneRects: LANE_RECTS } })
      const brick = w.get('[data-load="l1"]')

      firePointer(brick.element, 'pointerdown', { clientX: 500, clientY: 10 })
      firePointer(window, 'pointermove', { clientX: 540, clientY: 500 }) // below both lanes (0-64, 64-128)
      await w.vm.$nextTick()
      expect(w.find('[data-testid="drag-ghost"]').exists()).toBe(false) // no target lane -> no ghost

      firePointer(window, 'pointerup', { clientX: 540, clientY: 500 })
      await w.vm.$nextTick()
      expect(w.emitted('gesture-move')).toBeFalsy()
    })

    it('a drag under 3px is a click, not a drag: it opens the drawer and proposes nothing', async () => {
      const w = mount(GanttBoard, { props: { nowMs: NOW, laneRects: LANE_RECTS } })
      const brick = w.get('[data-load="l1"]')

      firePointer(brick.element, 'pointerdown', { clientX: 500, clientY: 10 })
      firePointer(window, 'pointermove', { clientX: 501, clientY: 11 }) // ~1.4px — under the 3px threshold
      firePointer(window, 'pointerup', { clientX: 501, clientY: 11 })
      await w.vm.$nextTick()

      expect(w.emitted('open')![0]).toEqual(['l1'])
      expect(w.emitted('gesture-move')).toBeFalsy()
      expect(w.find('[data-testid="drag-ghost"]').exists()).toBe(false)
    })

    it('dragging a backlog card onto a lane emits gesture-drop with the resolved driver', async () => {
      const ck = useCockpitStore()
      const w = mount(GanttBoard, { props: { nowMs: NOW, laneRects: LANE_RECTS } })
      // BacklogPanel is a sibling component, not a descendant of GanttBoard —
      // stand in a bare element carrying the same data-bid contract to prove
      // the document-level pointerdown delegation actually reaches it.
      const card = document.createElement('div')
      card.setAttribute('data-bid', 'l3')
      document.body.appendChild(card)
      try {
        firePointer(card, 'pointerdown', { clientX: 300, clientY: 10 })
        firePointer(window, 'pointermove', { clientX: 320, clientY: 10 }) // lands in d1's rect
        await w.vm.$nextTick()
        expect(w.find('[data-testid="drag-ghost"]').exists()).toBe(true)

        firePointer(window, 'pointerup', { clientX: 320, clientY: 10 })
        await w.vm.$nextTick()
        expect(w.emitted('gesture-drop')![0][0]).toEqual({ loadId: 'l3', driverId: 'd1', availableAt: proposeDrop(320, ck.config) })
      } finally {
        document.body.removeChild(card)
      }
    })

    it('a backlog card drop outside every lane emits nothing', async () => {
      const w = mount(GanttBoard, { props: { nowMs: NOW, laneRects: LANE_RECTS } })
      const card = document.createElement('div')
      card.setAttribute('data-bid', 'l3')
      document.body.appendChild(card)
      try {
        firePointer(card, 'pointerdown', { clientX: 300, clientY: 10 })
        firePointer(window, 'pointermove', { clientX: 320, clientY: 500 }) // below every lane
        firePointer(window, 'pointerup', { clientX: 320, clientY: 500 })
        await w.vm.$nextTick()
        expect(w.emitted('gesture-drop')).toBeFalsy()
      } finally {
        document.body.removeChild(card)
      }
    })

    // Cockpit S2b Task 12: the yard-chip pairing drag. YardChips is a sibling
    // component too, so — same as BacklogPanel above — a bare element
    // carrying the real `data-res`/`data-rid` contract stands in for it here.
    it('dragging a yard tractor chip onto a lane emits gesture-pair with tractorId', async () => {
      const w = mount(GanttBoard, { props: { nowMs: NOW, laneRects: LANE_RECTS } })
      const chip = document.createElement('span')
      chip.setAttribute('data-res', 'tractor')
      chip.setAttribute('data-rid', 't9')
      document.body.appendChild(chip)
      try {
        firePointer(chip, 'pointerdown', { clientX: 300, clientY: 10 })
        firePointer(window, 'pointermove', { clientX: 320, clientY: 10 }) // lands in d1's rect
        await w.vm.$nextTick()
        expect(w.find('[data-testid="drag-ghost"]').exists()).toBe(true)

        firePointer(window, 'pointerup', { clientX: 320, clientY: 10 })
        await w.vm.$nextTick()
        expect(w.emitted('gesture-pair')![0][0]).toEqual({ driverId: 'd1', tractorId: 't9' })
      } finally {
        document.body.removeChild(chip)
      }
    })

    it('dragging a yard trailer chip onto a lane emits gesture-pair with trailerId', async () => {
      const w = mount(GanttBoard, { props: { nowMs: NOW, laneRects: LANE_RECTS } })
      const chip = document.createElement('span')
      chip.setAttribute('data-res', 'trailer')
      chip.setAttribute('data-rid', 'r9')
      document.body.appendChild(chip)
      try {
        firePointer(chip, 'pointerdown', { clientX: 300, clientY: 70 })
        firePointer(window, 'pointermove', { clientX: 320, clientY: 70 }) // lands in d7's rect (64-128)
        await w.vm.$nextTick()

        firePointer(window, 'pointerup', { clientX: 320, clientY: 70 })
        await w.vm.$nextTick()
        expect(w.emitted('gesture-pair')![0][0]).toEqual({ driverId: 'd7', trailerId: 'r9' })
      } finally {
        document.body.removeChild(chip)
      }
    })

    it('a yard chip dropped outside every lane emits nothing', async () => {
      const w = mount(GanttBoard, { props: { nowMs: NOW, laneRects: LANE_RECTS } })
      const chip = document.createElement('span')
      chip.setAttribute('data-res', 'tractor')
      chip.setAttribute('data-rid', 't9')
      document.body.appendChild(chip)
      try {
        firePointer(chip, 'pointerdown', { clientX: 300, clientY: 10 })
        firePointer(window, 'pointermove', { clientX: 320, clientY: 500 }) // below every lane
        firePointer(window, 'pointerup', { clientX: 320, clientY: 500 })
        await w.vm.$nextTick()
        expect(w.emitted('gesture-pair')).toBeFalsy()
      } finally {
        document.body.removeChild(chip)
      }
    })

    it('a yard driver chip is not draggable — no gesture starts and pointerup opens nothing', async () => {
      const w = mount(GanttBoard, { props: { nowMs: NOW, laneRects: LANE_RECTS } })
      const chip = document.createElement('span')
      chip.setAttribute('data-res', 'driver')
      chip.setAttribute('data-rid', 'd9')
      document.body.appendChild(chip)
      try {
        firePointer(chip, 'pointerdown', { clientX: 300, clientY: 10 })
        firePointer(window, 'pointermove', { clientX: 320, clientY: 10 })
        firePointer(window, 'pointerup', { clientX: 320, clientY: 10 })
        await w.vm.$nextTick()
        expect(w.emitted('gesture-pair')).toBeFalsy()
        expect(w.emitted('open')).toBeFalsy()
      } finally {
        document.body.removeChild(chip)
      }
    })
  })

  // Plan A3 (spec §8.3): brokered loads — covered by an outside carrier, no
  // unit of ours behind them — get their own lane, projected by Task 5's
  // carrierLanesOf/spanOf. A placed leg spans its PU->DEL appointment window;
  // an unplaced one (spanOf null — no readable appointment) pins to the
  // lane's left edge and surfaces its Attention as a title.
  describe('carrier lanes on the board (plan A3)', () => {
    it('draws a carrier lane with a placed brick from its appointments and an unplaced brick at the left edge with its Attention', () => {
      const ck = useCockpitStore()
      ck.day0 = '2026-07-13'
      ck.days = 5
      useLoadboardStore().loads = [
        load({
          id: 'bl1',
          reference: 'BL-1',
          status: 'assigned',
          origin: 'Kansas City',
          destination: 'Chicago',
          assignment: null,
          carrierId: 'c1',
          carrierName: 'Blue Road LLC',
          carrierMc: '1000001',
          pickupWindowStart: iso(Date.UTC(2026, 6, 14, 17, 0)),
          deliveryWindowEnd: iso(Date.UTC(2026, 6, 16, 12, 0)),
        }),
        load({
          id: 'bl2',
          reference: 'BL-2',
          status: 'assigned',
          origin: 'St. Louis',
          destination: 'Memphis',
          assignment: null,
          carrierId: 'c2',
          carrierName: 'Fast Lane Inc',
          attention: ['can\'t read PU appointment: "PU: whenever"'],
        }),
      ]
      const w = mount(GanttBoard, { props: { nowMs: NOW } })

      const lane = w.find('[data-track="carrier:c1"]')
      expect(lane.exists()).toBe(true)
      const placed = lane.find('[data-brokered]')
      expect(placed.exists()).toBe(true)
      expect(Number.parseFloat(placed.attributes('style')!.match(/left:\s*([\d.]+)px/)![1])).toBeGreaterThan(0)
      const unplaced = w.find('[data-track="carrier:c2"] [data-unplaced]')
      expect(unplaced.attributes('title')).toBe('can\'t read PU appointment: "PU: whenever"')
      expect(unplaced.attributes('style')).toContain('left: 0px')
      expect(w.find('[data-lane-head="carrier:c1"]').text()).toContain('Blue Road LLC')
      expect(w.find('[data-lane-head="carrier:c1"]').text()).toContain('MC 1000001')
      // Fix round 1 (MEDIUM): UNPLACED_W (96px) is below LegBrick's `mid`
      // (110px) threshold that normally gates the carrier badge, so an
      // unplaced brick needs its own always-rendered path to show it.
      expect(unplaced.find('[data-testid="tag-carrier"]').text()).toBe('Fast Lane Inc')
    })

    // H1 (final fix wave): every brokered fixture above used status:
    // 'assigned', which never reached LegBrick's `in_progress` progress-bar
    // branch. A brokered load has no Assignment of ours, so startMs/endMs
    // both default to 0 and progressShare('in_progress', 0, 0, now) used to
    // read that as fully elapsed — drawing a full bar for a truck we have no
    // GPS on at all (spec §8.4). Pin an in_progress carrier leg and assert
    // the bar renders at zero width, not full.
    it('an in_progress carrier lane brick draws no progress bar — no GPS on a carrier truck', () => {
      const ck = useCockpitStore()
      ck.day0 = '2026-07-13'
      ck.days = 5
      useLoadboardStore().loads = [
        load({
          id: 'bl5',
          reference: 'BL-5',
          status: 'in_progress',
          origin: 'Dallas',
          destination: 'Houston',
          assignment: null,
          carrierId: 'c5',
          carrierName: 'Rolling Freight LLC',
          // Inside the ck.day0/days window set below (July 13-17), not near
          // NOW (Aug 28) — spanOf places the brick by this appointment
          // window regardless of nowMs, and nowMs no longer drives progress
          // for a load with no assignment of ours (H1 fix).
          pickupWindowStart: iso(Date.UTC(2026, 6, 14, 17, 0)),
          deliveryWindowEnd: iso(Date.UTC(2026, 6, 16, 12, 0)),
        }),
      ]
      const w = mount(GanttBoard, { props: { nowMs: NOW } })
      const brick = w.find('[data-load="bl5"]')
      expect(brick.exists()).toBe(true)
      expect(brick.find('[data-testid="brick-progress"]').attributes('style')).toContain('width: 0px')
    })

    // Fix round 1 (LOW-MEDIUM): unplaced legs on the same carrier all pinned
    // to x=0 would stack exactly on top of each other — each subsequent one
    // must stagger by UNPLACED_W + 4px so they sit side by side.
    it('staggers multiple unplaced legs on the same carrier lane instead of stacking them at x=0', () => {
      const ck = useCockpitStore()
      ck.day0 = '2026-07-13'
      ck.days = 5
      useLoadboardStore().loads = [
        load({
          id: 'bl3',
          reference: 'BL-3',
          status: 'assigned',
          origin: 'Omaha',
          destination: 'Denver',
          assignment: null,
          carrierId: 'c3',
          carrierName: 'Third Carrier',
          attention: ['no PU appointment on file'],
        }),
        load({
          id: 'bl4',
          reference: 'BL-4',
          status: 'assigned',
          origin: 'Tulsa',
          destination: 'Wichita',
          assignment: null,
          carrierId: 'c3',
          carrierName: 'Third Carrier',
          attention: ['no PU appointment on file either'],
        }),
      ]
      const w = mount(GanttBoard, { props: { nowMs: NOW } })

      const bricks = w.findAll('[data-track="carrier:c3"] [data-unplaced]')
      expect(bricks).toHaveLength(2)
      const lefts = bricks.map((b) => Number.parseFloat(b.attributes('style')!.match(/left:\s*([\d.]+)px/)![1]))
      expect(lefts[0]).toBe(0)
      expect(lefts[1]).toBe(100) // UNPLACED_W (96) + the 4px gap
      expect(lefts[0]).not.toBe(lefts[1])
    })

    // Fix round 1 (LOW): a brokered brick has no assignment of ours, so the
    // existing `!load.assignment` guard in `beginBrickGesture` must already
    // stop a pointerdown on it from ever becoming a drag — no ghost, no
    // gesture-move/-resize emitted, mirroring the "Escape cancels" / "click
    // under 3px" pointer-gesture tests' own assertions for ordinary bricks.
    it('pointerdown on a brokered brick starts no drag — no ghost, no gesture-move/resize emitted', async () => {
      const ck = useCockpitStore()
      ck.day0 = '2026-07-13'
      ck.days = 5
      useLoadboardStore().loads = [
        load({
          id: 'bl1',
          reference: 'BL-1',
          status: 'assigned',
          origin: 'Kansas City',
          destination: 'Chicago',
          assignment: null,
          carrierId: 'c1',
          carrierName: 'Blue Road LLC',
          carrierMc: '1000001',
          pickupWindowStart: iso(Date.UTC(2026, 6, 14, 17, 0)),
          deliveryWindowEnd: iso(Date.UTC(2026, 6, 16, 12, 0)),
        }),
      ]
      const w = mount(GanttBoard, { props: { nowMs: NOW, laneRects: [{ id: 'carrier:c1', top: 0, height: 64 }] } })
      const brick = w.get('[data-load="bl1"]')

      firePointer(brick.element, 'pointerdown', { clientX: 500, clientY: 10 })
      firePointer(window, 'pointermove', { clientX: 560, clientY: 10 })
      await w.vm.$nextTick()
      expect(w.find('[data-testid="drag-ghost"]').exists()).toBe(false)

      firePointer(window, 'pointerup', { clientX: 560, clientY: 10 })
      await w.vm.$nextTick()
      expect(w.emitted('gesture-move')).toBeFalsy()
      expect(w.emitted('gesture-resize')).toBeFalsy()
      // No drag state was ever armed (`beginBrickGesture` returned before
      // setting it), so the board's own pointerup handler — the thing that
      // turns an un-moved drag into an `open` emit for ordinary bricks —
      // never runs either; a brokered brick's click-to-open comes from
      // LegBrick's own @click, a real DOM 'click' event this pointerdown/up
      // pair does not synthesize.
      expect(w.emitted('open')).toBeFalsy()
    })
  })
})
