import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { BreakPlanEntry, FuelAdvice, FuelPlanBody, StopDetention } from '../../lib/api'
import type { BoardLoad } from '../../stores/loadboard'
import LegBrick from './LegBrick.vue'

const TZ = 'America/Chicago'
const NOW = Date.UTC(2026, 7, 28, 19, 32)
const iso = (ms: number) => new Date(ms).toISOString()
const H = 3_600_000
const load: BoardLoad = {
  id: 'l1', reference: 'L-51217', status: 'in_progress', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 145000,
  stopCount: 2, origin: 'Kansas City', destination: 'Chicago', brokerName: 'C.H. Robinson', commodity: 'Retail freight', weightLbs: 42000,
  assignment: { id: 'a1', driverId: 'd1', status: 'in_progress', plannedStart: iso(NOW - 0.5 * H), plannedEnd: iso(NOW + 18 * H), marginCents: 58000, economics: { estCostCents: 87000, marginCents: 58000 }, deadheadMi: 0, loadedMi: 497 },
}
/** Same leg, never priced: no Rate row, so the wire carries economics: null
 *  while the legacy Assignment.marginCents keeps its Int @default(0). */
const unpriced: BoardLoad = { ...load, assignment: { ...load.assignment!, marginCents: 0, economics: null } }
const base = { load, x: 100, w: 300, tz: TZ, nowMs: NOW }

// T3 Break and Rest Planning, Task 9 (Ruling 8) fixture — the exact shape
// `cockpit.ts`'s `breakPlanByLoadId` keys a load id to.
function breakEntry(over: Partial<BreakPlanEntry> = {}): BreakPlanEntry {
  return {
    atMs: NOW + 4 * H,
    at: { lat: 38.9717, lng: -95.2353 },
    precision: 'estimated',
    hasCoverage: true,
    options: [],
    ...over,
  }
}

// T4 Fuel and Stops, Task 9 fixtures — the exact shape `cockpit.ts`'s
// `fuelPlanByLoadId` keys a load id to.
function fuelAdvice(over: Partial<FuelAdvice> = {}): FuelAdvice {
  return { atSequence: 1, atLabel: "Love's #402", state: 'MO', gallons: 20, centsPerGal: 389, vsLabel: 'fleet avg', vsCentsPerGal: 412, savingCents: 4700, ...over }
}
function fuelPlan(over: Partial<FuelPlanBody> = {}): FuelPlanBody {
  return {
    burn: { deadheadGal: 1, loadedGal: 19, totalGal: 20, mpgUsed: 6.4 },
    advice: fuelAdvice(),
    ifta: { byState: [], unattributedGal: 0, complete: true },
    known: true,
    ...over,
  }
}

// T5 Dwell and Detention, Task 8 fixture — the exact shape GanttBoard's
// `detentionByLoadId` computed hands down (one `StopDetention` row).
function detentionRow(over: Partial<StopDetention> = {}): StopDetention {
  return {
    loadId: 'l1',
    loadRef: 'L-51217',
    stopId: 's1',
    stopLabel: 'Kroger DC 42',
    stopType: 'delivery',
    driverId: 'd1',
    driverName: 'Jake Morrow',
    claim: {
      clockStartMs: NOW,
      freeMin: 120,
      billableMin: 45,
      evidence: { pingCount: 14, maxGapMin: 6, firstSeenMs: NOW - H, lastSeenMs: NOW, departureObserved: true },
      needsReview: false,
      reviewReasons: [],
    },
    noClaimReason: null,
    observedMin: 165,
    ...over,
  }
}

