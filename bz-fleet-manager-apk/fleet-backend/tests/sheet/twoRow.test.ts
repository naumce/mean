import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDb } from "../helpers.js";
import { FakeConnector } from "../../src/lib/sheet/fakeConnector.js";
import type { TabRef } from "../../src/lib/sheet/connector.js";
import { syncBinding } from "../../src/lib/sheet/sync.js";
import { STANDARD_POLICY } from "../../src/lib/agentPolicies.js";
import { BROKER_ROWS, THEIR_HEADER } from "../fixtures/brokerBoard.js";

// Two-rows-per-load sheets: a binding with `rowsPerLoad: 2` over the broker
// fixture grid (title row, header on row 2, customer row + carrier row per
// load, a blank row between loads). `syncBinding` takes its connector as an
// explicit dependency, so nothing here is mocked.
process.env.PORTAL_URL ||= "http://localhost:5173";

const ref: TabRef = { spreadsheetId: "s1", tabId: "t1" };
const HEADER_ROW = 2;
const MAPPING = {
  loadRef: "LOAD#", driverPhone: "TELEPHONE#", driverName: "CONTACT NAME", pickup: "PICK UP", delivery: "DELIVERY",
  pickupAppt: "APPT SCHEDULE", deliveryAppt: "APPT SCHEDULE", carrierName: "CUSTOMER /CARRIER", rate: "RATE", notes: "****UPDATE****",
};
const SWITCH_COL = THEIR_HEADER.length;
const STATUS_COL = THEIR_HEADER.length + 1;
/** 1-based sheet rows of the fixture's five top rows and four carrier rows. */
const TOP_ROWS = [3, 6, 9, 12, 15];
const BOTTOM_ROWS = [4, 7, 10, 13];
const LOAD_NOS = ["145205", "145219", "145197", "145963", "2026-35100-00"];

let seq = 0;
async function seedOrg() {
  seq += 1;
  return prisma.org.create({ data: { name: `TwoRowOrg-${seq}`, linkSecret: randomBytes(32).toString("hex") } });
}

async function seedStandardPolicy(orgId: string) {
  return prisma.agentPolicy.create({ data: { ...STANDARD_POLICY, orgId, dispatcherEmail: "ops@acme.com" } });
}

async function seedBinding(orgId: string, rowsPerLoad: 1 | 2 = 2) {
  return prisma.sheetBinding.create({
    data: {
      orgId, provider: "google", spreadsheetId: ref.spreadsheetId, tabId: ref.tabId, tabTitle: "Board",
      headerRow: HEADER_ROW, columns: MAPPING, refreshToken: "sealed-x", status: "connected",
      agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL, rowsPerLoad,
    },
  });
}

/** The broker grid with the two agent columns appended to the header row
 *  (installed), and `switchAt` = { sheetRow: value } for the switch cells. */
function brokerGrid(switchAt: Record<number, string> = {}): string[][] {
  return BROKER_ROWS.map((row, i) => {
    const sheetRow = i + 1;
    if (sheetRow === HEADER_ROW) return [...row, "Night Shift", "Night Shift status"];
    const sw = switchAt[sheetRow];
    return sw === undefined ? [...row] : [...row, sw, ""];
  });
}

function newConnector(grid: string[][]): FakeConnector {
  return new FakeConnector({ s1: { title: "Board", tabs: { t1: { title: "Board", grid } } } });
}

const statusColumn = (c: FakeConnector): Record<number, string> =>
  Object.fromEntries(c.grid(ref).map((row, i) => [i + 1, row[STATUS_COL] ?? ""]).filter(([r, v]) => (r as number) > HEADER_ROW && v !== ""));

beforeEach(resetDb);

