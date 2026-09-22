import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDb } from "../helpers.js";
import { FakeConnector } from "../../src/lib/sheet/fakeConnector.js";
import type { CellWrite, SheetConnector, SpreadsheetInfo, AgentColumnNames, SheetRead, TabRef } from "../../src/lib/sheet/connector.js";
import { syncBinding } from "../../src/lib/sheet/sync.js";
import { applyLoadChange, type Actor } from "../../src/lib/loadWriter.js";
import { STANDARD_POLICY } from "../../src/lib/agentPolicies.js";

// Slice 4, Task 2 — board → sheet write-back, exercised end to end through
// `syncBinding` (a real DB, a `FakeConnector`) rather than unit-testing
// `collectBoardEdits` alone (that lives in writeBack.test.ts): this pins the
// actual tick sequencing — a board edit lands on the NEXT tick's connector
// grid, `boardSyncAtMs` advances, and our own write-back cells are folded
// into the predicted version the same way the status pass's are (Task 1),
// so the tick after that finds nothing to do.
process.env.PORTAL_URL ||= "http://localhost:5173";

const ref: TabRef = { spreadsheetId: "s1", tabId: "t1" };
const maria: Actor = { dispatcherId: "d-maria", name: "Maria" };
const board = (loadId: string, orgId: string, patch: Parameters<typeof applyLoadChange>[1]["patch"]) =>
  prisma.$transaction((tx) => applyLoadChange(tx, { loadId, orgId, actor: maria, source: "board", patch }));

let seq = 0;
async function seedOrg() {
  seq += 1;
  return prisma.org.create({ data: { name: `TwoWayOrg-${seq}`, linkSecret: randomBytes(32).toString("hex") } });
}
async function seedStandardPolicy(orgId: string) {
  return prisma.agentPolicy.create({ data: { ...STANDARD_POLICY, orgId, dispatcherEmail: "ops@acme.com" } });
}

// --- single-row-per-load fixture ---------------------------------------------

const MAPPING_1 = { loadRef: "LOAD#", driverPhone: "DRIVER PHONE", pickup: "PICK UP", delivery: "DELIVERY", pickupAppt: "PU APPT", deliveryAppt: "DEL APPT" };
const HEADER_1 = ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT"];
const SWITCH_COL_1 = HEADER_1.length;
const STATUS_COL_1 = HEADER_1.length + 1;
const DELIVERY_COL_1 = HEADER_1.indexOf("DELIVERY");
const DATA_ROW_1 = 2; // headerRow 1, one data row

function grid1(delivery = "Reno, NV"): string[][] {
  return [
    [...HEADER_1, "Night Shift", "Night Shift status"],
    ["145219", "+15551234567", "Dallas, TX", delivery, "09/21 08:00", "09/22 08:00", "", ""],
  ];
}

async function seedBinding1(orgId: string) {
  return prisma.sheetBinding.create({
    data: {
      orgId, provider: "google", spreadsheetId: ref.spreadsheetId, tabId: ref.tabId, tabTitle: "Sheet1",
      headerRow: 1, columns: MAPPING_1, refreshToken: "sealed-x", status: "connected",
      agentSwitchCol: SWITCH_COL_1, agentStatusCol: STATUS_COL_1, rowsPerLoad: 1,
    },
  });
}

// --- two-rows-per-load fixture ------------------------------------------------

const MAPPING_2 = {
  loadRef: "LOAD#", driverPhone: "DRIVER PHONE", pickup: "PICK UP", delivery: "DELIVERY",
  pickupAppt: "PU APPT", deliveryAppt: "DEL APPT", carrierPhone: "CARRIER PHONE",
};
const HEADER_2 = ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT", "CARRIER PHONE"];
const SWITCH_COL_2 = HEADER_2.length;
const STATUS_COL_2 = HEADER_2.length + 1;
const DELIVERY_COL_2 = HEADER_2.indexOf("DELIVERY");
const CARRIER_PHONE_COL_2 = HEADER_2.indexOf("CARRIER PHONE");
const TOP_ROW_2 = 2;
const BOTTOM_ROW_2 = 3;

function grid2(): string[][] {
  return [
    [...HEADER_2, "Night Shift", "Night Shift status"],
    ["", "", "Dallas, TX", "Reno, NV", "PU: 07/15 - 10:00", "", "", "", ""],
    ["145219", "", "", "", "", "DEL: 07/16 - 11:00", "(555) 010-1010", "", ""],
  ];
}

