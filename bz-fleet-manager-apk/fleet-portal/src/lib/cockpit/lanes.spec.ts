import { describe, expect, it } from 'vitest'
import type { BoardLoad, BoardTractor, BoardTrailer, LoadboardLane } from '../../stores/loadboard'
import {
  carrierLanesOf,
  committedGrossCents,
  groupLanesByCarrier,
  hosGate,
  laneMoneyInView,
  NO_CARRIER_ID,
  NO_CARRIER_LABEL,
  pillOf,
  plannedDriveTodayMin,
  projectLanes,
  spanOf,
  utilizationToday,
  type CockpitLane,
} from './lanes'

const TZ = 'America/Chicago'
const NOW = Date.UTC(2026, 7, 28, 19, 32) // Fri 14:32 CDT
const iso = (ms: number) => new Date(ms).toISOString()

const jake: LoadboardLane = { id: 'd1', name: 'Jake Morrow', status: 'active', hosKnown: true, driveRemainingMin: 495, currentTractorId: 't1', currentTrailerId: 'r1' }
const chuck: LoadboardLane = { id: 'd7', name: 'Chuck Baker', status: 'active', hosKnown: true, driveRemainingMin: 660 }
const t1: BoardTractor = { id: 't1', unit: '1207', make: 'Peterbilt 579', cab: 'Sleeper', status: 'active', inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null, currentDriverId: 'd1' }
const r1: BoardTrailer = { id: 'r1', unit: 'DV-4450', type: 'DryVan', length: "53'", status: 'active', features: null, inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null, currentDriverId: 'd1' }

const load = (over: Partial<BoardLoad>): BoardLoad => ({
  id: 'l1', reference: 'L-1', status: 'assigned', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 145000,
  stopCount: 2, origin: 'Kansas City', destination: 'Chicago', assignment: null, ...over,
})
// Fri 14:00 CDT -> Sat 09:00 CDT, in progress, 497 loaded mi
const rolling = load({ id: 'l1', status: 'in_progress', assignment: {
  id: 'a1', driverId: 'd1', tractorId: 't1', trailerId: 'r1', status: 'in_progress',
  plannedStart: iso(Date.UTC(2026, 7, 28, 19)), plannedEnd: iso(Date.UTC(2026, 7, 29, 14)), marginCents: 58000, deadheadMi: 0, loadedMi: 497 } })
const later = load({ id: 'l2', reference: 'L-2', origin: 'Indianapolis', destination: 'Columbus', assignment: {
  id: 'a2', driverId: 'd1', tractorId: 't1', trailerId: 'r1', status: 'assigned',
  plannedStart: iso(Date.UTC(2026, 7, 30, 12)), plannedEnd: iso(Date.UTC(2026, 7, 30, 16)), marginCents: 20000, deadheadMi: 198, loadedMi: 180 } })