describe('LegBrick', () => {
  it('wide tier: header tags, rate + $/mi, route with commodity, window + margin, step bar, progress', () => {
    const w = mount(LegBrick, { props: base })
    expect(w.attributes('style')).toContain('left: 100px')
    expect(w.attributes('style')).toContain('width: 300px')
    expect(w.text()).toContain('L-51217')
    expect(w.text()).toContain('DRY VAN')
    expect(w.text()).toContain('C.H. Robinson')
    expect(w.find('[data-testid="brick-rate"]').text()).toContain('$1,450')
    expect(w.find('[data-testid="brick-rate"]').text()).toContain('$2.92/mi')
    expect(w.find('[data-testid="brick-route"]').text()).toContain('Kansas City ➔ Chicago (Retail freight · 42,000 lbs)')
    expect(w.find('[data-testid="brick-margin"]').text()).toBe('+$580 MARGIN')
    const segs = w.find('[data-testid="step-bar"]').findAll('div')
    expect(segs.map((s) => s.classes().includes('bg-emerald-400'))).toEqual([true, true, false, false])
    expect(segs[2].classes()).toContain('bg-amber-400')
    // 0.5h of an 18.5h plan elapsed -> ~8px of 300
    expect(w.find('[data-testid="brick-progress"]').attributes('style')).toContain('width: 8px')
  })

  it('mid and narrow tiers drop detail progressively', () => {
    const mid = mount(LegBrick, { props: { ...base, w: 150 } })
    expect(mid.find('[data-testid="brick-route"]').exists()).toBe(true)
    expect(mid.find('[data-testid="brick-rate"]').exists()).toBe(false)
    const narrow = mount(LegBrick, { props: { ...base, w: 90 } })
    expect(narrow.find('[data-testid="brick-route"]').exists()).toBe(false)
    expect(narrow.text()).toContain('L-51217')
  })

  it('badges reflect real flags; spotted/dimmed/selected styling', () => {
    const w = mount(LegBrick, { props: { ...base, load: { ...load, hazmatClass: '8', status: 'tendered', assignment: { ...load.assignment!, status: 'tendered' } }, conflict: true, mismatch: true, hazIssue: true, regExpired: true, risk: 'block', spotted: true } })
    for (const t of ['tag-haz', 'tag-conflict', 'tag-mismatch', 'tag-hazissue', 'tag-reg', 'tag-late', 'tag-tendered', 'tag-spotted'])
      expect(w.find(`[data-testid="${t}"]`).exists(), t).toBe(true)
    expect(w.classes()).toContain('ck-spot')
    expect(w.classes()).toContain('ring-2')
    const dim = mount(LegBrick, { props: { ...base, dimmed: true } })
    expect(dim.classes()).toContain('opacity-40')
    const sel = mount(LegBrick, { props: { ...base, selected: true } })
    expect(sel.classes()).toContain('ring-brand/70')
  })

  // H1 (final fix wave, plan A3): a brokered brick has no Assignment of ours,
  // so startMs/endMs both default to 0 — progressShare('in_progress', 0, 0,
  // now) reads that zero-width window as fully elapsed and returns 1, which
  // would draw a full progress bar for a truck we have no GPS on at all
  // (spec §8.4). No assignment, no progress claim: the bar must render at
  // zero width instead.
  it('a brokered in_progress brick (no assignment of ours) draws no progress — zero-width bar, not full', () => {
    const brokeredRolling: BoardLoad = { ...load, assignment: null, carrierId: 'c1', carrierName: 'Blue Road LLC' }
    const w = mount(LegBrick, { props: { ...base, load: brokeredRolling, brokered: true } })
    expect(w.find('[data-testid="brick-progress"]').attributes('style')).toContain('width: 0px')
  })

  it('emits open on click and hover in/out', async () => {
    const w = mount(LegBrick, { props: base })
    await w.trigger('click')
    expect(w.emitted('open')![0]).toEqual(['l1'])
    await w.trigger('mouseenter')
    expect(w.emitted('hover')![0][0]).toBe('l1')
    await w.trigger('mouseleave')
    expect(w.emitted('hover')![1]).toEqual([null, null])
  })

  it('an unpriced leg shows no margin figure and earns no margin colour', () => {
    const w = mount(LegBrick, { props: { ...base, load: unpriced } })
    // The default-0 margin must not render as a measured, profitable "+$0".
    expect(w.find('[data-testid="brick-margin"]').text()).toBe('— MARGIN')
    expect(w.find('[data-testid="brick-margin"]').classes().join(' ')).not.toContain('emerald')
    expect(w.find('[data-testid="brick-margin"]').classes().join(' ')).not.toContain('red')

    // Margin heat must leave it alone: 0/145000 used to land in the <12% tier
    // and paint an unpriced load red — a false claim that it is losing money.
    const heat = mount(LegBrick, { props: { ...base, load: unpriced, marginView: true } })
    expect(heat.classes().join(' ')).not.toContain('red')
    expect(heat.classes().join(' ')).not.toContain('!bg-emerald-500/15')
    expect(heat.classes().join(' ')).not.toContain('!border-yellow-500')

    // A priced leg still gets its tier (58000/145000 = 40% -> emerald).
    const priced = mount(LegBrick, { props: { ...base, marginView: true } })
    expect(priced.classes()).toContain('!border-emerald-500')
  })

  it('a priced leg that genuinely loses money is red in both the margin row and the heat map', () => {
    const loser: BoardLoad = { ...load, assignment: { ...load.assignment!, marginCents: -4490, economics: { estCostCents: 78490, marginCents: -4490 } } }
    const w = mount(LegBrick, { props: { ...base, load: loser } })
    expect(w.find('[data-testid="brick-margin"]').text()).toBe('-$45 MARGIN')
    expect(w.find('[data-testid="brick-margin"]').classes().join(' ')).toContain('red')
    expect(mount(LegBrick, { props: { ...base, load: loser, marginView: true } }).classes()).toContain('!border-red-500')
  })

  it('border channel: conflict outranks mismatch and marginView, never both', () => {
    const both = mount(LegBrick, { props: { ...base, conflict: true, mismatch: true } })
    expect(both.classes()).toContain('!border-conflict')
    expect(both.classes()).not.toContain('!border-amber-500')

    const withMargin = mount(LegBrick, { props: { ...base, conflict: true, marginView: true } })
    expect(withMargin.classes()).toContain('!border-conflict')
    expect(withMargin.classes()).not.toContain('!border-emerald-500')
    expect(withMargin.classes()).not.toContain('!border-yellow-500')
    expect(withMargin.classes()).not.toContain('!border-red-500')
  })

  // A4 Task 8: the brick's own lock badge — reads the `lockedBy` prop
  // GanttBoard hands down from `useLoadLocksStore().theirs`, the one source
  // of lock truth. Deliberately NOT gated behind the `mid` (110px) tier —
  // A3 Task 6 already paid for that lesson once with the carrier-name badge
  // on an unplaced (96px) brick.
  describe('lock badge (A4 Task 8)', () => {
    it('shows no badge or data-locked attribute when nobody else holds the load', () => {
      const w = mount(LegBrick, { props: base })
      expect(w.attributes('data-locked')).toBeUndefined()
      expect(w.find('[data-testid="tag-locked"]').exists()).toBe(false)
    })

    it('marks the root and names the holder when another dispatcher holds the load', () => {
      const w = mount(LegBrick, { props: { ...base, lockedBy: 'Maria' } })
      expect(w.attributes('data-locked')).toBe('Maria')
      const tag = w.find('[data-testid="tag-locked"]')
      expect(tag.exists()).toBe(true)
      expect(tag.text()).toContain('Maria')
    })

    it('renders the badge at the 96px unplaced width — never gated behind the mid-tier threshold', () => {
      const w = mount(LegBrick, { props: { ...base, w: 96, lockedBy: 'Maria' } })
      expect(w.find('[data-testid="tag-locked"]').exists()).toBe(true)
      expect(w.text()).toContain('Maria')
    })
  })

  // Night Shift on the Board, Task 6: the AGENT pill on the brick. Same
  // "every width" rule the lock badge above already proved out — the pill
  // must show on the 96px unplaced brick, never gated behind the `mid`
  // (110px) tier the carrier-name badge was once wrongly gated behind.
  describe('agent pill (Task 6)', () => {
    it('shows no pill when the load has never been switched on (agentPill off or absent)', () => {
      expect(mount(LegBrick, { props: base }).find('[data-agent-pill]').exists()).toBe(false)
      expect(mount(LegBrick, { props: { ...base, load: { ...load, agentPill: 'off' } } }).find('[data-agent-pill]').exists()).toBe(false)
    })

    it('shows the pill with its state and line when the load is under a policy', () => {
      const watched = { ...load, agentPill: 'watching', agentLine: 'EN ROUTE — 40 mi out, ETA 10:20' }
      const w = mount(LegBrick, { props: { ...base, load: watched } })
      const pill = w.get('[data-agent-pill]')
      expect(pill.text()).toBe('Watching')
      expect(pill.attributes('title')).toBe('EN ROUTE — 40 mi out, ETA 10:20')
    })

    it('renders the pill at the 96px unplaced width — never gated behind the mid-tier threshold', () => {
      const watched = { ...load, agentPill: 'attention' }
      const w = mount(LegBrick, { props: { ...base, w: 96, load: watched } })
      expect(w.find('[data-agent-pill]').exists()).toBe(true)
    })

    it('clicking the pill emits open-agent with the load id, not open', async () => {
      const watched = { ...load, agentPill: 'asked' }
      const w = mount(LegBrick, { props: { ...base, load: watched } })
      await w.get('[data-agent-pill]').trigger('click')
      expect(w.emitted('open-agent')).toEqual([[load.id]])
      expect(w.emitted('open')).toBeUndefined()
    })
  })

  // T3 Break and Rest Planning, Task 9 (Ruling 8): the brick's own break
  // glyph. `needsBreak` does not exist on `BoardLoad` — this reads the
  // `breakPlan` prop GanttBoard hands down from `breakPlanByLoadId`, the
  // SAME store map the live map's marker layer reads, so the board and the
  // map can never disagree about whether a load needs a break.
  describe('break glyph (Task 9, Ruling 8)', () => {
    it('shows a break glyph when the cached plan is known and has entries, with a tooltip giving the break time', () => {
      const w = mount(LegBrick, { props: { ...base, breakPlan: { entries: [breakEntry({ atMs: NOW + 4 * H })], known: true } } })
      const tag = w.find('[data-testid="tag-break"]')
      expect(tag.exists()).toBe(true)
      expect(tag.attributes('title')).toContain('18:32') // NOW (19:32 UTC) + 4h = 23:32 UTC -> 18:32 CDT (tz=America/Chicago)
    })

    it('≈-prefixes the tooltip time when the break point is an estimate, never for a routed one', () => {
      const estimated = mount(LegBrick, { props: { ...base, breakPlan: { entries: [breakEntry({ precision: 'estimated' })], known: true } } })
      expect(estimated.find('[data-testid="tag-break"]').attributes('title')).toContain('≈')

      const routed = mount(LegBrick, { props: { ...base, breakPlan: { entries: [breakEntry({ precision: 'routed' })], known: true } } })
      expect(routed.find('[data-testid="tag-break"]').attributes('title')).not.toContain('≈')
    })

    it('shows no glyph when there is no cached break plan for this load at all', () => {
      const w = mount(LegBrick, { props: base })
      expect(w.find('[data-testid="tag-break"]').exists()).toBe(false)
    })

    it('shows no glyph when known: false — the driver\'s HOS was never imported', () => {
      const w = mount(LegBrick, { props: { ...base, breakPlan: { entries: [breakEntry()], known: false } } })
      expect(w.find('[data-testid="tag-break"]').exists()).toBe(false)
    })

    it('shows no glyph when known: true but the plan needs no break (empty entries)', () => {
      const w = mount(LegBrick, { props: { ...base, breakPlan: { entries: [], known: true } } })
      expect(w.find('[data-testid="tag-break"]').exists()).toBe(false)
    })
  })

  // T4 Fuel and Stops, Task 9: the brick's own fuel-saving chip — reads the
  // `fuelPlan` prop GanttBoard hands down from `fuelPlanByLoadId`, the same
  // one-reader-per-surface shape as the break glyph above. Covers all four
  // rows of the absence table: no cache, known: false, advice: null, and
  // advice present.
  describe('fuel chip (Task 9)', () => {
    it('shows no chip when there is no cached fuel plan for this load at all', () => {
      const w = mount(LegBrick, { props: base })
      expect(w.find('[data-testid="tag-fuel"]').exists()).toBe(false)
    })

    it('shows no chip when known: false — the burn was never evaluated (e.g. no mpg on file)', () => {
      const w = mount(LegBrick, { props: { ...base, fuelPlan: fuelPlan({ known: false }) } })
      expect(w.find('[data-testid="tag-fuel"]').exists()).toBe(false)
    })

    it('shows no chip when advice is null — burn is known but no cheaper stop is worth naming', () => {
      const w = mount(LegBrick, { props: { ...base, fuelPlan: fuelPlan({ advice: null }) } })
      expect(w.find('[data-testid="tag-fuel"]').exists()).toBe(false)
    })

    it('shows the saving chip when advice is present', () => {
      const w = mount(LegBrick, { props: { ...base, fuelPlan: fuelPlan({ advice: fuelAdvice({ savingCents: 4700 }) }) } })
      const chip = w.find('[data-testid="tag-fuel"]')
      expect(chip.exists()).toBe(true)
      expect(chip.text()).toContain('$47')
    })
  })

  // T5 Dwell and Detention, Task 8: the brick's own detention marker — reads
  // the `detention` prop GanttBoard hands down from its own
  // `detentionByLoadId` computed (derived from the store's flat
  // `detention.items`, not a keyed map — see GanttBoard.vue's doc). Same
  // one-reader-per-surface shape as the break glyph and fuel chip above.
  describe('detention marker (Task 8)', () => {
    it('shows no marker when there is no detention row for this load at all', () => {
      const w = mount(LegBrick, { props: base })
      expect(w.find('[data-testid="tag-detention"]').exists()).toBe(false)
    })

    it('shows no marker when a row exists but claim is null — a real dwell we cannot bill is not money owed', () => {
      const w = mount(LegBrick, { props: { ...base, detention: detentionRow({ claim: null, noClaimReason: 'No appointment on file for this stop.' }) } })
      expect(w.find('[data-testid="tag-detention"]').exists()).toBe(false)
    })

    it('shows the marker when claim is present, with a tooltip stating the billable minutes', () => {
      const w = mount(LegBrick, { props: { ...base, detention: detentionRow() } })
      const tag = w.find('[data-testid="tag-detention"]')
      expect(tag.exists()).toBe(true)
      expect(tag.attributes('title')).toContain('45 min billable')
    })
  })
})
