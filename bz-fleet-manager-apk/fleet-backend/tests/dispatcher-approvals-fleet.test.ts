import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDispatcher, createDriver } from "./helpers.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

async function dispatcherAuth() {
  const disp = await createDispatcher();
  return { auth: `Bearer ${signDispatcherAccess(disp.id)}`, dispatcherId: disp.id };
}

describe("trip approve/reject", () => {
  it("lists trips awaiting approval", async () => {
    const { auth } = await dispatcherAuth();
    const d = await createDriver({ email: "await@fleet.com" });
    await prisma.trip.create({ data: { identifier: "TR-AWAIT-1", status: "awaiting_approval", driverId: d.id } });
    await prisma.trip.create({ data: { identifier: "TR-PENDING-1", status: "pending" } });
    const res = await request(app).get("/api/dispatcher/approvals/trips").set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.map((t: { identifier: string }) => t.identifier)).toEqual(["TR-AWAIT-1"]);
  });

  it("approves a trip, setting status + approvedAt/approvedBy", async () => {
    const { auth, dispatcherId } = await dispatcherAuth();
    const d = await createDriver({ email: "appr@fleet.com" });
    const trip = await prisma.trip.create({
      data: { identifier: "TR-APPR-1", status: "awaiting_approval", driverId: d.id } });
    const res = await request(app).post(`/api/dispatcher/trips/${trip.id}/approve`).set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.approvedBy).toBe(dispatcherId);
    expect(res.body.approvedAt).toBeTruthy();
  });

  it("rejects a trip, setting status to rejected", async () => {
    const { auth } = await dispatcherAuth();
    const trip = await prisma.trip.create({ data: { identifier: "TR-REJ-1", status: "awaiting_approval" } });
    const res = await request(app).post(`/api/dispatcher/trips/${trip.id}/reject`).set("authorization", auth)
      .send({ reason: "missing paperwork" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
  });

  it("returns 404 approving an unknown trip", async () => {
    const { auth } = await dispatcherAuth();
    const res = await request(app).post("/api/dispatcher/trips/does-not-exist/approve").set("authorization", auth);
    expect(res.status).toBe(404);
  });
});

describe("signs-proof approve/reject", () => {
  async function pendingProof() {
    const d = await createDriver({ email: "sp@fleet.com" });
    const trip = await prisma.trip.create({ data: { identifier: "TR-SP-D1", status: "in_progress", driverId: d.id } });
    const stop = await prisma.stop.create({ data: { tripId: trip.id, sequence: 1, address: "A" } });
    return prisma.signsProof.create({
      data: { stopId: stop.id, proofType: "signature", fileUrl: "/uploads/x.png", status: "pending" } });
  }

  it("lists pending signs-proof approvals", async () => {
    const { auth } = await dispatcherAuth();
    await pendingProof();
    const res = await request(app).get("/api/dispatcher/approvals/signs-proof").set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe("pending");
  });

  it("approves a signs-proof, flipping status to approved (the value the driver app reads)", async () => {
    const { auth } = await dispatcherAuth();
    const proof = await pendingProof();
    const res = await request(app).post(`/api/dispatcher/signs-proof/${proof.id}/approve`).set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    const fromDb = await prisma.signsProof.findUnique({ where: { id: proof.id } });
    expect(fromDb?.status).toBe("approved");
  });

  it("rejects a signs-proof, flipping status to rejected", async () => {
    const { auth } = await dispatcherAuth();
    const proof = await pendingProof();
    const res = await request(app).post(`/api/dispatcher/signs-proof/${proof.id}/reject`).set("authorization", auth)
      .send({ reason: "blurry photo" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
  });

  it("returns 404 approving an unknown signs-proof", async () => {
    const { auth } = await dispatcherAuth();
    const res = await request(app).post("/api/dispatcher/signs-proof/does-not-exist/approve")
      .set("authorization", auth);
    expect(res.status).toBe(404);
  });
});

describe("fleet reads", () => {
  it("returns the latest location per driver", async () => {
    const { auth } = await dispatcherAuth();
    const d1 = await createDriver({ email: "loc1@fleet.com" });
    const d2 = await createDriver({ email: "loc2@fleet.com" });
    await prisma.driverLocation.create({ data: { driverId: d1.id, latitude: 1, longitude: 1 } });
    await prisma.driverLocation.create({ data: { driverId: d1.id, latitude: 2, longitude: 2 } });
    await prisma.driverLocation.create({ data: { driverId: d2.id, latitude: 9, longitude: 9 } });
    const res = await request(app).get("/api/dispatcher/locations").set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const forD1 = res.body.find((l: { driverId: string }) => l.driverId === d1.id);
    expect(forD1.latitude).toBe(2);
  });

  it("returns trip counts by status", async () => {
    const { auth } = await dispatcherAuth();
    await prisma.trip.create({ data: { identifier: "TR-OV-1", status: "pending" } });
    await prisma.trip.create({ data: { identifier: "TR-OV-2", status: "pending" } });
    await prisma.trip.create({ data: { identifier: "TR-OV-3", status: "assigned" } });
    const res = await request(app).get("/api/dispatcher/overview").set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.pending).toBe(2);
    expect(res.body.assigned).toBe(1);
  });
});
