import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDb } from "../helpers.js";
import { FakeConnector } from "../../src/lib/sheet/fakeConnector.js";
import type { TabRef } from "../../src/lib/sheet/connector.js";
import { syncBinding, COLUMNS_NOT_FOUND } from "../../src/lib/sheet/sync.js";
import { installAgentColumns } from "../../src/lib/sheet/installColumns.js";
import { linkUrlFor } from "../../src/lib/nightShiftLink.js";
import { STANDARD_POLICY } from "../../src/lib/agentPolicies.js";
import * as agentSwitchModule from "../../src/lib/agentSwitch.js";

// Task 9: the two cells — install, the switch read, the status write.
// `syncBinding` takes its connector as an explicit dependency (SyncDeps), so
// most of this file never needs to mock `connectorFor.js` at all — only
// `installAgentColumns` (no injectable connector; it always resolves one off
// the binding row) does, exactly the way `tests/sheet/routes.test.ts` mocks
// it for the HTTP routes.
process.env.PORTAL_URL ||= "http://localhost:5173";

let currentConnector: FakeConnector;
vi.mock("../../src/lib/sheet/connectorFor.js", () => ({
  connectorFor: vi.fn(() => currentConnector),
}));

const ref: TabRef = { spreadsheetId: "s1", tabId: "t1" };
const MAPPING = { loadRef: "LOAD#", driverPhone: "DRIVER PHONE", pickup: "PICK UP", delivery: "DELIVERY", pickupAppt: "PU APPT", deliveryAppt: "DEL APPT" };
const BASE_HEADER = ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT"];
const SWITCH_COL = 6;
const STATUS_COL = 7;

let seq = 0;
async function seedOrg() {
  seq += 1;
  // A real linkSecret (schema defaults to "" for existing rows; a fresh
  // create should look like every other org's — see dispatcherAuth.ts's
  // signup, which backfills the same way).
  return prisma.org.create({ data: { name: `SheetCellsOrg-${seq}`, linkSecret: randomBytes(32).toString("hex") } });
}

function policyData(orgId: string, over: Partial<Record<string, unknown>> = {}) {
  return { ...STANDARD_POLICY, orgId, dispatcherEmail: "ops@acme.com", ...over };
}

async function seedStandardPolicy(orgId: string) {
  return prisma.agentPolicy.create({ data: policyData(orgId) });
}

async function seedBinding(
  orgId: string,
  over: Partial<{ agentSwitchCol: number | null; agentStatusCol: number | null; lastVersion: string | null }> = {},
) {
  return prisma.sheetBinding.create({
    data: {
      orgId, provider: "google", spreadsheetId: ref.spreadsheetId, tabId: ref.tabId, tabTitle: "Sheet1",
      headerRow: 1, columns: MAPPING, refreshToken: "sealed-x", status: "connected",
      agentSwitchCol: over.agentSwitchCol ?? null,
      agentStatusCol: over.agentStatusCol ?? null,
      lastVersion: over.lastVersion ?? null,
    },
  });
}

/** A base sheet grid with the two agent columns already appended at
 *  `SWITCH_COL`/`STATUS_COL`, one row per entry. */
function gridWithAgentCols(rows: { loadNo: string; switchVal?: string }[]): string[][] {
  const header = [...BASE_HEADER, "Night Shift", "Night Shift status"];
  const body = rows.map((r) => [r.loadNo, "+15551234567", "Dallas, TX", "Reno, NV", "09/21 08:00", "09/22 08:00", r.switchVal ?? "", ""]);
  return [header, ...body];
}

function newConnector(grid: string[][]): FakeConnector {
  return new FakeConnector({ s1: { title: "Loads", tabs: { t1: { title: "Sheet1", grid } } } });
}

beforeEach(resetDb);

// --- install -----------------------------------------------------------------

