import { Prisma } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

// L7: a one-shot middleware — same shape as tests/vanish.ts (`$use` has no
// deregister, so arming is explicit and the middleware disarms itself the
// moment it fires) — that lands a concurrent, status-untouched version bump
// on a load exactly between the undo route's `fresh` read and its own write.
// The route's own `updateMany` guards on `status`, not `version`, so this
// concurrent bump still lands underneath it — and proves whether the route
// answers with the version it actually wrote or one it merely computed.
let armedRaceLoadId: string | null = null;
prisma.$use(async (params: Prisma.MiddlewareParams, next: (p: Prisma.MiddlewareParams) => Promise<unknown>) => {
  if (armedRaceLoadId && params.model === "LoadChange" && params.action === "findFirst") {
    const loadId = armedRaceLoadId;
    armedRaceLoadId = null;
    await prisma.load.update({ where: { id: loadId }, data: { version: { increment: 1 } } });
  }
  return next(params);
});

async function setup() {
  const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
  await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "Maria", orgId: org.id } });
  const { token } = await loginDispatcher("b@x.com", "pw");
  const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
  const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME", carrierId: carrier.id } });
  return { org, auth: { Authorization: `Bearer ${token}` }, load };
}

describe("update-rules", () => {
  beforeEach(resetDb);

  it("seeds their words on first read, and replaces them on PUT", async () => {
    const { auth } = await setup();
    const seeded = await request(app).get("/api/dispatcher/update-rules").set(auth);
    expect(seeded.status).toBe(200);
    expect(seeded.body.rules.map((r: { prefix: string }) => r.prefix)).toContain("DELIVERED");
    const put = await request(app).put("/api/dispatcher/update-rules").set(auth).send({ rules: [{ prefix: "DONE", status: "delivered" }, { prefix: "PENDING", status: "open", enabled: false }] });
    expect(put.status).toBe(200);
    const after = await request(app).get("/api/dispatcher/update-rules").set(auth);
    expect(after.body.rules).toEqual([{ prefix: "DONE", status: "delivered", enabled: true }, { prefix: "PENDING", status: "open", enabled: false }]);
  });

  it("refuses a status the platform does not have, and a duplicate prefix", async () => {
    const { auth } = await setup();
    await request(app).put("/api/dispatcher/update-rules").set(auth).send({ rules: [{ prefix: "X", status: "teleported" }] }).expect(400);
    await request(app).put("/api/dispatcher/update-rules").set(auth).send({ rules: [{ prefix: "DONE", status: "delivered" }, { prefix: "done", status: "canceled" }] }).expect(400);
  });

  // C2: an empty PUT deletes every rule, and the next read re-seeds the
  // defaults (that re-seeding IS the documented semantics of `rulesFor`). The
  // reply used to say `{rules: []}` — a state the org never actually had.
  it("answers an emptied set with the defaults it will have, not with nothing", async () => {
    const { auth } = await setup();
    const put = await request(app).put("/api/dispatcher/update-rules").set(auth).send({ rules: [] });
    expect(put.status).toBe(200);
    expect(put.body.rules.map((r: { prefix: string }) => r.prefix)).toContain("DELIVERED");
    const after = await request(app).get("/api/dispatcher/update-rules").set(auth);
    expect(after.body.rules).toEqual(put.body.rules);
  });

  it("catches a duplicate prefix that only differs by internal whitespace", async () => {
    const { auth } = await setup();
    await request(app).put("/api/dispatcher/update-rules").set(auth).send({ rules: [{ prefix: "PICKED UP", status: "in_progress" }, { prefix: "PICKED  UP", status: "assigned" }] }).expect(400);
  });
});

