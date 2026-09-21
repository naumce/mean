import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import WebSocket from "ws";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { brokerWorkbook, THEIR_HEADER } from "./fixtures/brokerBoard.js";
import { createMessageCollector, startServer, stopServer, waitForOpen } from "./realtime-helpers.js";
import { disarmVanish, vanishNext } from "./vanish.js";
import * as geocodeModule from "../src/lib/geocode.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "src");
const CANONICAL = "src/lib/loadEvents.ts";

function tsFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...tsFilesUnder(full));
    else if (entry.endsWith(".ts")) found.push(full);
  }
  return found;
}

describe("load_changed", () => {
  it("is emitted from exactly one module", () => {
    // The payload shape is a contract two portal stores decode. A second
    // place that builds the frame by hand is how the two drift apart.
    const offenders: string[] = [];
    for (const file of tsFilesUnder(srcDir)) {
      const rel = relative(repoRoot, file).split("\\").join("/");
      if (rel === CANONICAL) continue;
      if (readFileSync(file, "utf8").includes('"load_changed"')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

// A4 Task 9: board_update retires from every site load_changed now covers.
// Two sites are deliberate survivors — neither is a change to a Load record,
// so a load_changed there would be a false statement — and everywhere else
// that still says "board_update" is a site this task missed.
const BOARD_UPDATE_SURVIVORS = [
  // A replan edits the Assignment's plan, not the Load record — `load_changed`
  // would be a false statement about the load, so this one keeps the blunt
  // event and the board keeps its full refresh for it.
  "src/routes/dispatcherAssignments.ts",
  // Pairing a tractor or trailer to a driver changes neither a Load nor an
  // Assignment; the lane's equipment is read from the yard endpoint.
  "src/routes/dispatcherDrivers.ts",
];

describe("board_update", () => {
  it("fires board_update only where no load actually changed", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(srcDir)) {
      const rel = relative(repoRoot, file).split("\\").join("/");
      if (!readFileSync(file, "utf8").includes('"board_update"')) continue;
      if (!BOARD_UPDATE_SURVIVORS.includes(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

// --- behavioural: every Load write announces itself -------------------------

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
});

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const FAR = new Date("2027-01-01T00:00:00.000Z");
const FRESH_HOS = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };

let seq = 0;

async function seedOrgDispatcher() {
  seq += 1;
  const org = await prisma.org.create({ data: { name: `Acme ${seq}` } });
  const disp = await prisma.dispatcher.create({ data: { email: `d-${seq}@x.com`, passwordHash: "x", name: "D", orgId: org.id } });
  return { org, dispatcherId: disp.id, auth: { Authorization: `Bearer ${signDispatcherAccess(disp.id)}` } };
}

/** A committable assignment fixture: org + org-scoped dispatcher + driver
 *  parked on the pickup (near-zero deadhead) + tractor + trailer + an open
 *  Reefer load. Shared by the unassign and replan tests below, mirroring
 *  tests/dispatcher-assignments.test.ts's own seed(). */
async function seedAssignable() {
  const { org, dispatcherId, auth } = await seedOrgDispatcher();
  const driver = await prisma.driver.create({
    data: { email: `drv-${seq}@x.com`, passwordHash: "x", name: "Jake", orgId: org.id, lastLat: KC.lat, lastLng: KC.lng, hos: { create: FRESH_HOS } },
  });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: `T-${seq}`, status: "active" } });
  const trailer = await prisma.trailer.create({ data: { orgId: org.id, unit: `RF-${seq}`, type: "Reefer", status: "active" } });
  const load = await prisma.load.create({
    data: {
      orgId: org.id, requiredEquip: "Reefer", revenueCents: 30000, fscCents: 4000, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "KC dock", lat: KC.lat, lng: KC.lng, appointment: { create: { windowEnd: FAR, type: "pickup" } } },
          { sequence: 2, type: "delivery", address: "Omaha dock", lat: OMAHA.lat, lng: OMAHA.lng, appointment: { create: { windowEnd: FAR, type: "delivery" } } },
        ],
      },
    },
  });
  return { org, dispatcherId, auth, driver, tractor, trailer, load };
}

async function openSocket(dispatcherId: string) {
  const { server, port } = await startServer();
  const ws = new WebSocket(`ws://localhost:${port}/ws?token=${signDispatcherAccess(dispatcherId)}`);
  await waitForOpen(ws);
  return { server, ws, collector: createMessageCollector(ws) };
}

/** Skips past any other frame type (board_update, trip_*, …) to the next
 *  `load_changed` — the two routes on any Load write, and this suite only
 *  cares about the ordering it asserts explicitly. */
async function nextLoadChanged(collector: ReturnType<typeof createMessageCollector>, timeoutMs = 2000): Promise<Record<string, unknown>> {
  for (;;) {
    const frame = await collector.next(timeoutMs);
    if (frame.type === "load_changed") return frame;
  }
}

/** Drains every frame that arrives within `ms` of the call, for asserting an
 *  ABSENCE (no `load_changed` among them) rather than a presence — the
 *  negative shape `collector.next()` alone can't express when other frame
 *  types are expected to arrive. */
async function collectFramesFor(collector: ReturnType<typeof createMessageCollector>, ms = 300): Promise<Record<string, unknown>[]> {
  const frames: Record<string, unknown>[] = [];
  for (;;) {
    try {
      frames.push(await collector.next(ms));
    } catch {
      break;
    }
  }
  return frames;
}

describe("every Load write announces itself", () => {
  it("POST /loads/:id/geocode announces the stops it resolved", async () => {
    const { org, dispatcherId, auth } = await seedOrgDispatcher();
    const load = await prisma.load.create({
      data: {
        orgId: org.id, requiredEquip: "DryVan", revenueCents: 10000, status: "open",
        stops: {
          create: [
            { sequence: 1, type: "pickup", address: "Kansas City, MO", geocodeStatus: "pending" },
            { sequence: 2, type: "delivery", address: "Omaha, NE", geocodeStatus: "pending" },
          ],
        },
      },
    });
    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      const res = await request(app).post(`/api/dispatcher/loads/${load.id}/geocode`).set(auth);
      expect(res.status).toBe(200);
      expect(res.body.resolved).toBe(2);

      const frame = await nextLoadChanged(collector);
      const fresh = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
      expect(frame).toMatchObject({ orgId: org.id, loadId: load.id, version: fresh.version });
      expect((frame.fields as string[]).slice().sort()).toEqual(["delivery", "pickup"]);
      // Fix round 1: the version tick this route now makes has to leave the
      // same kind of trail every other version tick in the product leaves —
      // exactly one row, not zero and not one per stop.
      expect(fresh.version).toBe(1);
      const changes = await prisma.loadChange.findMany({ where: { loadId: load.id } });
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ orgId: org.id, source: "system", actorId: null, actorName: "geocoder", field: "geocode" });
    } finally {
      await stopServer(server, [ws]);
    }
  });

  it("DELETE /assignments/:id (unassign) announces the load returning to open", async () => {
    const { org, dispatcherId, auth, driver, tractor, trailer, load } = await seedAssignable();
    const commit = await request(app).post("/api/dispatcher/assignments").set(auth)
      .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
    expect(commit.status).toBe(201);

    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      const del = await request(app).delete(`/api/dispatcher/assignments/${commit.body.assignment.id}`).set(auth);
      expect(del.status).toBe(200);

      const frame = await nextLoadChanged(collector);
      const fresh = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
      expect(frame).toMatchObject({ orgId: org.id, loadId: load.id, version: fresh.version, fields: ["status"] });
      expect(fresh.status).toBe("open");
    } finally {
      await stopServer(server, [ws]);
    }
  });

  it("POST /broker-board/loads (add) announces the new row", async () => {
    const { org, dispatcherId, auth } = await seedOrgDispatcher();
    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      const res = await request(app).post("/api/dispatcher/broker-board/loads").set(auth);
      expect(res.status).toBe(201);

      const frame = await nextLoadChanged(collector);
      const fresh = await prisma.load.findUniqueOrThrow({ where: { id: res.body.load.id as string } });
      expect(frame).toMatchObject({ orgId: org.id, loadId: res.body.load.id, version: fresh.version, fields: ["created"] });
    } finally {
      await stopServer(server, [ws]);
    }
  });

  // M3: duplicating a blank "+ Load" row's writer diff can end up with
  // nothing in it — the copy still genuinely exists. Creation is a fact
  // about the row, not about which columns moved, so "created" must survive
  // being merged with whatever the writer itself saw change (or didn't).
  it("POST /broker-board/loads/duplicate announces the copy as created, not as nothing", async () => {
    const { org, dispatcherId, auth } = await seedOrgDispatcher();
    const add = await request(app).post("/api/dispatcher/broker-board/loads").set(auth);
    expect(add.status).toBe(201);
    const sourceId = add.body.load.id as string;

    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      const res = await request(app).post("/api/dispatcher/broker-board/loads/duplicate").set(auth).send({ ids: [sourceId] });
      expect(res.status).toBe(200);
      const copyId = res.body.loads[0].id as string;
      expect(await prisma.load.count({ where: { orgId: org.id } })).toBe(2);

      const frame = await nextLoadChanged(collector);
      expect(frame.loadId).toBe(copyId);
      expect(frame.fields as string[]).toContain("created");
    } finally {
      await stopServer(server, [ws]);
    }
  });

  it("POST /broker-board/loads/delete announces the removal and the row is gone", async () => {
    const { org, dispatcherId, auth } = await seedOrgDispatcher();
    const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "", status: "open" } });

    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      const res = await request(app).post("/api/dispatcher/broker-board/loads/delete").set(auth).send({ ids: [load.id] });
      expect(res.status).toBe(200);

      const frame = await nextLoadChanged(collector);
      // H2: NOT `version: load.version` (the ruling — A4-R13 — is that a
      // deleted row has no newer version, and the pre-delete number is
      // precisely what makes the frame undeliverable: both portal stores drop
      // a frame whose version they already hold). The contract a client can
      // actually act on is `fields: ["deleted"]` plus the id, and the row
      // genuinely being gone from the database — not a specific number.
      expect(frame).toMatchObject({ orgId: org.id, loadId: load.id, fields: ["deleted"] });
      expect(await prisma.load.findUnique({ where: { id: load.id } })).toBeNull();
    } finally {
      await stopServer(server, [ws]);
    }
  });

  it("POST /broker-board/loads/delete announces a removal for every id, not just the first", async () => {
    const { org, dispatcherId, auth } = await seedOrgDispatcher();
    const loads = await Promise.all(
      [0, 1, 2].map(() => prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "", status: "open" } })),
    );
    const ids = loads.map((l) => l.id);

    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      const res = await request(app).post("/api/dispatcher/broker-board/loads/delete").set(auth).send({ ids });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: 3 });

      const frames: Record<string, unknown>[] = [];
      for (let i = 0; i < ids.length; i++) frames.push(await nextLoadChanged(collector));
      expect(new Set(frames.map((f) => f.loadId))).toEqual(new Set(ids));
      for (const f of frames) expect(f.fields).toEqual(["deleted"]);
      expect(await prisma.load.count({ where: { id: { in: ids } } })).toBe(0);
    } finally {
      await stopServer(server, [ws]);
    }
  });

  it("POST /broker-board/import/confirm sends one load_changed per imported load", async () => {
    const { dispatcherId, auth } = await seedOrgDispatcher();
    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      const res = await request(app).post("/api/dispatcher/broker-board/import/confirm").set(auth)
        .attach("file", brokerWorkbook(), "board.xlsx");
      expect(res.status).toBe(200);
      expect(res.body.created).toBe(5);

      const frames = await collectFramesFor(collector, 500);
      const changed = frames.filter((f) => f.type === "load_changed");
      expect(changed).toHaveLength(5);
      // One frame per load, not one frame naming five — the distinct loadIds
      // prove it, not just the count.
      expect(new Set(changed.map((f) => f.loadId)).size).toBe(5);
    } finally {
      await stopServer(server, [ws]);
    }
  });

  // M3: an imported row's own LOAD# lands in `identity` (Load.externalId),
  // never in the writer's patch — so a row whose sheet cells carry nothing
  // the writer itself compares as a change (an unparseable SHIP DATE reads
  // as null, same as a fresh row's default) still gets created, and used to
  // be announced with `fields: []`, i.e. nothing at all.
  it("POST /broker-board/import/confirm announces a created row even when its only real content is its LOAD#", async () => {
    const { org, dispatcherId, auth } = await seedOrgDispatcher();
    const rows: string[][] = [
      THEIR_HEADER,
      // Top (customer) row: nothing the writer's patch would treat as a
      // change — an unparseable SHIP DATE satisfies `looksTop` (so the pair
      // is recognised as a load at all) but parses to `null`, same as a
      // fresh load's own default.
      ["", "", "", "", "", "", "", "", "", "", "", "", "", "not a date", "", ""],
      // Bottom (carrier) row: only the board's own LOAD#.
      ["", "", "", "", "", "", "", "", "", "", "", "", "LOADONLY1", "", "", ""],
    ];
    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      const res = await request(app).post("/api/dispatcher/broker-board/import/confirm").set(auth)
        .attach("file", brokerWorkbook(rows), "board.xlsx");
      expect(res.status).toBe(200);
      expect(res.body.created).toBe(1);
      const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, externalId: "LOADONLY1" } });

      const frame = await nextLoadChanged(collector);
      expect(frame.loadId).toBe(load.id);
      expect(frame.fields as string[]).toContain("created");
    } finally {
      await stopServer(server, [ws]);
    }
  });

  it("the inbound load webhook announces each row it writes", async () => {
    seq += 1;
    const org = await prisma.org.create({ data: { name: `Webhook Org ${seq}`, apiKey: `whk_events_${seq}` } });
    const disp = await prisma.dispatcher.create({ data: { email: `wd-${seq}@x.com`, passwordHash: "x", name: "D", orgId: org.id } });

    const { server, ws, collector } = await openSocket(disp.id);
    try {
      const res = await request(app).post("/api/webhooks/loads").set("x-api-key", `whk_events_${seq}`).send({
        externalId: `L-EVT-${seq}`, requiredEquip: "DryVan", revenueCents: 45000,
        pickupAddress: "Kansas City, MO", pickupLat: KC.lat, pickupLng: KC.lng,
        deliveryAddress: "Omaha, NE", deliveryLat: OMAHA.lat, deliveryLng: OMAHA.lng,
      });
      expect(res.status).toBe(200);
      expect(res.body.imported).toBe(1);

      const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, externalId: `L-EVT-${seq}` } });
      const frame = await nextLoadChanged(collector);
      expect(frame).toMatchObject({ orgId: org.id, loadId: load.id, version: load.version, fields: ["created"] });
    } finally {
      await stopServer(server, [ws]);
    }
  });

  it("PATCH /assignments/:id/plan (replan) does NOT emit load_changed — it moves the Assignment, not the Load", async () => {
    const { dispatcherId, auth, driver, tractor, trailer, load } = await seedAssignable();
    const availableAt = Date.now() + 24 * 3_600_000;
    const commit = await request(app).post("/api/dispatcher/assignments").set(auth)
      .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, availableAt });
    expect(commit.status).toBe(201);

    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      const res = await request(app).patch(`/api/dispatcher/assignments/${commit.body.assignment.id}/plan`).set(auth)
        .send({ availableAt: availableAt + 3 * 3_600_000 });
      expect(res.status).toBe(200);

      const frames = await collectFramesFor(collector, 300);
      // Sanity: the pipe is live (some frame did arrive) — otherwise an empty
      // `frames` would make the load_changed assertion below trivially true
      // for the wrong reason (nothing works, not "nothing was a lie").
      expect(frames.some((f) => f.type === "board_update")).toBe(true);
      expect(frames.some((f) => f.type === "load_changed")).toBe(false);
    } finally {
      await stopServer(server, [ws]);
    }
  });
});