describe("installAgentColumns", () => {
  it("adds the two columns, sets the dropdown to OFF + Standard, is idempotent, and a new policy grows the dropdown", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id);
    currentConnector = newConnector([
      BASE_HEADER,
      ["145219", "+15551234567", "Dallas, TX", "Reno, NV", "09/21 08:00", "09/22 08:00"],
    ]);

    const cols = await installAgentColumns(binding.id);
    expect(cols).toEqual({ switch: SWITCH_COL, status: STATUS_COL });
    expect(currentConnector.validation(ref, cols.switch)).toEqual(["OFF", "Standard"]);

    const fresh = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(fresh.agentSwitchCol).toBe(SWITCH_COL);
    expect(fresh.agentStatusCol).toBe(STATUS_COL);

    // Running it twice changes nothing: same indexes, same header.
    const headerBefore = await currentConnector.readHeader(ref, 1);
    const cols2 = await installAgentColumns(binding.id);
    expect(cols2).toEqual(cols);
    expect(await currentConnector.readHeader(ref, 1)).toEqual(headerBefore);

    // A new policy re-installs and the dropdown gains it.
    await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Hazmat" }) });
    await installAgentColumns(binding.id);
    expect(currentConnector.validation(ref, cols.switch)).toEqual(["OFF", "Standard", "Hazmat"]);
  });
});

// --- the switch read -----------------------------------------------------------------

