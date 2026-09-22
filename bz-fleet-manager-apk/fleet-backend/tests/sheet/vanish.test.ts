import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDb } from "../helpers.js";
import { FakeConnector } from "../../src/lib/sheet/fakeConnector.js";
import type { TabRef } from "../../src/lib/sheet/connector.js";
import { syncBinding } from "../../src/lib/sheet/sync.js";
import { applyStatusChange, type Actor } from "../../src/lib/loadWriter.js";
import { STANDARD_POLICY } from "../../src/lib/agentPolicies.js";

// Slice 4, Task 3: a row leaving the sheet already forgets `sheetRowIndex`
// (final fix wave, I6) — this pins the rest of the ruling: the load also
// archives and stops (unless it was already "done"), a re-added row bearing
// the same, now-archived, load number creates nothing and is painted with
// an attention cell instead.

process.env.PORTAL_URL ||= "http://localhost:5173";

const ref: TabRef = { spreadsheetId: "s1", tabId: "t1" };
const MAPPING = { loadRef: "LOAD#", driverPhone: "DRIVER PHONE", pickup: "PICK UP", delivery: "DELIVERY", pickupAppt: "PU APPT", deliveryAppt: "DEL APPT" };
const BASE_HEADER = ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT"];
const SWITCH_COL = BASE_HEADER.length;
const STATUS_COL = BASE_HEADER.length + 1;

const maria: Actor = { dispatcherId: "d-maria", name: "Maria" };

let seq = 0;
async function seedOrg() {
  seq += 1;
  return prisma.org.create({ data: { name: `VanishOrg-${seq}`, linkSecret: randomBytes(32).toString("hex") } });
}

function policyData(orgId: string) {
  return { ...STANDARD_POLICY, orgId, dispatcherEmail: "ops@acme.com" };
}

async function seedStandardPolicy(orgId: string) {
  return prisma.agentPolicy.create({ data: policyData(orgId) });
}

async function seedBinding(orgId: string, over: Partial<{ agentSwitchCol: number | null; agentStatusCol: number | null }> = {}) {
  return prisma.sheetBinding.create({
    data: {
      orgId, provider: "google", spreadsheetId: ref.spreadsheetId, tabId: ref.tabId, tabTitle: "Sheet1",
      headerRow: 1, columns: MAPPING, refreshToken: "sealed-x", status: "connected",
      agentSwitchCol: over.agentSwitchCol ?? null,
      agentStatusCol: over.agentStatusCol ?? null,
    },
  });
}

/** One row per entry, the two agent columns appended. */
function gridWithAgentCols(rows: { loadNo: string; switchVal?: string }[]): string[][] {
  const header = [...BASE_HEADER, "Night Shift", "Night Shift status"];
  const body = rows.map((r) => [r.loadNo, "+15551234567", "Dallas, TX", "Reno, NV", "09/21 08:00", "09/22 08:00", r.switchVal ?? "", ""]);
  return [header, ...body];
}

function newConnector(grid: string[][]): FakeConnector {
  return new FakeConnector({ s1: { title: "Loads", tabs: { t1: { title: "Sheet1", grid } } } });
}

beforeEach(resetDb);