// M6: settlePendingStops() runs after every writer call commits (cell,
// paste, duplicate, import, unarchive) and used to bump nothing and trace
// nothing — a stop the provider placed was invisible to every other board
// until someone reloaded. This drives one real call site (the cell route)
// end to end: a pending stop the write itself never touches still gets
// settled, its own version bump, its own trace row, and its own frame.
describe("M6: a stop the provider places after the write reaches the board", () => {
  const realFetch = globalThis.fetch;
  beforeEach(resetDb);
  afterEach(() => { delete process.env.GEOCODER_URL; globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it("PATCH .../cell settles a stop the write itself didn't touch, and announces it separately", async () => {
    const { org, dispatcherId, auth } = await seedOrgDispatcher();
    const load = await prisma.load.create({
      data: {
        orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME", status: "open",
        stops: {
          create: [
            { sequence: 1, type: "pickup", address: "Elsewhere, ZZ", geocodeStatus: "pending" },
            { sequence: 2, type: "delivery", address: "Dallas, TX", lat: 32.78, lng: -96.8, geocodeStatus: "ok" },
          ],
        },
      },
    });

    process.env.GEOCODER_URL = "http://geocoder.test/search";
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([{ lat: "41.5", lon: "-93.6" }]), { status: 200 })) as unknown as typeof fetch;

    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      // A cell write that never touches the stops at all — the pickup was
      // already "pending" before this request, from an earlier save.
      const res = await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth)
        .send({ row: "top", key: "customer", value: "ACME LOGISTICS", baseVersion: 0 });
      expect(res.status).toBe(200);

      // First frame: the cell write itself.
      const first = await nextLoadChanged(collector);
      expect(first).toMatchObject({ loadId: load.id, fields: ["customerName"] });

      // Second frame: the settle, in its OWN transaction with its OWN version
      // bump — naming the stop role it placed, not folded into the frame above.
      const second = await nextLoadChanged(collector);
      expect(second).toMatchObject({ loadId: load.id, fields: ["pickup"] });
      expect(second.version).toBe((first.version as number) + 1);

      const stop = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "pickup" } });
      expect(stop?.geocodeStatus).toBe("ok");
      expect([stop?.lat, stop?.lng]).toEqual([41.5, -93.6]);
      const trace = await prisma.loadChange.findMany({ where: { loadId: load.id, field: "geocode" } });
      expect(trace).toHaveLength(1);
    } finally {
      await stopServer(server, [ws]);
    }
  });

  // A4-R18: PATCH /loads/:id (dispatcherLoads.ts) was wired to
  // settlePendingStops in A4's final wave, beyond the brief's named sites
  // (cell, paste, duplicate, import, unarchive) — the sixth call site, with no
  // end-to-end test of its own wiring until now. Same assertions as the cell
  // site above: a PATCH that never touches the stops still settles one left
  // pending, in its own transaction, its own version bump, its own frame.
  it("PATCH /loads/:id settles a stop the write itself didn't touch, and announces it separately", async () => {
    const { org, dispatcherId, auth } = await seedOrgDispatcher();
    const load = await prisma.load.create({
      data: {
        orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, status: "open",
        stops: {
          create: [
            { sequence: 1, type: "pickup", address: "Elsewhere, ZZ", geocodeStatus: "pending" },
            { sequence: 2, type: "delivery", address: "Dallas, TX", lat: 32.78, lng: -96.8, geocodeStatus: "ok" },
          ],
        },
      },
    });

    process.env.GEOCODER_URL = "http://geocoder.test/search";
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([{ lat: "41.5", lon: "-93.6" }]), { status: 200 })) as unknown as typeof fetch;

    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      // A PATCH that only edits a scalar — never touches the stops at all —
      // the pickup was already "pending" before this request, from an
      // earlier save.
      const res = await request(app).patch(`/api/dispatcher/loads/${load.id}`).set(auth)
        .send({ commodity: "Steel coils" });
      expect(res.status).toBe(200);

      // First frame: the PATCH itself.
      const first = await nextLoadChanged(collector);
      expect(first).toMatchObject({ loadId: load.id, fields: ["commodity"] });

      // Second frame: the settle, in its OWN transaction with its OWN version
      // bump — naming the stop role it placed, not folded into the frame above.
      const second = await nextLoadChanged(collector);
      expect(second).toMatchObject({ loadId: load.id, fields: ["pickup"] });
      expect(second.version).toBe((first.version as number) + 1);

      const stop = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "pickup" } });
      expect(stop?.geocodeStatus).toBe("ok");
      expect([stop?.lat, stop?.lng]).toEqual([41.5, -93.6]);
      const trace = await prisma.loadChange.findMany({ where: { loadId: load.id, field: "geocode" } });
      expect(trace).toHaveLength(1);
    } finally {
      await stopServer(server, [ws]);
    }
  });
});