async function seedBinding2(orgId: string) {
  return prisma.sheetBinding.create({
    data: {
      orgId, provider: "google", spreadsheetId: ref.spreadsheetId, tabId: ref.tabId, tabTitle: "Sheet1",
      headerRow: 1, columns: MAPPING_2, refreshToken: "sealed-x", status: "connected",
      agentSwitchCol: SWITCH_COL_2, agentStatusCol: STATUS_COL_2, rowsPerLoad: 2,
    },
  });
}

function newConnector(grid: string[][]): FakeConnector {
  return new FakeConnector({ s1: { title: "Loads", tabs: { t1: { title: "Sheet1", grid } } } });
}

beforeEach(resetDb);

describe("board -> sheet write-back (rowsPerLoad 1)", () => {
  it("a board edit of the delivery city reaches the sheet cell on the next tick; boardSyncAtMs advances; the tick after that is a no-op", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding1(org.id);
    const connector = newConnector(grid1());

    const tick1 = await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    expect(tick1.error).toBeNull();
    expect(tick1.created).toBe(1);
    const bindingAfterTick1 = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(bindingAfterTick1.boardSyncAtMs).toBe(0n);

    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load.sheetRowIndex).toBe(DATA_ROW_1);
    await board(load.id, org.id, { stops: { delivery: { address: "Denver, CO" } } });

    const tick2 = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(tick2.error).toBeNull();
    // The sheet's own content is unchanged since tick1 (only the DB Load
    // moved) — the row pass has nothing to do; the write-back pass still
    // runs and lands the board's edit on the connector's real grid.
    expect(tick2.read).toBe(0);
    expect(connector.grid(ref)[DATA_ROW_1 - 1][DELIVERY_COL_1]).toBe("Denver, CO");
    const bindingAfterTick2 = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(bindingAfterTick2.boardSyncAtMs).toBeGreaterThan(0n);

    const statusCellAfterTick2 = connector.grid(ref)[DATA_ROW_1 - 1][STATUS_COL_1];
    const switchCellAfterTick2 = connector.grid(ref)[DATA_ROW_1 - 1][SWITCH_COL_1];

    // Tick 3: no new board edit, the write-back write already folded into
    // the predicted version — no read, no writes, no further boardSyncAtMs
    // movement.
    const tick3 = await syncBinding(binding.id, { connector, nowMs: () => 3000 });
    expect(tick3.error).toBeNull();
    expect(tick3.read).toBe(0);
    expect(connector.grid(ref)[DATA_ROW_1 - 1][DELIVERY_COL_1]).toBe("Denver, CO");
    const bindingAfterTick3 = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(bindingAfterTick3.boardSyncAtMs).toBe(bindingAfterTick2.boardSyncAtMs);
    // The switch/status columns are exactly as tick 2 left them.
    expect(connector.grid(ref)[DATA_ROW_1 - 1][STATUS_COL_1]).toBe(statusCellAfterTick2);
    expect(connector.grid(ref)[DATA_ROW_1 - 1][SWITCH_COL_1]).toBe(switchCellAfterTick2);
  });

  it("same-tick conflict: a human sheet edit beats the board's edit of the same field — the sheet's value wins, no write, one conflict line", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding1(org.id);
    const connector = newConnector(grid1("Reno, NV"));

    await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });

    // Between tick 1 and tick 2: a dispatcher edits the board (Denver, CO)
    // AND, separately, a human retypes the sheet cell directly (Chicago, IL)
    // — the sheet's row pass will see and apply Chicago, IL before the
    // write-back pass ever looks at the board's Denver, CO.
    await board(load.id, org.id, { stops: { delivery: { address: "Denver, CO" } } });
    await connector.writeCells(ref, [{ rowIndex: DATA_ROW_1, col: DELIVERY_COL_1, value: "Chicago, IL" }]);

    const statusColBefore = connector.grid(ref).map((r) => r[STATUS_COL_1]);
    const switchColBefore = connector.grid(ref).map((r) => r[SWITCH_COL_1]);

    const tick2 = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(tick2.error).toBeNull();

    // The Load ends up with the sheet's value (Chicago, IL), not the
    // board's (Denver, CO) and not the pre-edit one (Reno, NV).
    const after = await prisma.load.findUniqueOrThrow({ where: { id: load.id }, include: { stops: true } });
    expect(after.stops.find((s) => s.type === "delivery")?.address).toBe("Chicago, IL");
    // The sheet cell was never overwritten by the board's losing edit.
    expect(connector.grid(ref)[DATA_ROW_1 - 1][DELIVERY_COL_1]).toBe("Chicago, IL");

    const conflictLines = await prisma.agentUpdate.findMany({ where: { loadId: load.id, kind: "status" } });
    expect(conflictLines.map((l) => l.text)).toEqual([
      'conflict: sheet has "Chicago, IL", board tried "Denver, CO" — sheet kept',
    ]);

    // The agent's own columns are untouched by any of this.
    expect(connector.grid(ref).map((r) => r[STATUS_COL_1])).toEqual(statusColBefore);
    expect(connector.grid(ref).map((r) => r[SWITCH_COL_1])).toEqual(switchColBefore);
  });
});

