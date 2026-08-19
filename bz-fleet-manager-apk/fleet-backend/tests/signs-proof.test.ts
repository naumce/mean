import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

async function runningTripWithStop(driverId: string, ident = "TR-SP-1") {
  const trip = await prisma.trip.create({ data: { identifier: ident, status: "in_progress", driverId } });
  const stop = await prisma.stop.create({ data: { tripId: trip.id, sequence: 1, address: "A" } });
  return { trip, stop };
}

it("returns the signs-proof requirements for a stop", async () => {
  const d = await createDriver();
  const { trip, stop } = await runningTripWithStop(d.id);
  await prisma.signsProofRequirement.create({
    data: { stopId: stop.id, proofType: "signature", validationType: "customer", required: true },
  });
  const res = await request(app)
    .get(`/api/mobile/trips/${trip.id}/signs-proof-requirements?stopId=${stop.id}`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(1);
  expect(res.body[0].proofType).toBe("signature");
});

it("returns 404 for requirements on another driver's trip", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  const { trip, stop } = await runningTripWithStop(other.id, "TR-SP-OTHER");
  const res = await request(app)
    .get(`/api/mobile/trips/${trip.id}/signs-proof-requirements?stopId=${stop.id}`)
    .set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(404);
});

it("uploads a signs-proof and persists a SignsProof record", async () => {
  const d = await createDriver();
  const { stop } = await runningTripWithStop(d.id, "TR-SP-2");
  const requirement = await prisma.signsProofRequirement.create({
    data: { stopId: stop.id, proofType: "signature", required: true },
  });
  const res = await request(app)
    .post(`/api/signs-proof/${stop.id}/upload`)
    .set("authorization", `Bearer ${signAccess(d.id)}`)
    .field("requirementId", requirement.id)
    .field("proofType", "signature")
    .field("hasLocation", "true")
    .attach("file", Buffer.from("sig"), "sig.png");
  expect(res.status).toBe(200);
  expect(res.body.fileUrl).toMatch(/^\/uploads\//);
  expect(res.body.proofType).toBe("signature");
  expect(res.body.hasLocation).toBe(true);

  const proofs = await prisma.signsProof.findMany({ where: { stopId: stop.id } });
  expect(proofs).toHaveLength(1);
  expect(proofs[0].requirementId).toBe(requirement.id);
});

it("returns 404 uploading a signs-proof to a stop on another driver's trip", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  const { stop } = await runningTripWithStop(other.id, "TR-SP-OTHER-2");
  const res = await request(app)
    .post(`/api/signs-proof/${stop.id}/upload`)
    .set("authorization", `Bearer ${signAccess(me.id)}`)
    .field("proofType", "signature")
    .attach("file", Buffer.from("sig"), "sig.png");
  expect(res.status).toBe(404);
});

it("a signs-proof upload satisfies the requirement in the requirements listing", async () => {
  const d = await createDriver();
  const { stop } = await runningTripWithStop(d.id, "TR-SP-3");
  await prisma.signsProofRequirement.create({ data: { stopId: stop.id, proofType: "photo", required: true } });
  await request(app)
    .post(`/api/signs-proof/${stop.id}/upload`)
    .set("authorization", `Bearer ${signAccess(d.id)}`)
    .field("proofType", "photo")
    .attach("file", Buffer.from("p"), "p.jpg");
  const count = await prisma.signsProof.count({ where: { stopId: stop.id } });
  expect(count).toBe(1);
});

describe("can-proceed", () => {
  it("returns false with a reason when the current stop has an unmet required proof", async () => {
    const d = await createDriver();
    const { trip, stop } = await runningTripWithStop(d.id, "TR-CP-1");
    await prisma.signsProofRequirement.create({ data: { stopId: stop.id, proofType: "signature", required: true } });
    const res = await request(app)
      .get(`/api/trips/${trip.id}/can-proceed?currentStopSequence=${stop.sequence}`)
      .set("authorization", `Bearer ${signAccess(d.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.canProceed).toBe(false);
    expect(res.body.reason).toBeTruthy();
  });

  it("returns true once the required proof is satisfied", async () => {
    const d = await createDriver();
    const { trip, stop } = await runningTripWithStop(d.id, "TR-CP-2");
    await prisma.signsProofRequirement.create({ data: { stopId: stop.id, proofType: "signature", required: true } });
    await prisma.signsProof.create({ data: { stopId: stop.id, proofType: "signature", fileUrl: "/uploads/x.png" } });
    const res = await request(app)
      .get(`/api/trips/${trip.id}/can-proceed?currentStopSequence=${stop.sequence}`)
      .set("authorization", `Bearer ${signAccess(d.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.canProceed).toBe(true);
  });

  it("returns true when the stop has no requirements at all", async () => {
    const d = await createDriver();
    const { trip, stop } = await runningTripWithStop(d.id, "TR-CP-3");
    const res = await request(app)
      .get(`/api/trips/${trip.id}/can-proceed?currentStopSequence=${stop.sequence}`)
      .set("authorization", `Bearer ${signAccess(d.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.canProceed).toBe(true);
  });

  it("returns 404 for another driver's trip", async () => {
    const me = await createDriver({ email: "me@f.com" });
    const other = await createDriver({ email: "other@f.com" });
    const { trip, stop } = await runningTripWithStop(other.id, "TR-CP-OTHER");
    const res = await request(app)
      .get(`/api/trips/${trip.id}/can-proceed?currentStopSequence=${stop.sequence}`)
      .set("authorization", `Bearer ${signAccess(me.id)}`);
    expect(res.status).toBe(404);
  });
});