describe('lane projection', () => {
  it('groups legs by driver / tractor / trailer and sorts them by start', () => {
    const d = projectLanes('driver', [jake, chuck], [t1], [r1], [later, rolling])
    expect(d.map((l) => l.id)).toEqual(['d1', 'd7'])
    expect(d[0].legs.map((l) => l.id)).toEqual(['l1', 'l2'])
    expect(d[1].legs).toEqual([])
    const t = projectLanes('tractor', [jake], [t1], [r1], [rolling])
    expect(t[0]).toMatchObject({ kind: 'tractor', name: '#1207', sub: 'Peterbilt 579 · Sleeper' })
    expect(t[0].legs).toHaveLength(1)
    const r = projectLanes('trailer', [jake], [t1], [r1], [rolling])
    expect(r[0]).toMatchObject({ kind: 'trailer', name: 'DV-4450', sub: "DryVan · 53'" })
  })

  it('derives the status pill', () => {
    const [d1, d7] = projectLanes('driver', [jake, chuck], [t1], [r1], [rolling])
    expect(pillOf(d1, NOW)).toEqual({ t: 'ROLLING', c: 'emerald' })
    expect(pillOf(d7, NOW)).toEqual({ t: 'AVAILABLE', c: 'blue' })
    const soon = projectLanes('driver', [chuck], [], [], [load({ assignment: { ...later.assignment!, driverId: 'd7', plannedStart: iso(NOW + 3_600_000), plannedEnd: iso(NOW + 7_200_000) } })])[0]
    expect(pillOf(soon, NOW)).toEqual({ t: 'LOADING', c: 'blue' })
    expect(pillOf({ ...d7, driver: { ...chuck, status: 'on_break' } }, NOW)).toEqual({ t: 'RESTING', c: 'amber' })
    expect(pillOf({ ...d7, driver: { ...chuck, status: 'off_duty' } }, NOW)).toEqual({ t: 'OFF DUTY', c: 'slate' })
    const [tr] = projectLanes('tractor', [jake], [{ ...t1, status: 'in_shop' }], [], [])
    expect(pillOf(tr, NOW)).toEqual({ t: 'IN SHOP', c: 'purple' })
    const [dropped] = projectLanes('trailer', [], [], [{ ...r1, status: 'idle', currentDriverId: null }], [])
    expect(pillOf(dropped, NOW)).toEqual({ t: 'DROPPED', c: 'slate' })
    const [expired] = projectLanes('trailer', [], [], [{ ...r1, registrationExpiresAt: iso(NOW - 86_400_000) }], [])
    expect(pillOf(expired, NOW)).toEqual({ t: 'REG EXPIRED', c: 'red' })
  })

  it('HOS gate: remaining drive today from miles, capped by the part of the leg inside today', () => {
    const [d1] = projectLanes('driver', [jake], [t1], [r1], [rolling, later])
    // 497 mi / 50 mph = 596 min, 38-of-1140 min elapsed -> ~576 min remaining, but only 09:28 of Friday remain (568 min)
    const planned = plannedDriveTodayMin(d1, NOW, TZ)
    expect(planned).toBeGreaterThan(560)
    expect(planned).toBeLessThan(580)
    expect(hosGate([d1], NOW, TZ)).toEqual({ violations: 1, known: 1, total: 1 }) // 568 > 495 available
    const rested = { ...d1, driver: { ...jake, driveRemainingMin: 660 } }
    expect(hosGate([rested], NOW, TZ)).toEqual({ violations: 0, known: 1, total: 1 })
  })

  it('plannedDriveTodayMin: the in_progress reduction lowers drive time when miles, not the today-window, are the binding constraint', () => {
    // Leg starts 60 min before NOW and ends 240 min after NOW: a 300-min (5h) planned window.
    // 150 mi / 50 mph = 180 min of drive time at full remaining share.
    //   elapsed = 60 of 300 min -> progressShare 0.2 -> remaining share 0.8
    //   in_progress: 180 * 0.8 = 144 min
    //   assigned:    180 * 1   = 180 min
    // today-window cap = min(plannedEnd, next local midnight) - NOW = 240 min (plannedEnd is only
    // 4h out, well inside the ~9.5h left in the Chicago day), comfortably above both 144 and 180 —
    // so the cap never binds and the 144-vs-180 gap is purely the in_progress reduction. A deleted
    // or broken `remaining` calculation would make the in_progress case also read 180.
    const legFixture = (status: string): BoardLoad =>
      load({
        id: 'lp', status, origin: 'Topeka', destination: 'Wichita',
        assignment: {
          id: 'ap', driverId: 'd1', tractorId: 't1', trailerId: 'r1', status,
          plannedStart: iso(NOW - 60 * 60_000), plannedEnd: iso(NOW + 240 * 60_000),
          marginCents: 0, deadheadMi: 0, loadedMi: 150,
        },
      })
    const laneWith = (status: string): CockpitLane => ({
      id: 'd1', kind: 'driver', name: 'Jake Morrow', sub: 'active', driver: jake, legs: [legFixture(status)],
    })
    expect(plannedDriveTodayMin(laneWith('in_progress'), NOW, TZ)).toBe(144)
    expect(plannedDriveTodayMin(laneWith('assigned'), NOW, TZ)).toBe(180)
  })

  it('hosGate skips drivers whose HOS clock is unknown or unreported, and reports the coverage so 0 violations can never read as "protected"', () => {
    // Reuses the 497-mi in-progress leg shape from the HOS gate test above, which plans to ~568 min
    // today — comfortably over any driveRemainingMin, so these two drivers would count as violations
    // if the hosKnown / driveRemainingMin != null guard were missing or broken.
    const unknownHos: LoadboardLane = { id: 'd9', name: 'Unknown Hos', status: 'active', hosKnown: false, driveRemainingMin: 0 }
    const noRemainingReported: LoadboardLane = { id: 'd10', name: 'No Remaining Reported', status: 'active', hosKnown: true, driveRemainingMin: null }
    const legFor = (driverId: string): BoardLoad =>
      load({
        id: 'lu-' + driverId, status: 'in_progress',
        assignment: {
          id: 'au-' + driverId, driverId, tractorId: 't1', trailerId: 'r1', status: 'in_progress',
          plannedStart: iso(Date.UTC(2026, 7, 28, 19)), plannedEnd: iso(Date.UTC(2026, 7, 29, 14)),
          marginCents: 0, deadheadMi: 0, loadedMi: 497,
        },
      })
    const lanes = projectLanes('driver', [unknownHos, noRemainingReported], [], [], [legFor('d9'), legFor('d10')])
    expect(plannedDriveTodayMin(lanes[0], NOW, TZ)).toBeGreaterThan(0) // confirms the fixture would violate if HOS were assumed known
    // Zero violations, but zero coverage too — the tile needs both to stay honest.
    expect(hosGate(lanes, NOW, TZ)).toEqual({ violations: 0, known: 0, total: 2 })
    // A fleet with a partial ELD import reports the partial coverage.
    const mixed = projectLanes('driver', [unknownHos, jake], [t1], [r1], [legFor('d9'), rolling])
    expect(hosGate(mixed, NOW, TZ)).toEqual({ violations: 1, known: 1, total: 2 })
  })
})

