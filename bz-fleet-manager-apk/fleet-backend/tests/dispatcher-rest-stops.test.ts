import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDispatcher } from "./helpers.js";
import { signDispatcherAccess, signAccess } from "../src/lib/tokens.js";

// T3 Break and Rest Planning, Task 6 — CRUD + CSV import for RestStop.
//
// This codebase has shipped six cross-tenant defects, and mount order was one
// of the causes (see tests/dispatcher-mount-order.test.ts) — so every tenancy
// assertion here goes through the real app (`./helpers.js`'s `app`, built by
// the real `createApp()`), never a router mounted in isolation. Global
// Constraint 4 is "404, never 403" for a cross-tenant id: a 403 would confirm
// the row exists to a caller who has no business knowing that.

beforeEach(resetDb);

async function scopedAuth(orgId: string) {
  const disp = await prisma.dispatcher.create({
    data: { email: `disp-${orgId}@x.com`, passwordHash: "x", name: "D", orgId },
  });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

describe("rest stop CRUD", () => {
  it("creates a rest stop for the caller's org", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const res = await request(app).post("/api/dispatcher/rest-stops").set("authorization", auth)
      .send({ name: "I-70 Rest Area — Columbia MO", kind: "rest_area", lat: 38.9517, lng: -92.3341, spaces: 40 });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("I-70 Rest Area — Columbia MO");
    expect(res.body.orgId).toBe(org.id);
    expect(res.body.spaces).toBe(40);
    expect(res.body.amenities).toEqual([]);
  });

  it("rejects creating a rest stop without an org-scoped dispatcher account", async () => {
    // RestStop.orgId is NOT nullable (prisma/schema.prisma), same as Carrier
    // — there is no "unscoped/pool" rest stop convention to fall back on.
    const disp = await createDispatcher({ email: "legacy@x.com" });
    const auth = `Bearer ${signDispatcherAccess(disp.id)}`;

    const res = await request(app).post("/api/dispatcher/rest-stops").set("authorization", auth)
      .send({ name: "Orgless Stop", kind: "truck_stop", lat: 39.0, lng: -95.0 });
    expect(res.status).toBe(400);
  });

  // --- Zod validation --------------------------------------------------------

  it("rejects lat: 91 with 400", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const res = await request(app).post("/api/dispatcher/rest-stops").set("authorization", auth)
      .send({ name: "Off The Earth", kind: "truck_stop", lat: 91, lng: -95.0 });
    expect(res.status).toBe(400);
  });

  it("rejects lng: -181 with 400", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const res = await request(app).post("/api/dispatcher/rest-stops").set("authorization", auth)
      .send({ name: "Off The Earth", kind: "truck_stop", lat: 39.0, lng: -181 });
    expect(res.status).toBe(400);
  });

  // --- absent vs. measured -----------------------------------------------------

  it("spaces omitted on create persists as null, not 0", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    // `spaces` is not in the body at all — this is the "we were not told the
    // capacity" case, distinct from a facility that has zero parking.
    const res = await request(app).post("/api/dispatcher/rest-stops").set("authorization", auth)
      .send({ name: "Unknown Capacity Stop", kind: "rest_area", lat: 39.0, lng: -95.0 });
    expect(res.status).toBe(201);
    expect(res.body.spaces).toBeNull();
    expect(res.body.spaces).not.toBe(0);

    const reread = await prisma.restStop.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(reread.spaces).toBeNull();
  });

  // --- org scoping / cross-tenant shape ---------------------------------------

  it("GET /rest-stops returns only the caller's org's stops — a foreign stop is absent, not merely undercounted", async () => {
    const orgA = await prisma.org.create({ data: { name: "Alpha" } });
    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const stopB = await prisma.restStop.create({
      data: { orgId: orgB.id, name: "Beta Stop", kind: "truck_stop", lat: 39.0, lng: -95.0 },
    });
    const authA = await scopedAuth(orgA.id);
    const created = await request(app).post("/api/dispatcher/rest-stops").set("authorization", authA)
      .send({ name: "Alpha Stop", kind: "truck_stop", lat: 39.0, lng: -95.0 });

    const list = await request(app).get("/api/dispatcher/rest-stops").set("authorization", authA);
    expect(list.status).toBe(200);
    const ids = list.body.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(stopB.id);
    expect(ids).toContain(created.body.id);
  });

  it("DELETE of a cross-tenant id returns 404, never 403 — a 403 would confirm the row exists", async () => {
    const orgA = await prisma.org.create({ data: { name: "Alpha" } });
    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const stopB = await prisma.restStop.create({
      data: { orgId: orgB.id, name: "Beta Stop", kind: "truck_stop", lat: 39.0, lng: -95.0 },
    });
    const authA = await scopedAuth(orgA.id);

    const res = await request(app).delete(`/api/dispatcher/rest-stops/${stopB.id}`).set("authorization", authA);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);

    // The row must genuinely survive the refused delete, not merely return
    // the right status code while quietly deleting anyway.
    const stillThere = await prisma.restStop.findUnique({ where: { id: stopB.id } });
    expect(stillThere).not.toBeNull();
  });

  it("DELETE of an unknown id returns 404", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);
    const res = await request(app).delete("/api/dispatcher/rest-stops/does-not-exist").set("authorization", auth);
    expect(res.status).toBe(404);
  });

  it("DELETE within the caller's own org actually removes the row", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const stop = await prisma.restStop.create({
      data: { orgId: org.id, name: "Own Stop", kind: "yard", lat: 39.0, lng: -95.0 },
    });
    const auth = await scopedAuth(org.id);

    const res = await request(app).delete(`/api/dispatcher/rest-stops/${stop.id}`).set("authorization", auth);
    expect(res.status).toBe(204);

    const gone = await prisma.restStop.findUnique({ where: { id: stop.id } });
    expect(gone).toBeNull();
  });

  // --- auth gate ---------------------------------------------------------------

  it("sits behind the same dispatcher auth as dispatcherTrips — an unauthenticated call is 401", async () => {
    // Asserted through the real app (not the router in isolation): mount
    // order has been the cause of past cross-tenant leaks in this codebase,
    // so the only trustworthy check is the one that walks the full stack.
    const res = await request(app).get("/api/dispatcher/rest-stops");
    expect(res.status).toBe(401);
  });

  it("rejects a garbage bearer token with 401", async () => {
    const res = await request(app).get("/api/dispatcher/rest-stops").set("authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("rejects a valid driver-role token (wrong role) with 403 — requireDispatcher, not requireAuth", async () => {
    // requireDispatcher sits between requireAuth and attachOrgScope; a
    // driver-role token authenticates fine but must be refused here before
    // it ever reaches this router's handlers.
    const driver = await prisma.driver.create({
      data: { email: "driver@x.com", passwordHash: "x", name: "Driver" },
    });
    const res = await request(app).get("/api/dispatcher/rest-stops").set("authorization", `Bearer ${signAccess(driver.id)}`);
    expect(res.status).toBe(403);
  });
});

