import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { BreakPlanEntry, FuelPlanBody } from '../../lib/api'
import PlanVerdictModal, { type PlanVerdict, type PlanVerdictConflict } from './PlanVerdictModal.vue'

const plan = { proposedStart: 0, proposedEnd: 1, deadheadMi: 42, loadedMi: 166, driveMin: 250, onDutyMin: 370, needsBreak: false }
const economics = {
  revenueCents: 34000, totalMi: 208, deadheadMi: 42, loadedMi: 166,
  estCostCents: 24100, marginCents: 9900, marginPct: 0.29,
  ratePerLoadedMiCents: 205, ratePerTotalMiCents: 163,
}

function verdict(over: Partial<PlanVerdict> = {}): PlanVerdict {
  return { feasible: false, conflicts: [], plan, economics, ...over }
}

// T3 Break and Rest Planning, Task 9 fixtures. `atMs` is a clean UTC instant
// and every break-row test below mounts with `tz: 'UTC'` so the rendered wall
// clock is deterministic without needing DST-aware offset math.
function breakEntry(over: Partial<BreakPlanEntry> = {}): BreakPlanEntry {
  return {
    atMs: Date.UTC(2026, 7, 28, 14, 5),
    at: { lat: 38.9717, lng: -95.2353 },
    precision: 'estimated',
    hasCoverage: true,
    options: [],
    ...over,
  }
}

// T4 Fuel and Stops, Task 8 fixture. `known: true` with `advice: null` and
// `ifta.complete: true` is the "fully attributed, nothing to buy here" happy
// path; individual tests override the piece under test.
function fuelPlan(over: Partial<FuelPlanBody> = {}): FuelPlanBody {
  return {
    burn: { deadheadGal: 6, loadedGal: 24, totalGal: 30, mpgUsed: 6.5 },
    advice: null,
    ifta: { byState: [{ state: 'KS', gallons: 30 }], unattributedGal: 0, complete: true },
    known: true,
    ...over,
  }
}