describe('carrier grouping (T1 Carrier Layer, Task 7)', () => {
  // Two carriers plus a driver with none — the shape every fixture below reuses.
  const acme: LoadboardLane = { ...jake, carrierId: 'c-acme', carrierName: 'Acme Logistics' }
  const bolt: LoadboardLane = { ...chuck, carrierId: 'c-bolt', carrierName: 'Bolt Freight' }
  const noCarrier: LoadboardLane = { id: 'd9', name: 'Riley Solo', status: 'active', carrierId: null, carrierName: null }

  it('projectLanes("carrier", …) projects the same per-driver lanes as "driver" — carrier only changes the bucketing, not the projection', () => {
    const byDriver = projectLanes('driver', [acme, bolt, noCarrier], [], [], [])
    const byCarrier = projectLanes('carrier', [acme, bolt, noCarrier], [], [], [])
    expect(byCarrier).toEqual(byDriver)
    expect(byCarrier.every((l) => l.kind === 'driver')).toBe(true)
  })

  it('with two carriers, lanes appear under the right headings', () => {
    const lanes = projectLanes('carrier', [acme, bolt], [], [], [])
    const groups = groupLanesByCarrier(lanes)
    expect(groups.map((g) => g.name)).toEqual(['Acme Logistics', 'Bolt Freight']) // alphabetical
    expect(groups.find((g) => g.name === 'Acme Logistics')?.lanes.map((l) => l.id)).toEqual(['d1'])
    expect(groups.find((g) => g.name === 'Bolt Freight')?.lanes.map((l) => l.id)).toEqual(['d7'])
  })

  // THE requirement: a driver with no carrier must never silently vanish from
  // the board. The count assertion is what actually catches a dropped lane —
  // a test that only checks the "No carrier" group exists would still pass if
  // some *other* lane quietly disappeared during grouping.
  it('drivers with carrierId: null appear under "No carrier", and no lane is dropped in the process', () => {
    const lanes = projectLanes('carrier', [acme, bolt, noCarrier], [], [], [])
    const groups = groupLanesByCarrier(lanes)

    const none = groups.find((g) => g.id === NO_CARRIER_ID)
    expect(none?.name).toBe(NO_CARRIER_LABEL)
    expect(none?.lanes.map((l) => l.id)).toEqual(['d9'])

    // The discriminating assertion: total lanes across every group === input lanes.
    const totalGrouped = groups.reduce((sum, g) => sum + g.lanes.length, 0)
    expect(totalGrouped).toBe(lanes.length)
    expect(totalGrouped).toBe(3)
  })

  it('a fleet with only unassigned drivers still gets one "No carrier" group, not zero groups', () => {
    const lanes = projectLanes('carrier', [noCarrier], [], [], [])
    const groups = groupLanesByCarrier(lanes)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ id: NO_CARRIER_ID, name: NO_CARRIER_LABEL })
    expect(groups[0].lanes.map((l) => l.id)).toEqual(['d9'])
  })

  it('the existing driver/tractor/trailer groupings are unaffected by the carrier grouping addition', () => {
    // Same fixtures/assertions as the "groups legs by driver / tractor / trailer"
    // test above — pinned again here so a change to groupLanesByCarrier or the
    // 'carrier' branch in projectLanes cannot quietly regress the other three.
    const d = projectLanes('driver', [jake, chuck], [t1], [r1], [later, rolling])
    expect(d.map((l) => l.id)).toEqual(['d1', 'd7'])
    expect(d[0].legs.map((l) => l.id)).toEqual(['l1', 'l2'])
    const t = projectLanes('tractor', [jake], [t1], [r1], [rolling])
    expect(t[0]).toMatchObject({ kind: 'tractor', name: '#1207', sub: 'Peterbilt 579 · Sleeper' })
    const r = projectLanes('trailer', [jake], [t1], [r1], [rolling])
    expect(r[0]).toMatchObject({ kind: 'trailer', name: 'DV-4450', sub: "DryVan · 53'" })
  })
})