describe("syncBinding — the switch read", () => {
  it("a switch cell naming a policy enables the load, traced with source sheet, and never rewrites the switch cell", async () => {
    const org = await seedOrg();
    const policy = await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const grid = gridWithAgentCols([{ loadNo: "145219", switchVal: "Standard" }]);
    const connector = newConnector(grid);
    const switchColBefore = connector.grid(ref).map((row) => row[SWITCH_COL]);

    await syncBinding(binding.id, { connector, nowMs: () => 1000 });

    expect(connector.grid(ref).map((row) => row[SWITCH_COL])).toEqual(switchColBefore);

    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load.agentEnabled).toBe(true);
    expect(load.agentPolicyId).toBe(policy.id);
    expect(load.agentPill).toBe("watching");
    expect(load.sheetSwitchSeen).toBe("Standard"); // I5: what the sync last acted on

    const change = await prisma.loadChange.findFirst({ where: { loadId: load.id, field: "agentEnabled" } });
    expect(change?.source).toBe("sheet");
    expect(change?.actorName).toBe("sheet");
  });

  it("OFF disables an already-enabled load and writes a stop AgentCommand, without rewriting the switch cell", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const connector = newConnector(gridWithAgentCols([{ loadNo: "145219", switchVal: "Standard" }]));
    await syncBinding(binding.id, { connector, nowMs: () => 1000 });

    await connector.writeCells(ref, [{ rowIndex: 2, col: SWITCH_COL, value: "OFF" }]);
    const switchColBefore = connector.grid(ref).map((row) => row[SWITCH_COL]);

    await syncBinding(binding.id, { connector, nowMs: () => 2000 });

    expect(connector.grid(ref).map((row) => row[SWITCH_COL])).toEqual(switchColBefore);

    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load.agentEnabled).toBe(false);
    expect(load.agentPill).toBe("off");

    const commands = await prisma.agentCommand.findMany({ where: { loadId: load.id, kind: "stop" } });
    expect(commands).toHaveLength(1);
  });

  it("an unrecognized policy name raises attention and makes no switch change", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const connector = newConnector(gridWithAgentCols([{ loadNo: "145219", switchVal: "Bogus" }]));
    const switchColBefore = connector.grid(ref).map((row) => row[SWITCH_COL]);

    await syncBinding(binding.id, { connector, nowMs: () => 1000 });

    expect(connector.grid(ref).map((row) => row[SWITCH_COL])).toEqual(switchColBefore);

    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load.agentEnabled).toBe(false);
    expect(load.agentPolicyId).toBeNull();

    const attention = await prisma.agentUpdate.findMany({ where: { loadId: load.id, kind: "attention" } });
    expect(attention.some((a) => a.text === `unknown policy: "Bogus"`)).toBe(true);
  });

  // RULING (final fix wave, I5 — replaces fix round 1's "the sheet cell
  // wins over a board flip"): the switch reacts to the cell CHANGING, not to
  // the cell's value every tick. A drawer/deep-link `stop` (commands.ts's
  // applyStop: agentEnabled=false, pill off, no cell change) therefore
  // stands until the dispatcher touches the cell again — OFF, then the
  // policy name, restarts it. The board's own AgentSwitch stays disabled
  // for a bound org (Task 11), so the cell and the drawer are the only two
  // doors, and they no longer fight. This test pins that ruling down.
  it("a drawer stop is NOT reverted while the cell sits still; a cell change to OFF then the policy restarts it", async () => {
    const org = await seedOrg();
    const policy = await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const connector = newConnector(gridWithAgentCols([{ loadNo: "145219", switchVal: "Standard" }]));
    await syncBinding(binding.id, { connector, nowMs: () => 1000 });

    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load.agentEnabled).toBe(true);
    expect(load.sheetSwitchSeen).toBe("Standard");

    // Simulate the drawer's/deep link's Stop exactly as night-shift's
    // commands.ts applyStop writes it: the switch and the pill go off, with
    // no traced change and no cell change.
    await prisma.load.update({ where: { id: load.id }, data: { agentEnabled: false, agentPill: "off", version: { increment: 1 } } });

    // An unchanged sheet: no row pass at all, so nothing to revert with.
    await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).agentEnabled).toBe(false);

    // A changed sheet whose switch cell still reads "Standard": the row pass
    // runs, sees the cell equal to sheetSwitchSeen, and leaves the stop alone.
    await connector.writeCells(ref, [{ rowIndex: 2, col: 2, value: "Fort Worth, TX" }]);
    await syncBinding(binding.id, { connector, nowMs: () => 3000 });
    const stillStopped = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(stillStopped.agentEnabled).toBe(false);
    expect(stillStopped.agentPill).toBe("off");
    expect(await prisma.loadChange.count({ where: { loadId: load.id, field: "agentEnabled" } })).toBe(1); // only the original switch-on

    // The dispatcher flips the cell to OFF: a change, but the load is
    // already off — nothing to do beyond remembering the cell.
    await connector.writeCells(ref, [{ rowIndex: 2, col: SWITCH_COL, value: "OFF" }]);
    await syncBinding(binding.id, { connector, nowMs: () => 4000 });
    const afterOff = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(afterOff.agentEnabled).toBe(false);
    expect(afterOff.sheetSwitchSeen).toBe("OFF");
    expect(await prisma.agentCommand.count({ where: { loadId: load.id, kind: "stop" } })).toBe(0);

    // ...and back to the policy name: a change to ON restarts the agent,
    // traced as the sheet's own write.
    await connector.writeCells(ref, [{ rowIndex: 2, col: SWITCH_COL, value: "Standard" }]);
    await syncBinding(binding.id, { connector, nowMs: () => 5000 });
    const restarted = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(restarted.agentEnabled).toBe(true);
    expect(restarted.agentPolicyId).toBe(policy.id);
    expect(restarted.agentPill).toBe("watching");
    expect(restarted.sheetSwitchSeen).toBe("Standard");
    const changes = await prisma.loadChange.findMany({ where: { loadId: load.id, field: "agentEnabled" }, orderBy: { atMs: "desc" } });
    expect(changes).toHaveLength(2);
    expect(changes[0]?.source).toBe("sheet");
    expect(changes[0]?.after).toBe("true");
  });
});

// --- the agent columns, by name (final fix wave, C4) ---------------------------------

