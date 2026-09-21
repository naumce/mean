import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { confirmImport } from "../src/lib/brokerImport.js";
import { hashPassword } from "../src/lib/password.js";
import { brokerWorkbook } from "./fixtures/brokerBoard.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

async function setup() {
  const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Los_Angeles" } });
  await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
  const { token } = await loginDispatcher("b@x.com", "pw");
  await confirmImport(org.id, brokerWorkbook());
  // Task 8: confirmImport now derives status from the fixture's UPDATE text
  // through the writer, so the four assigned loads land as "delivered", not
  // the old hardcoded "open" (task-8-brief.md's context note). These tests
  // exercise the bulk archive/delete routes' own eligibility logic, not
  // import status derivation, so reset to a known "open" baseline here.
  await prisma.load.updateMany({ where: { orgId: org.id }, data: { status: "open" } });
  const loads = await prisma.load.findMany({ where: { orgId: org.id }, orderBy: { boardLine: "asc" } });
  return { org, auth: { Authorization: `Bearer ${token}` }, loads };
}

describe("bulk archive / unarchive", () => {
  beforeEach(resetDb);

  it("archives and unarchives a selection atomically", async () => {
    const { auth, loads } = await setup();
    const ids = [loads[0].id, loads[1].id];
    const a = await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids, archived: true });
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ updated: 2 });
    expect((await prisma.load.findMany({ where: { id: { in: ids } } })).map((l) => l.status)).toEqual(["archived", "archived"]);
    const u = await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids, archived: false });
    expect(u.body).toEqual({ updated: 2 });
    // Final-fix B4: unarchiving no longer LEAVES a load at "open". It sets
    // open and then hands the load to the writer with `force`, so the stored
    // UPDATE text decides — these two say "DELIVERED …" and have a carrier,
    // so they come back delivered. Writing "open" and stopping there lost an
    // `assigned`/`canceled` load's real status and left the row carrying a
    // permanent `record.update` dot against a status nothing had derived.
    expect((await prisma.load.findMany({ where: { id: { in: ids } } })).map((l) => l.status)).toEqual(["delivered", "delivered"]);
  });

  // L9 (spec §12: every version bump has a trace explaining it). Archiving
  // used to bump `Load.version` and flip `status` through a bare
  // `updateMany`, with no `LoadChange` row to say who did it or why.
  it("archiving writes exactly one LoadChange row naming the actor, and the version bumps by exactly one", async () => {
    const { auth, loads } = await setup();
    const target = loads[0];
    const before = await prisma.load.findUniqueOrThrow({ where: { id: target.id } });

    const res = await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: [target.id], archived: true });
    expect(res.status).toBe(200);

    const after = await prisma.load.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.version).toBe(before.version + 1);
    expect(after.status).toBe("archived");

    // Scoped to `after: "archived"` so an import-time trace row (from
    // `setup()`'s own confirmImport) can never be mistaken for this one.
    const trace = await prisma.loadChange.findMany({ where: { loadId: target.id, field: "status", after: "archived" } });
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ before: before.status, after: "archived", actorName: "B", source: "board" });
  });

  // A4-R17: the archive branch got its trace row in A4's final wave; unarchive
  // (archived -> open) still wrote none. Mirrors the archive test above
  // exactly — same shape, opposite direction.
  //
  // A fresh load with no UPDATE text and no carrier, not one of setup()'s
  // imported rows: those carry UPDATE text that re-derives past "open" on
  // unarchive (see "re-derives status..." below), which bumps the version a
  // SECOND time for a different reason and would make "exactly one" false for
  // the wrong cause. This isolates the archived->open transition itself.
  it("unarchiving writes exactly one LoadChange row naming the actor, and the version bumps by exactly one", async () => {
    const { org, auth } = await setup();
    const load = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME", status: "open" },
    });
    await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: [load.id], archived: true });
    const before = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(before.status).toBe("archived");

    const res = await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: [load.id], archived: false });
    expect(res.status).toBe(200);

    const after = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(after.status).toBe("open");
    expect(after.version).toBe(before.version + 1);

    // Scoped to `after: "open"` so the archive step's OWN trace row (written
    // moments ago, open -> archived) is never mistaken for this one.
    const trace = await prisma.loadChange.findMany({ where: { loadId: load.id, field: "status", after: "open" } });
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ before: "archived", after: "open", actorName: "B", source: "board" });
  });

  // B4 as the brief states it: a SCHEDULED load with a carrier comes back
  // assigned, not open.
  it("re-derives status from the stored UPDATE text when a load is unarchived", async () => {
    const { org, auth } = await setup();
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    const load = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME", carrierId: carrier.id, updateText: "SCHEDULED", status: "open" },
    });
    await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: [load.id], archived: true }).expect(200);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.status).toBe("archived");
    await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: [load.id], archived: false }).expect(200);
    const after = await prisma.load.findUnique({ where: { id: load.id } });
    expect(after?.status).toBe("assigned");
    // Archiving and unarchiving are both changes to the record: the version moves.
    expect(after?.version).toBeGreaterThanOrEqual(2);
  });

  it("refuses the whole request when one load is ineligible, naming it", async () => {
    const { auth, loads } = await setup();
    await prisma.load.update({ where: { id: loads[2].id }, data: { status: "in_progress" } });
    const r = await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: [loads[0].id, loads[2].id], archived: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/145197/);
    expect((await prisma.load.findUnique({ where: { id: loads[0].id } }))!.status).toBe("open");
  });

  it("refuses ids outside the org without touching anything", async () => {
    const { auth, loads } = await setup();
    const other = await prisma.org.create({ data: { name: "Other", timezone: "America/Chicago" } });
    const foreign = await prisma.load.create({ data: { orgId: other.id, requiredEquip: "DryVan", revenueCents: 0 } });
    const r = await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: [loads[0].id, foreign.id], archived: true });
    expect(r.status).toBe(404);
    expect((await prisma.load.findUnique({ where: { id: loads[0].id } }))!.status).toBe("open");
  });

  it("validates the body", async () => {
    const { auth } = await setup();
    expect((await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: [], archived: true })).status).toBe(400);
    expect((await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: ["x"] })).status).toBe(400);
  });

  // Final review finding 10: an over-cap request went back as raw zod text
  // ("ids: Array must contain at most 500 element(s)") straight into the
  // dispatcher's red banner. Same 400, product copy.
  it("says the selection cap in plain English, not raw schema text", async () => {
    const { auth } = await setup();
    const over = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
    const a = await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: over(501), archived: true });
    expect(a.status).toBe(400);
    expect(a.body.error).toBe("Select at most 500 loads");
    const d = await request(app).post("/api/dispatcher/broker-board/loads/delete").set(auth).send({ ids: over(501) });
    expect(d.status).toBe(400);
    expect(d.body.error).toBe("Select at most 500 loads");
    const e = await request(app).post("/api/dispatcher/broker-board/export").set(auth).send({ ids: over(2001) });
    expect(e.status).toBe(400);
    expect(e.body.error).toBe("Select at most 2000 loads");
  });

  // Final review finding 11: `Load.externalId` may carry the internal
  // `board:` prefix when a TMS fleet load already owns that LOAD#. A refusal
  // must name the number the dispatcher typed, never our key.
  it("names a refused load by its LOAD#, never the internal board: key", async () => {
    const { auth, loads } = await setup();
    await prisma.load.update({ where: { id: loads[0].id }, data: { externalId: "board:145197", status: "in_progress" } });
    const r = await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: [loads[0].id], archived: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("145197");
    expect(r.body.error).not.toContain("board:");
  });
});

