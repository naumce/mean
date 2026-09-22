import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDb } from "../helpers.js";
import { applyLoadChange, type Actor } from "../../src/lib/loadWriter.js";
import { collectBoardEdits, reverseFieldMap } from "../../src/lib/sheet/writeBack.js";
import { spliceLine } from "../../src/lib/boardCellApply.js";
import type { SheetMapping } from "../../src/lib/sheet/mapping.js";
import type { RawRow } from "../../src/lib/sheet/connector.js";

process.env.PORTAL_URL ||= "http://localhost:5173";

const maria: Actor = { dispatcherId: "d-maria", name: "Maria" };
const board = (loadId: string, orgId: string, patch: Parameters<typeof applyLoadChange>[1]["patch"]) =>
  prisma.$transaction((tx) => applyLoadChange(tx, { loadId, orgId, actor: maria, source: "board", patch }));
const sheet = (loadId: string, orgId: string, patch: Parameters<typeof applyLoadChange>[1]["patch"]) =>
  prisma.$transaction((tx) => applyLoadChange(tx, { loadId, orgId, actor: { dispatcherId: null, name: "sheet" }, source: "sheet", patch }));

const MAPPING: SheetMapping = {
  loadRef: "LOAD#", driverPhone: "DRIVER PHONE", driverName: "DRIVER NAME", pickup: "PICK UP", delivery: "DELIVERY",
  pickupAppt: "PU APPT", deliveryAppt: "DEL APPT", customerEmail: "EMAIL", carrierName: "CARRIER",
  carrierPhone: "CARRIER PHONE", rate: "RATE", notes: "NOTES",
};
const HEADER = ["LOAD#", "DRIVER PHONE", "DRIVER NAME", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT", "EMAIL", "CARRIER", "CARRIER PHONE", "RATE", "NOTES", "EXTRA COL", "Night Shift", "Night Shift status"];
const col = (h: string): number => HEADER.indexOf(h);

/** A full-width `RawRow` for `header`, blank except the given cells. */
function rowAt(rowIndex: number, header: string[], cells: Record<string, string> = {}): RawRow {
  const arr = header.map((h) => cells[h] ?? "");
  return { rowIndex, cells: arr };
}

let seq = 0;

/** An org plus a real, connected `SheetBinding` row — `Load.sheetBindingId`
 *  is a genuine FK (fix round 1), so every seeded load needs one that exists. */
async function seedOrgWithBinding() {
  seq += 1;
  const org = await prisma.org.create({ data: { name: `WriteBackOrg-${seq}`, timezone: "America/Chicago" } });
  const binding = await prisma.sheetBinding.create({
    data: {
      orgId: org.id, provider: "google", spreadsheetId: `s${seq}`, tabId: "t1", tabTitle: "Sheet1",
      headerRow: 1, columns: {}, refreshToken: "sealed-x", status: "connected",
    },
  });
  return { org, bindingId: binding.id };
}

async function seedLoad(orgId: string, bindingId: string, over: Record<string, unknown> = {}) {
  return prisma.load.create({
    data: { orgId, requiredEquip: "DryVan", sheetRowIndex: 5, boardLoadNo: "L1", sheetBindingId: bindingId, ...over },
  });
}

/** `collectBoardEdits` with the test defaults (no rows) filled in — most
 *  tests don't exercise the `apptText` cell guard, which is the only thing
 *  `rows` feeds. */
const collect = (over: Partial<Parameters<typeof collectBoardEdits>[0]> & Pick<Parameters<typeof collectBoardEdits>[0], "orgId" | "bindingId">) =>
  collectBoardEdits({
    sinceAtMs: 0n, mapping: MAPPING, header: HEADER, rows: [], rowsPerLoad: 1, hasBottomByRow: {},
    ...over,
  });

beforeEach(resetDb);

describe("reverseFieldMap", () => {
  it("maps every scalar field this pass writes to its sheet header", () => {
    expect(reverseFieldMap(MAPPING)).toEqual({
      boardLoadNo: ["LOAD#"], driverCell: ["DRIVER PHONE"], carrierContactName: ["DRIVER NAME"],
      "stops.pickup": ["PICK UP"], "stops.delivery": ["DELIVERY"], customerEmail: ["EMAIL"],
      carrierId: ["CARRIER"], carrierPhone: ["CARRIER PHONE"], revenueCents: ["RATE"], updateText: ["NOTES"],
      apptText: ["PU APPT", "DEL APPT"],
    });
  });

  it("resolves apptText to ONE header when pickup/delivery share a column", () => {
    const shared: SheetMapping = { ...MAPPING, pickupAppt: "APPT SCHEDULE", deliveryAppt: "APPT SCHEDULE" };
    expect(reverseFieldMap(shared).apptText).toEqual(["APPT SCHEDULE"]);
  });

  it("omits a field with no mapped header (bolNumber, customerName, soldRateCents, …)", () => {
    const map = reverseFieldMap(MAPPING);
    expect(map.bolNumber).toBeUndefined();
    expect(map.customerName).toBeUndefined();
    expect(map.soldRateCents).toBeUndefined();
  });
});

describe("collectBoardEdits", () => {
  it("writes a board-edited cell that survived this tick's row pass", async () => {
    const { org, bindingId } = await seedOrgWithBinding();
    const load = await seedLoad(org.id, bindingId);
    await board(load.id, org.id, { stops: { delivery: { address: "Reno, NV" } } });

    const { writes, conflicts, maxAtMs } = await collect({ orgId: org.id, bindingId });

    expect(conflicts).toEqual([]);
    expect(writes).toEqual([{ rowIndex: 5, col: col("DELIVERY"), value: "Reno, NV" }]);
    expect(maxAtMs).toBeGreaterThan(0n);
  });

  it("a second call since maxAtMs finds nothing new", async () => {
    const { org, bindingId } = await seedOrgWithBinding();
    const load = await seedLoad(org.id, bindingId);
    await board(load.id, org.id, { stops: { delivery: { address: "Reno, NV" } } });
    const first = await collect({ orgId: org.id, bindingId });
    const second = await collect({ orgId: org.id, bindingId, sinceAtMs: first.maxAtMs });
    expect(second).toEqual({ writes: [], conflicts: [], maxAtMs: first.maxAtMs });
  });

  it("a same-tick sheet edit of the same field beats the board's: conflict, no write, sheet's value survives", async () => {
    const { org, bindingId } = await seedOrgWithBinding();
    const load = await seedLoad(org.id, bindingId, { stops: { create: [{ type: "delivery", sequence: 2, address: "Dallas, TX", geocodeStatus: "ok" }] } });
    await board(load.id, org.id, { stops: { delivery: { address: "Reno, NV" } } });
    // The row pass, later in the same tick, re-mirrors the sheet's own value.
    await sheet(load.id, org.id, { stops: { delivery: { address: "Denver, CO" } } });

    const { writes, conflicts } = await collect({ orgId: org.id, bindingId });
    expect(writes).toEqual([]);
    expect(conflicts).toEqual([{ loadId: load.id, text: 'conflict: sheet has "Denver, CO", board tried "Reno, NV" — sheet kept' }]);
    const after = await prisma.load.findUniqueOrThrow({ where: { id: load.id }, include: { stops: true } });
    expect(after.stops.find((s) => s.type === "delivery")?.address).toBe("Denver, CO");
  });

  it("renders a rate edit as $x,xxx.xx", async () => {
    const { org, bindingId } = await seedOrgWithBinding();
    const load = await seedLoad(org.id, bindingId, { revenueCents: 400000 });
    await board(load.id, org.id, { revenueCents: 490000 });
    const { writes } = await collect({ orgId: org.id, bindingId });
    expect(writes).toEqual([{ rowIndex: 5, col: col("RATE"), value: "$4,900.00" }]);
  });

  it("a rate conflict renders BOTH sides as dollars, not raw cents", async () => {
    const { org, bindingId } = await seedOrgWithBinding();
    const load = await seedLoad(org.id, bindingId, { revenueCents: 400000 });
    await board(load.id, org.id, { revenueCents: 490000 });
    await sheet(load.id, org.id, { revenueCents: 500000 });
    const { writes, conflicts } = await collect({ orgId: org.id, bindingId });
    expect(writes).toEqual([]);
    expect(conflicts).toEqual([{ loadId: load.id, text: 'conflict: sheet has "$5,000.00", board tried "$4,900.00" — sheet kept' }]);
  });

  it("writes the carrier's NAME for a carrierId change, resolved off the load's current carrier", async () => {
    const { org, bindingId } = await seedOrgWithBinding();
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    const load = await seedLoad(org.id, bindingId);
    await board(load.id, org.id, { carrier: { name: "Blue Road LLC" } });
    const { writes } = await collect({ orgId: org.id, bindingId });
    expect(writes).toEqual([{ rowIndex: 5, col: col("CARRIER"), value: carrier.name }]);
  });

  describe("apptText", () => {
    it("writes the WHOLE text to a shared PU/DEL column", async () => {
      const { org, bindingId } = await seedOrgWithBinding();
      const load = await seedLoad(org.id, bindingId);
      const text = "PU: 07/15 - 10:00\nDEL: 07/16 - 11:00";
      await board(load.id, org.id, { apptText: text });
      const shared: SheetMapping = { ...MAPPING, pickupAppt: "APPT SCHEDULE", deliveryAppt: "APPT SCHEDULE" };
      const header = [...HEADER, "APPT SCHEDULE"];
      const { writes } = await collect({ orgId: org.id, bindingId, mapping: shared, header });
      expect(writes).toEqual([{ rowIndex: 5, col: header.indexOf("APPT SCHEDULE"), value: text }]);
    });

    it("splits LABELLED PU:/DEL: lines across two separate columns", async () => {
      const { org, bindingId } = await seedOrgWithBinding();
      const load = await seedLoad(org.id, bindingId);
      await board(load.id, org.id, { apptText: "PU: 07/15 - 10:00\nDEL: 07/16 - 11:00" });
      const { writes } = await collect({ orgId: org.id, bindingId });
      expect(writes.slice().sort((a, b) => a.col - b.col)).toEqual([
        { rowIndex: 5, col: col("PU APPT"), value: "07/15 - 10:00" },
        { rowIndex: 5, col: col("DEL APPT"), value: "07/16 - 11:00" },
      ]);
    });

    // CRITICAL fix (review round 1): the Broker Board's own APPT editor
    // (boardCellApply.ts's spliceLine) never labels a line — line 0 is PU,
    // line 1 is DEL. Before the fix, an unlabelled edit resolved BOTH sides
    // to "" and erased both cells.
    it("splits an UNLABELLED two-line text by position: line 0 -> PU, line 1 -> DEL", async () => {
      const { org, bindingId } = await seedOrgWithBinding();
      const load = await seedLoad(org.id, bindingId);
      await board(load.id, org.id, { apptText: "07/15 - 10:00\n07/16 - 11:00" });
      const { writes, conflicts } = await collect({ orgId: org.id, bindingId });
      expect(conflicts).toEqual([]);
      expect(writes.slice().sort((a, b) => a.col - b.col)).toEqual([
        { rowIndex: 5, col: col("PU APPT"), value: "07/15 - 10:00" },
        { rowIndex: 5, col: col("DEL APPT"), value: "07/16 - 11:00" },
      ]);
    });

    it("an UNLABELLED one-line text writes PU only; DEL is untouched (not blanked), no conflict when DEL was already blank", async () => {
      const { org, bindingId } = await seedOrgWithBinding();
      const load = await seedLoad(org.id, bindingId);
      await board(load.id, org.id, { apptText: "07/15 - 10:00" });
      const rows = [rowAt(5, HEADER, { "DEL APPT": "" })];
      const { writes, conflicts } = await collect({ orgId: org.id, bindingId, rows });
      expect(conflicts).toEqual([]);
      expect(writes).toEqual([{ rowIndex: 5, col: col("PU APPT"), value: "07/15 - 10:00" }]);
    });

    it("hard guard: an unlabelled edit that would blank a cell holding real text conflicts instead, and does not write it", async () => {
      const { org, bindingId } = await seedOrgWithBinding();
      const load = await seedLoad(org.id, bindingId);
      // A second, explicitly blank line (not just a missing one) — DEL
      // resolves to "" rather than null.
      await board(load.id, org.id, { apptText: "07/15 - 10:00\n" });
      const rows = [rowAt(5, HEADER, { "PU APPT": "", "DEL APPT": "07/16 - 11:00" })];
      const { writes, conflicts } = await collect({ orgId: org.id, bindingId, rows });
      expect(writes).toEqual([{ rowIndex: 5, col: col("PU APPT"), value: "07/15 - 10:00" }]);
      expect(conflicts).toEqual([{
        loadId: load.id,
        text: 'conflict: could not map appointment "07/15 - 10:00\n" to the sheet\'s PU/DEL columns — sheet kept',
      }]);
    });

    it("the Broker Board's own two-cell edit (boardCellApply.ts's spliceLine) round-trips cleanly, nothing blanked", async () => {
      const { org, bindingId } = await seedOrgWithBinding();
      const load = await seedLoad(org.id, bindingId);
      // Exactly what the board produces: two separate cell writes, neither labelled.
      const afterPu = spliceLine(null, 0, "07/15 - 10:00");
      await board(load.id, org.id, { apptText: afterPu });
      const afterBoth = spliceLine(afterPu, 1, "07/16 - 11:00");
      await board(load.id, org.id, { apptText: afterBoth });

      const { writes, conflicts } = await collect({ orgId: org.id, bindingId });
      expect(conflicts).toEqual([]);
      expect(writes.slice().sort((a, b) => a.col - b.col)).toEqual([
        { rowIndex: 5, col: col("PU APPT"), value: "07/15 - 10:00" },
        { rowIndex: 5, col: col("DEL APPT"), value: "07/16 - 11:00" },
      ]);
    });

    describe("two-rows-per-load, shared appointment column", () => {
      const SHARED_MAPPING: SheetMapping = { ...MAPPING, pickupAppt: "APPT SCHEDULE", deliveryAppt: "APPT SCHEDULE" };
      const SHARED_HEADER = [...HEADER, "APPT SCHEDULE"];
      const sharedCol = SHARED_HEADER.indexOf("APPT SCHEDULE");

      it("a pair WITH a bottom: PU line to the top row, DEL line to the bottom row (same column)", async () => {
        const { org, bindingId } = await seedOrgWithBinding();
        const load = await seedLoad(org.id, bindingId, { sheetRowIndex: 6 });
        await board(load.id, org.id, { apptText: "PU: 07/15 - 10:00\nDEL: 07/16 - 11:00" });
        const { writes } = await collect({
          orgId: org.id, bindingId, mapping: SHARED_MAPPING, header: SHARED_HEADER, rowsPerLoad: 2, hasBottomByRow: { 6: true },
        });
        expect(writes.slice().sort((a, b) => a.rowIndex - b.rowIndex)).toEqual([
          { rowIndex: 6, col: sharedCol, value: "07/15 - 10:00" },
          { rowIndex: 7, col: sharedCol, value: "07/16 - 11:00" },
        ]);
      });

      it("a lone top (no bottom): the whole text goes on the top cell, unsplit", async () => {
        const { org, bindingId } = await seedOrgWithBinding();
        const load = await seedLoad(org.id, bindingId, { sheetRowIndex: 6 });
        const text = "PU: 07/15 - 10:00\nDEL: 07/16 - 11:00";
        await board(load.id, org.id, { apptText: text });
        const { writes } = await collect({
          orgId: org.id, bindingId, mapping: SHARED_MAPPING, header: SHARED_HEADER, rowsPerLoad: 2, hasBottomByRow: { 6: false },
        });
        expect(writes).toEqual([{ rowIndex: 6, col: sharedCol, value: text }]);
      });
    });

    it("two-rows-per-load, SEPARATE columns: both lines land on the top row (unchanged)", async () => {
      const { org, bindingId } = await seedOrgWithBinding();
      const load = await seedLoad(org.id, bindingId, { sheetRowIndex: 6 });
      await board(load.id, org.id, { apptText: "PU: 07/15 - 10:00\nDEL: 07/16 - 11:00" });
      const { writes } = await collect({ orgId: org.id, bindingId, rowsPerLoad: 2, hasBottomByRow: { 6: true } });
      expect(writes.slice().sort((a, b) => a.col - b.col)).toEqual([
        { rowIndex: 6, col: col("PU APPT"), value: "07/15 - 10:00" },
        { rowIndex: 6, col: col("DEL APPT"), value: "07/16 - 11:00" },
      ]);
    });
  });

  it("extras: writes the changed key's own header cell", async () => {
    const { org, bindingId } = await seedOrgWithBinding();
    const load = await seedLoad(org.id, bindingId);
    await board(load.id, org.id, { extras: { "EXTRA COL": "foo" } });
    const { writes, conflicts } = await collect({ orgId: org.id, bindingId });
    expect(conflicts).toEqual([]);
    expect(writes).toEqual([{ rowIndex: 5, col: col("EXTRA COL"), value: "foo" }]);
  });

  it("extras: a same-tick sheet overwrite of the key conflicts instead of writing", async () => {
    const { org, bindingId } = await seedOrgWithBinding();
    const load = await seedLoad(org.id, bindingId);
    await board(load.id, org.id, { extras: { "EXTRA COL": "foo" } });
    await sheet(load.id, org.id, { extras: { "EXTRA COL": "bar" } });
    const { writes, conflicts } = await collect({ orgId: org.id, bindingId });
    expect(writes).toEqual([]);
    expect(conflicts).toEqual([{ loadId: load.id, text: 'conflict: sheet has "bar", board tried "foo" — sheet kept' }]);
  });

  it("never writes the agent switch or status columns, even for an extras key that happens to collide", async () => {
    const { org, bindingId } = await seedOrgWithBinding();
    const load = await seedLoad(org.id, bindingId);
    await board(load.id, org.id, { extras: { "Night Shift": "HACKED" } });
    const { writes } = await collect({ orgId: org.id, bindingId });
    expect(writes).toEqual([]);
  });

  describe("two-rows-per-load: bottom-owned fields", () => {
    const TWO_ROW_MAPPING: SheetMapping = { ...MAPPING, driverPhone: "TELEPHONE#" };
    const TWO_ROW_HEADER = [...HEADER, "TELEPHONE#"];

    it("lands on the bottom row when the pair has one", async () => {
      const { org, bindingId } = await seedOrgWithBinding();
      const load = await seedLoad(org.id, bindingId, { sheetRowIndex: 6 });
      await board(load.id, org.id, { driverCell: "+15551234567" });
      const { writes } = await collect({
        orgId: org.id, bindingId, mapping: TWO_ROW_MAPPING, header: TWO_ROW_HEADER, rowsPerLoad: 2, hasBottomByRow: { 6: true },
      });
      expect(writes).toEqual([{ rowIndex: 7, col: TWO_ROW_HEADER.indexOf("TELEPHONE#"), value: "+15551234567" }]);
    });

    it("lands on the top row when the pair has no bottom (a lone top)", async () => {
      const { org, bindingId } = await seedOrgWithBinding();
      const load = await seedLoad(org.id, bindingId, { sheetRowIndex: 6 });
      await board(load.id, org.id, { driverCell: "+15551234567" });
      const { writes } = await collect({
        orgId: org.id, bindingId, mapping: TWO_ROW_MAPPING, header: TWO_ROW_HEADER, rowsPerLoad: 2, hasBottomByRow: { 6: false },
      });
      expect(writes).toEqual([{ rowIndex: 6, col: TWO_ROW_HEADER.indexOf("TELEPHONE#"), value: "+15551234567" }]);
    });

    it("a top-owned field (delivery city) always lands on the top row", async () => {
      const { org, bindingId } = await seedOrgWithBinding();
      const load = await seedLoad(org.id, bindingId, { sheetRowIndex: 6 });
      await board(load.id, org.id, { stops: { delivery: { address: "Reno, NV" } } });
      const { writes } = await collect({
        orgId: org.id, bindingId, mapping: TWO_ROW_MAPPING, header: TWO_ROW_HEADER, rowsPerLoad: 2, hasBottomByRow: { 6: true },
      });
      expect(writes).toEqual([{ rowIndex: 6, col: TWO_ROW_HEADER.indexOf("DELIVERY"), value: "Reno, NV" }]);
    });
  });

  it("skips a load no longer linked to a sheet row (sheetRowIndex null)", async () => {
    const { org, bindingId } = await seedOrgWithBinding();
    const load = await seedLoad(org.id, bindingId, { sheetRowIndex: null });
    await board(load.id, org.id, { stops: { delivery: { address: "Reno, NV" } } });
    const { writes, conflicts } = await collect({ orgId: org.id, bindingId });
    expect(writes).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("skips a load mirrored by a DIFFERENT binding (sheetBindingId mismatch)", async () => {
    const { org, bindingId } = await seedOrgWithBinding();
    const other = await prisma.sheetBinding.create({
      data: { orgId: org.id, provider: "google", spreadsheetId: "s-other", tabId: "t1", tabTitle: "Other", headerRow: 1, columns: {}, refreshToken: "sealed-y", status: "connected" },
    });
    const load = await seedLoad(org.id, other.id);
    await board(load.id, org.id, { stops: { delivery: { address: "Reno, NV" } } });
    const { writes, conflicts } = await collect({ orgId: org.id, bindingId });
    expect(writes).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("ignores a non-board source (sheet, agent)", async () => {
    const { org, bindingId } = await seedOrgWithBinding();
    const load = await seedLoad(org.id, bindingId);
    await sheet(load.id, org.id, { stops: { delivery: { address: "Reno, NV" } } });
    const { writes } = await collect({ orgId: org.id, bindingId });
    expect(writes).toEqual([]);
  });
});