describe("syncBinding — the agent columns are found by header name, never by a stale index", () => {
  it("a column inserted to their left moves both: the status lands in the right column, the switch column is byte-identical, the indexes are re-persisted", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const connector = newConnector(gridWithAgentCols([{ loadNo: "145219", switchVal: "Standard" }]));
    await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    expect(connector.grid(ref)[1][STATUS_COL]).toMatch(/^● WATCHING/);

    // The dispatcher inserts a "NOTES" column at A between ticks: every
    // column, ours included, is one to the right of what the binding stored.
    const shifted = connector.grid(ref).map((row, i) => [i === 0 ? "NOTES" : "call me", ...row]);
    const connector2 = newConnector(shifted);
    const switchColBefore = connector2.grid(ref).map((row) => row[SWITCH_COL + 1]);
    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: 1500n, kind: "would_say", text: "would say: rolling" } });

    const report = await syncBinding(binding.id, { connector: connector2, nowMs: () => 2000 });
    expect(report.error).toBeNull();
    expect(report.statusWrites).toBe(1);

    const grid = connector2.grid(ref);
    expect(grid[1][STATUS_COL + 1]).toBe("● WATCHING — would say: rolling");
    expect(grid.map((row) => row[SWITCH_COL + 1])).toEqual(switchColBefore);
    // The old status index now holds the switch cell — it was never written.
    expect(grid[1][STATUS_COL]).toBe("Standard");

    const fresh = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(fresh.agentSwitchCol).toBe(SWITCH_COL + 1);
    expect(fresh.agentStatusCol).toBe(STATUS_COL + 1);
    expect(fresh.lastError).toBeNull();
  });

  it("a deleted status column: the switch read and the status pass are skipped, lastError says so, status stays connected — until the column is back", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    // The status column is gone; the switch column is still there and says
    // "Standard" — which must NOT be read while the install is broken.
    const grid = gridWithAgentCols([{ loadNo: "145219", switchVal: "Standard" }]).map((row) => row.slice(0, STATUS_COL));
    const connector = newConnector(grid);

    const report = await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    expect(report.error).toBeNull();
    expect(report.created).toBe(1); // rows still mirror
    expect(report.statusWrites).toBe(0);
    expect(connector.grid(ref)[1]).toHaveLength(STATUS_COL); // nothing written anywhere

    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load.agentEnabled).toBe(false);
    expect(load.sheetSwitchSeen).toBeNull();

    const after1 = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(after1.status).toBe("connected");
    expect(after1.lastError).toBe(COLUMNS_NOT_FOUND);

    // An unchanged tick keeps saying so — the columns are still missing.
    const report2 = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(report2.statusWrites).toBe(0);
    const after2 = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(after2.lastError).toBe(COLUMNS_NOT_FOUND);
    expect(after2.status).toBe("connected");

    // Install (the Connect page's button) puts the column back; the next
    // tick reads the switch and writes the status again, and lastError clears.
    currentConnector = connector;
    await installAgentColumns(binding.id);
    const report3 = await syncBinding(binding.id, { connector, nowMs: () => 3000 });
    expect(report3.statusWrites).toBe(1);
    const enabled = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(enabled.agentEnabled).toBe(true);
    expect(connector.grid(ref)[1][STATUS_COL]).toMatch(/^● WATCHING/);
    const after3 = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(after3.lastError).toBeNull();
  });
});

// --- rows that vanish, cells that already say so, duplicates (final fix wave) ----------

