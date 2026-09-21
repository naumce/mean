import { describe, expect, it } from "vitest";
import {
  buildCarrierStatement,
  commissionForLoad,
  type BillableLoad,
  type CommissionTerms,
  weeksInSpan,
} from "../src/domain/billing/commission.js";

// This module decides what a dispatch service INVOICES a client carrier. Every
// test below guards a case where returning a number instead of a refusal would
// put a wrong figure on a real bill.

const load = (over: Partial<BillableLoad> = {}): BillableLoad => ({
  loadId: "l1",
  reference: "W-01",
  linehaulCents: 100_000, // $1,000
  fscCents: 15_000, // $150 fuel surcharge
  completedAtMs: Date.UTC(2026, 8, 1),
  ...over,
});

const pct = (bps: number | null = 800): CommissionTerms => ({
  model: "percent_linehaul",
  pctBps: bps,
  flatCents: null,
});

describe("commissionForLoad", () => {
  it("takes its percentage of LINEHAUL, never of the fuel surcharge", () => {
    // The defect this prevents: 8% of (linehaul + FSC) = $92 instead of $80.
    // FSC is a pass-through covering the carrier's diesel; a dispatcher taking
    // a cut of it is taking a cut of their client's fuel money, on every load.
    const r = commissionForLoad(load(), pct(800));
    expect("line" in r).toBe(true);
    if (!("line" in r)) return;
    expect(r.line.commissionCents).toBe(8_000); // 8% of $1,000, not of $1,150
    expect(r.line.basisCents).toBe(100_000);
  });

  it("refuses when no terms are agreed — NOT a zero-dollar line", () => {
    // Billing $0 for "we never agreed a rate" is how a dispatch service bills a
    // number its client never signed.
    const r = commissionForLoad(load(), { model: null, pctBps: null, flatCents: null });
    expect("unbillable" in r).toBe(true);
    if (!("unbillable" in r)) return;
    expect(r.unbillable.reason).toMatch(/no commission terms/i);
  });

  it("refuses a percentage of an unpriced load", () => {
    // A percentage of an unknown number is a made-up number.
    const r = commissionForLoad(load({ linehaulCents: null }), pct(800));
    expect("unbillable" in r).toBe(true);
    if (!("unbillable" in r)) return;
    expect(r.unbillable.reason).toMatch(/no rate on file/i);
  });

  it("refuses when the model is set but its rate is not", () => {
    expect("unbillable" in commissionForLoad(load(), pct(null))).toBe(true);
    expect(
      "unbillable" in commissionForLoad(load(), { model: "per_load", pctBps: null, flatCents: null }),
    ).toBe(true);
  });

  it("charges a flat per-load fee regardless of the load's value", () => {
    const r = commissionForLoad(load(), { model: "per_load", pctBps: null, flatCents: 7_500 });
    expect("line" in r).toBe(true);
    if (!("line" in r)) return;
    expect(r.line.commissionCents).toBe(7_500);
    // Nothing was taken a percentage OF, and the statement should not imply
    // otherwise by showing a basis.
    expect(r.line.basisCents).toBe(0);
  });

  it("charges nothing per load under a per-truck-week model, with a reason", () => {
    const r = commissionForLoad(load(), { model: "per_truck_week", pctBps: null, flatCents: 20_000 });
    expect("unbillable" in r).toBe(true);
    if (!("unbillable" in r)) return;
    expect(r.unbillable.reason).toMatch(/per truck per week/i);
  });

  it("rounds to the cent at the line, not to the fraction", () => {
    // 7.5% of $333.33 = $24.99975. One rounding, at the line.
    const r = commissionForLoad(load({ linehaulCents: 33_333 }), pct(750));
    if (!("line" in r)) throw new Error("expected a line");
    expect(r.line.commissionCents).toBe(2_500);
    expect(Number.isInteger(r.line.commissionCents)).toBe(true);
  });
});

