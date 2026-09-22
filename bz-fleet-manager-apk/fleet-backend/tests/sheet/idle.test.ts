import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDb } from "../helpers.js";
import { FakeConnector } from "../../src/lib/sheet/fakeConnector.js";
import type { TabRef } from "../../src/lib/sheet/connector.js";
import { syncBinding } from "../../src/lib/sheet/sync.js";
import { STANDARD_POLICY } from "../../src/lib/agentPolicies.js";
import { BROKER_ROWS, THEIR_HEADER } from "../fixtures/brokerBoard.js";

// Task 1: our own status writes must not make the NEXT tick look like the
// sheet changed. Tick 1 writes the two agent cells; because `lastVersion` is
// now the PREDICTED post-write digest (digest.ts), tick 2 — with no human
// edit — reads the sheet as unchanged and skips the row pass entirely
// (report.read === 0, no new LoadChange rows, statusWrites === 0). A human
// edit between ticks is still detected on the very next tick.
process.env.PORTAL_URL ||= "http://localhost:5173";

const ref: TabRef = { spreadsheetId: "s1", tabId: "t1" };
const MAPPING = { loadRef: "LOAD#", driverPhone: "DRIVER PHONE", pickup: "PICK UP", delivery: "DELIVERY", pickupAppt: "PU APPT", deliveryAppt: "DEL APPT" };
const BASE_HEADER = ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT"];
const SWITCH_COL = 6;
const STATUS_COL = 7;

let seq = 0;
async function seedOrg() {
  seq += 1;
  return prisma.org.create({ data: { name: `SheetIdleOrg-${seq}`, linkSecret: randomBytes(32).toString("hex") } });
}

async function seedStandardPolicy(orgId: string) {
  return prisma.agentPolicy.create({ data: { ...STANDARD_POLICY, orgId, dispatcherEmail: "ops@acme.com" } });
}

async function seedBinding(orgId: string, over: Partial<{ rowsPerLoad: 1 | 2; headerRow: number; columns: unknown; tabTitle: string }> = {}) {
  return prisma.sheetBinding.create({
    data: {
      orgId, provider: "google", spreadsheetId: ref.spreadsheetId, tabId: ref.tabId, tabTitle: over.tabTitle ?? "Sheet1",
      headerRow: over.headerRow ?? 1, columns: over.columns ?? MAPPING, refreshToken: "sealed-x", status: "connected",
      agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL, rowsPerLoad: over.rowsPerLoad ?? 1,
    },
  });
}

function gridWithAgentCols(rows: { loadNo: string }[]): string[][] {
  const header = [...BASE_HEADER, "Night Shift", "Night Shift status"];
  const body = rows.map((r) => [r.loadNo, "+15551234567", "Dallas, TX", "Reno, NV", "09/21 08:00", "09/22 08:00", "", ""]);
  return [header, ...body];
}

function newConnector(grid: string[][]): FakeConnector {
  return new FakeConnector({ s1: { title: "Loads", tabs: { t1: { title: "Sheet1", grid } } } });
}

beforeEach(resetDb);

describe("idle ticks after our own status write (single row per load)", () => {
  it("tick 2 with no human edit is a no-op; a human edit is still caught on the next tick", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id);
    const connector = newConnector(gridWithAgentCols([{ loadNo: "145219" }]));

    const tick1 = await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    expect(tick1.statusWrites).toBeGreaterThan(0);
    expect(connector.grid(ref)[1][STATUS_COL]).toBe("● OFF");

    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    const changesAfterTick1 = await prisma.loadChange.count({ where: { loadId: load.id } });

    const tick2 = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(tick2.error).toBeNull();
    expect(tick2.read).toBe(0);
    expect(tick2.created).toBe(0);
    expect(tick2.updated).toBe(0);
    expect(tick2.skipped).toEqual([]);
    expect(tick2.statusWrites).toBe(0);
    expect(await prisma.loadChange.count({ where: { loadId: load.id } })).toBe(changesAfterTick1);

    // A human edits a cell between ticks: the very next tick detects it.
    await connector.writeCells(ref, [{ rowIndex: 2, col: 2, value: "Fort Worth, TX" }]);
    const tick3 = await syncBinding(binding.id, { connector, nowMs: () => 3000 });
    expect(tick3.read).toBe(1);
    expect(tick3.updated).toBe(1);
    expect(await prisma.loadChange.count({ where: { loadId: load.id } })).toBeGreaterThan(changesAfterTick1);
  });
});

