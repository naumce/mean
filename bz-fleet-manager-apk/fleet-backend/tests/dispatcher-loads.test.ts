import request from "supertest";
import WebSocket from "ws";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import * as loadWriterModule from "../src/lib/loadWriter.js";
import { createMessageCollector, startServer, stopServer, waitForOpen } from "./realtime-helpers.js";

beforeEach(resetDb);

async function seedOrgLoad(status = "open") {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const disp = await prisma.dispatcher.create({ data: { email: "d@x.com", passwordHash: "x", name: "D", orgId: org.id } });
  const auth = `Bearer ${signDispatcherAccess(disp.id)}`;
  const load = await prisma.load.create({
    data: {
      orgId: org.id, externalId: "L-1", requiredEquip: "DryVan", revenueCents: 30000, fscCents: 2000,
      status, commodity: "Paper",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "Kansas City, MO",
            appointment: { create: { windowEnd: new Date("2027-01-01T00:00:00.000Z"), type: "pickup" } } },
          { sequence: 2, type: "delivery", address: "Omaha, NE" },
        ],
      },
    },
  });
  return { org, auth, load };
}

it("returns full load detail with stops + appointments", async () => {
  const { auth, load } = await seedOrgLoad();
  const res = await request(app).get(`/api/dispatcher/loads/${load.id}`).set("authorization", auth);
  expect(res.status).toBe(200);
  expect(res.body.commodity).toBe("Paper");
  expect(res.body.stops).toHaveLength(2);
  expect(res.body.stops[0].appointment.type).toBe("pickup");
  expect(res.body.rate).toBeNull();
});

it("patches freight fields on an open load", async () => {
  const { auth, load } = await seedOrgLoad();
  const res = await request(app).patch(`/api/dispatcher/loads/${load.id}`).set("authorization", auth)
    .send({ revenueCents: 45000, commodity: "Steel coils", hazmatClass: "8" });
  expect(res.status).toBe(200);
  expect(res.body.revenueCents).toBe(45000);
  expect(res.body.commodity).toBe("Steel coils");
  expect(res.body.hazmatClass).toBe("8");
});

it("replaces the stop set wholesale, rebuilding appointments", async () => {
  const { auth, load } = await seedOrgLoad();
  const res = await request(app).patch(`/api/dispatcher/loads/${load.id}`).set("authorization", auth).send({
    stops: [
      { sequence: 1, type: "pickup", address: "St. Louis, MO", lat: 38.627, lng: -90.1994, windowEnd: "2027-02-01T00:00:00.000Z" },
      { sequence: 2, type: "intermediate", address: "Columbia, MO" },
      { sequence: 3, type: "delivery", address: "Wichita, KS", windowEnd: "2027-02-02T00:00:00.000Z" },
    ],
  });
  expect(res.status).toBe(200);
  expect(res.body.stops).toHaveLength(3);
  expect(res.body.stops[0].address).toBe("St. Louis, MO");
  expect(res.body.stops[0].geocodeStatus).toBe("ok");
  expect(res.body.stops[1].appointment).toBeNull();
  expect(res.body.stops[2].appointment.type).toBe("delivery");
  expect(await prisma.loadStop.count({ where: { loadId: load.id } })).toBe(3);
});

it("refuses edits to a non-open load and stop sets without pickup+delivery", async () => {
  const { auth, load } = await seedOrgLoad("assigned");
  const blocked = await request(app).patch(`/api/dispatcher/loads/${load.id}`).set("authorization", auth)
    .send({ revenueCents: 1 });
  expect(blocked.status).toBe(409);

  const { auth: auth2, load: openLoad } = await (async () => {
    const org = await prisma.org.create({ data: { name: "B" } });
    const disp = await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: "x", name: "B", orgId: org.id } });
    const l = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan", status: "open", stops: { create: [{ sequence: 1, type: "pickup", address: "A" }] } },
    });
    return { auth: `Bearer ${signDispatcherAccess(disp.id)}`, load: l };
  })();
  const badStops = await request(app).patch(`/api/dispatcher/loads/${openLoad.id}`).set("authorization", auth2)
    .send({ stops: [{ sequence: 1, type: "pickup", address: "A" }, { sequence: 2, type: "pickup", address: "B" }] });
  expect(badStops.status).toBe(400);
});

it("refuses to patch a load someone is editing on Their Board", async () => {
  const { org, auth, load } = await seedOrgLoad();
  await prisma.loadLock.create({
    data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) },
  });

  const res = await request(app).patch(`/api/dispatcher/loads/${load.id}`).set("authorization", auth)
    .send({ revenueCents: 45000 });

  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" } });
  const unchanged = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
  expect(unchanged.revenueCents).toBe(30000);
});

