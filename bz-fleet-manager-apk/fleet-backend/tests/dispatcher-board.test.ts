import request from "supertest";
import { app, resetDb, createDispatcher, createDriver } from "./helpers.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

beforeEach(resetDb);

async function auth() {
  const d = await createDispatcher();
  return `Bearer ${signDispatcherAccess(d.id)}`;
}

const WINDOW = "?from=2026-08-21T00:00:00.000Z&to=2026-08-22T00:00:00.000Z";

it("returns every driver as a lane", async () => {
  const a = await auth();
  await createDriver({ email: "lane1@fleet.com", name: "Lane One" });
  await createDriver({ email: "lane2@fleet.com", name: "Lane Two" });
  const res = await request(app).get(`/api/dispatcher/board${WINDOW}`).set("authorization", a);
  expect(res.status).toBe(200);
  expect(res.body.lanes.map((l: { name: string }) => l.name)).toEqual(expect.arrayContaining(["Lane One", "Lane Two"]));
});

it("returns scheduled trips inside the window with a stopCount", async () => {
  const a = await auth();
  await request(app).post("/api/dispatcher/trips").set("authorization", a).send({
    identifier: "TR-IN", stops: [{ sequence: 1, address: "A" }, { sequence: 2, address: "B" }],
    scheduledStart: "2026-08-21T09:00:00.000Z", scheduledEnd: "2026-08-21T12:00:00.000Z",
  });
  const res = await request(app).get(`/api/dispatcher/board${WINDOW}`).set("authorization", a);
  const t = res.body.trips.find((x: { identifier: string }) => x.identifier === "TR-IN");
  expect(t).toBeTruthy();
  expect(t.stopCount).toBe(2);
});

it("excludes scheduled trips outside the window but includes unscheduled trips", async () => {
  const a = await auth();
  await request(app).post("/api/dispatcher/trips").set("authorization", a).send({
    identifier: "TR-OUT", stops: [{ sequence: 1, address: "A" }],
    scheduledStart: "2026-09-01T09:00:00.000Z", scheduledEnd: "2026-09-01T12:00:00.000Z",
  });
  await request(app).post("/api/dispatcher/trips").set("authorization", a)
    .send({ identifier: "TR-UNSCHED", stops: [{ sequence: 1, address: "A" }] });
  const res = await request(app).get(`/api/dispatcher/board${WINDOW}`).set("authorization", a);
  const ids = res.body.trips.map((x: { identifier: string }) => x.identifier);
  expect(ids).not.toContain("TR-OUT");
  expect(ids).toContain("TR-UNSCHED");
});

it("rejects a missing/invalid window with 400", async () => {
  const a = await auth();
  const res = await request(app).get("/api/dispatcher/board").set("authorization", a);
  expect(res.status).toBe(400);
});

it("requires a dispatcher token (401/403 without one)", async () => {
  const res = await request(app).get(`/api/dispatcher/board${WINDOW}`);
  expect(res.status).toBeGreaterThanOrEqual(401);
  expect(res.status).toBeLessThanOrEqual(403);
});
