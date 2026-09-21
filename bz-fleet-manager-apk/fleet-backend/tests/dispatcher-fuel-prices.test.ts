import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDispatcher } from "./helpers.js";
import { signDispatcherAccess, signAccess } from "../src/lib/tokens.js";

// T4 Fuel and Stops, Task 6 — CRUD + CSV import for FuelPrice.
//
// This codebase has shipped multiple cross-tenant defects, and mount order
// was one of the causes (see tests/dispatcher-mount-order.test.ts) — so every
// tenancy assertion here goes through the real app (`./helpers.js`'s `app`,
// built by the real `createApp()`), never a router mounted in isolation.
// Global Constraint 4 is "404, never 403" for a cross-tenant id: a 403 would
// confirm the row exists to a caller who has no business knowing that.
//
// FuelPrice is NOT the costing assumption (Global Constraint 5).
// RateConfig.dieselCentsPerGal still prices every margin; this table only
// answers "where should the driver buy".

beforeEach(resetDb);

async function scopedAuth(orgId: string) {
  const disp = await prisma.dispatcher.create({
    data: { email: `disp-${orgId}@x.com`, passwordHash: "x", name: "D", orgId },
  });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

/** "YYYY-MM-DD" for `daysOffset` days from today, computed in UTC so it
 *  lines up with the route's own UTC-midnight day grid regardless of the
 *  machine's local timezone. */
function isoDateUtc(daysOffset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOffset);
  return d.toISOString().slice(0, 10);
}