describe("a row deleted from the sheet", () => {
  it("archives the load, queues a stop, writes an AgentUpdate, traces source sheet, and never writes the row again", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });

    // Tick 1: the row exists, switched on.
    const tick1 = await syncBinding(binding.id, {
      connector: newConnector(gridWithAgentCols([{ loadNo: "145219", switchVal: "Standard" }])),
      nowMs: () => 1000,
    });
    expect(tick1.error).toBeNull();
    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load.agentEnabled).toBe(true);
    expect(load.sheetRowIndex).not.toBeNull();

    // Tick 2: the row is gone (only the header remains).
    const tick2 = await syncBinding(binding.id, {
      connector: newConnector([[...BASE_HEADER, "Night Shift", "Night Shift status"]]),
      nowMs: () => 2000,
    });
    expect(tick2.error).toBeNull();

    const after = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(after.sheetRowIndex).toBeNull();
    expect(after.sheetBindingId).toBeNull();
    expect(after.status).toBe("archived");
    expect(after.agentEnabled).toBe(false);

    const statusChange = await prisma.loadChange.findFirst({ where: { loadId: load.id, field: "status" }, orderBy: { atMs: "desc" } });
    expect(statusChange?.source).toBe("sheet");
    expect(statusChange?.actorName).toBe("sheet");
    expect(statusChange?.after).toBe("archived");
    expect(statusChange?.note).toBe("row removed from sheet");

    const stopCommand = await prisma.agentCommand.findFirst({ where: { loadId: load.id, kind: "stop" } });
    expect(stopCommand).not.toBeNull();

    const updateLine = await prisma.agentUpdate.findFirst({ where: { loadId: load.id, kind: "status", text: "row removed from sheet" } });
    expect(updateLine).not.toBeNull();

    // A later tick with the row still gone changes nothing further — no
    // second archive, no second stop, no error.
    const tick3 = await syncBinding(binding.id, {
      connector: newConnector([[...BASE_HEADER, "Night Shift", "Night Shift status"]]),
      nowMs: () => 3000,
    });
    expect(tick3.error).toBeNull();
    const stopCommands = await prisma.agentCommand.count({ where: { loadId: load.id, kind: "stop" } });
    expect(stopCommands).toBe(1);
    const statusChanges = await prisma.loadChange.count({ where: { loadId: load.id, field: "status" } });
    expect(statusChanges).toBe(1);
  });
});

describe("a duplicated load number's rows", () => {
  it("are unlinked but never archived", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });

    await syncBinding(binding.id, {
      connector: newConnector(gridWithAgentCols([{ loadNo: "145219", switchVal: "Standard" }])),
      nowMs: () => 1000,
    });
    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load.sheetRowIndex).not.toBeNull();

    // Tick 2: the same number now appears twice — both rows are skipped as
    // duplicates, which unlinks the load (I6's own rule) but must not
    // archive it (Task 3's ruling: duplicated refs only unlink).
    await syncBinding(binding.id, {
      connector: newConnector(gridWithAgentCols([{ loadNo: "145219" }, { loadNo: "145219" }])),
      nowMs: () => 2000,
    });

    const after = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(after.sheetRowIndex).toBeNull();
    expect(after.sheetBindingId).toBeNull();
    expect(after.status).not.toBe("archived");
    expect(after.status).toBe("open");

    const stopCommand = await prisma.agentCommand.findFirst({ where: { loadId: load.id, kind: "stop" } });
    expect(stopCommand).toBeNull();
  });
});

describe("an already-delivered load whose row vanishes", () => {
  it("is unlinked but its status is left alone", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });

    await syncBinding(binding.id, {
      connector: newConnector(gridWithAgentCols([{ loadNo: "145219", switchVal: "Standard" }])),
      nowMs: () => 1000,
    });
    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });

    await prisma.$transaction((tx) => applyStatusChange(tx, {
      loadId: load.id, orgId: org.id, actor: maria, source: "board", status: "delivered", note: null,
    }));

    await syncBinding(binding.id, {
      connector: newConnector([[...BASE_HEADER, "Night Shift", "Night Shift status"]]),
      nowMs: () => 2000,
    });

    const after = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(after.sheetRowIndex).toBeNull();
    expect(after.status).toBe("delivered");

    const stopCommand = await prisma.agentCommand.findFirst({ where: { loadId: load.id, kind: "stop" } });
    expect(stopCommand).toBeNull();

    const statusChanges = await prisma.loadChange.count({ where: { loadId: load.id, field: "status" } });
    expect(statusChanges).toBe(1); // only the manual "delivered" write — none from the vanish
  });
});