describe("syncBinding — vanished rows, unchanged cells, duplicates", () => {
  it("I6: a deleted row's load forgets its sheetRowIndex and the next status pass never writes its row", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const connector = newConnector(gridWithAgentCols([{ loadNo: "145219" }, { loadNo: "145220" }]));
    await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    const load2 = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145220" } });
    expect(load2.sheetRowIndex).toBe(3);

    // Row 3 is deleted from the sheet; the load gets a fresh update that
    // WOULD earn a status write if its row were still believed to exist.
    const connector2 = newConnector(connector.grid(ref).slice(0, 2));
    await prisma.agentUpdate.create({ data: { loadId: load2.id, atMs: 1500n, kind: "would_say", text: "would say: gone" } });

    const report = await syncBinding(binding.id, { connector: connector2, nowMs: () => 2000 });
    expect(report.error).toBeNull();
    const forgotten = await prisma.load.findUniqueOrThrow({ where: { id: load2.id } });
    expect(forgotten.sheetRowIndex).toBeNull();
    expect(connector2.grid(ref)).toHaveLength(2); // no row 3 was ever written
    const trace = await prisma.loadChange.findFirst({ where: { loadId: load2.id, field: "sheetRowIndex" }, orderBy: { atMs: "desc" } });
    expect(trace?.after).toBeNull();
    expect(trace?.source).toBe("sheet");

    // And it stays forgotten: a later tick writes nothing for it either.
    await prisma.agentUpdate.create({ data: { loadId: load2.id, atMs: 2500n, kind: "would_say", text: "would say: still gone" } });
    const report2 = await syncBinding(binding.id, { connector: connector2, nowMs: () => 3000 });
    expect(report2.statusWrites).toBe(0);
    expect(connector2.grid(ref)).toHaveLength(2);
  });

  it("I9: an unchanged sheet with one blank-LOAD# row produces zero writes on the second tick", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const grid = gridWithAgentCols([{ loadNo: "145219" }, { loadNo: "" }]);
    const connector = newConnector(grid);

    const report1 = await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    expect(report1.statusWrites).toBe(2); // the load's ● OFF and the blank row's attention cell
    expect(connector.grid(ref)[2][STATUS_COL]).toBe("● ATTENTION — needs a load number");

    // Our own writes changed the sheet's digest, so the second tick re-reads
    // the rows — and finds every status cell already says what it would
    // write. The third tick is a plain unchanged one.
    const report2 = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(report2.skipped).toEqual([{ rowIndex: 3, reason: "needs a load number" }]);
    expect(report2.statusWrites).toBe(0);
    const report3 = await syncBinding(binding.id, { connector, nowMs: () => 3000 });
    expect(report3.read).toBe(0);
    expect(report3.statusWrites).toBe(0);
  });

  it("I14: rows sharing a load number get an ATTENTION cell naming the duplicate, with no note", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const connector = newConnector(gridWithAgentCols([{ loadNo: "145219" }, { loadNo: "145219" }]));

    const report = await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    expect(report.created).toBe(0);
    expect(report.statusWrites).toBe(2);
    expect(connector.grid(ref)[1][STATUS_COL]).toBe("● ATTENTION — duplicate load number 145219");
    expect(connector.grid(ref)[2][STATUS_COL]).toBe("● ATTENTION — duplicate load number 145219");
    expect(connector.notes(ref)[`2:${STATUS_COL}`]).toBeUndefined();
    expect(connector.notes(ref)[`3:${STATUS_COL}`]).toBeUndefined();

    // And, like every other status cell, not written again once it says so.
    const report2 = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(report2.statusWrites).toBe(0);
  });

  // Residual fix 1: a LOAD# that is duplicated AFTER its load exists. The
  // load's row is one of the two duplicates, so the status pass must not
  // also write the load's own pill there — that alternated with the
  // duplicate-attention cell every tick. The load is unlinked from the sheet
  // while the duplicate stands; the row patch re-links it once resolved.
  it("a duplicate added after the load exists: tick 2 writes only the two attention cells, the load is unlinked, tick 3 writes nothing", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const connector = newConnector(gridWithAgentCols([{ loadNo: "145219" }]));
    await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load.sheetRowIndex).toBe(2);
    expect(connector.grid(ref)[1][STATUS_COL]).toBe("● OFF");

    const connector2 = newConnector(gridWithAgentCols([{ loadNo: "145219" }, { loadNo: "145219" }]));
    const report2 = await syncBinding(binding.id, { connector: connector2, nowMs: () => 2000 });
    expect(report2.skipped.map((s) => s.reason)).toEqual(["duplicate load number 145219", "duplicate load number 145219"]);
    expect(report2.statusWrites).toBe(2);
    expect(connector2.grid(ref)[1][STATUS_COL]).toBe("● ATTENTION — duplicate load number 145219");
    expect(connector2.grid(ref)[2][STATUS_COL]).toBe("● ATTENTION — duplicate load number 145219");
    expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).sheetRowIndex).toBeNull();

    const report3 = await syncBinding(binding.id, { connector: connector2, nowMs: () => 3000 });
    expect(report3.statusWrites).toBe(0);
    const report4 = await syncBinding(binding.id, { connector: connector2, nowMs: () => 4000 });
    expect(report4.statusWrites).toBe(0);

    // Resolved: the second row gets its own number; the load re-links to row 2.
    await connector2.writeCells(ref, [{ rowIndex: 3, col: 0, value: "145220" }]);
    await syncBinding(binding.id, { connector: connector2, nowMs: () => 5000 });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).sheetRowIndex).toBe(2);
    expect(connector2.grid(ref)[1][STATUS_COL]).toBe("● OFF");
  });

  // Residual fix 2: `sheetSwitchSeen` is remembered only once the switch
  // write itself landed — otherwise a failed flip looked "seen" and was lost.
  it("a switch write that throws leaves sheetSwitchSeen unchanged, so the next tick applies the flip", async () => {
    const org = await seedOrg();
    const policy = await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const connector = newConnector(gridWithAgentCols([{ loadNo: "145219", switchVal: "Standard" }]));

    const spy = vi.spyOn(agentSwitchModule, "applyAgentSwitch").mockRejectedValueOnce(new Error("boom"));
    try {
      const report1 = await syncBinding(binding.id, { connector, nowMs: () => 1000 });
      expect(report1.skipped).toEqual([{ rowIndex: 2, reason: "boom" }]);
      const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
      expect(load.agentEnabled).toBe(false);
      expect(load.sheetSwitchSeen).toBeNull();

      const report2 = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
      expect(report2.skipped).toEqual([]);
      const flipped = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
      expect(flipped.agentEnabled).toBe(true);
      expect(flipped.agentPolicyId).toBe(policy.id);
      expect(flipped.sheetSwitchSeen).toBe("Standard");
    } finally {
      spy.mockRestore();
    }
  });

  // Minor (final fix wave, "status line"): an attention pill shows its
  // attention line, so the cell and the board's pill agree; any other pill
  // skips attention-kind updates when picking the line, as the board does.
  it("the line under the pill: attention-kind updates only when the pill itself is attention", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const connector = newConnector(gridWithAgentCols([{ loadNo: "145219" }]));
    await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });

    // A watching load with an attention line NEWER than its last story line
    // still shows the story line (the board's agentLine rule).
    await prisma.load.update({ where: { id: load.id }, data: { agentPill: "watching" } });
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: 1500n, kind: "would_say", text: "40 mi out, ETA 10:20" } });
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: 1600n, kind: "attention", text: `can't place delivery "Nowhere" on the map` } });
    await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(connector.grid(ref)[1][STATUS_COL]).toBe("● WATCHING — 40 mi out, ETA 10:20");

    // The pill flips to attention: now the attention line IS the story.
    await prisma.load.update({ where: { id: load.id }, data: { agentPill: "attention" } });
    await syncBinding(binding.id, { connector, nowMs: () => 3000 });
    expect(connector.grid(ref)[1][STATUS_COL]).toBe(`● ATTENTION — can't place delivery "Nowhere" on the map`);
  });
});