describe("board -> sheet write-back (rowsPerLoad 2)", () => {
  it("a bottom-owned field (carrier phone) lands on the bottom row; a top-owned field (delivery city) lands on the top row", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding2(org.id);
    const connector = newConnector(grid2());

    const tick1 = await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    expect(tick1.error).toBeNull();
    expect(tick1.created).toBe(1);

    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load.sheetRowIndex).toBe(TOP_ROW_2);

    await board(load.id, org.id, { carrierPhone: "(555) 999-9999" });
    await board(load.id, org.id, { stops: { delivery: { address: "Denver, CO" } } });

    const tick2 = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(tick2.error).toBeNull();

    const grid = connector.grid(ref);
    expect(grid[BOTTOM_ROW_2 - 1][CARRIER_PHONE_COL_2]).toBe("(555) 999-9999");
    expect(grid[TOP_ROW_2 - 1][DELIVERY_COL_2]).toBe("Denver, CO");
    // Never written to the bottom row's delivery cell (blank in the fixture).
    expect(grid[BOTTOM_ROW_2 - 1][DELIVERY_COL_2]).toBe("");
  });
});

// Review round 1, item 3 — an org running TWO connected bindings must never
// let one binding's write-back reach the other's grid, even when their
// loads happen to share a `sheetRowIndex` (both single-row fixtures put
// their one load at row 2). Before the fix (`Load.sheetBindingId` + scoping
// every lookup by it), this was unscoped by `orgId` alone.
describe("two connected bindings in one org: no misrouting", () => {
  it("binding A's write-back never reaches binding B's grid, or vice versa, even at the same rowIndex", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);

    const refA: TabRef = { spreadsheetId: "sA", tabId: "t1" };
    const refB: TabRef = { spreadsheetId: "sB", tabId: "t1" };
    const gridFor = (loadNo: string, delivery: string): string[][] => [
      [...HEADER_1, "Night Shift", "Night Shift status"],
      [loadNo, "+15551234567", "Dallas, TX", delivery, "09/21 08:00", "09/22 08:00", "", ""],
    ];
    const connector = new FakeConnector({
      sA: { title: "Sheet A", tabs: { t1: { title: "Sheet1", grid: gridFor("A-1", "Reno, NV") } } },
      sB: { title: "Sheet B", tabs: { t1: { title: "Sheet1", grid: gridFor("B-1", "Boise, ID") } } },
    });

    const bindingA = await prisma.sheetBinding.create({
      data: {
        orgId: org.id, provider: "google", spreadsheetId: refA.spreadsheetId, tabId: refA.tabId, tabTitle: "Sheet1",
        headerRow: 1, columns: MAPPING_1, refreshToken: "sealed-a", status: "connected",
        agentSwitchCol: SWITCH_COL_1, agentStatusCol: STATUS_COL_1, rowsPerLoad: 1,
      },
    });
    const bindingB = await prisma.sheetBinding.create({
      data: {
        orgId: org.id, provider: "google", spreadsheetId: refB.spreadsheetId, tabId: refB.tabId, tabTitle: "Sheet1",
        headerRow: 1, columns: MAPPING_1, refreshToken: "sealed-b", status: "connected",
        agentSwitchCol: SWITCH_COL_1, agentStatusCol: STATUS_COL_1, rowsPerLoad: 1,
      },
    });

    await syncBinding(bindingA.id, { connector, nowMs: () => 1000 });
    await syncBinding(bindingB.id, { connector, nowMs: () => 1000 });

    const loadA = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "A-1" } });
    const loadB = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "B-1" } });
    expect(loadA.sheetRowIndex).toBe(DATA_ROW_1);
    expect(loadB.sheetRowIndex).toBe(DATA_ROW_1); // same row number, different sheets

    await board(loadA.id, org.id, { stops: { delivery: { address: "Denver, CO" } } });
    await board(loadB.id, org.id, { stops: { delivery: { address: "Chicago, IL" } } });

    // Only binding A ticks. If write-back were scoped by orgId alone, its
    // pass would also pick up B's newer board change and, since both loads
    // sit at the same rowIndex, overwrite A's own cell with B's value.
    const tickA = await syncBinding(bindingA.id, { connector, nowMs: () => 2000 });
    expect(tickA.error).toBeNull();
    expect(connector.grid(refA)[DATA_ROW_1 - 1][DELIVERY_COL_1]).toBe("Denver, CO");
    // B's own sheet is untouched — B hasn't ticked yet.
    expect(connector.grid(refB)[DATA_ROW_1 - 1][DELIVERY_COL_1]).toBe("Boise, ID");

    const tickB = await syncBinding(bindingB.id, { connector, nowMs: () => 2000 });
    expect(tickB.error).toBeNull();
    expect(connector.grid(refB)[DATA_ROW_1 - 1][DELIVERY_COL_1]).toBe("Chicago, IL");
    // A's cell is exactly as A's own tick left it — B's tick never touched it.
    expect(connector.grid(refA)[DATA_ROW_1 - 1][DELIVERY_COL_1]).toBe("Denver, CO");
  });
});

