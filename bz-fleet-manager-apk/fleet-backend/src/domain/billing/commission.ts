// What the dispatch service bills a carrier for the work it dispatched.
//
// This is the OTHER side of the ledger from driver settlements: those compute
// what a carrier pays its driver, this computes what the dispatch service
// charges the carrier. Until now the product could dispatch trucks it does not
// own and never invoice anyone for doing it.
//
// Pure: no DB, no Date, no I/O. Money is integer cents throughout.
//
// THE RULE THAT MATTERS: this function returns null far more readily than it
// returns zero. An uninvoiceable load and a load worth nothing are different
// facts, and a statement that prints $0 for "we never agreed terms" is how a
// dispatch service bills a number its client never signed and loses the
// account. Every null carries a reason the statement prints verbatim.

export type CommissionModel = "percent_linehaul" | "per_load" | "per_truck_week";

export interface CommissionTerms {
  model: CommissionModel | null;
  /** basis points; 800 = 8.00%. Required by percent_linehaul. */
  pctBps: number | null;
  /** cents. Required by per_load and per_truck_week. */
  flatCents: number | null;
}

/** Only what a commission needs off a load. `linehaulCents`/`fscCents` are null
 *  when the load was never priced — no Rate row — which is a real state. */
export interface BillableLoad {
  loadId: string;
  reference: string | null;
  linehaulCents: number | null;
  fscCents: number | null;
  completedAtMs: number;
}

export interface CommissionLine {
  loadId: string;
  reference: string | null;
  /** the amount the commission was computed ON, for the statement to show */
  basisCents: number;
  commissionCents: number;
}

export interface UnbillableLoad {
  loadId: string;
  reference: string | null;
  /** printed verbatim on the statement — a blank line invites a guess */
  reason: string;
}

/**
 * Commission on ONE load. Null when it cannot honestly be billed, with the
 * reason — never a zero-dollar line.
 *
 * Percent is charged on LINEHAUL ONLY, never on the fuel surcharge. That is the
 * industry norm and it is not a detail: FSC is a pass-through to cover the
 * carrier's diesel, and a dispatcher taking a cut of it is taking a cut of the
 * carrier's fuel money. Getting this wrong quietly overcharges every load.
 */
export function commissionForLoad(
  load: BillableLoad,
  terms: CommissionTerms,
): { line: CommissionLine } | { unbillable: UnbillableLoad } {
  const id = { loadId: load.loadId, reference: load.reference };

  if (!terms.model) {
    return { unbillable: { ...id, reason: "No commission terms agreed with this carrier" } };
  }

  if (terms.model === "per_load") {
    if (terms.flatCents == null) {
      return { unbillable: { ...id, reason: "Per-load fee not set for this carrier" } };
    }
    return { line: { ...id, basisCents: 0, commissionCents: terms.flatCents } };
  }

  if (terms.model === "per_truck_week") {
    // Billed per truck per week, not per load — a load carries no charge of its
    // own. Not an error and not zero-owed: the charge exists at the statement
    // level (see weeklyTruckCharge), so the load is simply not a line here.
    return { unbillable: { ...id, reason: "Billed per truck per week — not charged per load" } };
  }

  // percent_linehaul
  if (terms.pctBps == null) {
    return { unbillable: { ...id, reason: "Commission percentage not set for this carrier" } };
  }
  if (load.linehaulCents == null) {
    // The load was never priced. Charging a percentage of an unknown number is
    // charging a made-up number.
    return { unbillable: { ...id, reason: "Load has no rate on file — nothing to take a percentage of" } };
  }
  return {
    line: {
      ...id,
      basisCents: load.linehaulCents,
      // Round once, at the line. Rounding a fraction of a cent per load and
      // summing is how a monthly statement drifts from its own lines.
      commissionCents: Math.round((load.linehaulCents * terms.pctBps) / 10_000),
    },
  };
}

export interface CarrierStatement {
  lines: CommissionLine[];
  unbillable: UnbillableLoad[];
  /** loads that produced a billable line */
  billedLoadCount: number;
  /** gross linehaul the commission was taken on */
  basisCents: number;
  /** per-load commission total */
  loadCommissionCents: number;
  /** the per-truck-week charge, when that is the model */
  truckWeekCents: number;
  /** everything owed for the period */
  totalCents: number;
  /** false when ANY load could not be billed — the statement is incomplete and
   *  must say so rather than presenting its total as the whole picture */
  complete: boolean;
}

/**
 * Roll a carrier's delivered loads into a statement for the period.
 *
 * `truckWeeks` is (trucks × weeks) for the per_truck_week model; the caller
 * counts them because only it knows the fleet and the period.
 */
export function buildCarrierStatement(
  loads: readonly BillableLoad[],
  terms: CommissionTerms,
  truckWeeks = 0,
): CarrierStatement {
  const lines: CommissionLine[] = [];
  const unbillable: UnbillableLoad[] = [];

  for (const load of loads) {
    const r = commissionForLoad(load, terms);
    if ("line" in r) lines.push(r.line);
    else unbillable.push(r.unbillable);
  }

  const loadCommissionCents = lines.reduce((a, l) => a + l.commissionCents, 0);
  const basisCents = lines.reduce((a, l) => a + l.basisCents, 0);
  const truckWeekCents =
    terms.model === "per_truck_week" && terms.flatCents != null
      ? terms.flatCents * Math.max(0, truckWeeks)
      : 0;

  return {
    lines,
    unbillable,
    billedLoadCount: lines.length,
    basisCents,
    loadCommissionCents,
    truckWeekCents,
    totalCents: loadCommissionCents + truckWeekCents,
    // per_truck_week marks every load "unbillable per load" by design, so the
    // completeness flag would always be false for that model if it counted
    // those. It asks a different question: is anything MISSING that should
    // have been billed?
    complete:
      terms.model === "per_truck_week"
        ? terms.flatCents != null
        : unbillable.length === 0,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole weeks in a period, for the per-truck-week model.
 *
 *  The span is resolved to a whole DAY COUNT before weeks are taken, and the
 *  day count is ROUNDED rather than floored or ceiled. Two things force that:
 *
 *  1. Ceiling the raw millisecond span was knife-edged. "The last 7 days" built
 *     from two Date.now() calls a few milliseconds apart is 7 days + 1 ms,
 *     which ceilings to TWO weeks — at $225 per truck per week with two trucks,
 *     a $450 error on a real invoice, appearing only intermittently. Caught by
 *     opening the Money page and reading $777 where an API call minutes earlier
 *     had said $1,227.
 *
 *  2. The two callers disagree about what a range MEANS. The default period is
 *     an exact 7.000-day span; the date pickers send an inclusive end-of-day,
 *     so seven picked calendar days arrive as 6.99999 days. Flooring bills
 *     eight picked days as one week; ceiling bills the default seven as two.
 *     Rounding is the only rule under which both conventions agree, because
 *     each is within a millisecond of a whole day.
 *
 *  Whole weeks still round UP: a carrier dispatched for three days owes the
 *  week. Eight days is two weeks; seven days is one. */
export function weeksInSpan(fromMs: number, toMs: number): number {
  const days = Math.round((toMs - fromMs) / DAY_MS);
  return Math.max(1, Math.ceil(days / 7));
}
