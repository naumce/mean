import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

// PATCH one cell: the write half of the board. The mapping itself is proven
// in board-cell-write.test.ts; this is about the database, the org gate, and
// what a dispatcher is told when a cell is refused.
const CELL = "/api/dispatcher/broker-board/loads";

async function setup() {
  const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
  await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
  const { token } = await loginDispatcher("b@x.com", "pw");
  const load = await prisma.load.create({
    data: {
      orgId: org.id, requiredEquip: "DryVan", revenueCents: 400000, soldRateCents: 360000,
      bolNumber: "0500001", customerName: "ACME FOODS", apptText: "PU: 07/13 - 13:00\nDEL: 07/15 - 11:00",
      stops: { create: [{ sequence: 1, type: "pickup", address: "Henderson, NV 89074" }, { sequence: 2, type: "delivery", address: "Dallas, TX 75236" }] },
    },
  });
  return { org, token, load };
}

// R2: `cellSchema` now REQUIRES `baseVersion` (spec §7.4). Every existing
// call in this file wrote exactly one fresh load, so a default of 0 here is
// the correct rebase for all of them; a test that writes the same load twice
// in a row overrides it explicitly on the second call (see below).
const patch = (token: string, loadId: string, body: Record<string, unknown>) =>
  request(app).patch(`${CELL}/${loadId}/cell`).set("Authorization", `Bearer ${token}`).send({ baseVersion: 0, ...body });

describe("PATCH /dispatcher/broker-board/loads/:id/cell", () => {
  beforeEach(resetDb);

  it("writes a text cell and answers with the load's fresh rows", async () => {
    const { token, load } = await setup();
    const res = await patch(token, load.id, { row: "top", key: "customer", value: "NEW CUSTOMER" });
    expect(res.status).toBe(200);
    // The board redraws from the answer, so the answer is the row itself —
    // not an "ok" the client has to guess the consequences of.
    expect(res.body.load.top.customer).toBe("NEW CUSTOMER");
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.customerName).toBe("NEW CUSTOMER");
  });

  it("recomputes PROFIT from the rate it was given", async () => {
    const { token, load } = await setup();
    const res = await patch(token, load.id, { row: "top", key: "rate", value: "$4,500.00" });
    expect(res.status).toBe(200);
    expect(res.body.load.top.rate).toBe("$4,500.00");
    expect(res.body.load.top.profit).toBe("$900.00");
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.revenueCents).toBe(450000);
  });

  it("refuses an amount it cannot read, and changes nothing", async () => {
    const { token, load } = await setup();
    const res = await patch(token, load.id, { row: "top", key: "rate", value: "ask john" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not an amount/);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.revenueCents).toBe(400000);
  });

  it("refuses PROFIT, the MC label and the agent's column with a sentence", async () => {
    const { token, load } = await setup();
    for (const body of [
      { row: "top", key: "profit", value: "1" },
      { row: "top", key: "mc", value: "1000001" },
      { row: "top", key: "agent", value: "fine" },
    ]) {
      const res = await patch(token, load.id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.length).toBeGreaterThan(10);
    }
  });

  it("finds the org's carrier by name, and makes one only when there is none", async () => {
    const { org, token, load } = await setup();
    const existing = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    await patch(token, load.id, { row: "bottom", key: "customer", value: "Blue Road LLC" }).expect(200);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.carrierId).toBe(existing.id);
    expect(await prisma.carrier.count({ where: { orgId: org.id } })).toBe(1);

    const res = await patch(token, load.id, { row: "bottom", key: "customer", value: "Red Line Transport", baseVersion: 1 });
    expect(res.status).toBe(200);
    expect(res.body.load.bottom.customer).toBe("Red Line Transport");
    expect(await prisma.carrier.count({ where: { orgId: org.id } })).toBe(2);
  });

  it("writes a city without losing the ZIP beside it", async () => {
    const { token, load } = await setup();
    const res = await patch(token, load.id, { row: "top", key: "pickupCity", value: "Las Vegas, NV" });
    expect(res.status).toBe(200);
    expect(res.body.load.top.pickupCity).toBe("Las Vegas, NV");
    expect(res.body.load.top.puZip).toBe("89074");
    const stop = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "pickup" } });
    expect(stop?.address).toBe("Las Vegas, NV 89074");
  });

  it("replaces one appointment line and keeps the other", async () => {
    const { token, load } = await setup();
    await patch(token, load.id, { row: "bottom", key: "appt", value: "DEL: 07/16 - 09:00" }).expect(200);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.apptText).toBe("PU: 07/13 - 13:00\nDEL: 07/16 - 09:00");
  });

  it("keeps a cell that has no column of its own instead of dropping it", async () => {
    const { token, load } = await setup();
    await patch(token, load.id, { row: "top", key: "extra", source: "TRAILER TYPE", value: "REEFER" }).expect(200);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.extras).toEqual({ "TRAILER TYPE": "REEFER" });
    // Emptying it takes the key back out rather than storing "".
    await patch(token, load.id, { row: "top", key: "extra", source: "TRAILER TYPE", value: "", baseVersion: 1 }).expect(200);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.extras).toBeNull();
  });

  it("never writes to another org's load", async () => {
    const { token } = await setup();
    const other = await prisma.org.create({ data: { name: "Other", timezone: "UTC" } });
    const theirs = await prisma.load.create({ data: { orgId: other.id, requiredEquip: "DryVan", revenueCents: 1, customerName: "THEIRS" } });
    const res = await patch(token, theirs.id, { row: "top", key: "customer", value: "MINE NOW" });
    expect(res.status).toBe(404);
    expect((await prisma.load.findUnique({ where: { id: theirs.id } }))?.customerName).toBe("THEIRS");
  });

  it("refuses a body that is not a cell", async () => {
    const { token, load } = await setup();
    await patch(token, load.id, { row: "sideways", key: "bol", value: "x" }).expect(400);
    await patch(token, load.id, { row: "top", value: "x" }).expect(400);
  });

  it("bumps the version, traces the cell, and renders the carrier line's LOAD# from boardLoadNo", async () => {
    const { token, load } = await setup();
    const res = await patch(token, load.id, { row: "bottom", key: "loadNo", value: "145205" });
    expect(res.status).toBe(200);
    expect(res.body.load.version).toBe(1);
    expect(res.body.load.bottom.loadNo).toBe("145205");          // defect 1: it used to vanish on refresh
    const trace = await prisma.loadChange.findMany({ where: { loadId: load.id } });
    expect(trace.map((t) => [t.field, t.after, t.source])).toEqual([["boardLoadNo", "145205", "board"]]);
  });

  it("parses an APPT cell into a real appointment the Cockpit can read", async () => {
    const { token, load } = await setup();
    await patch(token, load.id, { row: "top", key: "shipDate", value: "7/13/2026" }).expect(200);
    await patch(token, load.id, { row: "bottom", key: "appt", value: "DEL: 07/17 - 10:00", baseVersion: 1 }).expect(200);
    const del = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "delivery" }, include: { appointment: true } });
    expect(del?.appointment?.windowEnd.toISOString()).toBe("2026-07-17T15:00:00.000Z");
  });

  it("geocodes a city typed on the board", async () => {
    const { token, load } = await setup();
    await patch(token, load.id, { row: "top", key: "pickupCity", value: "Omaha, NE" }).expect(200);
    const pu = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "pickup" } });
    expect(pu?.lat).not.toBeNull();
    expect(pu?.geocodeStatus).toBe("ok");
  });

  it("moves status from UPDATE on a brokered load, and refuses on one of ours with a sentence", async () => {
    const { token, load } = await setup();
    await patch(token, load.id, { row: "bottom", key: "customer", value: "Blue Road LLC" }).expect(200);
    const res = await patch(token, load.id, { row: "top", key: "update", value: "DELIVERED 07/17/2026", baseVersion: 1 });
    expect(res.status).toBe(200);
    expect(res.body.load.status).toBe("delivered");
    expect(res.body.statusRefused).toBeNull();
  });
});