// --- the status write -----------------------------------------------------------------

describe("syncBinding — the status write", () => {
  it("writes the pill+line with a deep-link note; a second sync writes nothing; a newer update writes again", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const connector = newConnector(gridWithAgentCols([{ loadNo: "145219" }]));

    const report1 = await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    expect(report1.statusWrites).toBeGreaterThan(0);

    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    await prisma.load.update({ where: { id: load.id }, data: { agentPill: "shadow" } });
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: 1500n, kind: "would_say", text: "would say: hi Milan" } });

    const report2 = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(report2.statusWrites).toBeGreaterThan(0);

    expect(connector.grid(ref)[1][STATUS_COL]).toBe("● SHADOW — would say: hi Milan");
    expect(connector.notes(ref)[`2:${STATUS_COL}`]).toBe(linkUrlFor(org, load.id));

    const afterWrite = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(afterWrite.sheetStatusWrittenAt).not.toBeNull();

    // Nothing changed since: no rewrite.
    const report3 = await syncBinding(binding.id, { connector, nowMs: () => 3000 });
    expect(report3.statusWrites).toBe(0);
    expect(connector.grid(ref)[1][STATUS_COL]).toBe("● SHADOW — would say: hi Milan");

    // A newer AgentUpdate writes again.
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: 2500n, kind: "would_say", text: "would say: bye Milan" } });
    const report4 = await syncBinding(binding.id, { connector, nowMs: () => 4000 });
    expect(report4.statusWrites).toBeGreaterThan(0);
    expect(connector.grid(ref)[1][STATUS_COL]).toBe("● SHADOW — would say: bye Milan");
  });

  // The `lastPillWritten` branch (fix round 1, finding 2): a pill change
  // with NO accompanying new AgentUpdate must still trigger a rewrite —
  // `sheetStatusWrittenAt`/newest-atMs alone would miss this, since neither
  // one moved.
  it("a pill change with no new AgentUpdate still gets its status cell rewritten (the worker set it directly)", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const connector = newConnector(gridWithAgentCols([{ loadNo: "145219" }]));

    await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(connector.grid(ref)[1][STATUS_COL]).toBe("● OFF");

    // The worker sets the pill directly (e.g. "held") — no new AgentUpdate
    // row at all, so `sheetStatusWrittenAt` and the newest `AgentUpdate`'s
    // `atMs` are both exactly as they were after the first sync.
    await prisma.load.update({ where: { id: load.id }, data: { agentPill: "held" } });

    const report = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(report.statusWrites).toBeGreaterThan(0);
    expect(connector.grid(ref)[1][STATUS_COL]).toBe("● HELD");
  });

  it("a row skipped for needing a load number still gets its status cell, with no note", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const connector = newConnector(gridWithAgentCols([{ loadNo: "" }]));

    const report = await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    expect(report.skipped).toEqual([{ rowIndex: 2, reason: "needs a load number" }]);

    expect(connector.grid(ref)[1][STATUS_COL]).toBe("● ATTENTION — needs a load number");
    expect(connector.notes(ref)[`2:${STATUS_COL}`]).toBeUndefined();
  });

  it("a row moved by an insert has its status write land at the new index", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });
    const connector = newConnector(gridWithAgentCols([{ loadNo: "145219" }]));
    await syncBinding(binding.id, { connector, nowMs: () => 1000 });

    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load.sheetRowIndex).toBe(2);
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: 1500n, kind: "would_say", text: "would say: still rolling" } });

    // A row inserted at the top of the fake between syncs: "145219" is now
    // at sheet row 3, not 2.
    const movedGrid = gridWithAgentCols([{ loadNo: "999999" }, { loadNo: "145219" }]);
    const connector2 = newConnector(movedGrid);
    // A fresh FakeConnector instance stands in for "the same tab after an
    // edit" — bump its version once so it reads as changed against the
    // `lastVersion` the first sync (on the ORIGINAL connector) recorded.
    await connector2.writeCells(ref, []);

    await syncBinding(binding.id, { connector: connector2, nowMs: () => 2000 });

    const moved = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(moved.sheetRowIndex).toBe(3);
    // Row 3 (grid index 2) is "145219", now moved — its status followed it
    // to the new index, carrying its own line, not the newly-inserted
    // "999999" row's freshly-created "● OFF" (that row is its own mirrored
    // load, at row 2 / grid index 1).
    expect(connector2.grid(ref)[2][STATUS_COL]).toBe("● OFF — would say: still rolling");
    expect(connector2.grid(ref)[1][STATUS_COL]).toBe("● OFF");
  });
});

