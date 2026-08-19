import request from "supertest";
import { prisma } from "../src/db.js";
import { createApp } from "../src/app.js";

export const app = createApp();

export async function resetDb() {
  await prisma.$transaction([
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
