import { prisma } from "../../db.js";
import { CHICAGO_PICKUP, DEMO_CUSTOMER_EMAIL, DEMO_LOAD_REF, DETROIT_DELIVERY } from "./fixtures.js";

// Demo Mode: the one load the whole story follows. Kept at the SAME row id
// across resets (find by the org-scoped externalId, update in place) so every
// link the presenter/portal holds onto (cockpit, AI Lab, the agent timeline)
// keeps working after a Reset — only the historical loads are thrown away
// and recreated (fixturesHistory.ts).

const PICKUP_DWELL_MIN = 45;
/** The delivery window the load carries from reset until approval: generous
 *  on purpose, so the assignment endpoint's own feasibility guard books the
 *  run without objection whenever the presenter gets to it. The window that
 *  actually drives the story — tight, in wall time — is set by
 *  `recordApproval` (actions.ts) once the assignment exists. */
const RESET_DELIVERY_WINDOW_MS = 24 * 60 * 60_000;

export async function upsertDemoLoad(orgId: string, customerId: string, nowMs: number = Date.now()): Promise<{ id: string }> {
  const pickupWindowStart = new Date(nowMs + 30 * 60_000);
  const pickupWindowEnd = new Date(nowMs + 3 * 60 * 60_000);
  const deliveryWindowEnd = new Date(nowMs + RESET_DELIVERY_WINDOW_MS);

  const fields = {
    requiredEquip: "DryVan",
    status: "open",
    customerName: "Demo Customer",
    customerEmail: DEMO_CUSTOMER_EMAIL,
    customerId,
    // Night Shift names a load by `boardLoadNo ?? orderRef ?? id` in every
    // message and escalation subject. `orderRef` (not `boardLoadNo`, which
    // belongs to the broker-board/sheet mirror) makes those read
    // "load DEMO-CHI-DET" instead of a uuid.
    orderRef: DEMO_LOAD_REF,
    agentEnabled: false,
    agentPill: "off",
    revenueCents: 185_000,
  };

  const existing = await prisma.load.findUnique({ where: { orgId_externalId: { orgId, externalId: DEMO_LOAD_REF } }, select: { id: true } });
  const load = existing
    // `version: { increment: 1 }` (finding F12/M12): this write bypasses the
    // load writer (a wholesale fixture rebuild, not a dispatcher edit), so
    // without it Load.version never moves and no LoadChange is recorded —
    // a Cockpit tab left open across a Reset could then submit an edit
    // against the rebuilt row and have it accepted as if nothing changed.
    ? await prisma.load.update({ where: { id: existing.id }, data: { ...fields, version: { increment: 1 } } })
    : await prisma.load.create({ data: { orgId, externalId: DEMO_LOAD_REF, ...fields } });

  // Stops/appointments are rebuilt fresh every reset — cheaper and safer
  // than diffing two rows that must always come out identical anyway.
  // Appointment has no cascade off LoadStop, so it goes first.
  await prisma.appointment.deleteMany({ where: { stop: { loadId: load.id } } });
  await prisma.loadStop.deleteMany({ where: { loadId: load.id } });

  await prisma.loadStop.create({
    data: {
      loadId: load.id, sequence: 1, type: "pickup", address: CHICAGO_PICKUP.address,
      lat: CHICAGO_PICKUP.lat, lng: CHICAGO_PICKUP.lng, geocodeStatus: "ok", dwellMin: PICKUP_DWELL_MIN,
      appointment: { create: { windowStart: pickupWindowStart, windowEnd: pickupWindowEnd, type: "pickup" } },
    },
  });
  await prisma.loadStop.create({
    data: {
      loadId: load.id, sequence: 2, type: "delivery", address: DETROIT_DELIVERY.address,
      lat: DETROIT_DELIVERY.lat, lng: DETROIT_DELIVERY.lng, geocodeStatus: "ok",
      appointment: { create: { windowEnd: deliveryWindowEnd, type: "delivery" } },
    },
  });

  return load;
}