// --- not yet installed (fix round 1, finding 2) -------------------------------------

describe("syncBinding — a binding with no agent columns installed", () => {
  it("skips the switch read and the status write entirely, with no error, mirroring rows same as Task 8", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    // Neither agentSwitchCol nor agentStatusCol set — the state of every
    // binding before its first `installAgentColumns` call ever runs.
    const binding = await seedBinding(org.id);
    // The grid still HAS a "Night Shift"-shaped column at SWITCH_COL, with a
    // value that would otherwise enable the load — proving the column is
    // never read at all when the binding doesn't know its index, not merely
    // that it happens not to match anything this time.
    const connector = newConnector(gridWithAgentCols([{ loadNo: "145219", switchVal: "Standard" }]));

    const report = await syncBinding(binding.id, { connector, nowMs: () => 1000 });

    expect(report.error).toBeNull();
    expect(report.statusWrites).toBe(0);

    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load.agentEnabled).toBe(false);
    expect(load.agentPill).toBe("off");
    // No status cell was ever touched.
    expect(connector.grid(ref)[1][STATUS_COL]).toBe("");
    expect(connector.notes(ref)[`2:${STATUS_COL}`]).toBeUndefined();

    const fresh = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(fresh.status).toBe("connected"); // no connector failure either
  });
});
