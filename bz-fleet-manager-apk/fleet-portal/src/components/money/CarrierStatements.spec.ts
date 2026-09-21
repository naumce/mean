import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CarrierStatements from './CarrierStatements.vue'
import type { CarrierStatementsResult } from '../../lib/api'

vi.mock('../../lib/api', () => ({ fetchCarrierStatements: vi.fn() }))
const { fetchCarrierStatements } = await import('../../lib/api')
const mockFetch = vi.mocked(fetchCarrierStatements)

// This panel produces the number a dispatch service SENDS to a client. Each
// test guards a case where merging two states would put a wrong figure on a
// real invoice.

const row = (over: Partial<CarrierStatementsResult['rows'][number]> = {}) =>
  ({
    carrierId: 'c1',
    carrierName: 'Cornhusker Carriers LLC',
    terms: { model: 'percent_linehaul' as const, pctBps: 800, flatCents: null },
    truckWeeks: 3,
    statement: {
      lines: [],
      unbillable: [],
      billedLoadCount: 6,
      basisCents: 409_000,
      loadCommissionCents: 32_720,
      truckWeekCents: 0,
      totalCents: 32_720,
      complete: true,
    },
    ...over,
  }) as CarrierStatementsResult['rows'][number]

const result = (over: Partial<CarrierStatementsResult> = {}): CarrierStatementsResult => ({
  rows: [row()],
  ownFleet: { loadCount: 0, linehaulCents: 0 },
  fromMs: 0,
  toMs: 0,
  ...over,
})

const mountIt = async () => {
  const w = mount(CarrierStatements, { props: { from: '', to: '' } })
  await flushPromises()
  return w
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('CarrierStatements', () => {
  it('loads on mount with a default period rather than waiting for a date picker', async () => {
    // MoneyView's pickers start empty. A panel that renders blank until someone
    // chooses a range looks broken on the screen a dispatcher opens to bill.
    mockFetch.mockResolvedValue(result())
    await mountIt()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [from, to] = mockFetch.mock.calls[0]
    expect(Date.parse(from)).toBeLessThan(Date.parse(to))
  })

  it('shows the amount due and the basis it was taken on', async () => {
    mockFetch.mockResolvedValue(result())
    const w = await mountIt()
    expect(w.find('[data-testid="statements-total"]').text()).toContain('327')
    expect(w.text()).toContain('8.00% of linehaul')
  })

  it('renders a carrier with NO agreed terms as "not billable", never as $0', async () => {
    // Billing $0 for "we never agreed a rate" invoices a number the client
    // never signed. It is also not the same as owing nothing.
    mockFetch.mockResolvedValue(
      result({
        rows: [
          row({
            terms: { model: null, pctBps: null, flatCents: null },
            statement: { ...row().statement, billedLoadCount: 0, basisCents: 0, totalCents: 0, complete: true },
          }),
        ],
      }),
    )
    const w = await mountIt()
    expect(w.find('[data-testid="statement-no-terms"]').exists()).toBe(true)
    expect(w.find('[data-testid="statement-no-terms"]').text()).toBe('not billable')
  })

  it('flags an incomplete statement and prints the reasons verbatim', async () => {
    mockFetch.mockResolvedValue(
      result({
        rows: [
          row({
            statement: {
              ...row().statement,
              unbillable: [{ loadId: 'l9', reference: 'W-09', reason: 'Load has no rate on file' }],
              complete: false,
            },
          }),
        ],
      }),
    )
    const w = await mountIt()
    expect(w.find('[data-testid="statement-incomplete"]').exists()).toBe(true)
    expect(w.find('[data-testid="statement-unbillable"]').text()).toContain('Load has no rate on file')
  })

  it('reports own-fleet work separately and never inside the invoiceable total', async () => {
    // There is nobody to invoice for the org's own trucks. Folding that revenue
    // into the total would bill a carrier for a load they never ran.
    mockFetch.mockResolvedValue(result({ ownFleet: { loadCount: 3, linehaulCents: 250_000 } }))
    const w = await mountIt()
    expect(w.find('[data-testid="statements-own-fleet"]').text()).toContain('no carrier to invoice')
    expect(w.find('[data-testid="statements-total"]').text()).toContain('327')
  })

  it('an outage shows an error, NOT an empty statement reading as nothing owed', async () => {
    mockFetch.mockRejectedValue(new Error('network'))
    const w = await mountIt()
    expect(w.find('[data-testid="statements-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="statements-total"]').exists()).toBe(false)
  })

  it('keeps the last figures when a REFRESH fails, labelled as stale', async () => {
    mockFetch.mockResolvedValueOnce(result())
    const w = await mountIt()
    mockFetch.mockRejectedValueOnce(new Error('network'))
    await w.setProps({ from: '2026-08-01', to: '2026-08-31' })
    await flushPromises()
    expect(w.find('[data-testid="statements-stale"]').exists()).toBe(true)
    expect(w.find('[data-testid="statements-total"]').text()).toContain('327')
  })
})