describe("syncBinding with rowsPerLoad 2", () => {
  it("mirrors the broker grid as 5 loads keyed by the carrier row's LOAD#, linked to the top rows", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id);
    const connector = newConnector(brokerGrid());

    const report = await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    expect(report.error).toBeNull();
    expect(report.read).toBe(5);
    expect(report.created).toBe(5);
    expect(report.skipped).toEqual([]);

    const loads = await prisma.load.findMany({ where: { orgId: org.id }, orderBy: { sheetRowIndex: "asc" }, include: { carrier: true, stops: true } });
    expect(loads.map((l) => l.boardLoadNo)).toEqual(LOAD_NOS);
    expect(loads.map((l) => l.sheetRowIndex)).toEqual(TOP_ROWS);

    const first = loads[0];
    expect(first.driverCell).toBe("+15550100104"); // the carrier row's phone, not the tracking URL
    expect(first.carrierContactName).toBe("Contact A");
    expect(first.carrier?.name).toBe("BLUE ROAD LLC");
    expect(first.apptText).toBe("PU: 07/13 - 13:00\nDEL: 07/15 - 11:00");
    expect(first.revenueCents).toBe(400000);
    expect((first.extras as Record<string, string>)["ORDER REF"]).toBe("2026-34566-00");
    expect((first.extras as Record<string, string>)["M.C. #"]).toBe("MC"); // top wins on an unmapped column
    expect(first.stops.map((s) => s.address).sort()).toEqual(["Dallas, TX", "Henderson, NV"]);

    // The unassigned Denver load: its own LOAD#, no carrier phone -> attention, no ORDER REF.
    const denver = loads[4];
    expect(denver.boardLoadNo).toBe("2026-35100-00");
    expect(denver.driverCell).toBeNull();
    expect((denver.extras as Record<string, string> | null)?.["ORDER REF"]).toBeUndefined();
  });

  it("the status cell lands on the top row only, and an unchanged second tick writes nothing", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id);
    const connector = newConnector(brokerGrid());

    const first = await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    expect(first.statusWrites).toBe(5);
    const written = statusColumn(connector);
    expect(Object.keys(written).map(Number).sort((a, b) => a - b)).toEqual(TOP_ROWS);
    for (const r of BOTTOM_ROWS) expect(written[r]).toBeUndefined();

    // Tick 1's own status writes changed the content digest, so tick 2
    // re-runs the row pass but writes nothing back to the sheet; tick 3
    // sees the sheet still and reads nothing at all.
    const second = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(second.error).toBeNull();
    expect(second.statusWrites).toBe(0);
    expect(second.created).toBe(0);
    expect(second.skipped).toEqual([]);
    expect(statusColumn(connector)).toEqual(written);

    const third = await syncBinding(binding.id, { connector, nowMs: () => 3000 });
    expect(third.statusWrites).toBe(0);
    expect(third.read).toBe(0);
    expect(statusColumn(connector)).toEqual(written);
  });

  it("Standard on a TOP row's Night Shift cell enables that load", async () => {
    const org = await seedOrg();
    const policy = await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id);
    const connector = newConnector(brokerGrid({ [TOP_ROWS[1]]: "Standard" }));
    const switchBefore = connector.grid(ref).map((row) => row[SWITCH_COL] ?? "");

    await syncBinding(binding.id, { connector, nowMs: () => 1000 });

    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load.agentEnabled).toBe(true);
    expect(load.agentPolicyId).toBe(policy.id);
    expect(load.sheetSwitchSeen).toBe("Standard");
    const others = await prisma.load.findMany({ where: { orgId: org.id, NOT: { boardLoadNo: "145219" } } });
    expect(others.every((l) => !l.agentEnabled)).toBe(true);
    // the switch column is never written
    expect(connector.grid(ref).map((row) => row[SWITCH_COL] ?? "")).toEqual(switchBefore);
  });

  it("a value in a BOTTOM row's Night Shift cell does nothing", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id);
    const connector = newConnector(brokerGrid({ [BOTTOM_ROWS[1]]: "Standard", [BOTTOM_ROWS[0]]: "Bogus" }));

    const report = await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    expect(report.error).toBeNull();

    const loads = await prisma.load.findMany({ where: { orgId: org.id } });
    expect(loads).toHaveLength(5);
    expect(loads.every((l) => !l.agentEnabled && l.agentPolicyId === null)).toBe(true);
    expect(loads.every((l) => (l.sheetSwitchSeen ?? "") === "")).toBe(true);
    const attention = await prisma.agentUpdate.findMany({ where: { loadId: { in: loads.map((l) => l.id) }, kind: "attention", text: { contains: "unknown policy" } } });
    expect(attention).toEqual([]);
    // and nothing was painted onto the bottom rows
    const written = statusColumn(connector);
    for (const r of BOTTOM_ROWS) expect(written[r]).toBeUndefined();
  });

  it("with rowsPerLoad 1 the same grid is read row-by-row (carrier rows have no load number)", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, 1);
    const connector = newConnector(brokerGrid());

    const report = await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    expect(report.read).toBe(9);
    const loads = await prisma.load.findMany({ where: { orgId: org.id } });
    expect(loads.map((l) => l.boardLoadNo).sort()).toEqual([...LOAD_NOS, "2026-34566-00", "2026-35082-00", "RBMT61145", "931599400"].sort());
  });
});
