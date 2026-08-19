import request from "supertest";
import { app, resetDb, createDispatcher, createDriver } from "./helpers.js";
import { signAccess, signDispatcherAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

async function dispatcherAuth() {
  const disp = await createDispatcher();
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

it("creates a trip with stops + checklist, unassigned, status pending", async () => {
  const auth = await dispatcherAuth();
  const res = await request(app).post("/api/dispatcher/trips").set("authorization", auth).send({
    identifier: "TR-DSP-1",
    stops: [{ sequence: 1, address: "A St" }, { sequence: 2, address: "B St" }],
    checklistItems: [{ label: "Check tires", required: true }],
  });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe("pending");
  expect(res.body.driverId).toBeNull();
  expect(res.body.stops).toHaveLength(2);
  expect(res.body.checklistItems).toHaveLength(1);
});

it("rejects a trip create with no stops with 400", async () => {
  const auth = await dispatcherAuth();
  const res = await request(app).post("/api/dispatcher/trips").set("authorization", auth)
    .send({ identifier: "TR-DSP-BAD", stops: [] });
  expect(res.status).toBe(400);
});

it("GET /dispatcher/trips/:id returns the full nested trip", async () => {
  const auth = await dispatcherAuth();
  const create = await request(app).post("/api/dispatcher/trips").set("authorization", auth).send({
    identifier: "TR-DSP-2",
    stops: [{ sequence: 1, address: "A St" }],
    checklistItems: [{ label: "Check fuel" }],
  });
  const res = await request(app).get(`/api/dispatcher/trips/${create.body.id}`).set("authorization", auth);
  expect(res.status).toBe(200);
  expect(res.body.stops).toHaveLength(1);
  expect(res.body.stops[0]).toHaveProperty("signsProofs");
  expect(res.body.checklistItems).toHaveLength(1);
});

it("returns 404 for an unknown trip id", async () => {
  const auth = await dispatcherAuth();
  const res = await request(app).get("/api/dispatcher/trips/does-not-exist").set("authorization", auth);
  expect(res.status).toBe(404);
});

it("filters the trip list by status and driverId", async () => {
  const auth = await dispatcherAuth();
  const driver = await createDriver({ email: "filt@fleet.com" });
  await request(app).post("/api/dispatcher/trips").set("authorization", auth)
    .send({ identifier: "TR-FILT-1", stops: [{ sequence: 1, address: "A" }] });
  const assigned = await request(app).post("/api/dispatcher/trips").set("authorization", auth)
    .send({ identifier: "TR-FILT-2", stops: [{ sequence: 1, address: "B" }] });
  await request(app).post(`/api/dispatcher/trips/${assigned.body.id}/assign`).set("authorization", auth)
    .send({ driverId: driver.id });

  const byStatus = await request(app).get("/api/dispatcher/trips?status=pending").set("authorization", auth);
  expect(byStatus.body.map((t: { identifier: string }) => t.identifier)).toContain("TR-FILT-1");
  expect(byStatus.body.map((t: { identifier: string }) => t.identifier)).not.toContain("TR-FILT-2");

  const byDriver = await request(app).get(`/api/dispatcher/trips?driverId=${driver.id}`).set("authorization", auth);
  expect(byDriver.body.map((t: { identifier: string }) => t.identifier)).toEqual(["TR-FILT-2"]);
});

it("end-to-end: dispatcher creates + assigns a trip; the assigned driver sees it via /driver/trips/active", async () => {
  const auth = await dispatcherAuth();
  const driver = await createDriver({ email: "assignee@fleet.com" });
  const create = await request(app).post("/api/dispatcher/trips").set("authorization", auth).send({
    identifier: "TR-E2E-1",
    stops: [{ sequence: 1, address: "A St" }],
  });
  const assign = await request(app).post(`/api/dispatcher/trips/${create.body.id}/assign`)
    .set("authorization", auth).send({ driverId: driver.id });
  expect(assign.status).toBe(200);
  expect(assign.body.driverId).toBe(driver.id);
  expect(assign.body.status).toBe("assigned");

  const active = await request(app).get("/api/driver/trips/active")
    .set("authorization", `Bearer ${signAccess(driver.id)}`);
  expect(active.status).toBe(200);
  expect(active.body.map((t: { identifier: string }) => t.identifier)).toContain("TR-E2E-1");
});

it("returns 404 assigning to a nonexistent trip", async () => {
  const auth = await dispatcherAuth();
  const driver = await createDriver({ email: "noone@fleet.com" });
  const res = await request(app).post("/api/dispatcher/trips/does-not-exist/assign")
    .set("authorization", auth).send({ driverId: driver.id });
  expect(res.status).toBe(404);
});

it("returns 404 assigning a nonexistent driver", async () => {
  const auth = await dispatcherAuth();
  const create = await request(app).post("/api/dispatcher/trips").set("authorization", auth)
    .send({ identifier: "TR-DSP-NODRV", stops: [{ sequence: 1, address: "A" }] });
  const res = await request(app).post(`/api/dispatcher/trips/${create.body.id}/assign`)
    .set("authorization", auth).send({ driverId: "does-not-exist" });
  expect(res.status).toBe(404);
});
