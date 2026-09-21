import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

// A paste is many cells at once. All of them land or none of them do: a
// dispatcher who pasted a block and got two thirds of it has a board that
// matches neither what they had nor what they meant.
async function setup() {
  const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
  await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
  const { token } = await loginDispatcher("b@x.com", "pw");
  const mk = (bol: string, line: number) =>
    prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 100000, soldRateCents: 90000, bolNumber: bol, customerName: "OLD", boardLine: line } });
  const loads = [await mk("0500001", 1), await mk("0500002", 2)];
  return { org, auth: { Authorization: `Bearer ${token}` }, loads };
}

const paste = (auth: Record<string, string>, cells: unknown[]) =>
  request(app).post("/api/dispatcher/broker-board/cells").set(auth).send({ cells });

describe("POST /dispatcher/broker-board/cells", () => {
  beforeEach(resetDb);

  it("writes a block of cells across rows and answers with every load it touched", async () => {
    const { auth, loads } = await setup();
    const res = await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "customer", value: "ACME FOODS", baseVersion: 0 },
      { loadId: loads[0].id, row: "top", key: "rate", value: "$4,000.00", baseVersion: 0 },
      { loadId: loads[1].id, row: "top", key: "customer", value: "BETA CORP", baseVersion: 0 },
      { loadId: loads[1].id, row: "top", key: "rate", value: "2500", baseVersion: 0 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.loads).toHaveLength(2);
    expect(res.body.loads.map((l: { top: { customer: string } }) => l.top.customer)).toEqual(["ACME FOODS", "BETA CORP"]);
    expect(res.body.loads[0].top.profit).toBe("$3,100.00");
    expect((await prisma.load.findUnique({ where: { id: loads[1].id } }))?.revenueCents).toBe(250000);
  });

  it("keeps every cell when several land on the same load", async () => {
    // Both of these write `extras`, and both write `apptText`. Applied from a
    // stale snapshot, the second would erase the first.
    const { auth, loads } = await setup();
    await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "extra", source: "TRAILER TYPE", value: "REEFER", baseVersion: 0 },
      { loadId: loads[0].id, row: "top", key: "extra", source: "TEMP", value: "-10", baseVersion: 0 },
      { loadId: loads[0].id, row: "top", key: "appt", value: "PU: 07/13 - 13:00", baseVersion: 0 },
      { loadId: loads[0].id, row: "bottom", key: "appt", value: "DEL: 07/15 - 11:00", baseVersion: 0 },
    ]).expect(200);
    const after = await prisma.load.findUnique({ where: { id: loads[0].id } });
    expect(after?.extras).toEqual({ "TRAILER TYPE": "REEFER", TEMP: "-10" });
    expect(after?.apptText).toBe("PU: 07/13 - 13:00\nDEL: 07/15 - 11:00");
  });

  it("refuses the whole paste when one cell cannot be read, and writes nothing", async () => {
    const { auth, loads } = await setup();
    const res = await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "customer", value: "ACME FOODS", baseVersion: 0 },
      { loadId: loads[1].id, row: "top", key: "rate", value: "whatever john says", baseVersion: 0 },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not an amount/);
    // The good cell in the same paste did not land either.
    expect((await prisma.load.findUnique({ where: { id: loads[0].id } }))?.customerName).toBe("OLD");
  });

  it("refuses a paste that reaches outside the org, and writes nothing", async () => {
    const { auth, loads } = await setup();
    const other = await prisma.org.create({ data: { name: "Other", timezone: "UTC" } });
    const theirs = await prisma.load.create({ data: { orgId: other.id, requiredEquip: "DryVan", revenueCents: 1, customerName: "THEIRS" } });
    const res = await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "customer", value: "MINE", baseVersion: 0 },
      { loadId: theirs.id, row: "top", key: "customer", value: "MINE NOW", baseVersion: 0 },
    ]);
    expect(res.status).toBe(404);
    expect((await prisma.load.findUnique({ where: { id: theirs.id } }))?.customerName).toBe("THEIRS");
    expect((await prisma.load.findUnique({ where: { id: loads[0].id } }))?.customerName).toBe("OLD");
  });

  it("says how much is too much rather than truncating the paste", async () => {
    const { auth, loads } = await setup();
    const cells = Array.from({ length: 501 }, () => ({ loadId: loads[0].id, row: "top", key: "customer", value: "X" }));
    const res = await paste(auth, cells);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 500 cells/i);
  });

  it("refuses an empty paste", async () => {
    const { auth } = await setup();
    await paste(auth, []).expect(400);
  });

  it("bumps each touched load's version exactly once per paste", async () => {
    const { auth, loads } = await setup();
    // Two cells on load A that BOTH change something ("1000" equalled the
    // seeded rate and hid a per-cell bump behind a no-op write): one paste,
    // one version, both values landed.
    await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "customer", value: "A", baseVersion: 0 },
      { loadId: loads[0].id, row: "top", key: "rate", value: "2000", baseVersion: 0 },
      { loadId: loads[1].id, row: "top", key: "customer", value: "B", baseVersion: 0 },
    ]).expect(200);
    const [a, b] = await Promise.all(loads.map((l) => prisma.load.findUnique({ where: { id: l.id } })));
    expect([a?.version, b?.version]).toEqual([1, 1]);
    expect([a?.customerName, a?.revenueCents]).toEqual(["A", 200000]);
  });

  // B2: the cell route has always answered with `statusRefused`; a paste
  // dropped it entirely, so a dispatcher who pasted a column of UPDATEs over
  // loads our own drivers run saw nothing happen and no reason why.
  it("carries the record's refusal back for every load in the paste that was refused", async () => {
    const { org, auth, loads } = await setup();
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    const driver = await prisma.driver.create({ data: { email: "j@x.com", passwordHash: "x", name: "Jake", orgId: org.id } });
    await prisma.load.update({ where: { id: loads[0].id }, data: { carrierId: carrier.id, status: "assigned" } });
    await prisma.assignment.create({ data: { orgId: org.id, loadId: loads[0].id, driverId: driver.id, status: "dispatched", plannedStart: new Date(), plannedEnd: new Date() } });
    const res = await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "update", value: "DELIVERED 07/17/2026", baseVersion: 0 },
      { loadId: loads[1].id, row: "top", key: "customer", value: "BETA CORP", baseVersion: 0 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.refusals).toHaveLength(1);
    expect(res.body.refusals[0].loadId).toBe(loads[0].id);
    expect(res.body.refusals[0].sentence).toMatch(/record says assigned — advance the trip in the Cockpit/);
    // The cell itself still landed: nothing a human typed is thrown away.
    expect((await prisma.load.findUnique({ where: { id: loads[0].id } }))?.updateText).toBe("DELIVERED 07/17/2026");
  });

  it("answers with an empty refusals list when nothing was refused", async () => {
    const { auth, loads } = await setup();
    const res = await paste(auth, [{ loadId: loads[0].id, row: "top", key: "customer", value: "ACME FOODS", baseVersion: 0 }]);
    expect(res.status).toBe(200);
    expect(res.body.refusals).toEqual([]);
  });

  it("derives once from a paste that lands an APPT line and a city on the same load", async () => {
    const { auth, loads } = await setup();
    await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "appt", value: "PU: 07/14 - 12:00", baseVersion: 0 },
      { loadId: loads[0].id, row: "top", key: "pickupCity", value: "Kansas City, MO", baseVersion: 0 },
    ]).expect(200);
    const load = await prisma.load.findUnique({ where: { id: loads[0].id }, include: { stops: { include: { appointment: true } } } });
    expect(load?.version).toBe(1);
    expect(load?.apptText).toBe("PU: 07/14 - 12:00");
    const pu = load?.stops.find((s) => s.type === "pickup");
    expect(pu?.address).toBe("Kansas City, MO");
    expect(pu?.lat).not.toBeNull();
    expect(pu?.appointment?.type).toBe("pickup");
  });
});