describe('cockpit money + capacity definitions', () => {
  // Both revenue figures are real and different; these tests pin the difference
  // so a future refactor cannot quietly collapse them into one number.
  const ended = load({ id: 'l0', reference: 'L-0', revenueCents: 30000, assignment: {
    id: 'a0', driverId: 'd1', status: 'completed', plannedStart: iso(NOW - 8 * 3_600_000), plannedEnd: iso(NOW - 2 * 3_600_000),
    marginCents: 9000, economics: { estCostCents: 21000, marginCents: 9000 } } })

  it('committedGrossCents counts each live, not-yet-finished leg once; laneMoneyInView counts every leg on the lane', () => {
    const [d1] = projectLanes('driver', [jake], [t1], [r1], [ended, rolling, later])
    // rolling (in_progress, ends tomorrow) + later (assigned, ends Sunday) = 2 x 145000; the completed leg is already earned.
    expect(committedGrossCents([d1], NOW)).toEqual({ cents: 290000, loads: 2 })
    // The lane footer describes the whole row, finished legs included.
    expect(laneMoneyInView(d1).revenueCents).toBe(320000)
  })

  it('laneMoneyInView reports margin only from priced legs, and null when nothing on the lane was priced', () => {
    const [priced] = projectLanes('driver', [jake], [t1], [r1], [ended, rolling])
    // rolling has no `economics` — it must not drag the lane's margin toward zero.
    expect(laneMoneyInView(priced)).toEqual({ revenueCents: 175000, marginCents: 9000, pricedRevenueCents: 30000 })
    const [unpriced] = projectLanes('driver', [jake], [t1], [r1], [rolling, later])
    expect(laneMoneyInView(unpriced).marginCents).toBeNull()
  })

  it('utilizationToday uses the org calendar day, not a rolling now+24h', () => {
    // Sat 08:00 CDT is ~17.5h out — inside a rolling 24h window, but a different
    // org day, so it must not count as utilized today.
    const tomorrow = load({ id: 'lt', reference: 'L-T', assignment: {
      id: 'at', driverId: 'd7', status: 'assigned',
      plannedStart: iso(Date.UTC(2026, 7, 29, 13)), plannedEnd: iso(Date.UTC(2026, 7, 29, 18)), marginCents: 0 } })
    const lanes = projectLanes('driver', [jake, chuck], [t1], [r1], [rolling, tomorrow])
    expect(utilizationToday(lanes, NOW, TZ)).toEqual({ used: 1, total: 2 })
    // Off-duty drivers are not capacity.
    const off = projectLanes('driver', [jake, { ...chuck, status: 'off_duty' }], [t1], [r1], [rolling, tomorrow])
    expect(utilizationToday(off, NOW, TZ)).toEqual({ used: 1, total: 1 })
  })
})