describe("buildCarrierStatement", () => {
  const three = [load({ loadId: "a" }), load({ loadId: "b" }), load({ loadId: "c" })];

  it("totals the lines and reports the basis they were taken on", () => {
    const s = buildCarrierStatement(three, pct(800));
    expect(s.billedLoadCount).toBe(3);
    expect(s.basisCents).toBe(300_000);
    expect(s.loadCommissionCents).toBe(24_000);
    expect(s.totalCents).toBe(24_000);
    expect(s.complete).toBe(true);
  });

  it("marks the statement INCOMPLETE when any load could not be billed", () => {
    // The number at the bottom is no longer the whole picture, and the
    // statement has to say so — a total that silently omits three loads is
    // worse than one that admits it.
    const s = buildCarrierStatement([...three, load({ loadId: "d", linehaulCents: null })], pct(800));
    expect(s.billedLoadCount).toBe(3);
    expect(s.unbillable).toHaveLength(1);
    expect(s.complete).toBe(false);
    // The billed total is still correct for what it covers.
    expect(s.loadCommissionCents).toBe(24_000);
  });

  it("bills per-truck-week off the truck count, not the loads", () => {
    const s = buildCarrierStatement(three, { model: "per_truck_week", pctBps: null, flatCents: 20_000 }, 6);
    expect(s.loadCommissionCents).toBe(0);
    expect(s.truckWeekCents).toBe(120_000); // 6 truck-weeks x $200
    expect(s.totalCents).toBe(120_000);
    // Every load reads "not charged per load" by design, so completeness asks a
    // different question: is the fee itself configured?
    expect(s.complete).toBe(true);
  });

  it("is incomplete under per-truck-week when the fee is not set", () => {
    const s = buildCarrierStatement(three, { model: "per_truck_week", pctBps: null, flatCents: null }, 6);
    expect(s.truckWeekCents).toBe(0);
    expect(s.complete).toBe(false);
  });

  it("an empty period is a complete statement for zero, not an error", () => {
    const s = buildCarrierStatement([], pct(800));
    expect(s.totalCents).toBe(0);
    expect(s.complete).toBe(true);
  });

  it("never lets the total drift from the sum of its own lines", () => {
    // A statement whose total disagrees with its lines is the one thing a
    // client will always catch.
    const mixed = [
      load({ loadId: "a", linehaulCents: 33_333 }),
      load({ loadId: "b", linehaulCents: 71_777 }),
      load({ loadId: "c", linehaulCents: 12_345 }),
    ];
    const s = buildCarrierStatement(mixed, pct(725));
    expect(s.loadCommissionCents).toBe(s.lines.reduce((a, l) => a + l.commissionCents, 0));
    expect(s.totalCents).toBe(s.loadCommissionCents + s.truckWeekCents);
  });
});

// The truck-week span is billing arithmetic, so its boundary is tested directly
// rather than trusted. Found live: the Money page showed $777 where an API call
// minutes earlier had said $1,227, because "the last 7 days" built from two
// Date.now() calls is 7 days + a few milliseconds, and ceiling the raw span
// charged a second week. Two trucks at $225 = a $450 invoice error from jitter.
describe("weeksInSpan", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const T0 = Date.UTC(2026, 8, 1);
  // The REAL function, not a restatement of it. buildStatements calls this same
  // export, so a change to the rule cannot pass here and fail on an invoice.
  const weeksFor = (ms: number): number => weeksInSpan(T0, T0 + ms);

  it("charges ONE week for a seven-day range, jitter or not", () => {
    expect(weeksFor(7 * DAY)).toBe(1);
    expect(weeksFor(7 * DAY + 1)).toBe(1);
    expect(weeksFor(7 * DAY + 999)).toBe(1);
  });

  it("still rounds a partial week UP — three days dispatched owes the week", () => {
    expect(weeksFor(3 * DAY)).toBe(1);
    expect(weeksFor(8 * DAY)).toBe(2);
    expect(weeksFor(13 * DAY)).toBe(2);
    expect(weeksFor(14 * DAY)).toBe(2);
    expect(weeksFor(15 * DAY)).toBe(3);
  });

  it("agrees with the DATE PICKER convention — inclusive end-of-day", () => {
    // MoneyView sends `<date>T00:00:00.000Z` to `<date>T23:59:59.999Z`, so N
    // picked calendar days arrive as N-1+0.99999 days. Flooring billed eight
    // picked days as ONE week while the default period billed eight days as
    // two — the same range meaning two different invoices depending on which
    // control produced it.
    const day = (d: number) => Date.UTC(2026, 7, d);
    const picked = (a: number, b: number) => weeksInSpan(day(a), day(b) + 86_399_999);
    expect(picked(1, 1)).toBe(1); // one day
    expect(picked(1, 7)).toBe(1); // seven calendar days -> one week
    expect(picked(1, 8)).toBe(2); // eight -> two, same as the default period
    expect(picked(1, 14)).toBe(2);
    expect(picked(1, 15)).toBe(3);
    // Both conventions must land on the same answer for the same intent.
    expect(picked(1, 7)).toBe(weeksFor(7 * DAY));
    expect(picked(1, 8)).toBe(weeksFor(8 * DAY));
  });

  it("never charges zero weeks for a same-day range", () => {
    expect(weeksFor(0)).toBe(1);
    expect(weeksFor(60_000)).toBe(1);
  });
});