describe("POST /dispatcher/broker-board/loads (+ load) and /duplicate", () => {
  beforeEach(resetDb);

  it("adds a blank load at the end of the board", async () => {
    const { auth, loads } = await setup();
    const res = await request(app).post("/api/dispatcher/broker-board/loads").set(auth).send({});
    expect(res.status).toBe(201);
    expect(res.body.load.top.customer).toBe("");
    // It is a brokered row from the start — otherwise it renders as a fleet
    // load with no carrier line and the dispatcher cannot type one.
    expect(res.body.load.bottom).not.toBeNull();
    // It lands at the END of the board as the board is ordered — which is
    // `boardLine` NULL plus the newest createdAt, not "max + 1". A board whose
    // rows all came from an import with no line numbers has no max, so max+1
    // computed 1 and put every new row at the TOP of their sheet.
    const board = await prisma.load.findMany({
      where: { orgId: loads[0].orgId },
      orderBy: [{ boardLine: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    });
    expect(board).toHaveLength(3);
    expect(board[2].id).toBe(res.body.load.id);
    expect(board[2].boardLine).toBeNull();
  });

  it("duplicates a load with its stops and its money, under a new id", async () => {
    const { auth, loads } = await setup();
    await request(app).patch(`/api/dispatcher/broker-board/loads/${loads[0].id}/cell`).set(auth)
      .send({ row: "top", key: "pickupCity", value: "Henderson, NV", baseVersion: 0 }).expect(200);
    const res = await request(app).post("/api/dispatcher/broker-board/loads/duplicate").set(auth).send({ ids: [loads[0].id] });
    expect(res.status).toBe(200);
    expect(res.body.loads).toHaveLength(1);
    const copy = res.body.loads[0];
    expect(copy.id).not.toBe(loads[0].id);
    expect(copy.top.bol).toBe("0500001");
    expect(copy.top.pickupCity).toBe("Henderson, NV");
    expect(copy.top.rate).toBe("$1,000.00");
    expect(await prisma.load.count({ where: { orgId: loads[0].orgId } })).toBe(3);
    // B1: the copy comes through the writer, so it is a derived record from
    // birth — a version, a placed stop — not a version-0 shell of columns.
    expect(copy.version).toBeGreaterThanOrEqual(1);
    const pu = await prisma.loadStop.findFirst({ where: { loadId: copy.id, type: "pickup" } });
    expect(pu?.lat).not.toBeNull();
  });

  // B1: the copy used to be written straight into `prisma.load.create` —
  // open with a DELIVERED update text, no appointments beside its APPT text,
  // stops with no coordinates, version 0 and no trace. It goes through the
  // one writer now, so the copy is as derived as the original.
  it("duplicates through the writer, so the copy is placed, timed and derived", async () => {
    const { org, auth, loads } = await setup();
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    await prisma.load.update({
      where: { id: loads[0].id },
      data: { carrierId: carrier.id, updateText: "DELIVERED 07/17/2026", apptText: "PU: 07/14 - 12:00", shipDate: new Date("2026-07-13T00:00:00Z") },
    });
    await request(app).patch(`/api/dispatcher/broker-board/loads/${loads[0].id}/cell`).set(auth)
      .send({ row: "top", key: "pickupCity", value: "Kansas City, MO", baseVersion: 0 }).expect(200);

    const res = await request(app).post("/api/dispatcher/broker-board/loads/duplicate").set(auth).send({ ids: [loads[0].id] });
    expect(res.status).toBe(200);
    const copy = await prisma.load.findUnique({
      where: { id: res.body.loads[0].id },
      include: { stops: { include: { appointment: true } } },
    });
    expect(copy!.version).toBeGreaterThanOrEqual(1);
    expect(copy!.status).toBe("delivered");                       // derived from the copied UPDATE text
    const pu = copy!.stops.find((s) => s.type === "pickup");
    expect(pu?.address).toBe("Kansas City, MO");
    expect(pu?.lat).not.toBeNull();                               // placed from the gazetteer
    expect(pu?.geocodeStatus).toBe("ok");
    expect(pu?.appointment?.windowEnd.toISOString()).toBe("2026-07-14T17:00:00.000Z");   // read from the copied APPT text
    // And the trace says where it came from rather than nothing at all.
    expect(await prisma.loadChange.count({ where: { loadId: copy!.id } })).toBeGreaterThan(0);
  });

  it("never duplicates the board's LOAD#, which has to stay unique", async () => {
    const { auth, loads } = await setup();
    await prisma.load.update({ where: { id: loads[0].id }, data: { boardLoadNo: "145205" } });
    const res = await request(app).post("/api/dispatcher/broker-board/loads/duplicate").set(auth).send({ ids: [loads[0].id] });
    expect(res.status).toBe(200);
    // The copy carries everything a dispatcher can retype and neither of the
    // two identities: `boardLoadNo` is unique per org and `externalId` names
    // a record in someone else's system.
    const copy = await prisma.load.findUnique({ where: { id: res.body.loads[0].id } });
    expect(copy?.boardLoadNo).toBeNull();
    expect(copy?.externalId).toBeNull();
    expect(copy?.bolNumber).toBe("0500001");
  });
});

describe("GET/PUT /dispatcher/broker-board/view", () => {
  beforeEach(resetDb);

  it("starts empty and keeps what the dispatcher paints", async () => {
    const { auth, loads } = await setup();
    const empty = await request(app).get("/api/dispatcher/broker-board/view").set(auth);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ fills: {}, merges: {} });

    const view = { fills: { row: { [loads[0].id]: "#fff3b0" }, col: { rate: "#cfe3ff" }, cell: { [`${loads[1].id}|customer`]: "#ffe95c" } }, merges: { [loads[0].id]: ["customer", "phone"] } };
    await request(app).put("/api/dispatcher/broker-board/view").set(auth).send(view).expect(200);
    const back = await request(app).get("/api/dispatcher/broker-board/view").set(auth);
    expect(back.body).toEqual(view);
  });

  it("is one view per org, and never another org's", async () => {
    const { auth } = await setup();
    await request(app).put("/api/dispatcher/broker-board/view").set(auth).send({ fills: { row: { a: "#fff3b0" } }, merges: {} }).expect(200);
    await request(app).put("/api/dispatcher/broker-board/view").set(auth).send({ fills: { row: { b: "#cfe3ff" } }, merges: {} }).expect(200);
    expect(await prisma.boardView.count()).toBe(1);

    const other = await prisma.org.create({ data: { name: "Other", timezone: "UTC" } });
    await prisma.dispatcher.create({ data: { email: "c@x.com", passwordHash: await hashPassword("pw"), name: "C", orgId: other.id } });
    const { token } = await loginDispatcher("c@x.com", "pw");
    const theirs = await request(app).get("/api/dispatcher/broker-board/view").set({ Authorization: `Bearer ${token}` });
    expect(theirs.body).toEqual({ fills: {}, merges: {} });
  });

  it("refuses a colour that is not one", async () => {
    const { auth } = await setup();
    await request(app).put("/api/dispatcher/broker-board/view").set(auth)
      .send({ fills: { row: { a: "javascript:alert(1)" } }, merges: {} }).expect(400);
  });
});

