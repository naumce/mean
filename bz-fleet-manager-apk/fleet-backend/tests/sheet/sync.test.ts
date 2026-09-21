import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDb } from "../helpers.js";
import { FakeConnector } from "../../src/lib/sheet/fakeConnector.js";
import type { SheetConnector, TabRef } from "../../src/lib/sheet/connector.js";
import { syncBinding, syncAllSheets, ERROR_RETRY_MS } from "../../src/lib/sheet/sync.js";

// Task 8: read-only sync — a connected SheetBinding's rows become Loads.
// FakeConnector (Task 4) stands in for the network; the writes land through
// applyLoadChange against the real test DB, exactly as a route test would
// see them.

const ref: TabRef = { spreadsheetId: "s1", tabId: "t1" };
const MAPPING = { loadRef: "LOAD#", driverPhone: "DRIVER PHONE", pickup: "PICK UP", delivery: "DELIVERY", pickupAppt: "PU APPT", deliveryAppt: "DEL APPT" };

let seq = 0;
async function seedOrg() {
  seq += 1;
  return prisma.org.create({ data: { name: `SheetSyncOrg-${seq}` } });
}

async function seedBinding(orgId: string, overrides: Partial<{ lastVersion: string | null; status: string }> = {}) {
  return prisma.sheetBinding.create({
    data: {
      orgId, provider: "google", spreadsheetId: ref.spreadsheetId, tabId: ref.tabId, tabTitle: "Sheet1",
      headerRow: 1, columns: MAPPING, refreshToken: "sealed-x",
      status: overrides.status ?? "connected",
      lastVersion: overrides.lastVersion ?? null,
    },
  });
}

function baseGrid(): string[][] {
  return [
    ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT"],
    ["145219", "+15551234567", "Dallas, TX", "Reno, NV", "09/21 08:00", "09/22 08:00"],
    ["145220", "555-1234", "Tulsa, OK", "Boise, ID", "09/22 14:00", "09/23 14:00"],
    ["", "+15559998888", "Chicago, IL", "Miami, FL", "09/23 09:00", "09/24 09:00"],
  ];
}

function newConnector(grid: string[][] = baseGrid()): FakeConnector {
  return new FakeConnector({ s1: { title: "Loads", tabs: { t1: { title: "Sheet1", grid } } } });
}

function throwingConnector(message: string): SheetConnector {
  return {
    spreadsheetInfo: async () => ({ title: "Loads", tabs: [] }),
    readHeader: async () => baseGrid()[0],
    readRows: async () => { throw new Error(message); },
    writeCells: async () => {},
    ensureAgentColumns: async () => ({ switch: 0, status: 0 }),
  };
}

beforeEach(resetDb);