describe("rest stop CSV import", () => {
  it("round-trips a name containing a comma and a quote", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    // RFC-4180: the whole field is quoted because it contains a comma, and
    // the literal double-quote inside it is escaped by doubling ("").
    const csv =
      'name,kind,lat,lng,spaces\n' +
      '"Bob\'s ""Big Rig"" Stop, Exit 12",truck_stop,39.5,-100.7,50\n';

    const res = await request(app).post("/api/dispatcher/rest-stops/import").set("authorization", auth)
      .send({ csv });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.errors).toEqual([]);

    const stops = await prisma.restStop.findMany({ where: { orgId: org.id } });
    expect(stops).toHaveLength(1);
    expect(stops[0]!.name).toBe('Bob\'s "Big Rig" Stop, Exit 12');
    expect(stops[0]!.lat).toBe(39.5);
    expect(stops[0]!.lng).toBe(-100.7);
    expect(stops[0]!.spaces).toBe(50);
  });

  it("a row with spaces left blank imports with spaces persisted as null, not 0", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const csv = "name,kind,lat,lng,spaces\nNo Capacity Data,rest_area,39.0,-95.0,\n";

    const res = await request(app).post("/api/dispatcher/rest-stops/import").set("authorization", auth)
      .send({ csv });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);

    const stop = await prisma.restStop.findFirstOrThrow({ where: { orgId: org.id, name: "No Capacity Data" } });
    expect(stop.spaces).toBeNull();
  });

  it("rejects a row whose lat is not a number, rather than persisting NaN", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const csv = "name,kind,lat,lng,spaces\nBad Row,truck_stop,not-a-number,-95.0,10\n";

    const res = await request(app).post("/api/dispatcher/rest-stops/import").set("authorization", auth)
      .send({ csv });

    // No rows imported successfully -> 422, and the row-level error report
    // names the bad row instead of silently dropping it.
    expect(res.status).toBe(422);
    expect(res.body.imported).toBe(0);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].row).toBe(1);

    const stops = await prisma.restStop.findMany({ where: { orgId: org.id } });
    expect(stops).toHaveLength(0);
    // Belt and suspenders: even if a bug let this through, it must never be
    // a literal NaN reaching the database.
    for (const s of stops) expect(Number.isNaN(s.lat)).toBe(false);
  });

  it("imports the good rows and reports the bad ones in a mixed batch", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const csv =
      "name,kind,lat,lng,spaces\n" +
      "Good Stop One,truck_stop,39.0,-95.0,20\n" +
      "Bad Stop,truck_stop,95,-95.0,20\n" + // lat out of range
      "Good Stop Two,rest_area,40.0,-96.0,\n";

    const res = await request(app).post("/api/dispatcher/rest-stops/import").set("authorization", auth)
      .send({ csv });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].row).toBe(2);

    const stops = await prisma.restStop.findMany({ where: { orgId: org.id }, orderBy: { name: "asc" } });
    expect(stops.map((s) => s.name)).toEqual(["Good Stop One", "Good Stop Two"]);
  });

  it("import requires an org-scoped dispatcher account", async () => {
    const disp = await createDispatcher({ email: "legacy-import@x.com" });
    const auth = `Bearer ${signDispatcherAccess(disp.id)}`;
    const res = await request(app).post("/api/dispatcher/rest-stops/import").set("authorization", auth)
      .send({ csv: "name,kind,lat,lng\nX,truck_stop,39.0,-95.0\n" });
    expect(res.status).toBe(400);
  });

  it("import sits behind the same dispatcher auth — unauthenticated is 401", async () => {
    const res = await request(app).post("/api/dispatcher/rest-stops/import").send({ csv: "name,kind,lat,lng\n" });
    expect(res.status).toBe(401);
  });
});