describe("POST cells — locks and the version backstop (spec §7.2)", () => {
  beforeEach(resetDb);

  it("refuses the whole paste when any target is held by someone else, naming the holder and the LOAD#s", async () => {
    const { org, auth, loads } = await setup();
    await prisma.load.update({ where: { id: loads[1].id }, data: { boardLoadNo: "0563272" } });
    await prisma.loadLock.create({ data: { loadId: loads[1].id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    const res = await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "customer", value: "A", baseVersion: 0 },
      { loadId: loads[1].id, row: "top", key: "customer", value: "B", baseVersion: 0 },
    ]);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("LOAD_LOCKED");
    expect(res.body.holders).toEqual([{ loadId: loads[1].id, loadNo: "0563272", by: "Maria" }]);
    expect(res.body.message).toBe("Maria is editing 0563272 — try again when the badge clears");
    expect((await prisma.load.findUnique({ where: { id: loads[0].id } }))?.customerName).toBe("OLD");
  });

  it("holds every target only for the write, and leaves a lock the paster already held", async () => {
    const { org, auth, loads } = await setup();
    const me = await prisma.dispatcher.findFirst({ where: { orgId: org.id } });
    await prisma.loadLock.create({ data: { loadId: loads[0].id, orgId: org.id, dispatcherId: me!.id, dispatcherName: me!.name, expiresAt: new Date(Date.now() + 60_000) } });
    await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "customer", value: "A", baseVersion: 0 },
      { loadId: loads[1].id, row: "top", key: "customer", value: "B", baseVersion: 0 },
    ]).expect(200);
    const locks = await prisma.loadLock.findMany();
    expect(locks.map((l) => l.loadId)).toEqual([loads[0].id]);
  });

  it("refuses a paste over a row that moved since it was copied", async () => {
    const { auth, loads } = await setup();
    await paste(auth, [{ loadId: loads[0].id, row: "top", key: "customer", value: "FIRST", baseVersion: 0 }]).expect(200);
    const res = await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "customer", value: "SECOND", baseVersion: 0 },
      { loadId: loads[1].id, row: "top", key: "customer", value: "B", baseVersion: 0 },
    ]);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "STALE_VERSION", loadIds: [loads[0].id] });
    expect(res.body.message).toMatch(/changed since you copied/);
    expect((await prisma.load.findUnique({ where: { id: loads[1].id } }))?.customerName).toBe("OLD");
  });

  // F1(a)/F3: ownership is resolved before ANY lock call. Two things used to
  // reach `acquireLoadLock` that never should have: a deleted id (whose FK
  // then failed inside the write transaction) and a foreign id (whose holder
  // the refusal would have named — another tenant's dispatcher).

  it("answers 404 for a deleted id, writes nothing, and leaves no lock rows behind", async () => {
    const { auth, loads } = await setup();
    const goneId = loads[1].id;
    await prisma.load.delete({ where: { id: goneId } });
    const res = await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "customer", value: "A", baseVersion: 0 },
      { loadId: goneId, row: "top", key: "customer", value: "B", baseVersion: 0 },
    ]);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "One or more loads were not found" });
    expect((await prisma.load.findUnique({ where: { id: loads[0].id } }))?.customerName).toBe("OLD");
    expect(await prisma.loadLock.count()).toBe(0);
  });

  it("answers 404 for another org's id with no holder information at all", async () => {
    const { auth, loads } = await setup();
    const other = await prisma.org.create({ data: { name: "Other", timezone: "UTC" } });
    const theirs = await prisma.load.create({ data: { orgId: other.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "THEIRS" } });
    await prisma.loadLock.create({ data: { loadId: theirs.id, orgId: other.id, dispatcherId: "disp-nina", dispatcherName: "Nina", expiresAt: new Date(Date.now() + 60_000) } });
    const res = await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "customer", value: "A", baseVersion: 0 },
      { loadId: theirs.id, row: "top", key: "customer", value: "B", baseVersion: 0 },
    ]);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "One or more loads were not found" });
    // Not a word about Nina, and not a lock taken on our side either.
    expect(JSON.stringify(res.body)).not.toMatch(/Nina/);
    expect((await prisma.load.findUnique({ where: { id: theirs.id } }))?.customerName).toBe("THEIRS");
    expect(await prisma.loadLock.count({ where: { orgId: loads[0].orgId } })).toBe(0);
  });

  // F1(b): the locks are taken on the autocommit client BEFORE the write
  // transaction and released in a `finally`. A refusal from inside the
  // transaction must therefore still leave nothing behind.
  it("releases every lock it took when the write is refused", async () => {
    const { auth, loads } = await setup();
    await paste(auth, [{ loadId: loads[0].id, row: "top", key: "customer", value: "FIRST", baseVersion: 0 }]).expect(200);
    await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "customer", value: "SECOND", baseVersion: 0 },
      { loadId: loads[1].id, row: "top", key: "customer", value: "B", baseVersion: 0 },
    ]).expect(409);
    expect(await prisma.loadLock.count()).toBe(0);
  });
});