describe("syncBinding", () => {
  it("creates loads for numbered rows, records attention, skips a row with no load number", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id);
    const connector = newConnector();

    const report = await syncBinding(binding.id, { connector, nowMs: () => 1000 });

    expect(report.read).toBe(3);
    expect(report.created).toBe(2);
    expect(report.error).toBeNull();
    expect(report.skipped).toEqual([{ rowIndex: 4, reason: "needs a load number" }]);

    const load1 = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load1.sheetRowIndex).toBe(2);
    const load2 = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145220" } });
    expect(load2.sheetRowIndex).toBe(3);

    const noLoad = await prisma.load.findFirst({ where: { orgId: org.id, boardLoadNo: null } });
    expect(noLoad).toBeNull();

    const attention = await prisma.agentUpdate.findMany({ where: { loadId: load2.id, kind: "attention" } });
    expect(attention.some((a) => a.text.includes('driver phone "555-1234"'))).toBe(true);
    // Both appointments are mapped and readable (pickupAppt is required —
    // final fix wave, I7), so no appointment refusal exists on either load.
    expect(attention.some((a) => a.text.startsWith("can't read"))).toBe(false);
    const load1Attention = await prisma.agentUpdate.findMany({ where: { loadId: load1.id, kind: "attention" } });
    expect(load1Attention).toEqual([]);

    const changes = await prisma.loadChange.findMany({ where: { orgId: org.id } });
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.source === "sheet" && c.actorName === "sheet")).toBe(true);
  });

  it("a second sync with an unchanged sheet reads zero rows and writes nothing", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id);
    const connector = newConnector();
    await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    const before = await prisma.loadChange.count({ where: { orgId: org.id } });

    const report = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(report.read).toBe(0);
    expect(report.created).toBe(0);
    expect(report.updated).toBe(0);

    const after = await prisma.loadChange.count({ where: { orgId: org.id } });
    expect(after).toBe(before);
  });

  it("editing the pickup cell and syncing again produces exactly one new LoadChange", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id);
    const connector = newConnector();
    await syncBinding(binding.id, { connector, nowMs: () => 1000 });

    await connector.writeCells(ref, [{ rowIndex: 2, col: 2, value: "Fort Worth, TX" }]);
    const beforeCount = await prisma.loadChange.count();

    const report = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(report.error).toBeNull();
    expect(report.updated).toBe(1);
    expect(report.unchanged).toBe(1);

    const afterCount = await prisma.loadChange.count();
    expect(afterCount - beforeCount).toBe(1);

    const [newest] = await prisma.loadChange.findMany({ where: { field: "stops.pickup" }, orderBy: { atMs: "desc" }, take: 1 });
    expect(newest.before).toBe("Dallas, TX");
    expect(newest.after).toBe("Fort Worth, TX");
  });

  it("two rows sharing a load number are both skipped; a pre-existing Load with that number is untouched", async () => {
    const org = await seedOrg();
    const preexisting = await prisma.load.create({
      data: { orgId: org.id, status: "open", legType: "linehaul", requiredEquip: "DryVan", fscCents: 0, boardLoadNo: "145219", carrierContactName: "Original" },
    });
    const binding = await seedBinding(org.id);
    const grid = [
      ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT"],
      ["145219", "+15551234567", "Dallas, TX", "Reno, NV", "09/21 08:00", "09/22 08:00"],
      ["145219", "+15557654321", "Tulsa, OK", "Boise, ID", "09/22 14:00", "09/23 14:00"],
    ];
    const connector = newConnector(grid);

    const report = await syncBinding(binding.id, { connector, nowMs: () => 1000 });

    expect(report.created).toBe(0);
    expect(report.updated).toBe(0);
    expect(report.skipped).toEqual([
      { rowIndex: 2, reason: "duplicate load number 145219" },
      { rowIndex: 3, reason: "duplicate load number 145219" },
    ]);

    const fresh = await prisma.load.findUniqueOrThrow({ where: { id: preexisting.id } });
    expect(fresh.carrierContactName).toBe("Original");
    expect(fresh.version).toBe(preexisting.version);
  });

  it("three consecutive connector failures set status error with lastError; a later success resets it", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id);
    const bad = throwingConnector("network down");

    await syncBinding(binding.id, { connector: bad, nowMs: () => 1000 });
    const after1 = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(after1.status).toBe("connected");
    expect(after1.lastError).toBe("network down");

    await syncBinding(binding.id, { connector: bad, nowMs: () => 2000 });
    const after2 = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(after2.status).toBe("connected");

    const report3 = await syncBinding(binding.id, { connector: bad, nowMs: () => 3000 });
    expect(report3.error).toBe("network down");
    const after3 = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(after3.status).toBe("error");
    expect(after3.lastError).toBe("network down");

    const good = newConnector();
    const report4 = await syncBinding(binding.id, { connector: good, nowMs: () => 4000 });
    expect(report4.error).toBeNull();
    const after4 = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(after4.status).toBe("connected");
  });

  it("records lastVersion and lastSyncAt on success", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id);
    const connector = newConnector();

    await syncBinding(binding.id, { connector, nowMs: () => 12345 });

    const fresh = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    // Final fix wave, C1: the version is a content digest, not a counter.
    expect(fresh.lastVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh.lastSyncAt?.getTime()).toBe(12345);
  });

  // Fix round 1, item 1: patchDiffers must compare the carrier name too, or a
  // corrected CARRIER cell on an existing load is silently dropped.
  it("editing the carrier cell and syncing again produces exactly one new LoadChange, field carrierId", async () => {
    const carrierMapping = { ...MAPPING, carrierName: "CARRIER" };
    const org = await seedOrg();
    const binding = await prisma.sheetBinding.create({
      data: {
        orgId: org.id, provider: "google", spreadsheetId: ref.spreadsheetId, tabId: ref.tabId, tabTitle: "Sheet1",
        headerRow: 1, columns: carrierMapping, refreshToken: "sealed-x", status: "connected", lastVersion: null,
      },
    });
    const grid = [
      ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT", "CARRIER"],
      ["145219", "+15551234567", "Dallas, TX", "Reno, NV", "09/21 08:00", "09/22 08:00", "Acme Trucking"],
    ];
    const connector = newConnector(grid);
    await syncBinding(binding.id, { connector, nowMs: () => 1000 });

    const before = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" }, include: { carrier: true } });
    expect(before.carrier?.name).toBe("Acme Trucking");

    await connector.writeCells(ref, [{ rowIndex: 2, col: 6, value: "Zenith Freight" }]);
    const beforeCount = await prisma.loadChange.count();

    const report = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(report.error).toBeNull();

    const afterCount = await prisma.loadChange.count();
    expect(afterCount - beforeCount).toBe(1);

    const [newest] = await prisma.loadChange.findMany({ where: { field: "carrierId" }, orderBy: { atMs: "desc" }, take: 1 });
    expect(newest).toBeTruthy();

    const after = await prisma.load.findUniqueOrThrow({ where: { id: before.id }, include: { carrier: true } });
    expect(after.carrier?.name).toBe("Zenith Freight");
  });

  // Fix round 1, item 2: a row locked by a dispatcher must not abort the
  // batch or count toward the connector-failure counter.
  describe("a row locked by a dispatcher", () => {
    it("is skipped with the holder's name; other rows still write; failures and status are unaffected", async () => {
      const org = await seedOrg();
      const binding = await seedBinding(org.id);
      const connector = newConnector();
      await syncBinding(binding.id, { connector, nowMs: () => 1000 });

      const load1 = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
      await prisma.loadLock.create({
        data: { loadId: load1.id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) },
      });

      await connector.writeCells(ref, [
        { rowIndex: 2, col: 2, value: "Fort Worth, TX" },
        { rowIndex: 3, col: 2, value: "Springfield, MO" },
      ]);

      // Three ticks in a row while the lock holds — none of them may push
      // this binding to `status: "error"`, because none of them is a
      // connector failure. Nothing edits the sheet between ticks: a tick
      // with a row error does NOT advance `lastVersion` (final fix wave),
      // so the very next tick re-reads and retries the locked row by itself
      // — "retried next sync" is a promise, not a hope for another edit.
      let report = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
      for (let i = 0; i < 2; i++) {
        report = await syncBinding(binding.id, { connector, nowMs: () => 3000 + i });
      }

      expect(report.skipped).toEqual(expect.arrayContaining([
        expect.objectContaining({ rowIndex: 2, reason: "locked by Maria — retried next sync" }),
      ]));

      const binding3 = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
      expect(binding3.status).toBe("connected");
      expect(binding3.lastError).toBe("1 rows skipped — see log");

      const untouchedStops = await prisma.loadStop.findMany({ where: { loadId: load1.id, type: "pickup" } });
      expect(untouchedStops[0]?.address).toBe("Dallas, TX"); // the locked row's edit never landed

      const load2 = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145220" } });
      const load2Stops = await prisma.loadStop.findMany({ where: { loadId: load2.id, type: "pickup" } });
      expect(load2Stops[0]?.address).toBe("Springfield, MO"); // the unlocked row's edit did land

      // Unlock and sync again: the row is written and lastError clears. (The
      // fixture's row 4 has no load number, so it is always skipped for that
      // ordinary reason — unrelated to the lock.)
      await prisma.loadLock.deleteMany({ where: { loadId: load1.id } });
      const finalReport = await syncBinding(binding.id, { connector, nowMs: () => 4000 });
      expect(finalReport.skipped).toEqual([{ rowIndex: 4, reason: "needs a load number" }]);

      const finalStops = await prisma.loadStop.findMany({ where: { loadId: load1.id, type: "pickup" } });
      expect(finalStops[0]?.address).toBe("Fort Worth, TX");

      const finalBinding = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
      expect(finalBinding.lastError).toBeNull();
    });
  });
});