describe("no-op writes stay silent", () => {
  it("says nothing when a board cell write changed nothing (F11's rule, generalised)", async () => {
    const { org, dispatcherId, auth } = await seedOrgDispatcher();
    const load = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME FOODS", status: "open" },
    });

    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      // Sanity: the pipe is live. board_update no longer fires on this route
      // (A4 Task 9), so a real cell change — proven by its own load_changed —
      // stands in as the positive control the old board_update check gave;
      // without it, the "nothing arrived" assertion below would pass just as
      // well for a dead socket as for a genuine no-op.
      const real = await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth)
        .send({ row: "top", key: "customer", value: "ACME LOGISTICS", baseVersion: 0 });
      expect(real.status).toBe(200);
      const sanity = await nextLoadChanged(collector);
      expect(sanity.loadId).toBe(load.id);
      expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).version).toBe(1);

      const res = await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth)
        .send({ row: "top", key: "customer", value: "ACME LOGISTICS", baseVersion: 1 });
      expect(res.status).toBe(200);

      const frames = await collectFramesFor(collector, 300);
      expect(frames.some((f) => f.type === "load_changed")).toBe(false);
      expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).version).toBe(1);
    } finally {
      await stopServer(server, [ws]);
    }
  });
});

// --- fix round 1: geocode atomicity + trace, webhook idempotency -----------