// Review round 1, item 5 — a connector failure during write-back must not
// look like the edit succeeded: `boardSyncAtMs` only advances once the
// writes actually land.
describe("a connector failure during write-back", () => {
  class ThrowOnceConnector implements SheetConnector {
    private thrown = false;
    constructor(private readonly inner: FakeConnector) {}
    spreadsheetInfo(id: string): Promise<SpreadsheetInfo> { return this.inner.spreadsheetInfo(id); }
    readHeader(r: TabRef, headerRow: number): Promise<string[]> { return this.inner.readHeader(r, headerRow); }
    readRows(r: TabRef, headerRow: number, since?: string): Promise<SheetRead> { return this.inner.readRows(r, headerRow, since); }
    async writeCells(r: TabRef, writes: CellWrite[]): Promise<void> {
      if (!this.thrown) { this.thrown = true; throw new Error("connector down"); }
      return this.inner.writeCells(r, writes);
    }
    ensureAgentColumns(r: TabRef, headerRow: number, names: AgentColumnNames, policyNames: string[]) {
      return this.inner.ensureAgentColumns(r, headerRow, names, policyNames);
    }
  }

  it("writeCells throwing leaves boardSyncAtMs unchanged; the edit is retried and lands on the next successful tick", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding1(org.id);
    const fake = newConnector(grid1());

    // Tick 1 (creates the load, writes its first status cell) uses the
    // plain connector — only tick 2's write-back call should fail.
    await syncBinding(binding.id, { connector: fake, nowMs: () => 1000 });
    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    await board(load.id, org.id, { stops: { delivery: { address: "Denver, CO" } } });

    const flaky = new ThrowOnceConnector(fake);

    const tick2 = await syncBinding(binding.id, { connector: flaky, nowMs: () => 2000 });
    expect(tick2.error).not.toBeNull();
    const bindingAfterTick2 = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(bindingAfterTick2.boardSyncAtMs).toBe(0n);
    expect(fake.grid(ref)[DATA_ROW_1 - 1][DELIVERY_COL_1]).toBe("Reno, NV"); // never written

    const tick3 = await syncBinding(binding.id, { connector: flaky, nowMs: () => 3000 });
    expect(tick3.error).toBeNull();
    expect(fake.grid(ref)[DATA_ROW_1 - 1][DELIVERY_COL_1]).toBe("Denver, CO");
    const bindingAfterTick3 = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(bindingAfterTick3.boardSyncAtMs).toBeGreaterThan(0n);
  });
});