describe("a new row bearing an archived load's number", () => {
  it("creates nothing and paints an attention cell instead of resurrecting the load", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });

    await syncBinding(binding.id, {
      connector: newConnector(gridWithAgentCols([{ loadNo: "145219", switchVal: "Standard" }])),
      nowMs: () => 1000,
    });
    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });

    await syncBinding(binding.id, {
      connector: newConnector([[...BASE_HEADER, "Night Shift", "Night Shift status"]]),
      nowMs: () => 2000,
    });
    const archived = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(archived.status).toBe("archived");
    const loadCountAfterArchive = await prisma.load.count({ where: { orgId: org.id } });

    // Tick 3: a NEW row appears carrying the same, now-archived, number.
    const connector3 = newConnector(gridWithAgentCols([{ loadNo: "145219" }]));
    const tick3 = await syncBinding(binding.id, { connector: connector3, nowMs: () => 3000 });
    expect(tick3.error).toBeNull();
    expect(tick3.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ rowIndex: 2, reason: 'archived load: "145219"' }),
    ]));

    // No new Load was created.
    const loadCountAfterRetry = await prisma.load.count({ where: { orgId: org.id } });
    expect(loadCountAfterRetry).toBe(loadCountAfterArchive);

    // The archived load itself is untouched (still archived, still unlinked).
    const stillArchived = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(stillArchived.status).toBe("archived");
    expect(stillArchived.sheetRowIndex).toBeNull();

    // The status cell reads the attention text, not a normal pill.
    const grid = connector3.grid(ref);
    expect(grid[1]?.[STATUS_COL]).toBe('● ATTENTION — archived load: "145219" — use a new load number');

    // A further tick writes nothing new for this row (it already says so).
    const tick4 = await syncBinding(binding.id, { connector: connector3, nowMs: () => 4000 });
    expect(tick4.error).toBeNull();
    expect(tick4.statusWrites).toBe(0);
  });
});

// Fix round 1, item 1: a load an Assignment (or an active status) still
// occupies must never be archived or stopped just because its sheet row
// disappeared — a driver can be mid-trip. Mirrors the Broker Board's own
// delete guard (dispatcherBrokerBoard.ts's assignment/status check).
describe("a vanished row on a load with an active assignment", () => {
  it("is unlinked but not archived, not stopped, and gets a kept-load line instead", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });

    await syncBinding(binding.id, {
      connector: newConnector(gridWithAgentCols([{ loadNo: "145219", switchVal: "Standard" }])),
      nowMs: () => 1000,
    });
    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load.agentEnabled).toBe(true);

    const driver = await prisma.driver.create({ data: { email: `driver-${load.id}@example.com`, passwordHash: "x", name: "Milan", orgId: org.id } });
    await prisma.assignment.create({
      data: { orgId: org.id, loadId: load.id, driverId: driver.id, plannedStart: new Date(), plannedEnd: new Date() },
    });

    await syncBinding(binding.id, {
      connector: newConnector([[...BASE_HEADER, "Night Shift", "Night Shift status"]]),
      nowMs: () => 2000,
    });

    const after = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(after.sheetRowIndex).toBeNull();
    expect(after.sheetBindingId).toBeNull();
    // Kept, not archived; still switched on — no stop was queued.
    expect(after.status).not.toBe("archived");
    expect(after.agentEnabled).toBe(true);

    const statusChanges = await prisma.loadChange.count({ where: { loadId: load.id, field: "status" } });
    expect(statusChanges).toBe(0);

    const stopCommand = await prisma.agentCommand.findFirst({ where: { loadId: load.id, kind: "stop" } });
    expect(stopCommand).toBeNull();

    const updateLine = await prisma.agentUpdate.findFirst({
      where: { loadId: load.id, kind: "status", text: "row removed from sheet — load kept, it has an active assignment" },
    });
    expect(updateLine).not.toBeNull();
  });
});