it("404s cross-org access on detail and patch", async () => {
  const { load } = await seedOrgLoad();
  const other = await prisma.org.create({ data: { name: "Other" } });
  const foreign = await prisma.dispatcher.create({ data: { email: "f@x.com", passwordHash: "x", name: "F", orgId: other.id } });
  const auth = `Bearer ${signDispatcherAccess(foreign.id)}`;
  expect((await request(app).get(`/api/dispatcher/loads/${load.id}`).set("authorization", auth)).status).toBe(404);
  expect((await request(app).patch(`/api/dispatcher/loads/${load.id}`).set("authorization", auth).send({ revenueCents: 1 })).status).toBe(404);
});

it("cancels an open load and reopens it back into the backlog", async () => {
  const { auth, load } = await seedOrgLoad();
  const cancel = await request(app).post(`/api/dispatcher/loads/${load.id}/cancel`).set("authorization", auth);
  expect(cancel.status).toBe(200);
  expect(cancel.body.status).toBe("canceled");

  // Canceled loads don't reopen twice, and only canceled loads reopen.
  const again = await request(app).post(`/api/dispatcher/loads/${load.id}/cancel`).set("authorization", auth);
  expect(again.status).toBe(409);

  const reopen = await request(app).post(`/api/dispatcher/loads/${load.id}/reopen`).set("authorization", auth);
  expect(reopen.status).toBe(200);
  expect(reopen.body.status).toBe("open");
  const reopenAgain = await request(app).post(`/api/dispatcher/loads/${load.id}/reopen`).set("authorization", auth);
  expect(reopenAgain.status).toBe(409);
});

// R16: cancel now moves through applyStatusChange (the same writer every
// other status change uses) instead of a direct tx.load.update — so the
// single most consequential status change in the product finally gets a
// trace row explaining who did it, not just the version tick F6 already gave
// it. Every existing cancel/reopen assertion above must stay green: the HTTP
// behaviour does not change, only how the write lands.
it("cancel writes exactly one LoadChange row naming the canceling dispatcher, and bumps the version by exactly one", async () => {
  const { org, auth, load } = await seedOrgLoad();
  const disp = await prisma.dispatcher.findFirstOrThrow({ where: { orgId: org.id } });
  expect(load.version).toBe(0);

  const res = await request(app).post(`/api/dispatcher/loads/${load.id}/cancel`).set("authorization", auth);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("canceled");

  const after = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
  expect(after.version).toBe(1);

  const rows = await prisma.loadChange.findMany({ where: { loadId: load.id } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ field: "status", before: "open", after: "canceled", actorId: disp.id, actorName: disp.name, source: "loadboard" });
});

it("refuses to cancel an assigned load — unassign first", async () => {
  const { auth, load } = await seedOrgLoad("assigned");
  const res = await request(app).post(`/api/dispatcher/loads/${load.id}/cancel`).set("authorization", auth);
  expect(res.status).toBe(409);
  expect(res.body.error).toContain("unassign");
});

// A3-R21: `LoadNotFound` out of `applyStatusChange` maps to a 404 in the
// `reopen` handler's catch (dispatcherLoads.ts) — the load vanishing between
// the route's own `findUnique` and the transaction's re-read (a race the
// early `!load` guard above can't catch, since it already saw the row).
// Present in source and read by a reviewer, but only the sibling "answers
// 500 — not silence" test below ever exercised that catch, and only for an
// unrecognised error — never for this specific, named, reachable one.
it("reopen answers 404 — not the generic 500 — when the writer can't find the load anymore", async () => {
  const { auth, load } = await seedOrgLoad("canceled");
  const spy = vi.spyOn(loadWriterModule, "applyStatusChange")
    .mockRejectedValueOnce(new loadWriterModule.LoadNotFound(`load ${load.id} is gone`));
  const res = await request(app).post(`/api/dispatcher/loads/${load.id}/reopen`).set("authorization", auth);
  spy.mockRestore();
  expect(res.status).toBe(404);
  expect(res.body).toMatchObject({ error: expect.any(String) });
});

it("hides cancel/reopen from other orgs as 404", async () => {
  const { load } = await seedOrgLoad();
  const rivalOrg = await prisma.org.create({ data: { name: "Rival" } });
  const rival = await prisma.dispatcher.create({ data: { email: "r@x.com", passwordHash: "x", name: "R", orgId: rivalOrg.id } });
  const res = await request(app).post(`/api/dispatcher/loads/${load.id}/cancel`)
    .set("authorization", `Bearer ${signDispatcherAccess(rival.id)}`);
  expect(res.status).toBe(404);
});