// Closes the contradiction T2 shipped with and T3 deferred: the map's trailer
// layer filters on `activeDriverId` (physically attached) while this pill read
// `currentDriverId` (attached OR default-paired). FB-3310 therefore rendered
// DROPPED on the map and HOOKED on the board at the same moment. Two surfaces,
// one fact, two answers — the exact defect the later slices were built to avoid.
describe('trailer HOOKED pill agrees with the map', () => {
  const base = { id: 'tr1', unit: 'FB-3310', type: 'Flatbed', status: 'idle' } as never

  it('reads DROPPED when the trailer is only default-paired, not attached', () => {
    const lanes = projectLanes('trailer', [], [], [
      { ...(base as object), currentDriverId: 'd1', activeDriverId: null } as never,
    ], [])
    expect(pillOf(lanes[0], Date.now()).t).toBe('DROPPED')
  })

  it('reads HOOKED only when a driver is actually on it', () => {
    const lanes = projectLanes('trailer', [], [], [
      { ...(base as object), currentDriverId: 'd1', activeDriverId: 'd1' } as never,
    ], [])
    expect(pillOf(lanes[0], Date.now()).t).toBe('HOOKED')
  })
})

describe('carrier lanes (plan A3)', () => {
  const covered = load({ id: 'b1', reference: '0563265', status: 'assigned', brokered: true, carrierId: 'c1', carrierName: 'Blue Road LLC', carrierMc: '1000001',
    pickupWindowStart: iso(Date.UTC(2026, 6, 14, 17)), deliveryWindowEnd: iso(Date.UTC(2026, 6, 16, 12)), assignment: null })
  const rolling = load({ id: 'b2', reference: '0563272', status: 'in_progress', brokered: true, carrierId: 'c1', carrierName: 'Blue Road LLC', carrierMc: '1000001',
    pickupWindowStart: iso(Date.UTC(2026, 6, 13, 12)), deliveryWindowEnd: iso(Date.UTC(2026, 6, 14, 12)), assignment: null })
  const unplaced = load({ id: 'b3', reference: '0563280', status: 'assigned', brokered: true, carrierId: 'c2', carrierName: 'Fast Lane Inc', carrierMc: null, attention: ['can\'t read PU appointment: "PU: whenever"'], assignment: null })
  const linedUp = load({ id: 'b4', status: 'open', brokered: true, carrierId: 'c1', carrierName: 'Blue Road LLC', assignment: null })

  it('projects one lane per carrier for covered brokered loads, sorted by start, and leaves the open one to the backlog', () => {
    const lanes = projectLanes('driver', [jake], [t1], [r1], [covered, rolling, unplaced, linedUp])
    const brokered = lanes.filter((l) => l.kind === 'brokered')
    expect(brokered.map((l) => [l.id, l.name, l.sub, l.legs.map((x) => x.id)])).toEqual([
      ['carrier:c1', 'Blue Road LLC', 'MC 1000001', ['b2', 'b1']],
      ['carrier:c2', 'Fast Lane Inc', '', ['b3']],
    ])
    expect(lanes[0].kind).toBe('driver')
    expect(projectLanes('tractor', [jake], [t1], [r1], [covered]).some((l) => l.kind === 'brokered')).toBe(true)
  })

  it('spanOf: planned window for a leg, appointment windows for a brokered brick, null when unplaced', () => {
    expect(spanOf(covered)).toEqual({ startMs: Date.UTC(2026, 6, 14, 17), endMs: Date.UTC(2026, 6, 16, 12) })
    expect(spanOf(unplaced)).toBeNull()
  })

  it('groups a brokered lane under its own carrier', () => {
    const groups = groupLanesByCarrier(projectLanes('carrier', [jake], [t1], [r1], [covered]))
    const c1 = groups.find((g) => g.id === 'c1')
    expect(c1?.name).toBe('Blue Road LLC')
    expect(c1?.lanes.map((l) => l.kind)).toContain('brokered')
  })

  it('pillOf reads BROKERED for a brokered lane — it has no unit/driver to fall back on', () => {
    const brokeredLane = carrierLanesOf([covered, rolling])[0]
    expect(pillOf(brokeredLane, NOW)).toEqual({ t: 'BROKERED', c: 'cyan' })
  })

  it('plannedDriveTodayMin: HOS drive-time does not apply to a brokered lane', () => {
    const brokeredLane = carrierLanesOf([covered, rolling])[0]
    expect(plannedDriveTodayMin(brokeredLane, NOW, TZ)).toBe(0)
  })

  it('hosGate is unchanged by a brokered lane appended alongside driver lanes', () => {
    const driverLanes = projectLanes('driver', [jake], [t1], [r1], [])
    const brokeredLane = carrierLanesOf([covered, rolling])[0]
    expect(hosGate([...driverLanes, brokeredLane], NOW, TZ)).toEqual(hosGate(driverLanes, NOW, TZ))
  })

  it('utilizationToday is unchanged by a brokered lane appended alongside driver lanes', () => {
    const driverLanes = projectLanes('driver', [jake], [t1], [r1], [])
    const brokeredLane = carrierLanesOf([covered, rolling])[0]
    expect(utilizationToday([...driverLanes, brokeredLane], NOW, TZ)).toEqual(utilizationToday(driverLanes, NOW, TZ))
  })

  it('committedGrossCents counts a live brokered leg by revenueCents once, and a delivered one not at all', () => {
    const live = load({ id: 'b5', status: 'in_progress', brokered: true, carrierId: 'c9', carrierName: 'Test Carrier',
      pickupWindowStart: iso(NOW - 3_600_000), deliveryWindowEnd: iso(NOW + 3_600_000), assignment: null, revenueCents: 50000 })
    expect(committedGrossCents([carrierLanesOf([live])[0]], NOW)).toEqual({ cents: 50000, loads: 1 })
    const delivered = load({ id: 'b6', status: 'delivered', brokered: true, carrierId: 'c9', carrierName: 'Test Carrier',
      pickupWindowStart: iso(NOW - 3_600_000), deliveryWindowEnd: iso(NOW + 3_600_000), assignment: null, revenueCents: 50000 })
    expect(committedGrossCents([carrierLanesOf([delivered])[0]], NOW)).toEqual({ cents: 0, loads: 0 })
  })

  it("laneMoneyInView sums a brokered lane's revenue with null margin — a brokered leg never carries a rate snapshot", () => {
    const brokeredLane = carrierLanesOf([covered, rolling])[0]
    expect(laneMoneyInView(brokeredLane)).toEqual({ revenueCents: 290000, marginCents: null, pricedRevenueCents: 0 })
  })

  it('groupLanesByCarrier merges a driver lane and a brokered lane under the same carrier', () => {
    const driverLaneForC1: CockpitLane = {
      id: 'd1', kind: 'driver', name: 'Jake Morrow', sub: 'active',
      driver: { ...jake, carrierId: 'c1', carrierName: 'Blue Road LLC' }, legs: [],
    }
    const brokeredLaneForC1 = carrierLanesOf([covered])[0]
    const groups = groupLanesByCarrier([driverLaneForC1, brokeredLaneForC1])
    const c1 = groups.find((g) => g.id === 'c1')
    expect(c1?.lanes.length).toBe(2)
  })
})