describe("idle ticks after our own status write (two rows per load)", () => {
  const HEADER_ROW = 2;
  const TWO_ROW_MAPPING = {
    loadRef: "LOAD#", driverPhone: "TELEPHONE#", driverName: "CONTACT NAME", pickup: "PICK UP", delivery: "DELIVERY",
    pickupAppt: "APPT SCHEDULE", deliveryAppt: "APPT SCHEDULE", carrierName: "CUSTOMER /CARRIER", rate: "RATE", notes: "****UPDATE****",
  };
  const TWO_ROW_SWITCH_COL = THEIR_HEADER.length;
  const TWO_ROW_STATUS_COL = THEIR_HEADER.length + 1;
  const TOP_ROWS = [3, 6, 9, 12, 15];

  function brokerGrid(): string[][] {
    return BROKER_ROWS.map((row, i) => (i + 1 === HEADER_ROW ? [...row, "Night Shift", "Night Shift status"] : [...row]));
  }

  function twoRowConnector(grid: string[][]): FakeConnector {
    return new FakeConnector({ s1: { title: "Board", tabs: { t1: { title: "Board", grid } } } });
  }

  async function seedTwoRowBinding(orgId: string) {
    return prisma.sheetBinding.create({
      data: {
        orgId, provider: "google", spreadsheetId: ref.spreadsheetId, tabId: ref.tabId, tabTitle: "Board",
        headerRow: HEADER_ROW, columns: TWO_ROW_MAPPING, refreshToken: "sealed-x", status: "connected",
        agentSwitchCol: TWO_ROW_SWITCH_COL, agentStatusCol: TWO_ROW_STATUS_COL, rowsPerLoad: 2,
      },
    });
  }

  it("tick 2 with no human edit is a no-op; a human edit to a top row is still caught next tick", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedTwoRowBinding(org.id);
    const connector = twoRowConnector(brokerGrid());

    const tick1 = await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    expect(tick1.statusWrites).toBe(5);
    const writtenAfterTick1 = TOP_ROWS.map((r) => connector.grid(ref)[r - 1][TWO_ROW_STATUS_COL]);
    expect(writtenAfterTick1.every((v) => v.length > 0)).toBe(true);

    const loadCountBefore = await prisma.load.count({ where: { orgId: org.id } });
    const changesBefore = await prisma.loadChange.count({ where: { load: { orgId: org.id } } });

    const tick2 = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(tick2.error).toBeNull();
    expect(tick2.read).toBe(0);
    expect(tick2.created).toBe(0);
    expect(tick2.updated).toBe(0);
    expect(tick2.statusWrites).toBe(0);
    expect(await prisma.load.count({ where: { orgId: org.id } })).toBe(loadCountBefore);
    expect(await prisma.loadChange.count({ where: { load: { orgId: org.id } } })).toBe(changesBefore);
    expect(TOP_ROWS.map((r) => connector.grid(ref)[r - 1][TWO_ROW_STATUS_COL])).toEqual(writtenAfterTick1);

    // A human edits a top row's own cell between ticks: caught next tick.
    await connector.writeCells(ref, [{ rowIndex: TOP_ROWS[0], col: 0, value: "999999" }]);
    const tick3 = await syncBinding(binding.id, { connector, nowMs: () => 3000 });
    expect(tick3.read).toBe(5);
  });
});
