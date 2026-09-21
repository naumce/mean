// Compliance-vs-trip-time rules (pure). The clock semantics, uniform across
// every document type:
//   - expired ON OR BEFORE the proposed departure  -> BLOCK (illegal to roll)
//   - expires between departure and trip end       -> WARN  (runs out mid-trip)
//   - service-due dates never block — an overdue PM is a shop visit, not a
//     legal bar — they warn whenever the due date precedes the trip's end.
// Untracked (null/undefined) clocks are silent: no data is not a violation.
import type { Conflict, DispatchPlan, DriverInput, TractorInput, TrailerInput } from "./types.js";

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function expiryConflict(
  kind: Conflict["kind"],
  label: string,
  expiresAt: number | null | undefined,
  plan: Pick<DispatchPlan, "proposedStart" | "proposedEnd">,
): Conflict | null {
  if (expiresAt == null) return null;
  if (expiresAt <= plan.proposedStart) {
    return { kind, severity: "block", detail: `${label} expired ${day(expiresAt)} — before departure` };
  }
  if (expiresAt < plan.proposedEnd) {
    return { kind, severity: "warn", detail: `${label} expires ${day(expiresAt)} — during this trip` };
  }
  return null;
}

function serviceConflict(
  label: string,
  dueAt: number | null | undefined,
  plan: Pick<DispatchPlan, "proposedEnd">,
): Conflict | null {
  if (dueAt == null || dueAt >= plan.proposedEnd) return null;
  return { kind: "service_due", severity: "warn", detail: `${label} service due ${day(dueAt)} — before this trip ends` };
}

export function checkCompliance(
  driver: DriverInput,
  tractor: TractorInput,
  trailer: TrailerInput,
  plan: Pick<DispatchPlan, "proposedStart" | "proposedEnd">,
): Conflict[] {
  const candidates: (Conflict | null)[] = [
    expiryConflict("medical", "Driver's medical certificate", driver.medicalExpiresAt, plan),
    expiryConflict("inspection", "Tractor inspection", tractor.inspectionExpiresAt, plan),
    expiryConflict("registration", "Tractor registration", tractor.registrationExpiresAt, plan),
    serviceConflict("Tractor", tractor.serviceDueAt, plan),
    expiryConflict("inspection", "Trailer inspection", trailer.inspectionExpiresAt, plan),
    expiryConflict("registration", "Trailer registration", trailer.registrationExpiresAt, plan),
    serviceConflict("Trailer", trailer.serviceDueAt, plan),
  ];
  return candidates.filter((c): c is Conflict => c !== null);
}
