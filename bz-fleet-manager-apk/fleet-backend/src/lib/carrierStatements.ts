// Assemble each client carrier's statement for a period: what this dispatch
// service invoices them for the loads it dispatched on their trucks.
//
// A load belongs to a carrier through the DRIVER who ran it
// (assignment.driver.carrierId). A driver with NO carrier is the org's own
// truck — there is nobody to invoice, which is not the same as a carrier who
// owes zero, and the two must never be summed together.
//
// Only DELIVERED work counts, bucketed by when it actually completed. A booked
// load that never ran earned nothing; a plan is not work. Same rule the driver
// settlements route already applies, deliberately — a dispatch service billing
// its client on a different definition of "done" than it pays its drivers on
// will be asked why, and will not have an answer.

import { prisma } from "../db.js";
import {
  buildCarrierStatement,
  type BillableLoad,
  type CarrierStatement,
  type CommissionTerms,
  weeksInSpan,
} from "../domain/billing/commission.js";

export interface CarrierStatementRow {
  carrierId: string;
  carrierName: string;
  terms: CommissionTerms;
  /** trucks × weeks in the period, for the per_truck_week model */
  truckWeeks: number;
  statement: CarrierStatement;
}

export interface StatementsResult {
  rows: CarrierStatementRow[];
  /** Delivered loads run by drivers with NO carrier — the org's own trucks.
   *  Reported separately and never folded into a carrier's total: there is
   *  nobody to invoice for these, which is a different fact from owing zero. */
  ownFleet: { loadCount: number; linehaulCents: number };
  fromMs: number;
  toMs: number;
}

export async function buildStatements(
  orgId: string,
  fromMs: number,
  toMs: number,
): Promise<StatementsResult> {
  const carriers = await prisma.carrier.findMany({
    where: { orgId },
    select: {
      id: true,
      name: true,
      commissionModel: true,
      commissionPctBps: true,
      commissionFlatCents: true,
      _count: { select: { drivers: true } },
    },
    orderBy: { name: "asc" },
  });

  // Delivered work in the window, with the carrier it belongs to and its rate.
  const assignments = await prisma.assignment.findMany({
    where: {
      orgId,
      status: "completed",
      completedAt: { gte: new Date(fromMs), lte: new Date(toMs) },
    },
    select: {
      completedAt: true,
      driver: { select: { carrierId: true } },
      load: {
        select: {
          id: true,
          externalId: true,
          orderRef: true,
          rate: { select: { linehaulCents: true, fscCents: true } },
        },
      },
    },
  });

  const byCarrier = new Map<string, BillableLoad[]>();
  const ownFleet = { loadCount: 0, linehaulCents: 0 };

  for (const a of assignments) {
    const billable: BillableLoad = {
      loadId: a.load.id,
      reference: a.load.externalId ?? a.load.orderRef ?? null,
      // No Rate row means the load was never priced. Carried through as null
      // rather than 0 so the commission layer can refuse it by name.
      linehaulCents: a.load.rate?.linehaulCents ?? null,
      fscCents: a.load.rate?.fscCents ?? null,
      completedAtMs: a.completedAt?.getTime() ?? fromMs,
    };
    const carrierId = a.driver.carrierId;
    if (!carrierId) {
      ownFleet.loadCount += 1;
      ownFleet.linehaulCents += billable.linehaulCents ?? 0;
      continue;
    }
    const list = byCarrier.get(carrierId) ?? [];
    list.push(billable);
    byCarrier.set(carrierId, list);
  }

  // Truck-weeks: drivers on the carrier x weeks in the period. The week rule
  // lives in the commission module and is tested there.
  const weeks = weeksInSpan(fromMs, toMs);

  const rows: CarrierStatementRow[] = carriers.map((c) => {
    const terms: CommissionTerms = {
      model: (c.commissionModel as CommissionTerms["model"]) ?? null,
      pctBps: c.commissionPctBps,
      flatCents: c.commissionFlatCents,
    };
    const truckWeeks = c._count.drivers * weeks;
    return {
      carrierId: c.id,
      carrierName: c.name,
      terms,
      truckWeeks,
      statement: buildCarrierStatement(byCarrier.get(c.id) ?? [], terms, truckWeeks),
    };
  });

  return { rows, ownFleet, fromMs, toMs };
}