describe("changes and undo", () => {
  beforeEach(resetDb);

  it("lists what changed, newest first, and undoes the last text-driven status", async () => {
    const { auth, load } = await setup();
    await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth).send({ row: "top", key: "update", value: "DELIVERED 07/17/2026", baseVersion: 0 }).expect(200);
    const list = await request(app).get(`/api/dispatcher/loads/${load.id}/changes`).set(auth);
    expect(list.status).toBe(200);
    expect(list.body.changes[0]).toMatchObject({ field: "status", before: "open", after: "delivered", note: "DELIVERED 07/17/2026", actorName: "Maria", source: "board" });
    const undo = await request(app).post(`/api/dispatcher/loads/${load.id}/undo-status`).set(auth);
    expect(undo.status).toBe(200);
    expect(undo.body.status).toBe("open");
    // L7: the version in the answer is the one the database actually holds,
    // not an arithmetic guess.
    expect(undo.body.version).toBe((await prisma.load.findUnique({ where: { id: load.id } }))?.version);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.status).toBe("open");
    const again = await request(app).get(`/api/dispatcher/loads/${load.id}/changes`).set(auth);
    expect(again.body.changes[0]).toMatchObject({ field: "status", before: "delivered", after: "open", source: "board" });
  });

  // L7: `updateMany`'s guard is on `status`, not `version` — a concurrent
  // bump that never touches status (an import, a board cell on another
  // field) still lands underneath the undo. The route used to answer with
  // `fresh.version + 1`, computed from a read taken BEFORE that concurrent
  // bump; this proves the answer instead matches whatever version the write
  // actually produced.
  it("emits the version it actually wrote, not one computed before a concurrent bump landed", async () => {
    const { auth, load } = await setup();
    await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth)
      .send({ row: "top", key: "update", value: "DELIVERED 07/17/2026", baseVersion: 0 }).expect(200);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).version).toBe(1);

    armedRaceLoadId = load.id;
    const undo = await request(app).post(`/api/dispatcher/loads/${load.id}/undo-status`).set(auth);
    expect(armedRaceLoadId).toBeNull(); // the middleware fired — otherwise this test proves nothing

    expect(undo.status).toBe(200);
    const fresh = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(fresh.status).toBe("open");
    // 1 (the cell write) + 1 (the concurrent bump injected mid-transaction) +
    // 1 (the undo's own write) — `fresh.version + 1` computed before the
    // concurrent bump would have answered 2, one short of the truth.
    expect(fresh.version).toBe(3);
    expect(undo.body.version).toBe(3);
  });

  // C1: the undo wrote its own `LoadChange{field:"status", note:"undo"}`,
  // which the NEXT undo then found and reverted — two clicks ping-ponged the
  // load between delivered and open forever.
  it("refuses a second undo instead of ping-ponging the status back", async () => {
    const { auth, load } = await setup();
    await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth).send({ row: "top", key: "update", value: "DELIVERED 07/17/2026", baseVersion: 0 }).expect(200);
    await request(app).post(`/api/dispatcher/loads/${load.id}/undo-status`).set(auth).expect(200);
    const second = await request(app).post(`/api/dispatcher/loads/${load.id}/undo-status`).set(auth);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/Nothing to undo/);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.status).toBe("open");
  });

  it("refuses an undo when there is nothing to undo, or when our driver runs the load", async () => {
    const { org, auth, load } = await setup();
    const none = await request(app).post(`/api/dispatcher/loads/${load.id}/undo-status`).set(auth);
    expect(none.status).toBe(409);
    await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth).send({ row: "top", key: "update", value: "DELIVERED", baseVersion: 0 }).expect(200);
    const driver = await prisma.driver.create({ data: { email: "j@x.com", passwordHash: "x", name: "Jake", orgId: org.id } });
    await prisma.assignment.create({ data: { orgId: org.id, loadId: load.id, driverId: driver.id, status: "dispatched", plannedStart: new Date(), plannedEnd: new Date() } });
    const blocked = await request(app).post(`/api/dispatcher/loads/${load.id}/undo-status`).set(auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/Cockpit/);
  });

  it("refuses an undo when the load's status changed since it was last listed", async () => {
    const { auth, load } = await setup();
    await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth).send({ row: "top", key: "update", value: "DELIVERED", baseVersion: 0 }).expect(200);
    await request(app).get(`/api/dispatcher/loads/${load.id}/changes`).set(auth).expect(200);
    // A concurrent write — another dispatcher, an import, the board — moves
    // the status again before this undo request reaches the server.
    await prisma.load.update({ where: { id: load.id }, data: { status: "canceled" } });
    const changesBefore = await prisma.loadChange.count({ where: { loadId: load.id } });
    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/undo-status`).set(auth);
    expect(res.status).toBe(409);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.status).toBe("canceled");
    expect(await prisma.loadChange.count({ where: { loadId: load.id } })).toBe(changesBefore);
  });

  it("never shows or undoes another org's load", async () => {
    const { auth } = await setup();
    const other = await prisma.org.create({ data: { name: "Other", timezone: "UTC" } });
    const theirs = await prisma.load.create({ data: { orgId: other.id, requiredEquip: "DryVan", revenueCents: 0 } });
    await request(app).get(`/api/dispatcher/loads/${theirs.id}/changes`).set(auth).expect(404);
    await request(app).post(`/api/dispatcher/loads/${theirs.id}/undo-status`).set(auth).expect(404);
  });

  // A7/F5 — spec §7.3: a write to a load another dispatcher holds is
  // refused, and an undo is a write. This route reached the record and the
  // trace straight past the gate every board route goes through.
  it("refuses an undo on a load another dispatcher is editing, naming them", async () => {
    const { org, auth, load } = await setup();
    await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth).send({ row: "top", key: "update", value: "DELIVERED", baseVersion: 0 }).expect(200);
    const changesBefore = await prisma.loadChange.count({ where: { loadId: load.id } });
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-jake", dispatcherName: "Jake", expiresAt: new Date(Date.now() + 60_000) } });

    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/undo-status`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Jake" }, message: "Jake is editing this load" });
    // Nothing moved and nothing was traced.
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.status).toBe("delivered");
    expect(await prisma.loadChange.count({ where: { loadId: load.id } })).toBe(changesBefore);
  });

  it("allows the undo when the lock is the undoer's own", async () => {
    const { org, auth, load } = await setup();
    const me = await prisma.dispatcher.findFirstOrThrow({ where: { orgId: org.id } });
    await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth).send({ row: "top", key: "update", value: "DELIVERED", baseVersion: 0 }).expect(200);
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: me.id, dispatcherName: me.name, expiresAt: new Date(Date.now() + 60_000) } });
    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/undo-status`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("open");
  });
});