describe("fuel price CRUD", () => {
  it("creates a fuel price for the caller's org", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const res = await request(app).post("/api/dispatcher/fuel-prices").set("authorization", auth)
      .send({ state: "MO", centsPerGal: 385, effectiveOn: isoDateUtc(0) });

    expect(res.status).toBe(201);
    expect(res.body.state).toBe("MO");
    expect(res.body.centsPerGal).toBe(385);
    expect(res.body.orgId).toBe(org.id);
    expect(res.body.source).toBe("import");
  });

  it("rejects creating a fuel price without an org-scoped dispatcher account", async () => {
    // FuelPrice.orgId is NOT nullable (prisma/schema.prisma), same as
    // RestStop — there is no unscoped/pool price convention to fall back on.
    const disp = await createDispatcher({ email: "legacy@x.com" });
    const auth = `Bearer ${signDispatcherAccess(disp.id)}`;

    const res = await request(app).post("/api/dispatcher/fuel-prices").set("authorization", auth)
      .send({ state: "MO", centsPerGal: 385, effectiveOn: isoDateUtc(0) });
    expect(res.status).toBe(400);
  });

  // --- Zod validation --------------------------------------------------------

  it('rejects state: "XX" with 400', async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const res = await request(app).post("/api/dispatcher/fuel-prices").set("authorization", auth)
      .send({ state: "XX", centsPerGal: 385, effectiveOn: isoDateUtc(0) });
    expect(res.status).toBe(400);
  });

  it("rejects a negative centsPerGal with 400", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const res = await request(app).post("/api/dispatcher/fuel-prices").set("authorization", auth)
      .send({ state: "MO", centsPerGal: -50, effectiveOn: isoDateUtc(0) });
    expect(res.status).toBe(400);

    const stored = await prisma.fuelPrice.findMany({ where: { orgId: org.id } });
    expect(stored).toHaveLength(0);
  });

  it("rejects an unparseable effectiveOn with 400", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const res = await request(app).post("/api/dispatcher/fuel-prices").set("authorization", auth)
      .send({ state: "MO", centsPerGal: 385, effectiveOn: "not-a-date" });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate (state, effectiveOn) for the same org with 409, not a hang", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);
    const day = isoDateUtc(0);

    const first = await request(app).post("/api/dispatcher/fuel-prices").set("authorization", auth)
      .send({ state: "MO", centsPerGal: 385, effectiveOn: day });
    expect(first.status).toBe(201);

    const dupe = await request(app).post("/api/dispatcher/fuel-prices").set("authorization", auth)
      .send({ state: "MO", centsPerGal: 399, effectiveOn: day });
    expect(dupe.status).toBe(409);

    const stored = await prisma.fuelPrice.findMany({ where: { orgId: org.id, state: "MO" } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.centsPerGal).toBe(385);
  });

  // --- the query that is easy to get subtly wrong -----------------------------

  it("GET ?state=MO returns the latest effectiveOn at or before today — not the newest-created row, not a future-dated one", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    // Deliberately out of chronological-entry order: the row dated "today"
    // (the correct answer) is created FIRST; the row dated 5 days ago is
    // created LAST, so it is the most-recently-created row overall among the
    // eligible (<= today) ones. `orderBy: { createdAt: "desc" }` would wrongly
    // return the 5-days-ago row. A future-dated row sits in between and must
    // never be returned at all, however it's ordered.
    await prisma.fuelPrice.create({
      data: {
        orgId: org.id, state: "MO", centsPerGal: 410,
        effectiveOn: new Date(`${isoDateUtc(0)}T00:00:00.000Z`),
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
      },
    });
    await prisma.fuelPrice.create({
      data: {
        orgId: org.id, state: "MO", centsPerGal: 999,
        effectiveOn: new Date(`${isoDateUtc(1)}T00:00:00.000Z`), // tomorrow — must never be returned
        createdAt: new Date("2020-01-02T00:00:00.000Z"),
      },
    });
    await prisma.fuelPrice.create({
      data: {
        orgId: org.id, state: "MO", centsPerGal: 390,
        effectiveOn: new Date(`${isoDateUtc(-5)}T00:00:00.000Z`),
        createdAt: new Date("2020-01-03T00:00:00.000Z"), // most recently created of all three
      },
    });

    const res = await request(app).get("/api/dispatcher/fuel-prices?state=MO").set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();
    expect(res.body.centsPerGal).toBe(410);
  });

  it("GET ?state=KS returns null (200, not an error) when the org has no current price for that state", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const res = await request(app).get("/api/dispatcher/fuel-prices?state=KS").set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it("GET ?state=KS only sees a future-dated row and still returns null, not the future price", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);
    await prisma.fuelPrice.create({
      data: { orgId: org.id, state: "KS", centsPerGal: 420, effectiveOn: new Date(`${isoDateUtc(3)}T00:00:00.000Z`) },
    });

    const res = await request(app).get("/api/dispatcher/fuel-prices?state=KS").set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it("rejects a state query param that isn't a valid US state code with 400", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);
    const res = await request(app).get("/api/dispatcher/fuel-prices?state=ZZ").set("authorization", auth);
    expect(res.status).toBe(400);
  });

  // --- org scoping / cross-tenant shape ---------------------------------------

  it("GET /fuel-prices (unfiltered) returns only the caller's org's prices — a foreign price is absent, not merely undercounted", async () => {
    const orgA = await prisma.org.create({ data: { name: "Alpha" } });
    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const priceB = await prisma.fuelPrice.create({
      data: { orgId: orgB.id, state: "MO", centsPerGal: 400, effectiveOn: new Date(`${isoDateUtc(0)}T00:00:00.000Z`) },
    });
    const authA = await scopedAuth(orgA.id);
    const created = await request(app).post("/api/dispatcher/fuel-prices").set("authorization", authA)
      .send({ state: "MO", centsPerGal: 385, effectiveOn: isoDateUtc(0) });

    const list = await request(app).get("/api/dispatcher/fuel-prices").set("authorization", authA);
    expect(list.status).toBe(200);
    const ids = list.body.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(priceB.id);
    expect(ids).toContain(created.body.id);
  });

  it("GET ?state=MO never returns another org's price for the same state and day", async () => {
    const orgA = await prisma.org.create({ data: { name: "Alpha" } });
    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    await prisma.fuelPrice.create({
      data: { orgId: orgB.id, state: "MO", centsPerGal: 400, effectiveOn: new Date(`${isoDateUtc(0)}T00:00:00.000Z`) },
    });
    const authA = await scopedAuth(orgA.id);

    const res = await request(app).get("/api/dispatcher/fuel-prices?state=MO").set("authorization", authA);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it("DELETE of a cross-tenant id returns 404, never 403 — a 403 would confirm the row exists", async () => {
    const orgA = await prisma.org.create({ data: { name: "Alpha" } });
    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const priceB = await prisma.fuelPrice.create({
      data: { orgId: orgB.id, state: "MO", centsPerGal: 400, effectiveOn: new Date(`${isoDateUtc(0)}T00:00:00.000Z`) },
    });
    const authA = await scopedAuth(orgA.id);

    const res = await request(app).delete(`/api/dispatcher/fuel-prices/${priceB.id}`).set("authorization", authA);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);

    // The row must genuinely survive the refused delete, not merely return
    // the right status code while quietly deleting anyway.
    const stillThere = await prisma.fuelPrice.findUnique({ where: { id: priceB.id } });
    expect(stillThere).not.toBeNull();
  });

  it("DELETE of an unknown id returns 404", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);
    const res = await request(app).delete("/api/dispatcher/fuel-prices/does-not-exist").set("authorization", auth);
    expect(res.status).toBe(404);
  });

  it("DELETE within the caller's own org actually removes the row", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const price = await prisma.fuelPrice.create({
      data: { orgId: org.id, state: "MO", centsPerGal: 385, effectiveOn: new Date(`${isoDateUtc(0)}T00:00:00.000Z`) },
    });
    const auth = await scopedAuth(org.id);

    const res = await request(app).delete(`/api/dispatcher/fuel-prices/${price.id}`).set("authorization", auth);
    expect(res.status).toBe(204);

    const gone = await prisma.fuelPrice.findUnique({ where: { id: price.id } });
    expect(gone).toBeNull();
  });

  // --- auth gate ---------------------------------------------------------------

  it("sits behind the same dispatcher auth as dispatcherTrips — an unauthenticated call is 401", async () => {
    // Asserted through the real app (not the router in isolation): mount
    // order has been the cause of past cross-tenant leaks in this codebase,
    // so the only trustworthy check is the one that walks the full stack.
    const res = await request(app).get("/api/dispatcher/fuel-prices");
    expect(res.status).toBe(401);
  });

  it("rejects a garbage bearer token with 401", async () => {
    const res = await request(app).get("/api/dispatcher/fuel-prices").set("authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("rejects a valid driver-role token (wrong role) with 403 — requireDispatcher, not requireAuth", async () => {
    // requireDispatcher sits between requireAuth and attachOrgScope; a
    // driver-role token authenticates fine but must be refused here before
    // it ever reaches this router's handlers.
    const driver = await prisma.driver.create({
      data: { email: "driver@x.com", passwordHash: "x", name: "Driver" },
    });
    const res = await request(app).get("/api/dispatcher/fuel-prices").set("authorization", `Bearer ${signAccess(driver.id)}`);
    expect(res.status).toBe(403);
  });
});