describe("fix round 1", () => {
  async function seedPendingLoad() {
    const { org, dispatcherId, auth } = await seedOrgDispatcher();
    const load = await prisma.load.create({
      data: {
        orgId: org.id, requiredEquip: "DryVan", revenueCents: 10000, status: "open",
        stops: {
          create: [
            { sequence: 1, type: "pickup", address: "Kansas City, MO", geocodeStatus: "pending" },
            { sequence: 2, type: "delivery", address: "Omaha, NE", geocodeStatus: "pending" },
          ],
        },
      },
    });
    return { org, dispatcherId, auth, load };
  }

  it("a failure inside the geocode transaction leaves no coordinates written and the version unmoved", async () => {
    const { auth, load } = await seedPendingLoad();
    // The trace-row create is the LAST write in the transaction — forcing
    // exactly that one to fail proves everything BEFORE it (both stop
    // updates, the attention clears, the version bump) rolls back too, not
    // just that the last statement itself never lands.
    vanishNext("LoadChange", "create");
    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/geocode`).set(auth);
    disarmVanish();

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "INTERNAL" });

    const stops = await prisma.loadStop.findMany({ where: { loadId: load.id } });
    expect(stops.every((s) => s.lat === null && s.lng === null && s.geocodeStatus === "pending")).toBe(true);
    const fresh = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(fresh.version).toBe(0);
    expect(await prisma.loadChange.count({ where: { loadId: load.id } })).toBe(0);
  });

  it("geocode answers 500 JSON — not a hang — when an unexpected error is thrown", async () => {
    const { auth, load } = await seedPendingLoad();
    vi.spyOn(geocodeModule, "geocodeAddress").mockRejectedValueOnce(new Error("boom"));

    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/geocode`).set(auth);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "INTERNAL" });
    const fresh = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(fresh.version).toBe(0);
  });

  async function seedWebhookOrg() {
    seq += 1;
    const org = await prisma.org.create({ data: { name: `Webhook Org ${seq}`, apiKey: `whk_idem_${seq}` } });
    const disp = await prisma.dispatcher.create({ data: { email: `wd2-${seq}@x.com`, passwordHash: "x", name: "D", orgId: org.id } });
    const body = {
      externalId: `L-IDEM-${seq}`, requiredEquip: "DryVan", revenueCents: 45000,
      pickupAddress: "Kansas City, MO", pickupLat: KC.lat, pickupLng: KC.lng,
      deliveryAddress: "Omaha, NE", deliveryLat: OMAHA.lat, deliveryLng: OMAHA.lng,
    };
    return { org, apiKey: `whk_idem_${seq}`, dispatcherId: disp.id, body };
  }

  it("a repeat webhook push of CHANGED content bumps the version and the frame carries it", async () => {
    const { org, apiKey, dispatcherId, body } = await seedWebhookOrg();
    const first = await request(app).post("/api/webhooks/loads").set("x-api-key", apiKey).send(body);
    expect(first.status).toBe(200);
    const afterFirst = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, externalId: body.externalId } });
    expect(afterFirst.version).toBe(0);

    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      const second = await request(app).post("/api/webhooks/loads").set("x-api-key", apiKey)
        .send({ ...body, revenueCents: 52000 });
      expect(second.status).toBe(200);

      const frame = await nextLoadChanged(collector);
      const afterSecond = await prisma.load.findUniqueOrThrow({ where: { id: afterFirst.id } });
      expect(afterSecond.revenueCents).toBe(52000);
      expect(afterSecond.version).toBe(1);
      // L8: the real changed-field name, not the "imported" sentinel —
      // "imported" is outside `loadEvents.ts`'s documented vocabulary (field
      // names plus "created"/"deleted"), so the Cockpit's activity feed could
      // narrate a TMS push without ever saying what moved.
      expect(frame).toMatchObject({ orgId: org.id, loadId: afterFirst.id, version: 1, fields: ["revenueCents"] });
    } finally {
      await stopServer(server, [ws]);
    }
  });

  it("a repeat webhook push of IDENTICAL content emits nothing and leaves the version alone", async () => {
    const { org, apiKey, dispatcherId, body } = await seedWebhookOrg();
    const first = await request(app).post("/api/webhooks/loads").set("x-api-key", apiKey).send(body);
    expect(first.status).toBe(200);
    const afterFirst = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, externalId: body.externalId } });

    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      const second = await request(app).post("/api/webhooks/loads").set("x-api-key", apiKey).send(body);
      expect(second.status).toBe(200);
      expect(second.body.imported).toBe(1);

      const frames = await collectFramesFor(collector, 300);
      expect(frames.some((f) => f.type === "load_changed")).toBe(false);
      const afterSecond = await prisma.load.findUniqueOrThrow({ where: { id: afterFirst.id } });
      expect(afterSecond.version).toBe(afterFirst.version);
    } finally {
      await stopServer(server, [ws]);
    }
  });

  // L8: a re-push that only moves a stop (no scalar differs) names the stop
  // role, not "imported" — the OTHER half of loadIngest.ts's diff
  // (`stopChanged`, alongside `fieldsChanged`), covered separately from the
  // scalar-only case above.
  it("a repeat webhook push that only moves a stop names the stop role, not a sentinel", async () => {
    const { org, apiKey, dispatcherId, body } = await seedWebhookOrg();
    const first = await request(app).post("/api/webhooks/loads").set("x-api-key", apiKey).send(body);
    expect(first.status).toBe(200);
    const afterFirst = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, externalId: body.externalId } });

    const { server, ws, collector } = await openSocket(dispatcherId);
    try {
      const second = await request(app).post("/api/webhooks/loads").set("x-api-key", apiKey)
        .send({ ...body, deliveryAddress: "Rockford, IL" });
      expect(second.status).toBe(200);

      const frame = await nextLoadChanged(collector);
      const afterSecond = await prisma.load.findUniqueOrThrow({ where: { id: afterFirst.id } });
      expect(afterSecond.version).toBe(afterFirst.version + 1);
      expect(frame).toMatchObject({ orgId: org.id, loadId: afterFirst.id, fields: ["delivery"] });
    } finally {
      await stopServer(server, [ws]);
    }
  });
});