// Final fix wave, I8: whatever the gazetteer could not place is asked of the
// provider after the row pass, the same `settlePendingStops` the board import
// runs — outside every transaction, and only once a provider is configured.
describe("syncBinding — geocoding the stops the gazetteer misses", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { delete process.env.GEOCODER_URL; globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it("a city the gazetteer misses stays pending, then settles when the provider answers on a later tick", async () => {
    const org = await seedOrg();
    const binding = await seedBinding(org.id);
    const grid = [
      ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT"],
      ["145219", "+15551234567", "Nowhere, ZZ 00000", "Reno, NV", "09/21 08:00", "09/22 08:00"],
    ];
    const connector = newConnector(grid);

    // No provider configured: the gazetteer is the whole geocoder.
    await syncBinding(binding.id, { connector, nowMs: () => 1000 });
    const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, boardLoadNo: "145219" } });
    const pending = await prisma.loadStop.findFirstOrThrow({ where: { loadId: load.id, type: "pickup" } });
    expect(pending.geocodeStatus).toBe("pending");
    expect(pending.lat).toBeNull();
    const lines = (await prisma.agentUpdate.findMany({ where: { loadId: load.id, kind: "attention" } })).map((a) => a.text);
    expect(lines).toContain('can\'t place pickup "Nowhere, ZZ 00000" on the map');

    // A provider appears (mocked), and the row is touched again.
    process.env.GEOCODER_URL = "http://geocoder.test/search";
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify([{ lat: "40.1", lon: "-96.1" }]), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await connector.writeCells(ref, [{ rowIndex: 2, col: 1, value: "+15557654321" }]);
    const report = await syncBinding(binding.id, { connector, nowMs: () => 2000 });
    expect(report.updated).toBe(1);

    expect(fetchSpy).toHaveBeenCalled();
    const settled = await prisma.loadStop.findFirstOrThrow({ where: { loadId: load.id, type: "pickup" } });
    expect([settled.lat, settled.lng]).toEqual([40.1, -96.1]);
    expect(settled.geocodeStatus).toBe("ok");
    const after = (await prisma.agentUpdate.findMany({ where: { loadId: load.id, kind: "attention" } })).map((a) => a.text);
    expect(after.some((t) => t.startsWith("can't place pickup"))).toBe(false);
  });
});