describe('PlanVerdictModal', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders nothing when there is no verdict', () => {
    const w = mount(PlanVerdictModal, { props: { verdict: null } })
    expect(w.find('[data-testid="verdict-modal"]').exists()).toBe(false)
  })

  it('renders block and warn rows with their detail text', () => {
    const conflicts: PlanVerdictConflict[] = [
      { kind: 'hos', severity: 'block', detail: 'needs 4h 35m drive; 3h 42m remaining' },
      { kind: 'late_delivery', severity: 'warn', detail: 'tight arrival at stop 2' },
    ]
    const w = mount(PlanVerdictModal, { props: { verdict: verdict({ conflicts }) } })
    const block = w.find('[data-severity="block"]')
    const warn = w.find('[data-severity="warn"]')
    expect(block.text()).toContain('✗')
    expect(block.text()).toContain('needs 4h 35m drive; 3h 42m remaining')
    expect(warn.text()).toContain('⚠')
    expect(warn.text()).toContain('tight arrival at stop 2')
  })

  it('offers Force for an ordinary (non-overlap) blocker', async () => {
    const w = mount(PlanVerdictModal, {
      props: { verdict: verdict({ conflicts: [{ kind: 'hos', severity: 'block', detail: 'not enough drive time' }] }) },
    })
    expect(w.find('[data-testid="verdict-force"]').exists()).toBe(true)
    await w.find('[data-testid="verdict-force"]').trigger('click')
    expect(w.emitted('force')).toHaveLength(1)
    expect(w.emitted('cancel')).toBeUndefined()
  })

  it('Force is absent when there are no blockers', () => {
    const w = mount(PlanVerdictModal, { props: { verdict: verdict({ feasible: true, conflicts: [] }) } })
    expect(w.find('[data-testid="verdict-force"]').exists()).toBe(false)
    expect(w.find('[data-testid="verdict-clean"]').text()).toContain('No conflicts')
  })

  it('Force is absent when a warning exists but nothing blocks', () => {
    const w = mount(PlanVerdictModal, {
      props: { verdict: verdict({ feasible: true, conflicts: [{ kind: 'late_delivery', severity: 'warn', detail: 'tight arrival' }] }) },
    })
    expect(w.find('[data-testid="verdict-force"]').exists()).toBe(false)
  })

  it('Force is absent when any blocker is an overlap, even alongside other blockers, and states the reason', () => {
    const w = mount(PlanVerdictModal, {
      props: {
        verdict: verdict({
          conflicts: [
            { kind: 'hos', severity: 'block', detail: 'not enough drive time' },
            { kind: 'overlap', severity: 'block', detail: 'driver already committed to an overlapping trip' },
          ],
        }),
      },
    })
    expect(w.find('[data-testid="verdict-force"]').exists()).toBe(false)
    const reason = w.find('[data-testid="verdict-overlap-reason"]')
    expect(reason.exists()).toBe(true)
    expect(reason.text()).toContain('cannot be forced')
  })

  it('does not show the overlap reason when there is no overlap blocker', () => {
    const w = mount(PlanVerdictModal, {
      props: { verdict: verdict({ conflicts: [{ kind: 'hos', severity: 'block', detail: 'not enough drive time' }] }) },
    })
    expect(w.find('[data-testid="verdict-overlap-reason"]').exists()).toBe(false)
  })

  it('renders the economics figures when the load was priced', () => {
    const w = mount(PlanVerdictModal, { props: { verdict: verdict() } })
    const econText = w.find('[data-testid="verdict-economics"]').text()
    expect(econText).toContain('$241')
    expect(econText).toContain('$99')
    expect(econText).toContain('29%')
    expect(econText).toContain('166 mi')
    expect(econText).toContain('42 mi')
  })

  it('renders "—" and never "$0" when economics is null (unpriced load)', () => {
    const w = mount(PlanVerdictModal, {
      props: { verdict: verdict({ conflicts: [{ kind: 'hos', severity: 'block', detail: 'not enough drive time' }], economics: null }) },
    })
    const econText = w.find('[data-testid="verdict-economics"]').text()
    expect(econText).toContain('—')
    expect(econText).not.toContain('$0')
    expect(w.find('[data-testid="verdict-unpriced"]').exists()).toBe(true)
  })

  it('Cancel closes without committing', async () => {
    const w = mount(PlanVerdictModal, {
      props: { verdict: verdict({ conflicts: [{ kind: 'hos', severity: 'block', detail: 'not enough drive time' }] }) },
    })
    await w.find('[data-testid="verdict-cancel"]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('force')).toBeUndefined()
  })

  it('the close (✕) button also cancels without committing', async () => {
    const w = mount(PlanVerdictModal, {
      props: { verdict: verdict({ conflicts: [{ kind: 'hos', severity: 'block', detail: 'not enough drive time' }] }) },
    })
    await w.find('[data-testid="verdict-close"]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('force')).toBeUndefined()
  })

  it('Escape emits cancel and never force', async () => {
    const w = mount(PlanVerdictModal, {
      attachTo: document.body,
      props: { verdict: verdict({ conflicts: [{ kind: 'hos', severity: 'block', detail: 'not enough drive time' }] }) },
    })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await w.vm.$nextTick()
    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('force')).toBeUndefined()
  })

  it('a non-Escape key does nothing', async () => {
    const w = mount(PlanVerdictModal, {
      attachTo: document.body,
      props: { verdict: verdict({ conflicts: [{ kind: 'hos', severity: 'block', detail: 'not enough drive time' }] }) },
    })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await w.vm.$nextTick()
    expect(w.emitted('cancel')).toBeUndefined()
    expect(w.emitted('force')).toBeUndefined()
  })

  it('Escape does nothing once unmounted (listener cleaned up)', async () => {
    const w = mount(PlanVerdictModal, {
      attachTo: document.body,
      props: { verdict: verdict({ conflicts: [{ kind: 'hos', severity: 'block', detail: 'not enough drive time' }] }) },
    })
    w.unmount()
    // Must not throw and must not leak a handler that outlives the component.
    expect(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))).not.toThrow()
  })

  it('clicking the backdrop cancels without committing', async () => {
    const w = mount(PlanVerdictModal, {
      props: { verdict: verdict({ conflicts: [{ kind: 'hos', severity: 'block', detail: 'not enough drive time' }] }) },
    })
    await w.find('[data-testid="verdict-modal"]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('force')).toBeUndefined()
  })

  it('clicking inside the dialog panel does not cancel', async () => {
    const w = mount(PlanVerdictModal, {
      props: { verdict: verdict({ conflicts: [{ kind: 'hos', severity: 'block', detail: 'not enough drive time' }] }) },
    })
    await w.find('[role="dialog"]').trigger('click')
    expect(w.emitted('cancel')).toBeUndefined()
  })

  // T3 Break and Rest Planning, Task 9: the break row — the point of this
  // task. Consumes `breakPlan`/`breakPlanKnown` (Task 7 + Ruling 7), never
  // `plan.needsBreak` (that would be a second source of truth for the same
  // fact, which Ruling 8 forbids).
  describe('break plan (Task 9)', () => {
    it('renders a break row stating the time and place, ≈-prefixed when estimated', () => {
      const w = mount(PlanVerdictModal, {
        props: { verdict: verdict({ breakPlanKnown: true, breakPlan: [breakEntry({ precision: 'estimated' })] }), tz: 'UTC' },
      })
      const row = w.find('[data-testid="verdict-break-row"]')
      expect(row.exists()).toBe(true)
      expect(row.text()).toContain('Aug 28 @ 14:05')
      expect(row.text()).toContain('≈38.9717, -95.2353')
    })

    it('a routed break point is never ≈-prefixed — only an estimated one is', () => {
      const w = mount(PlanVerdictModal, {
        props: { verdict: verdict({ breakPlanKnown: true, breakPlan: [breakEntry({ precision: 'routed' })] }), tz: 'UTC' },
      })
      const row = w.find('[data-testid="verdict-break-row"]')
      expect(row.text()).toContain('38.9717, -95.2353')
      expect(row.text()).not.toContain('≈')
    })

    it('renders one row per break point for a plan needing more than one', () => {
      const w = mount(PlanVerdictModal, {
        props: {
          verdict: verdict({
            breakPlanKnown: true,
            breakPlan: [breakEntry({ atMs: Date.UTC(2026, 7, 28, 14, 5) }), breakEntry({ atMs: Date.UTC(2026, 7, 28, 22, 30) })],
          }),
          tz: 'UTC',
        },
      })
      expect(w.findAll('[data-testid="verdict-break-row"]')).toHaveLength(2)
    })

    it('a no_rest conflict renders with its detail verbatim — the modal never re-words a server reason', () => {
      const detail = 'no reachable rest stop within 35 mi of the mandatory break point near Salina, KS'
      const w = mount(PlanVerdictModal, {
        props: { verdict: verdict({ conflicts: [{ kind: 'no_rest', severity: 'block', detail }] }) },
      })
      expect(w.find('[data-kind="no_rest"]').text()).toContain(detail)
    })

    it('hasCoverage: false renders "rest options unknown" with no warning styling', () => {
      const w = mount(PlanVerdictModal, {
        props: { verdict: verdict({ breakPlanKnown: true, breakPlan: [breakEntry({ hasCoverage: false })] }) },
      })
      const coverage = w.find('[data-testid="verdict-break-coverage"]')
      expect(coverage.text()).toBe('rest options unknown')
      expect(coverage.text()).not.toContain('no rest options')
      const classes = coverage.classes().join(' ')
      expect(classes).not.toContain('amber')
      expect(classes).not.toContain('conflict')
      expect(classes).not.toContain('red')
    })

    it('hasCoverage: true with no options in range reads "no rest option within 35 mi", never "unknown"', () => {
      const w = mount(PlanVerdictModal, {
        props: { verdict: verdict({ breakPlanKnown: true, breakPlan: [breakEntry({ hasCoverage: true, options: [] })] }) },
      })
      expect(w.find('[data-testid="verdict-break-coverage"]').text()).toBe('no rest option within 35 mi')
    })

    it('breakPlanKnown: false renders "break schedule unknown — HOS not imported" with no warning styling', () => {
      const w = mount(PlanVerdictModal, {
        props: { verdict: verdict({ breakPlanKnown: false, breakPlan: [] }) },
      })
      const unknown = w.find('[data-testid="verdict-break-unknown"]')
      expect(unknown.text()).toBe('break schedule unknown — HOS not imported')
      const classes = unknown.classes().join(' ')
      expect(classes).not.toContain('amber')
      expect(classes).not.toContain('conflict')
      expect(classes).not.toContain('red')
      expect(w.find('[data-testid="verdict-break-list"]').exists()).toBe(false)
      expect(w.find('[data-testid="verdict-break-none"]').exists()).toBe(false)
    })

    it('breakPlanKnown: true with an empty plan reads "no break required"', () => {
      const w = mount(PlanVerdictModal, {
        props: { verdict: verdict({ breakPlanKnown: true, breakPlan: [] }) },
      })
      expect(w.find('[data-testid="verdict-break-none"]').text()).toBe('no break required')
      expect(w.find('[data-testid="verdict-break-unknown"]').exists()).toBe(false)
      expect(w.find('[data-testid="verdict-break-list"]').exists()).toBe(false)
    })

    it('a verdict body with breakPlan absent entirely renders as unknown and does not crash — an older server response degrades, not explodes', () => {
      // The default `verdict()` fixture carries neither `breakPlan` nor
      // `breakPlanKnown` at all — the exact pre-T3 / CockpitVerdict-
      // degradation shape this test exists to pin.
      expect(() => mount(PlanVerdictModal, { props: { verdict: verdict() } })).not.toThrow()
      const w = mount(PlanVerdictModal, { props: { verdict: verdict() } })
      expect(w.find('[data-testid="verdict-break-unknown"]').text()).toBe('break schedule unknown — HOS not imported')
    })
  })

  // T4 Fuel and Stops, Task 8: diesel burn, buy advice, and IFTA attribution
  // in the verdict. Three states mirroring T3's break row, plus the
  // never-hide-the-unattributed-remainder rule (Global Constraint 6).
  describe('fuel plan (Task 8)', () => {
    it('known: false renders "fuel estimate unavailable" with no gallons and no cost', () => {
      const w = mount(PlanVerdictModal, {
        props: { verdict: verdict({ fuel: fuelPlan({ known: false }) }) },
      })
      const unknown = w.find('[data-testid="verdict-fuel-unknown"]')
      expect(unknown.text()).toBe('fuel estimate unavailable')
      expect(w.find('[data-testid="verdict-fuel-burn"]').exists()).toBe(false)
      expect(w.find('[data-testid="verdict-fuel-advice"]').exists()).toBe(false)
      expect(w.find('[data-testid="verdict-fuel-ifta"]').exists()).toBe(false)
    })

    it('known: true, advice: null renders gallons burned only — no saving claimed', () => {
      const w = mount(PlanVerdictModal, {
        props: { verdict: verdict({ fuel: fuelPlan({ advice: null }) }) },
      })
      const burn = w.find('[data-testid="verdict-fuel-burn"]')
      expect(burn.exists()).toBe(true)
      expect(burn.text()).toContain('30 gal')
      expect(burn.text()).toContain('24 gal')
      expect(burn.text()).toContain('6 gal')
      expect(w.find('[data-testid="verdict-fuel-advice"]').exists()).toBe(false)
      const fuelPanel = w.find('[data-testid="verdict-fuel"]')
      expect(fuelPanel.text()).not.toContain('saves')
      expect(fuelPanel.text()).not.toContain('$')
    })

    it('known: true, advice present renders the buy recommendation and the saving', () => {
      const advice = {
        atSequence: 2,
        atLabel: 'Kansas City, MO',
        state: 'MO',
        gallons: 118,
        centsPerGal: 389,
        vsLabel: 'Denver, CO',
        vsCentsPerGal: 436,
        savingCents: 4700,
      }
      const w = mount(PlanVerdictModal, {
        props: { verdict: verdict({ fuel: fuelPlan({ advice }) }) },
      })
      const adviceRow = w.find('[data-testid="verdict-fuel-advice"]')
      expect(adviceRow.exists()).toBe(true)
      expect(adviceRow.text()).toContain('118 gal')
      expect(adviceRow.text()).toContain('Kansas City, MO')
      expect(adviceRow.text()).toContain('$47')
      expect(adviceRow.text()).toContain('Denver, CO')
    })

    it('renders per-state IFTA gallons when known', () => {
      const w = mount(PlanVerdictModal, {
        props: {
          verdict: verdict({
            fuel: fuelPlan({ ifta: { byState: [{ state: 'KS', gallons: 18 }, { state: 'MO', gallons: 12 }], unattributedGal: 0, complete: true } }),
          }),
        },
      })
      const rows = w.findAll('[data-testid="verdict-fuel-ifta-row"]')
      expect(rows).toHaveLength(2)
      expect(rows[0].text()).toContain('KS')
      expect(rows[0].text()).toContain('18 gal')
      expect(rows[1].text()).toContain('MO')
      expect(rows[1].text()).toContain('12 gal')
    })

    it('ifta.complete: false renders the explicit unattributed-gallons line', () => {
      const w = mount(PlanVerdictModal, {
        props: {
          verdict: verdict({
            fuel: fuelPlan({ ifta: { byState: [{ state: 'KS', gallons: 18 }], unattributedGal: 12, complete: false } }),
          }),
        },
      })
      const line = w.find('[data-testid="verdict-fuel-unattributed"]')
      expect(line.exists()).toBe(true)
      expect(line.text()).toContain('12 gal')
      expect(line.text()).toContain('unattributed')
    })

    it('ifta.complete: true never renders the unattributed line', () => {
      const w = mount(PlanVerdictModal, {
        props: { verdict: verdict({ fuel: fuelPlan({ ifta: { byState: [{ state: 'KS', gallons: 30 }], unattributedGal: 0, complete: true } }) }) },
      })
      expect(w.find('[data-testid="verdict-fuel-unattributed"]').exists()).toBe(false)
    })

    it('a verdict body with fuel absent entirely renders as unavailable and does not crash — an older server response degrades, not explodes', () => {
      expect(() => mount(PlanVerdictModal, { props: { verdict: verdict() } })).not.toThrow()
      const w = mount(PlanVerdictModal, { props: { verdict: verdict() } })
      expect(w.find('[data-testid="verdict-fuel-unknown"]').text()).toBe('fuel estimate unavailable')
    })
  })
})