// E1: POST /loads/:id/geocode is the recovery path after a provider is
// configured (or an address fixed). It placed the stop and left the writer's
// `can't place <role> "…" on the map` line standing, so the board kept the
// Attention pill for a stop that was on the map.
it("clears the stop's can't-place attention once it is placed", async () => {
  const { auth, load } = await seedOrgLoad();
  const stops = await prisma.loadStop.findMany({ where: { loadId: load.id }, orderBy: { sequence: "asc" } });
  await prisma.loadStop.updateMany({ where: { loadId: load.id }, data: { lat: null, lng: null, geocodeStatus: "pending" } });
  await prisma.agentUpdate.createMany({ data: [
    { loadId: load.id, atMs: BigInt(1), kind: "attention", text: `can't place ${stops[0].type} "Kansas City, MO" on the map` },
    { loadId: load.id, atMs: BigInt(2), kind: "attention", text: 'can\'t read RATE: blank' },
  ] });

  const res = await request(app).post(`/api/dispatcher/loads/${load.id}/geocode`).set("authorization", auth);
  expect(res.status).toBe(200);
  expect(res.body.resolved).toBe(2);
  const left = (await prisma.agentUpdate.findMany({ where: { loadId: load.id } })).map((a) => a.text);
  // Only the placement refusal goes; an unrelated aspect is nobody else's to clear.
  expect(left).toEqual(["can't read RATE: blank"]);
});

// --- R8/A3: the two writes that had no load guard ------------------------
//
// §7.3 is general: a write to a load another dispatcher holds is refused.
// /cancel deliberately stays unguarded — its own ruling comment: a
// cancellation is external reality that must land.

const holdFor = (orgId: string, loadId: string) =>
  prisma.loadLock.create({ data: { loadId, orgId, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });

it("refuses to reopen a load someone is editing on Their Board", async () => {
  const { org, auth, load } = await seedOrgLoad("canceled");
  await holdFor(org.id, load.id);
  const res = await request(app).post(`/api/dispatcher/loads/${load.id}/reopen`).set("authorization", auth);
  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" } });
  expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).status).toBe("canceled");
});

it("refuses to re-geocode a load someone is editing on Their Board", async () => {
  const { org, auth, load } = await seedOrgLoad();
  await prisma.loadStop.updateMany({ where: { loadId: load.id }, data: { lat: null, lng: null, geocodeStatus: "pending" } });
  await holdFor(org.id, load.id);
  const res = await request(app).post(`/api/dispatcher/loads/${load.id}/geocode`).set("authorization", auth);
  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" } });
  const stops = await prisma.loadStop.findMany({ where: { loadId: load.id } });
  expect(stops.every((s) => s.lat === null)).toBe(true);
});

it("still cancels a load someone is editing — a cancellation is external reality", async () => {
  const { org, auth, load } = await seedOrgLoad();
  await holdFor(org.id, load.id);
  const res = await request(app).post(`/api/dispatcher/loads/${load.id}/cancel`).set("authorization", auth);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("canceled");
});

// --- F6: the version moves for every Load write ---------------------------
//
// Without this, a board cell rendered before a cancel/reopen/PATCH still
// carried the version those writes never moved, so §7.4's backstop waved it
// through and the edit landed on top of them.
it("bumps the version on cancel, reopen and PATCH, so a stale board cell is then refused", async () => {
  const { org, auth, load } = await seedOrgLoad();
  await prisma.dispatcher.create({ data: { email: "board@x.com", passwordHash: "x", name: "Board", orgId: org.id } });
  expect(load.version).toBe(0);

  await request(app).patch(`/api/dispatcher/loads/${load.id}`).set("authorization", auth).send({ revenueCents: 45000 }).expect(200);
  expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).version).toBe(1);

  await request(app).post(`/api/dispatcher/loads/${load.id}/cancel`).set("authorization", auth).expect(200);
  expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).version).toBe(2);

  await request(app).post(`/api/dispatcher/loads/${load.id}/reopen`).set("authorization", auth).expect(200);
  expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).version).toBe(3);

  // The point of the bump: a board still holding version 0 is refused.
  const stale = await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set("authorization", auth)
    .send({ row: "top", key: "customer", value: "MINE", baseVersion: 0 });
  expect(stale.status).toBe(409);
  expect(stale.body).toMatchObject({ error: "STALE_VERSION", current: 3 });
});