describe("syncAllSheets", () => {
  // Final fix wave, I11: an "error" binding is not parked forever — once it
  // has sat for ERROR_RETRY_MS it is tried again, and a success restores it.
  it("retries an error binding older than five minutes and restores it to connected; a fresh one waits", async () => {
    const staleOrg = await seedOrg();
    const stale = await prisma.sheetBinding.create({
      data: {
        orgId: staleOrg.id, provider: "google", spreadsheetId: ref.spreadsheetId, tabId: ref.tabId, tabTitle: "Sheet1",
        headerRow: 1, columns: MAPPING, refreshToken: "sealed-x", status: "error", lastError: "network down",
        updatedAt: new Date(Date.now() - ERROR_RETRY_MS - 60_000),
      },
    });
    const freshOrg = await seedOrg();
    const fresh = await seedBinding(freshOrg.id, { status: "error" });

    const reports = await syncAllSheets({
      connectorFor: (b) => (b.id === stale.id ? newConnector() : throwingConnector("should not run")),
      nowMs: () => Date.now(),
    });

    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBeNull();
    const restored = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: stale.id } });
    expect(restored.status).toBe("connected");
    expect(restored.lastError).toBeNull();
    const untouched = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(untouched.status).toBe("error");
  });

  it("only syncs connected bindings and never throws when a binding fails", async () => {
    const connectedOrg = await seedOrg();
    const connected = await seedBinding(connectedOrg.id);
    const pausedOrg = await seedOrg();
    await seedBinding(pausedOrg.id, { status: "paused" });

    const reports = await syncAllSheets({
      connectorFor: (b) => (b.id === connected.id ? newConnector() : throwingConnector("should not run")),
      nowMs: () => 5000,
    });

    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBeNull();
    expect(reports[0].created).toBe(2);
  });

  it("never throws even if connectorFor itself throws for a binding", async () => {
    const org = await seedOrg();
    await seedBinding(org.id);

    const reports = await syncAllSheets({
      connectorFor: () => { throw new Error("boom"); },
      nowMs: () => 6000,
    });

    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBe("boom");
  });
});