describe("bulk actions on a held load", () => {
  beforeEach(resetDb);

  it("refuses archive, delete and duplicate while someone else is editing one of the loads", async () => {
    const { org, auth, loads } = await setup();
    await prisma.loadLock.create({ data: { loadId: loads[0].id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    for (const call of [
      request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: [loads[0].id, loads[1].id], archived: true }),
      request(app).post("/api/dispatcher/broker-board/loads/delete").set(auth).send({ ids: [loads[0].id] }),
      request(app).post("/api/dispatcher/broker-board/loads/duplicate").set(auth).send({ ids: [loads[0].id] }),
    ]) {
      const res = await call;
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" } });
    }
    expect((await prisma.load.findUnique({ where: { id: loads[1].id } }))?.status).not.toBe("archived");
  });
});

describe("bulk actions when the database misbehaves", () => {
  beforeEach(resetDb);

  it("answers a clean 500 instead of hanging when the transaction throws something unexpected", async () => {
    const { auth, loads } = await setup();
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("connection reset"));
    const r = await request(app).post("/api/dispatcher/broker-board/loads/delete").set(auth).send({ ids: [loads[4].id] });
    spy.mockRestore();
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/nothing was changed/);
    expect(await prisma.load.count()).toBe(5);
  });
});

describe("bulk delete", () => {
  beforeEach(resetDb);

  it("deletes open loads with their stops, appointments and agent lines, in one go", async () => {
    const { auth, loads } = await setup();
    const ids = [loads[3].id, loads[4].id];
    const r = await request(app).post("/api/dispatcher/broker-board/loads/delete").set(auth).send({ ids });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: 2 });
    expect(await prisma.load.count({ where: { id: { in: ids } } })).toBe(0);
    expect(await prisma.loadStop.count({ where: { loadId: { in: ids } } })).toBe(0);
    expect(await prisma.agentUpdate.count({ where: { loadId: { in: ids } } })).toBe(0);
    expect(await prisma.load.count()).toBe(3);
  });

  it("refuses a load with an assignment or a live status, naming it, and deletes nothing", async () => {
    const { org, auth, loads } = await setup();
    const driver = await prisma.driver.create({ data: { email: "d@x.com", passwordHash: "x", name: "D", orgId: org.id } });
    await prisma.assignment.create({ data: { orgId: org.id, loadId: loads[0].id, driverId: driver.id, plannedStart: new Date(), plannedEnd: new Date(), deadheadMi: 0, loadedMi: 0, marginCents: 0, savedMi: 0, driveMin: 0, onDutyMin: 0, tookBreak: false, status: "assigned" } });
    const r = await request(app).post("/api/dispatcher/broker-board/loads/delete").set(auth).send({ ids: [loads[0].id, loads[1].id] });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/145205/);
    expect(await prisma.load.count()).toBe(5);
  });

  it("refuses to delete when a load's eligibility changed since the read (race), and deletes nothing", async () => {
    const { org, auth, loads } = await setup();
    const driver = await prisma.driver.create({ data: { email: "race@x.com", passwordHash: "x", name: "Race", orgId: org.id } });
    // The DB row really is assigned by the time the write runs...
    await prisma.assignment.create({ data: { orgId: org.id, loadId: loads[0].id, driverId: driver.id, plannedStart: new Date(), plannedEnd: new Date(), deadheadMi: 0, loadedMi: 0, marginCents: 0, savedMi: 0, driveMin: 0, onDutyMin: 0, tookBreak: false, status: "assigned" } });
    // ...but the route's pre-flight eligibility snapshot (ownedLoads) is
    // stubbed to look stale: open, unassigned — as if the request had read
    // it just before the assignment above landed.
    const stale = { ...loads[0], assignment: null };
    const spy = vi.spyOn(prisma.load, "findMany").mockImplementationOnce((async () => [stale]) as unknown as typeof prisma.load.findMany);
    const r = await request(app).post("/api/dispatcher/broker-board/loads/delete").set(auth).send({ ids: [loads[0].id] });
    spy.mockRestore();
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/reload and try again/);
    expect(await prisma.load.count()).toBe(5);
  });
});