describe("PATCH cell — locks and the version backstop (spec §7)", () => {
  beforeEach(resetDb);

  it("requires baseVersion", async () => {
    const { token, load } = await setup();
    // Deliberately bypasses the `patch` helper, which defaults baseVersion —
    // this is the one call in the file that has to omit it.
    const res = await request(app).patch(`${CELL}/${load.id}/cell`).set("Authorization", `Bearer ${token}`).send({ row: "top", key: "customer", value: "A" });
    expect(res.status).toBe(400);
  });

  it("refuses a stale view with both values and the fresh row, then accepts the re-based write", async () => {
    const { token, load } = await setup();
    await patch(token, load.id, { row: "top", key: "customer", value: "THEIRS", baseVersion: 0 }).expect(200);
    const stale = await patch(token, load.id, { row: "top", key: "customer", value: "MINE", baseVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "STALE_VERSION", current: 1, theirs: "THEIRS" });
    expect(stale.body.load).toMatchObject({ id: load.id, version: 1 });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.customerName).toBe("THEIRS");
    const rebased = await patch(token, load.id, { row: "top", key: "customer", value: "MINE", baseVersion: 1 });
    expect(rebased.status).toBe(200);
    expect(rebased.body.version).toBe(2);
  });

  it("refuses a cell on a load someone else is editing, naming them", async () => {
    const { org, token, load } = await setup();
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    const res = await patch(token, load.id, { row: "top", key: "customer", value: "A", baseVersion: 0 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" }, message: "Maria is editing this load" });
  });

  // R12b: an EXTRA column is not one of the rendered `top`/`bottom` keys, so
  // the conflict panel used to offer "take theirs" for a blank it invented.
  it("answers the current EXTRA value in `theirs` when an extra column is stale", async () => {
    const { token, load } = await setup();
    await patch(token, load.id, { row: "top", key: "extra", source: "TRAILER TYPE", value: "REEFER", baseVersion: 0 }).expect(200);
    const stale = await patch(token, load.id, { row: "top", key: "extra", source: "TRAILER TYPE", value: "DRY VAN", baseVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "STALE_VERSION", current: 1, theirs: "REEFER" });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.extras).toEqual({ "TRAILER TYPE": "REEFER" });
  });

  it("answers the carrier line's own extra value in `theirs`", async () => {
    const { token, load } = await setup();
    await patch(token, load.id, { row: "bottom", key: "extra", source: "TRAILER TYPE", value: "53 REEFER", baseVersion: 0 }).expect(200);
    const stale = await patch(token, load.id, { row: "bottom", key: "extra", source: "TRAILER TYPE", value: "48 DRY", baseVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "STALE_VERSION", theirs: "53 REEFER" });
  });
});

// F1(d): Express 4 with no error middleware sends NO response for a rejected
// async handler — the dispatcher watches a spinner forever. Every board write
// route now ends its catch in a clean 500 instead of re-throwing.
describe("PATCH cell — an unmodelled failure is a 500, never a hung request", () => {
  beforeEach(resetDb);

  it("answers 500 JSON when the write throws something nobody modelled", async () => {
    const { token, load } = await setup();
    // Thrown from the writer's own transaction — the same place a dead
    // connection or an unmodelled constraint would surface.
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("boom"));
    let res;
    try {
      res = await patch(token, load.id, { row: "top", key: "customer", value: "A", baseVersion: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "That did not go through — try again" });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.customerName).toBe("ACME FOODS");
  });
});
