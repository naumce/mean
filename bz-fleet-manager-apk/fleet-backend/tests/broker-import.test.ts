import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { buildPreview, confirmImport } from "../src/lib/brokerImport.js";
import * as loadWriterModule from "../src/lib/loadWriter.js";
import { BROKER_ROWS, THEIR_HEADER, brokerWorkbook, multiSheetWorkbook } from "./fixtures/brokerBoard.js";
import { resetDb } from "./helpers.js";

const EQUIP_NOTE = "equipment assumed Dry Van (the sheet has no equipment column)";

async function org() { return prisma.org.create({ data: { name: "Test Broker", timezone: "America/Los_Angeles" } }); }

describe("buildPreview", () => {
  beforeEach(resetDb);

  it("shows every load as the dispatcher will see it, with parsed money, dates and windows", async () => {
    const o = await org();
    const p = await buildPreview(o.id, brokerWorkbook());
    expect(p.layout.map((c) => c.key)).toContain("appt");
    expect(p.loads).toHaveLength(5);
    const first = p.loads[0];
    expect(first).toMatchObject({ loadNo: "145205", orderRef: "2026-34566-00", bol: "0500001", customer: "ACME FOODS", carrier: "BLUE ROAD LLC", mc: "1000001", contact: "Contact A", pickup: "Henderson, NV", puZip: "89074", delivery: "Dallas, TX", delZip: "75236", rateCents: 400000, soldRateCents: 360000, profitCents: 40000, shipDate: "2026-07-13", update: "DELIVERED 07/15/2026" });
    expect(first.trackingUrl).toMatch(/^https:/);
    expect(first.appt.pu?.startMs).toBe(Date.parse("2026-07-13T13:00:00-07:00"));
    expect(first.appt.del?.endMs).toBe(Date.parse("2026-07-15T11:00:00-07:00"));
    expect(first.notes).toEqual([EQUIP_NOTE]);
  });

  it("reads FCFS windows and keeps a trailing word as a note", async () => {
    const o = await org();
    const p = await buildPreview(o.id, brokerWorkbook());
    expect(p.loads[2].appt.pu).toMatchObject({ kind: "fcfs" });
    expect(p.loads[2].appt.del?.startMs).toBe(Date.parse("2026-07-17T08:00:00-07:00"));
    expect(p.loads[3].notes).toContain('PU: ignored "working"');
  });

  it("flags what it cannot read instead of guessing: an unassigned load with no delivery time", async () => {
    const o = await org();
    const p = await buildPreview(o.id, brokerWorkbook());
    const last = p.loads[4];
    expect(last.carrier).toBeNull();
    expect(last.appt.pu).toBeNull();
    expect(last.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^PU: no time/), "DEL: missing"]));
  });

  it("notes a profit cell that disagrees with rate minus sold rate", async () => {
    const o = await org();
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[2][10] = "$999.00";
    const p = await buildPreview(o.id, brokerWorkbook(rows));
    expect(p.loads[0].notes).toContain("PROFIT $999.00 does not equal RATE - SOLD RATE ($400.00)");
    expect(p.loads[0].profitCents).toBe(40000);
  });

  it("flags a blank RATE cell instead of silently letting it become $0", async () => {
    const o = await org();
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[2][8] = "";
    const p = await buildPreview(o.id, brokerWorkbook(rows));
    expect(p.loads[0].rateCents).toBeNull();
    expect(p.loads[0].notes).toContain("can't read RATE: blank");
  });
});