// --- Plan A3: the Cockpit's load edit and reopen go through the one writer -
describe("the Cockpit's load edit goes through the writer (plan A3)", () => {
  it("traces every field it changed, geocodes the new stops, and bumps the version once", async () => {
    const { auth, load } = await seedOrgLoad();
    const res = await request(app).patch(`/api/dispatcher/loads/${load.id}`).set("authorization", auth).send({
      requiredEquip: "Reefer", commodity: "Frozen peas",
      stops: [
        { sequence: 1, type: "pickup", address: "Kansas City, MO", windowStart: "2026-07-14T15:00:00.000Z", windowEnd: "2026-07-14T17:00:00.000Z" },
        { sequence: 2, type: "delivery", address: "Dallas, TX", windowEnd: "2026-07-16T12:00:00.000Z" },
      ],
    });
    expect(res.status).toBe(200);
    const after = await prisma.load.findUnique({ where: { id: load.id }, include: { stops: { orderBy: { sequence: "asc" }, include: { appointment: true } } } });
    expect(after?.version).toBe(1);
    expect(after?.stops.map((s) => [s.address, s.geocodeStatus, s.appointment?.windowEnd?.toISOString() ?? null])).toEqual([
      ["Kansas City, MO", "ok", "2026-07-14T17:00:00.000Z"], ["Dallas, TX", "ok", "2026-07-16T12:00:00.000Z"],
    ]);
    const fields = (await prisma.loadChange.findMany({ where: { loadId: load.id } })).map((c) => c.field).sort();
    expect(fields).toEqual(["commodity", "requiredEquip", "stopSet"]);
  });

  it("reopen goes through the writer: traced, versioned, and refused while someone edits the load", async () => {
    const { auth, load } = await seedOrgLoad("canceled");
    await request(app).post(`/api/dispatcher/loads/${load.id}/reopen`).set("authorization", auth).expect(200);
    const row = await prisma.loadChange.findFirst({ where: { loadId: load.id, field: "status" } });
    expect([row?.before, row?.after, row?.source]).toEqual(["canceled", "open", "loadboard"]);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.version).toBe(1);
  });

  // F5: an unrecognised error out of the writer must never leave the handler
  // silent — Express 4 does not await async handlers, so an uncaught throw
  // used to answer with nothing at all, forever (the reopen button spinning
  // until the client gave up).
  it("reopen answers 500 — not silence — when the writer rejects with an unrecognised error", async () => {
    const { auth, load } = await seedOrgLoad("canceled");
    const spy = vi.spyOn(loadWriterModule, "applyStatusChange").mockRejectedValueOnce(new Error("boom"));
    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/reopen`).set("authorization", auth);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "INTERNAL" });
  });

  // Fix round 1: the writer rejects a stop set with duplicate sequences
  // (InvalidStopSet) — the route must answer 400 INVALID_STOP_SET, not the
  // generic 500 the catch-all would otherwise send.
  it("PATCH with duplicate stop sequences answers 400 INVALID_STOP_SET, writing nothing", async () => {
    const { auth, load } = await seedOrgLoad();
    const res = await request(app).patch(`/api/dispatcher/loads/${load.id}`).set("authorization", auth).send({
      stops: [
        { sequence: 1, type: "pickup", address: "Kansas City, MO" },
        { sequence: 1, type: "delivery", address: "Dallas, TX" },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "INVALID_STOP_SET" });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.version).toBe(0);
  });

  // F7: a no-op PATCH — values identical to what's already stored — must not
  // wake every other board with a frame carrying `fields: []` and a version
  // that never moved. Needs a real socket (the router fans out through
  // realtime.ts), so this goes through startServer(), not supertest.
  it("emits no realtime frame for a no-op PATCH", async () => {
    const { org, auth, load } = await seedOrgLoad();
    const disp = await prisma.dispatcher.findFirstOrThrow({ where: { orgId: org.id } });

    const { server, port } = await startServer();
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${signDispatcherAccess(disp.id)}`);
    await waitForOpen(ws);
    const messages = createMessageCollector(ws);

    try {
      const res = await fetch(`http://localhost:${port}/api/dispatcher/loads/${load.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ revenueCents: load.revenueCents, commodity: load.commodity }),
      });
      expect(res.status).toBe(200);
      await expect(messages.next(400)).rejects.toThrow(/timed out/);
    } finally {
      await stopServer(server, [ws]);
    }
  });
});
