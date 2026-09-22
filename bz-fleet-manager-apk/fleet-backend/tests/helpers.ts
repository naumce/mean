import request from "supertest";
import { prisma } from "../src/db.js";
import { createApp } from "../src/app.js";

export const app = createApp();

export async function resetDb() {
  await prisma.$transaction([
    // Control Tower domain (children -> parents), cleared before driver/org below
    prisma.deadheadLeg.deleteMany(), prisma.dispatchConflict.deleteMany(),
    prisma.rate.deleteMany(), prisma.assignment.deleteMany(),
    prisma.agentUpdate.deleteMany(),
    // Night Shift (spec §17.2): AgentCommand cascades with its load anyway,
    // but AgentPolicy's FK to Org is RESTRICT (like boardLayout/updateRule
    // below) — must be cleared before org.deleteMany() or every later
    // suite's resetDb fails.
    prisma.agentCommand.deleteMany(),
    prisma.agentPolicy.deleteMany(),
    prisma.appointment.deleteMany(), prisma.loadStop.deleteMany(),
    // A2: locks cascade with their load, but a live one on a load another
    // suite created must not survive into the next suite's org — clear first.
    prisma.loadLock.deleteMany(),
    // One honest record: the trace rows cascade with the load, but the
    // vocabulary is org-scoped and its FK to Org is RESTRICT — clear it before
    // org, like boardLayout/boardView, or every later suite's resetDb fails.
    prisma.loadChange.deleteMany(),
    prisma.load.deleteMany(), prisma.hosState.deleteMany(),
    prisma.serviceRecord.deleteMany(), prisma.serviceShop.deleteMany(),
    prisma.tractor.deleteMany(), prisma.trailer.deleteMany(),
    prisma.routeDistance.deleteMany(),
    // Existing mobile/dispatcher domain
    prisma.message.deleteMany(), prisma.conversation.deleteMany(),
    prisma.notification.deleteMany(), prisma.driverSession.deleteMany(),
    prisma.safetyAlert.deleteMany(), prisma.fuelLog.deleteMany(),
    prisma.vehicleIssue.deleteMany(), prisma.incident.deleteMany(),
    prisma.driverLocation.deleteMany(), prisma.routePreAssignment.deleteMany(),
    prisma.signsProof.deleteMany(), prisma.signsProofRequirement.deleteMany(),
    prisma.upload.deleteMany(), prisma.checklistItem.deleteMany(),
    prisma.stop.deleteMany(), prisma.trip.deleteMany(),
    prisma.vehicle.deleteMany(), prisma.revokedToken.deleteMany(),
    prisma.driver.deleteMany(), prisma.dispatcher.deleteMany(),
    // Carrier layer (T1): drivers/tractors/trailers above may reference a
    // carrier, and carrier references org — must clear after them, before org.
    prisma.carrier.deleteMany(),
    // T3 rest stops: org-scoped, no other table references it yet — clear
    // before org like serviceShop/carrier above.
    prisma.restStop.deleteMany(),
    // T4 fuel prices: org-scoped, orgId FK is ON DELETE RESTRICT — clear
    // before org like restStop above.
    prisma.fuelPrice.deleteMany(),
    // Broker Board layout and view: org-scoped, one per org, and their FK to
    // Org is RESTRICT — a row left behind here does not fail its own test, it
    // fails `org.deleteMany()` in every suite that runs after it in the same
    // schema. Clear both before org.
    prisma.boardLayout.deleteMany(),
    prisma.boardView.deleteMany(),
    prisma.updateRule.deleteMany(),
    // Night Shift sheet slices: Plan/OrgTelephony/SheetBinding are org-scoped,
    // one (or several, for SheetBinding) per org, and their FK to Org is
    // RESTRICT — clear before org, like boardLayout/updateRule above.
    prisma.plan.deleteMany(),
    prisma.orgTelephony.deleteMany(),
    prisma.sheetBinding.deleteMany(),
    // Task 5: OrgApiKey is org-scoped with an FK to Org — clear before org,
    // same reasoning as plan/orgTelephony/sheetBinding above.
    prisma.orgApiKey.deleteMany(),
    // Org last — drivers/loads/tractors/trailers/assignments all reference it
    prisma.org.deleteMany(),
  ]);
}

export async function createDriver(over: Partial<{ email: string; passwordHash: string; name: string }> = {}) {
  return prisma.driver.create({
    data: { email: over.email ?? "d@x.com", passwordHash: over.passwordHash ?? "x",
            name: over.name ?? "Test Driver" },
  });
}

export async function createDispatcher(over: Partial<{ email: string; passwordHash: string; name: string }> = {}) {
  return prisma.dispatcher.create({
    data: { email: over.email ?? "disp@x.com", passwordHash: over.passwordHash ?? "x",
            name: over.name ?? "Test Dispatcher" },
  });
}

export async function loginDispatcher(email: string, password: string) {
  const res = await request(app).post("/api/auth/dispatcher/login").send({ email, password });
  return res.body as { dispatcher: { id: string; email: string; name: string }; token: string; refreshToken: string };
}