describe("confirmImport", () => {
  beforeEach(resetDb);

  it("creates loads, stops, appointments and carriers, saves the layout, and audits the batch", async () => {
    const o = await org();
    const r = await confirmImport(o.id, brokerWorkbook());
    expect(r).toMatchObject({ created: 5, updated: 0 });
    const loads = await prisma.load.findMany({ where: { orgId: o.id }, include: { stops: { include: { appointment: true }, orderBy: { sequence: "asc" } }, carrier: true, agentUpdates: true }, orderBy: { externalId: "asc" } });
    expect(loads).toHaveLength(5);
    const l = loads.find((x) => x.externalId === "145205")!;
    expect(l.bolNumber).toBe("0500001");
    expect(l.customerName).toBe("ACME FOODS");
    expect(l.revenueCents).toBe(400000);
    expect(l.soldRateCents).toBe(360000);
    expect(l.carrier?.mcNumber).toBe("1000001");
    expect(l.carrierPhone).toBe("(555) 010-0104");
    expect(l.carrierContactName).toBe("Contact A");
    expect(l.updateText).toBe("DELIVERED 07/15/2026");
    expect(l.apptText).toBe("PU: 07/13 - 13:00\nDEL: 07/15 - 11:00");
    expect(l.shipDate?.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(l.requiredEquip).toBe("DryVan");
    expect(l.stops[0]).toMatchObject({ type: "pickup", address: "Henderson, NV 89074", geocodeStatus: "ok" });
    expect(l.stops[0].lat).not.toBeNull();
    expect(l.stops[0].appointment?.windowStart?.toISOString()).toBe("2026-07-13T20:00:00.000Z");
    expect(l.stops[1].appointment?.windowEnd.toISOString()).toBe("2026-07-15T18:00:00.000Z");
    expect(l.stops[1].appointment?.kind).toBe("appointment");
    expect(l.agentUpdates).toEqual([]);

    const unassigned = loads.find((x) => x.orderRef === "2026-35100-00")!;
    expect(unassigned.externalId).toBeNull();
    expect(unassigned.carrierId).toBeNull();
    // PU is unreadable and no DEL line was ever typed: two refusals, one load.
    expect(unassigned.agentUpdates.map((u) => u.kind)).toEqual(["attention", "attention"]);
    expect(unassigned.agentUpdates.some((u) => /read PU appointment/.test(u.text))).toBe(true);
    expect(r.attention).toBe(1);

    expect(await prisma.carrier.count({ where: { orgId: o.id } })).toBe(4);
    const layout = await prisma.boardLayout.findUnique({ where: { orgId: o.id } });
    expect(layout).not.toBeNull();
    const batch = await prisma.importBatch.findUnique({ where: { id: r.batchId } });
    expect(batch).toMatchObject({ orgId: o.id, source: "xlsx", entity: "broker_loads", rows: 5 });
  });

  it("re-importing the same file updates by LOAD# instead of duplicating, and matches by BOL# when LOAD# is blank", async () => {
    const o = await org();
    await confirmImport(o.id, brokerWorkbook());
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[2][14] = "ARRIVED, unloading";           // the dispatcher edited UPDATE on load 145205
    rows[14][9] = "$2,800.00";                     // the unassigned load (no LOAD#) got a sold rate; still no carrier row
    const r = await confirmImport(o.id, brokerWorkbook(rows));
    expect(r).toMatchObject({ created: 0, updated: 5 });
    expect(await prisma.load.count({ where: { orgId: o.id } })).toBe(5);
    expect((await prisma.load.findFirst({ where: { orgId: o.id, externalId: "145205" } }))?.updateText).toBe("ARRIVED, unloading");
    expect((await prisma.load.findFirst({ where: { orgId: o.id, bolNumber: "0500005" } }))?.soldRateCents).toBe(280000);
    expect(await prisma.loadStop.count()).toBe(10);
    expect(await prisma.carrier.count({ where: { orgId: o.id } })).toBe(4);
  });

  // Final review finding 8: a re-import deliberately does NOT resurrect a load
  // the dispatcher archived (`fields` carries no `status`), but calling it
  // plain "updated" is dishonest — the dialog said "5 updated" while the board
  // showed 4. Count the ones that stayed archived so the dialog can say so.
  it("counts the loads that stayed archived on a re-import instead of calling them plain updates", async () => {
    const o = await org();
    await confirmImport(o.id, brokerWorkbook());
    const plain = await confirmImport(o.id, brokerWorkbook());
    expect(plain).toMatchObject({ created: 0, updated: 5, archivedKept: 0 });
    const one = await prisma.load.findFirst({ where: { orgId: o.id, externalId: "145205" } });
    await prisma.load.update({ where: { id: one!.id }, data: { status: "archived" } });
    const r = await confirmImport(o.id, brokerWorkbook());
    expect(r).toMatchObject({ created: 0, updated: 5, archivedKept: 1 });
    expect((await prisma.load.findUnique({ where: { id: one!.id } }))!.status).toBe("archived");
  });

  // A1: `mergeAttention` only ever deleted rows for aspects the CURRENT write
  // mentioned, and a corrected sheet mentions nothing — so a refusal about a
  // cell that has since been fixed outlived the problem forever. The importer
  // owns its three "can't read" aspects and clears them every time.
  it("clears the SHIP DATE refusal when the corrected sheet is re-imported", async () => {
    const o = await org();
    const broken = BROKER_ROWS.map((r) => [...r]);
    broken[2][13] = "TBD";                        // SHIP DATE nobody can read
    await confirmImport(o.id, brokerWorkbook(broken));
    const before = await prisma.load.findFirst({ where: { orgId: o.id, externalId: "145205" }, include: { agentUpdates: true } });
    expect(before?.agentUpdates.some((u) => u.text.startsWith("can't read SHIP DATE"))).toBe(true);

    await confirmImport(o.id, brokerWorkbook());  // the same sheet, SHIP DATE fixed
    const after = await prisma.load.findFirst({ where: { orgId: o.id, externalId: "145205" }, include: { agentUpdates: true } });
    expect(after?.agentUpdates.some((u) => u.text.startsWith("can't read SHIP DATE"))).toBe(false);
    expect(after?.shipDate?.toISOString().slice(0, 10)).toBe("2026-07-13");
  });

  it("writes revenueCents 0 for a blank RATE but flags it, and gives every attention line in the batch a distinct atMs", async () => {
    const o = await org();
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[2][8] = "";
    const r = await confirmImport(o.id, brokerWorkbook(rows));
    const l = await prisma.load.findFirst({ where: { orgId: o.id, externalId: "145205" }, include: { agentUpdates: true } });
    expect(l?.revenueCents).toBe(0);
    expect(l?.agentUpdates.some((u) => /RATE/.test(u.text))).toBe(true);
    expect(r.attention).toBeGreaterThanOrEqual(2); // load 145205 (blank RATE) + the unassigned load (unreadable PU)

    const allNotes = await prisma.agentUpdate.findMany({ where: { load: { orgId: o.id } } });
    expect(allNotes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(allNotes.map((n) => n.atMs)).size).toBe(allNotes.length);
  });

  it("a city the gazetteer does not know becomes an attention line, not an error", async () => {
    const o = await org();
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[2][4] = "Nowhereville, ZZ";
    const r = await confirmImport(o.id, brokerWorkbook(rows));
    expect(r.created).toBe(5);
    // `stops[0]` has to BE the pickup: without an explicit order Postgres
    // hands rows back in physical order, and once this file's earlier tests
    // churned the heap enough the delivery (which geocodes fine) came back
    // first and this assertion read 'ok'. Every other stop lookup in this
    // file already orders by sequence; this one did not.
    const l = await prisma.load.findFirst({ where: { orgId: o.id, externalId: "145205" }, include: { stops: { orderBy: { sequence: "asc" } }, agentUpdates: true } });
    // spec D6: a geocode miss writes "pending", never "failed" — the writer now owns this derivation.
    expect(l?.stops[0]).toMatchObject({ type: "pickup", geocodeStatus: "pending" });
    expect(l?.agentUpdates.some((u) => /can't place pickup/.test(u.text))).toBe(true);
  });

  it("keeps a good appointment when a re-import brings an unreadable one, and says so", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Los_Angeles" } });
    await confirmImport(org.id, brokerWorkbook());
    const before = await prisma.appointment.findMany({ where: { stop: { load: { orgId: org.id, bolNumber: BROKER_ROWS[2][0] } } } });
    expect(before.length).toBeGreaterThan(0);
    const broken = BROKER_ROWS.map((r) => [...r]);
    broken[2][15] = "DEL: sometime";                                   // the APPT cell of the first row (load 1's top row)
    const result = await confirmImport(org.id, brokerWorkbook(broken));
    expect(result.attention).toBeGreaterThan(0);
    const after = await prisma.appointment.findMany({ where: { stop: { load: { orgId: org.id, bolNumber: BROKER_ROWS[2][0] } } } });
    expect(after.map((a) => a.windowEnd.toISOString()).sort()).toEqual(before.map((a) => a.windowEnd.toISOString()).sort());
  });

  it("writes pending, not failed, for a city the gazetteer does not know", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Los_Angeles" } });
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[2][4] = "Nowhere, ZZ";
    await confirmImport(org.id, brokerWorkbook(rows));
    const pu = await prisma.loadStop.findFirst({ where: { type: "pickup", load: { orgId: org.id, bolNumber: BROKER_ROWS[2][0] } } });
    expect(pu?.geocodeStatus).toBe("pending");
  });

  it("versions and traces every imported load", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Los_Angeles" } });
    await confirmImport(org.id, brokerWorkbook());
    const loads = await prisma.load.findMany({ where: { orgId: org.id } });
    expect(loads.every((l) => l.version >= 1)).toBe(true);
    expect(await prisma.loadChange.count({ where: { orgId: org.id, source: "import" } })).toBeGreaterThan(0);
  });

  // Fix round 1: identity (Load.create/update) and the writer now share one
  // transaction, so a throw from applyLoadChange (timeout, connection loss,
  // deadlock) rolls the identity write back too — no ghost Load left behind
  // holding only externalId/brokerName/boardLine, satisfying none of
  // BROKERED_WHERE, that a later re-import can neither find nor recreate
  // (it would collide on @@unique([orgId, externalId])).
  it("leaves no ghost Load when the writer throws mid-import", async () => {
    const o = await org();
    const spy = vi.spyOn(loadWriterModule, "applyLoadChange").mockRejectedValueOnce(new Error("boom"));
    // The importer's for-loop has no try/catch around the per-row
    // transaction, so a throw from the writer propagates out of
    // confirmImport as a rejection — the whole batch aborts rather than
    // silently skipping the row.
    await expect(confirmImport(o.id, brokerWorkbook())).rejects.toThrow("boom");
    spy.mockRestore();
    expect(await prisma.load.count({ where: { orgId: o.id, externalId: "145205" } })).toBe(0);
  });

  it("skips a row someone is editing, says who, and imports the rest", async () => {
    const o = await org();
    const first = await confirmImport(o.id, brokerWorkbook());
    expect(first.created).toBe(5);
    const held = await prisma.load.findFirst({ where: { orgId: o.id, bolNumber: "0500001" } });
    await prisma.loadLock.create({ data: { loadId: held!.id, orgId: o.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    const rows = brokerWorkbook();
    const again = await confirmImport(o.id, rows);
    expect(again).toMatchObject({ created: 0, updated: 4, locked: 1 });
    expect(again.notes.some((n) => /Maria is editing this load — not imported/.test(n))).toBe(true);
    expect((await prisma.load.findUnique({ where: { id: held!.id } }))?.version).toBe(1);
  });
});

// The fix wave for the final whole-slice review: C1, C2, C3, I9-I12, I15.
describe("importing their real file", () => {
  beforeEach(resetDb);

  it("reads the tab that holds the board and names the other boards it found", async () => {
    const o = await org();
    const p = await buildPreview(o.id, multiSheetWorkbook([
      ["Summary", [["Month", "Total"], ["July", "5"]]],
      ["July", BROKER_ROWS],
      ["August", BROKER_ROWS.slice(0, 4)],
    ]));
    expect(p.sheetName).toBe("July");
    expect(p.loads).toHaveLength(5);
    expect(p.notes).toContain("also found a board on sheet 'August' — only 'July' was imported");
  });

  it("reads a PU and a DEL typed as two lines in one cell", async () => {
    const o = await org();
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[2][15] = "PU: 07/13 - 13:00\nDEL: 07/15 - 11:00";
    rows[3][15] = "";
    const p = await buildPreview(o.id, brokerWorkbook(rows));
    expect(p.loads[0].appt.pu?.startMs).toBe(Date.parse("2026-07-13T13:00:00-07:00"));
    expect(p.loads[0].appt.del?.endMs).toBe(Date.parse("2026-07-15T11:00:00-07:00"));
    expect(p.loads[0].notes.filter((n) => n.startsWith("can't"))).toEqual([]);
  });

  it("keeps every appointment line of a load that has no carrier row", async () => {
    const o = await org();
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[14][15] = "PU: 07/15 - 09:00\nDEL: 07/17 - 10:00";
    const r = await confirmImport(o.id, brokerWorkbook(rows));
    const l = await prisma.load.findFirst({ where: { orgId: o.id, bolNumber: "0500005" }, include: { stops: { include: { appointment: true }, orderBy: { sequence: "asc" } }, agentUpdates: true } });
    expect(l?.apptText).toBe("PU: 07/15 - 09:00\nDEL: 07/17 - 10:00");
    expect(l?.stops[1].appointment?.windowEnd.toISOString()).toBe("2026-07-17T17:00:00.000Z");
    expect(l?.agentUpdates).toEqual([]);
    expect(r.attention).toBe(0);
  });

  it("refuses a missing DEL even with no carrier row, and quotes the whole cell it read", async () => {
    const o = await org();
    await confirmImport(o.id, brokerWorkbook());
    const l = await prisma.load.findFirst({ where: { orgId: o.id, bolNumber: "0500005" }, include: { agentUpdates: true } });
    const texts = l!.agentUpdates.map((u) => u.text);
    expect(texts).toContain(`can't read PU appointment: "PU: 07/15 - tbd"`);
    expect(texts).toContain(`can't read DEL appointment: "PU: 07/15 - tbd"`);
  });

  it("quotes both appointment cells when the load has a carrier row", async () => {
    const o = await org();
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[3][15] = "DEL: whenever";
    await confirmImport(o.id, brokerWorkbook(rows));
    const l = await prisma.load.findFirst({ where: { orgId: o.id, externalId: "145205" }, include: { agentUpdates: true } });
    expect(l!.agentUpdates.map((u) => u.text)).toContain(`can't read DEL appointment: "PU: 07/13 - 13:00 / DEL: whenever"`);
  });

  it("skips a second row that claims a LOAD# already used in the same file, and says which line kept it", async () => {
    const o = await org();
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[6][12] = "145205";                       // load 2's carrier row re-uses load 1's LOAD#
    const p = await buildPreview(o.id, brokerWorkbook(rows));
    expect(p.loads[1].notes).toContain("duplicate LOAD# 145205 — first occurrence on line 3 kept");
    const r = await confirmImport(o.id, brokerWorkbook(rows));
    expect(r).toMatchObject({ created: 4, updated: 0, skipped: 1 });
    expect(r.notes).toContain("line 6: duplicate LOAD# 145205 — first occurrence on line 3 kept");
    expect(await prisma.load.count({ where: { orgId: o.id } })).toBe(4);
    expect((await prisma.load.findFirst({ where: { orgId: o.id, externalId: "145205" } }))?.bolNumber).toBe("0500001");
    expect(await prisma.load.count({ where: { orgId: o.id, bolNumber: "0500002" } })).toBe(0);
  });

  it("updates the stops in place on a re-import so the Control Tower's own columns survive", async () => {
    const o = await org();
    await confirmImport(o.id, brokerWorkbook());
    const before = await prisma.load.findFirst({ where: { orgId: o.id, externalId: "145205" }, include: { stops: { orderBy: { sequence: "asc" } } } });
    await prisma.loadStop.update({ where: { id: before!.stops[0].id }, data: { dwellMin: 90, detentionFreeMin: 120 } });
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[2][4] = "Reno, NV";
    rows[2][15] = "PU: 07/13 - 15:00";
    await confirmImport(o.id, brokerWorkbook(rows));
    const after = await prisma.load.findFirst({ where: { orgId: o.id, externalId: "145205" }, include: { stops: { include: { appointment: true }, orderBy: { sequence: "asc" } } } });
    expect(after!.stops[0].id).toBe(before!.stops[0].id);
    expect(after!.stops[0].dwellMin).toBe(90);
    expect(after!.stops[0].detentionFreeMin).toBe(120);
    expect(after!.stops[0].address).toBe("Reno, NV 89074");
    expect(after!.stops[0].appointment?.windowStart?.toISOString()).toBe("2026-07-13T22:00:00.000Z");
    expect(await prisma.loadStop.count()).toBe(10);
    expect(await prisma.appointment.count({ where: { stopId: after!.stops[0].id } })).toBe(1);
  });

  it("never touches a TMS fleet load that happens to share the sheet's LOAD#", async () => {
    const o = await org();
    const fleet = await prisma.load.create({ data: { orgId: o.id, externalId: "145205", requiredEquip: "Reefer", revenueCents: 999900, status: "in_progress", commodity: "Frozen peas", stops: { create: [{ sequence: 1, type: "pickup", address: "Chicago, IL 60601", dwellMin: 90 }] } } });
    const r = await confirmImport(o.id, brokerWorkbook());
    expect(r).toMatchObject({ created: 5, updated: 0 });
    const after = await prisma.load.findUnique({ where: { id: fleet.id }, include: { stops: true } });
    expect(after).toMatchObject({ externalId: "145205", status: "in_progress", requiredEquip: "Reefer", revenueCents: 999900, commodity: "Frozen peas" });
    expect(after!.stops).toHaveLength(1);
    expect(after!.stops[0].dwellMin).toBe(90);
    expect(await prisma.load.count({ where: { orgId: o.id } })).toBe(6);
    const board = await prisma.load.findFirst({ where: { orgId: o.id, bolNumber: "0500001" } });
    expect(board!.id).not.toBe(fleet.id);
    const r2 = await confirmImport(o.id, brokerWorkbook());
    expect(r2).toMatchObject({ created: 0, updated: 5 });
    expect(await prisma.load.count({ where: { orgId: o.id } })).toBe(6);
  });

  it("matches on the order number when a row has neither LOAD# nor BOL#", async () => {
    const o = await org();
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[14][0] = "";                              // load 5 keeps only its order number
    await confirmImport(o.id, brokerWorkbook(rows));
    const first = await prisma.load.findFirst({ where: { orgId: o.id, orderRef: "2026-35100-00" } });
    const r2 = await confirmImport(o.id, brokerWorkbook(rows));
    expect(r2).toMatchObject({ created: 0, updated: 5 });
    expect((await prisma.load.findFirst({ where: { orgId: o.id, orderRef: "2026-35100-00" } }))?.id).toBe(first!.id);
    expect(await prisma.load.count({ where: { orgId: o.id } })).toBe(5);
  });

  it("says a row with no LOAD#, BOL# or order number will import as new every time", async () => {
    const o = await org();
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[14][0] = ""; rows[14][12] = "";
    const p = await buildPreview(o.id, brokerWorkbook(rows));
    expect(p.loads[4].notes).toContain("no LOAD#, BOL# or order number — this row will import as new each time");
    await confirmImport(o.id, brokerWorkbook(rows));
    await confirmImport(o.id, brokerWorkbook(rows));
    expect(await prisma.load.count({ where: { orgId: o.id } })).toBe(6);
    const notes = await prisma.agentUpdate.findMany({ where: { load: { orgId: o.id } } });
    expect(notes.some((n) => /import as new/.test(n.text))).toBe(false);
  });

  it("tells the dispatcher that every load is assumed a dry van, without raising a pill", async () => {
    const o = await org();
    const p = await buildPreview(o.id, brokerWorkbook());
    expect(p.loads.every((l) => l.notes.includes(EQUIP_NOTE))).toBe(true);
    const r = await confirmImport(o.id, brokerWorkbook());
    expect(r.attention).toBe(1);
    const notes = await prisma.agentUpdate.findMany({ where: { load: { orgId: o.id } } });
    expect(notes.some((n) => /equipment/i.test(n.text))).toBe(false);
  });

  it("saves the layout of the file being imported, so a column added later shows up", async () => {
    const o = await org();
    await confirmImport(o.id, brokerWorkbook());
    const v1 = await prisma.boardLayout.findUnique({ where: { orgId: o.id } });
    expect((v1!.columns as Array<{ label: string }>).some((c) => c.label === "TRAILER #")).toBe(false);
    const rows = [[...THEIR_HEADER, "TRAILER #"], ...BROKER_ROWS.slice(2).map((r) => [...r, ""])];
    await confirmImport(o.id, brokerWorkbook(rows));
    const v2 = await prisma.boardLayout.findUnique({ where: { orgId: o.id } });
    expect((v2!.columns as Array<{ label: string }>).map((c) => c.label)).toContain("TRAILER #");
  });
});