describe("fuel price CSV import", () => {
  it("round-trips a valid CSV", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const csv = `state,centsPerGal,effectiveOn\nMO,385,${isoDateUtc(0)}\n`;

    const res = await request(app).post("/api/dispatcher/fuel-prices/import").set("authorization", auth)
      .send({ csv });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.errors).toEqual([]);

    const prices = await prisma.fuelPrice.findMany({ where: { orgId: org.id } });
    expect(prices).toHaveLength(1);
    expect(prices[0]!.state).toBe("MO");
    expect(prices[0]!.centsPerGal).toBe(385);
    expect(prices[0]!.source).toBe("import");
  });

  it("rejects a row whose centsPerGal is not a number, rather than persisting NaN", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const csv = `state,centsPerGal,effectiveOn\nMO,not-a-number,${isoDateUtc(0)}\n`;

    const res = await request(app).post("/api/dispatcher/fuel-prices/import").set("authorization", auth)
      .send({ csv });

    // No rows imported successfully -> 422, and the row-level error report
    // names the bad row instead of silently dropping it.
    expect(res.status).toBe(422);
    expect(res.body.imported).toBe(0);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].row).toBe(1);

    const prices = await prisma.fuelPrice.findMany({ where: { orgId: org.id } });
    expect(prices).toHaveLength(0);
    // Belt and suspenders: even if a bug let this through, it must never be
    // a literal NaN reaching the database.
    for (const p of prices) expect(Number.isNaN(p.centsPerGal)).toBe(false);
  });

  it("rejects a row with a negative centsPerGal", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const csv = `state,centsPerGal,effectiveOn\nMO,-50,${isoDateUtc(0)}\n`;

    const res = await request(app).post("/api/dispatcher/fuel-prices/import").set("authorization", auth)
      .send({ csv });

    expect(res.status).toBe(422);
    expect(res.body.imported).toBe(0);
    const prices = await prisma.fuelPrice.findMany({ where: { orgId: org.id } });
    expect(prices).toHaveLength(0);
  });

  it("rejects a row whose state is not a valid US state code", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const csv = `state,centsPerGal,effectiveOn\nXX,385,${isoDateUtc(0)}\n`;

    const res = await request(app).post("/api/dispatcher/fuel-prices/import").set("authorization", auth)
      .send({ csv });

    expect(res.status).toBe(422);
    expect(res.body.imported).toBe(0);
  });

  it("imports the good rows and reports the bad ones in a mixed batch", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const csv =
      "state,centsPerGal,effectiveOn\n" +
      `MO,385,${isoDateUtc(0)}\n` +
      `XX,400,${isoDateUtc(0)}\n` + // invalid state
      `KS,410,${isoDateUtc(0)}\n`;

    const res = await request(app).post("/api/dispatcher/fuel-prices/import").set("authorization", auth)
      .send({ csv });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].row).toBe(2);

    const prices = await prisma.fuelPrice.findMany({ where: { orgId: org.id }, orderBy: { state: "asc" } });
    expect(prices.map((p) => p.state)).toEqual(["KS", "MO"]);
  });

  it("import requires an org-scoped dispatcher account", async () => {
    const disp = await createDispatcher({ email: "legacy-import@x.com" });
    const auth = `Bearer ${signDispatcherAccess(disp.id)}`;
    const res = await request(app).post("/api/dispatcher/fuel-prices/import").set("authorization", auth)
      .send({ csv: `state,centsPerGal,effectiveOn\nMO,385,${isoDateUtc(0)}\n` });
    expect(res.status).toBe(400);
  });

  it("import sits behind the same dispatcher auth — unauthenticated is 401", async () => {
    const res = await request(app).post("/api/dispatcher/fuel-prices/import").send({ csv: "state,centsPerGal,effectiveOn\n" });
    expect(res.status).toBe(401);
  });
});