// Fix round 1, item 2: a whole-sheet accident (filter, bad paste, an "undo"
// that didn't take) must never mass-archive. A genuinely small vanish still
// works exactly as before.
describe("a whole-sheet accident (mass vanish)", () => {
  function eightRows(present: number): { loadNo: string; switchVal?: string }[] {
    return Array.from({ length: present }, (_, i) => ({ loadNo: `L${i + 1}`, switchVal: "Standard" }));
  }

  it("6 of 8 rows vanishing at once changes nothing and sets lastError; restoring them clears it", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });

    await syncBinding(binding.id, { connector: newConnector(gridWithAgentCols(eightRows(8))), nowMs: () => 1000 });
    const loadsBefore = await prisma.load.findMany({ where: { orgId: org.id }, select: { id: true, sheetRowIndex: true, status: true } });
    expect(loadsBefore).toHaveLength(8);
    expect(loadsBefore.every((l) => l.sheetRowIndex !== null)).toBe(true);

    // Only 2 of the 8 rows remain.
    const tick2 = await syncBinding(binding.id, { connector: newConnector(gridWithAgentCols(eightRows(2))), nowMs: () => 2000 });
    expect(tick2.error).toBeNull();

    const afterBlocked = await prisma.load.findMany({ where: { orgId: org.id }, select: { id: true, sheetRowIndex: true, status: true } });
    // Nothing archived, nothing unlinked — every load still mirrors.
    expect(afterBlocked.every((l) => l.sheetRowIndex !== null)).toBe(true);
    expect(afterBlocked.every((l) => l.status !== "archived")).toBe(true);

    const bindingAfterBlocked = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(bindingAfterBlocked.lastError).toBe('6 of 8 rows vanished at once — nothing archived; check the sheet or click Sync now');
    expect(bindingAfterBlocked.status).toBe("connected");

    // Tick 3: all 8 rows are back — an ordinary clean pass, no accident.
    const tick3 = await syncBinding(binding.id, { connector: newConnector(gridWithAgentCols(eightRows(8))), nowMs: () => 3000 });
    expect(tick3.error).toBeNull();
    const bindingAfterRestored = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(bindingAfterRestored.lastError).toBeNull();
    const afterRestored = await prisma.load.findMany({ where: { orgId: org.id }, select: { sheetRowIndex: true, status: true } });
    expect(afterRestored.every((l) => l.sheetRowIndex !== null)).toBe(true);
    expect(afterRestored.every((l) => l.status !== "archived")).toBe(true);
  });

  it("a mass vanish persisting 3 consecutive ticks unlinks everything, archiving nothing", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });

    await syncBinding(binding.id, { connector: newConnector(gridWithAgentCols(eightRows(8))), nowMs: () => 1000 });

    const missingConnector = () => newConnector(gridWithAgentCols(eightRows(2)));
    const tick2 = await syncBinding(binding.id, { connector: missingConnector(), nowMs: () => 2000 });
    expect(tick2.error).toBeNull();
    const tick3 = await syncBinding(binding.id, { connector: missingConnector(), nowMs: () => 3000 });
    expect(tick3.error).toBeNull();

    // Still blocked after two ticks.
    const stillLinked = await prisma.load.findMany({ where: { orgId: org.id }, select: { sheetRowIndex: true, status: true } });
    expect(stillLinked.every((l) => l.sheetRowIndex !== null)).toBe(true);

    // Third consecutive tick: persisted — unlink everything, archive nothing.
    const tick4 = await syncBinding(binding.id, { connector: missingConnector(), nowMs: () => 4000 });
    expect(tick4.error).toBeNull();

    const afterPersisted = await prisma.load.findMany({ where: { orgId: org.id }, select: { boardLoadNo: true, sheetRowIndex: true, status: true } });
    const stillPresent = new Set(["L1", "L2"]);
    for (const l of afterPersisted) {
      if (stillPresent.has(l.boardLoadNo ?? "")) {
        expect(l.sheetRowIndex).not.toBeNull();
      } else {
        expect(l.sheetRowIndex).toBeNull();
        expect(l.status).not.toBe("archived"); // never archived in bulk
      }
    }

    const bindingAfterPersisted = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(bindingAfterPersisted.lastError).toBeNull(); // resolved — no longer blocked
  });

  it("1 of 8 rows vanishing is an ordinary deletion — archived as before, no lastError", async () => {
    const org = await seedOrg();
    await seedStandardPolicy(org.id);
    const binding = await seedBinding(org.id, { agentSwitchCol: SWITCH_COL, agentStatusCol: STATUS_COL });

    await syncBinding(binding.id, { connector: newConnector(gridWithAgentCols(eightRows(8))), nowMs: () => 1000 });
    const tick2 = await syncBinding(binding.id, { connector: newConnector(gridWithAgentCols(eightRows(7))), nowMs: () => 2000 });
    expect(tick2.error).toBeNull();

    const removedLoad = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "L8" } });
    expect(removedLoad.sheetRowIndex).toBeNull();
    expect(removedLoad.status).toBe("archived");

    const keptLoad = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "L1" } });
    expect(keptLoad.sheetRowIndex).not.toBeNull();

    const bindingAfter = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(bindingAfter.lastError).toBeNull();
  });
});
