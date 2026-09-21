import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { applyLoadChange, applyStatusChange, attentionAspect, InvalidStopSet, LoadNotFound, StaleVersion, type Actor, type StopSetEntry } from "../src/lib/loadWriter.js";
import { LoadLocked } from "../src/lib/loadLocks.js";
import { resetDb } from "./helpers.js";

const maria: Actor = { dispatcherId: "d-maria", name: "Maria" };

async function setup() {
  const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
  const load = await prisma.load.create({
    data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 400000, soldRateCents: 360000, customerName: "ACME", bolNumber: "0500001" },
  });
  return { org, load };
}

const apply = (loadId: string, orgId: string, patch: Parameters<typeof applyLoadChange>[1]["patch"], extra: Partial<Parameters<typeof applyLoadChange>[1]> = {}) =>
  prisma.$transaction((tx) => applyLoadChange(tx, { loadId, orgId, actor: maria, source: "board", patch, ...extra }));

describe("applyLoadChange — the patch, the version, the trace", () => {
  beforeEach(resetDb);

  it("writes the scalar patch, bumps the version once, and traces each field that changed", async () => {
    const { org, load } = await setup();
    const r = await apply(load.id, org.id, { customerName: "NEW CO", bolNumber: "0500001", revenueCents: 450000 });
    expect(r.version).toBe(1);
    // bolNumber was patched to the value it already had: not a change, not a trace.
    expect(r.changed.sort()).toEqual(["customerName", "revenueCents"]);
    const after = await prisma.load.findUnique({ where: { id: load.id } });
    expect(after?.customerName).toBe("NEW CO");
    expect(after?.version).toBe(1);
    const trace = await prisma.loadChange.findMany({ where: { loadId: load.id }, orderBy: { field: "asc" } });
    expect(trace.map((t) => [t.field, t.before, t.after, t.actorName, t.source])).toEqual([
      ["customerName", "ACME", "NEW CO", "Maria", "board"],
      ["revenueCents", "400000", "450000", "Maria", "board"],
    ]);
  });

  it("does not bump the version or write a trace when nothing changed", async () => {
    const { org, load } = await setup();
    const r = await apply(load.id, org.id, { customerName: "ACME" });
    expect(r.version).toBe(0);
    expect(r.changed).toEqual([]);
    expect(await prisma.loadChange.count()).toBe(0);
  });

  it("refuses a load outside the org as not found", async () => {
    const { load } = await setup();
    const other = await prisma.org.create({ data: { name: "Other", timezone: "UTC" } });
    await expect(apply(load.id, other.id, { customerName: "X" })).rejects.toBeInstanceOf(LoadNotFound);
  });

  it("finds the org's carrier by name and only creates one when there is none; MC lands on that carrier", async () => {
    const { org, load } = await setup();
    const existing = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    await apply(load.id, org.id, { carrier: { name: "Blue Road LLC" } });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.carrierId).toBe(existing.id);
    await apply(load.id, org.id, { carrier: { mcNumber: "1000001" } });
    expect((await prisma.carrier.findUnique({ where: { id: existing.id } }))?.mcNumber).toBe("1000001");
    await apply(load.id, org.id, { carrier: { name: "Red Line" } });
    expect(await prisma.carrier.count({ where: { orgId: org.id } })).toBe(2);
    // emptying the name detaches the load; it never deletes a carrier
    await apply(load.id, org.id, { carrier: { name: "" } });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.carrierId).toBeNull();
    expect(await prisma.carrier.count({ where: { orgId: org.id } })).toBe(2);
  });

  it("keeps producer-supplied attention by aspect: a new RATE refusal replaces the old one and leaves others alone", async () => {
    const { org, load } = await setup();
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(1), kind: "attention", text: 'can\'t read RATE "abc"' } });
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(2), kind: "attention", text: 'can\'t place pickup "Nowhere, ZZ" on the map' } });
    const r = await apply(load.id, org.id, {}, { attention: ['can\'t read RATE "xyz"'] });
    expect(r.attention).toEqual(['can\'t read RATE "xyz"']);
    const rows = (await prisma.agentUpdate.findMany({ where: { loadId: load.id }, orderBy: { atMs: "asc" } })).map((a) => a.text);
    expect(rows).toEqual(['can\'t place pickup "Nowhere, ZZ" on the map', 'can\'t read RATE "xyz"']);
  });

  it("clears the RATE attention when a readable rate lands", async () => {
    const { org, load } = await setup();
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(1), kind: "attention", text: 'can\'t read RATE "abc"' } });
    await apply(load.id, org.id, { revenueCents: 100000 });
    expect(await prisma.agentUpdate.count({ where: { loadId: load.id } })).toBe(0);
  });

  // A1: the SHIP DATE and SOLD RATE cells refuse the same way RATE does, so
  // typing them answers their refusal the same way.
  it("clears the SHIP DATE and SOLD RATE refusals when those cells are written", async () => {
    const { org, load } = await setup();
    await prisma.agentUpdate.createMany({ data: [
      { loadId: load.id, atMs: BigInt(1), kind: "attention", text: 'can\'t read SHIP DATE "TBD"' },
      { loadId: load.id, atMs: BigInt(2), kind: "attention", text: 'can\'t read SOLD RATE "ask john"' },
      { loadId: load.id, atMs: BigInt(3), kind: "attention", text: 'can\'t place pickup "Nowhere, ZZ" on the map' },
    ] });
    await apply(load.id, org.id, { shipDate: new Date("2026-07-13T00:00:00Z"), soldRateCents: 350000 });
    const rows = (await prisma.agentUpdate.findMany({ where: { loadId: load.id } })).map((a) => a.text);
    expect(rows).toEqual(['can\'t place pickup "Nowhere, ZZ" on the map']);
  });

  // A1: the defect this closes — a producer that no longer raises a line for
  // an aspect it OWNS must clear the row it left behind, or the pill outlives
  // the problem forever.
  it("clears an owned aspect the producer no longer raises, and keeps aspects it does not own", async () => {
    const { org, load } = await setup();
    await prisma.agentUpdate.createMany({ data: [
      { loadId: load.id, atMs: BigInt(1), kind: "attention", text: 'can\'t read SHIP DATE "TBD"' },
      { loadId: load.id, atMs: BigInt(2), kind: "attention", text: 'can\'t read PU appointment: "PU: whenever"' },
    ] });
    // The corrected sheet reads SHIP DATE now, so it sends no line for it —
    // but it is still the aspect's owner, so the stale row goes.
    const r = await apply(load.id, org.id, {}, { attention: [], attentionOwned: ["can't read RATE", "can't read SHIP DATE", "can't read SOLD RATE"] });
    expect(r.attention).toEqual([]);
    const rows = (await prisma.agentUpdate.findMany({ where: { loadId: load.id } })).map((a) => a.text);
    expect(rows).toEqual(['can\'t read PU appointment: "PU: whenever"']);
  });
});

// A2 + A3: a Carrier row is shared. What a dispatcher types on ONE board line
// must never rewrite what another line's carrier says, and a blank cell never
// invents a carrier at all.
describe("applyLoadChange — the carrier a cell may and may not touch", () => {
  beforeEach(resetDb);

  it("never invents a carrier for an emptied M.C.#, and leaves the status alone", async () => {
    const { org, load } = await setup();
    await prisma.load.update({ where: { id: load.id }, data: { updateText: "SCHEDULED", status: "open" } });
    const r = await apply(load.id, org.id, { carrier: { mcNumber: "" } });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.carrierId).toBeNull();
    expect(await prisma.carrier.count({ where: { orgId: org.id } })).toBe(0);
    expect(r.status).toBe("open");
  });

  it("updates the carrier in place when this load is its only referrer", async () => {
    const { org, load } = await setup();
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    await prisma.load.update({ where: { id: load.id }, data: { carrierId: carrier.id } });
    await apply(load.id, org.id, { carrier: { mcNumber: "1000001" } });
    expect((await prisma.carrier.findUnique({ where: { id: carrier.id } }))?.mcNumber).toBe("1000001");
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.carrierId).toBe(carrier.id);
  });

  it("relinks instead of rewriting when two loads share the carrier", async () => {
    const { org, load } = await setup();
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC", mcNumber: "1000001" } });
    const other = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, carrierId: carrier.id } });
    await prisma.load.update({ where: { id: load.id }, data: { carrierId: carrier.id } });
    await apply(load.id, org.id, { carrier: { mcNumber: "2000002" } });
    // The shared row is exactly as it was, and the other load still points at it.
    expect((await prisma.carrier.findUnique({ where: { id: carrier.id } }))?.mcNumber).toBe("1000001");
    expect((await prisma.load.findUnique({ where: { id: other.id } }))?.carrierId).toBe(carrier.id);
    // The edited load points somewhere else, with the number that was typed.
    const mine = await prisma.load.findUnique({ where: { id: load.id }, include: { carrier: true } });
    expect(mine?.carrierId).not.toBe(carrier.id);
    expect(mine?.carrier?.mcNumber).toBe("2000002");
    expect(mine?.carrier?.name).toBe("Blue Road LLC");
  });

  it("finds the org's carrier for a shared row's new M.C.# rather than making a second one", async () => {
    const { org, load } = await setup();
    const shared = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC", mcNumber: "1000001" } });
    const target = await prisma.carrier.create({ data: { orgId: org.id, name: "Fast Lane Inc", mcNumber: "2000002" } });
    await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, carrierId: shared.id } });
    await prisma.load.update({ where: { id: load.id }, data: { carrierId: shared.id } });
    await apply(load.id, org.id, { carrier: { mcNumber: "2000002" } });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.carrierId).toBe(target.id);
    expect(await prisma.carrier.count({ where: { orgId: org.id } })).toBe(2);
  });

  it("lands a typed M.C.# when the shared carrier has none yet, without renumbering it", async () => {
    // The ordinary case: the same name typed on two rows links both to one
    // unnumbered carrier; then the number is typed on one of them. The
    // shared row resolves to itself by name — the cell must still land.
    const { org, load } = await setup();
    const shared = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    const other = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, carrierId: shared.id } });
    await prisma.load.update({ where: { id: load.id }, data: { carrierId: shared.id } });
    const r = await apply(load.id, org.id, { carrier: { mcNumber: "1000001" } });
    expect(r.changed).toContain("carrierId");
    const mine = await prisma.load.findUnique({ where: { id: load.id }, include: { carrier: true } });
    expect(mine?.carrier?.mcNumber).toBe("1000001");
    expect(mine?.carrier?.name).toBe("Blue Road LLC");
    expect((await prisma.carrier.findUnique({ where: { id: shared.id } }))?.mcNumber).toBeNull();
    expect((await prisma.load.findUnique({ where: { id: other.id } }))?.carrierId).toBe(shared.id);
  });

  it("gives a same-named unnumbered twin the typed M.C.# when no other load runs it", async () => {
    const { org, load } = await setup();
    const shared = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC", mcNumber: "1000001" } });
    const twin = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, carrierId: shared.id } });
    await prisma.load.update({ where: { id: load.id }, data: { carrierId: shared.id } });
    await apply(load.id, org.id, { carrier: { mcNumber: "2000002" } });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.carrierId).toBe(twin.id);
    expect((await prisma.carrier.findUnique({ where: { id: twin.id } }))?.mcNumber).toBe("2000002");
    expect((await prisma.carrier.findUnique({ where: { id: shared.id } }))?.mcNumber).toBe("1000001");
    expect(await prisma.carrier.count({ where: { orgId: org.id } })).toBe(2);
  });
});

describe("attentionAspect", () => {
  it("is the text up to the first colon or quote", () => {
    expect(attentionAspect('can\'t read PU appointment: "PU: 07/13"')).toBe("can't read PU appointment");
    expect(attentionAspect('can\'t place pickup "Henderson, NV" on the map')).toBe("can't place pickup");
    expect(attentionAspect("can't read RATE: blank")).toBe("can't read RATE");
  });
});

describe("applyLoadChange — stops and coordinates", () => {
  beforeEach(resetDb);

  it("creates the pickup and delivery stops by role on first write, and geocodes a city the gazetteer knows", async () => {
    const { org, load } = await setup();
    const r = await apply(load.id, org.id, { stops: { pickup: { address: "Kansas City, MO 64120" } } });
    expect(r.changed).toContain("stops.pickup");
    const stops = await prisma.loadStop.findMany({ where: { loadId: load.id }, orderBy: { sequence: "asc" } });
    // both roles exist from the first write — the board's GET reads them by
    // type, and the board shows both columns for every row anyway
    expect(stops.map((s) => [s.type, s.sequence])).toEqual([["pickup", 1], ["delivery", 2]]);
    expect(stops[0].address).toBe("Kansas City, MO 64120");
    expect(stops[0].lat).not.toBeNull();
    expect(stops[0].geocodeStatus).toBe("ok");
    expect(stops[1].address).toBe("");
  });

  it("writes pending, never failed, and an attention naming the address, for a city it cannot place", async () => {
    const { org, load } = await setup();
    const r = await apply(load.id, org.id, { stops: { delivery: { address: "Nowhere, ZZ 00000" } } });
    expect(r.attention).toEqual(['can\'t place delivery "Nowhere, ZZ 00000" on the map']);
    const del = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "delivery" } });
    expect(del?.lat).toBeNull();
    expect(del?.geocodeStatus).toBe("pending");
  });

  it("re-geocodes only the stop whose address changed, and clears its attention when it resolves", async () => {
    const { org, load } = await setup();
    await apply(load.id, org.id, { stops: { pickup: { address: "Nowhere, ZZ" }, delivery: { address: "Dallas, TX 75236" } } });
    expect(await prisma.agentUpdate.count({ where: { loadId: load.id } })).toBe(1);
    const r = await apply(load.id, org.id, { stops: { pickup: { address: "Omaha, NE 68137" } } });
    expect(r.changed).toEqual(["stops.pickup"]);
    expect(await prisma.agentUpdate.count({ where: { loadId: load.id } })).toBe(0);
    const del = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "delivery" } });
    expect(del?.address).toBe("Dallas, TX 75236");
  });

  // A5: a city retyped on the board moved the load on the map and left no
  // trace at all — nobody could see who moved it.
  it("traces a stop edit with the address before and after it", async () => {
    const { org, load } = await setup();
    await apply(load.id, org.id, { stops: { pickup: { address: "Kansas City, MO 64120" } } });
    await apply(load.id, org.id, { stops: { pickup: { address: "Omaha, NE 68137" } } });
    const trace = await prisma.loadChange.findMany({ where: { loadId: load.id, field: "stops.pickup" }, orderBy: { atMs: "asc" } });
    expect(trace.map((t) => [t.before, t.after, t.source])).toEqual([
      [null, "Kansas City, MO 64120", "board"],
      ["Kansas City, MO 64120", "Omaha, NE 68137", "board"],
    ]);
  });

  it("leaves a stop the Cockpit already placed alone when the address did not change, even under force", async () => {
    const { org, load } = await setup();
    await prisma.loadStop.create({ data: { loadId: load.id, sequence: 1, type: "pickup", address: "Kansas City, MO", lat: 39.1, lng: -94.6, geocodeStatus: "ok" } });
    await apply(load.id, org.id, {}, { force: true });
    const pu = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "pickup" } });
    expect(pu?.lat).toBe(39.1);
  });

  it("geocodes a stop that has an address but no coordinates under force", async () => {
    const { org, load } = await setup();
    await prisma.loadStop.create({ data: { loadId: load.id, sequence: 1, type: "pickup", address: "Kansas City, MO 64120", geocodeStatus: "pending" } });
    await apply(load.id, org.id, {}, { force: true });
    const pu = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "pickup" } });
    expect(pu?.lat).not.toBeNull();
    expect(pu?.geocodeStatus).toBe("ok");
  });
});

describe("applyLoadChange — appointments", () => {
  beforeEach(resetDb);

  const withStops = async () => {
    const { org, load } = await setup();
    await apply(load.id, org.id, { shipDate: new Date("2026-07-13T00:00:00Z"), stops: { pickup: { address: "Kansas City, MO" }, delivery: { address: "Dallas, TX" } } });
    return { org, load };
  };
  const appointments = (loadId: string) =>
    prisma.appointment.findMany({ where: { stop: { loadId } }, include: { stop: true }, orderBy: { stop: { sequence: "asc" } } });

  it("parses PU and DEL lines into the two stops' appointments, in the org's zone", async () => {
    const { org, load } = await withStops();
    const r = await apply(load.id, org.id, { apptText: "PU: 07/14 - 12:00\nDEL: 07/17 - 10:00" });
    expect(r.attention).toEqual([]);
    const rows = await appointments(load.id);
    expect(rows.map((a) => [a.stop.type, a.kind])).toEqual([["pickup", "appointment"], ["delivery", "appointment"]]);
    // 12:00 Chicago (CDT, UTC-5) on 07/14/2026 is 17:00Z
    expect(rows[0].windowEnd.toISOString()).toBe("2026-07-14T17:00:00.000Z");
    expect(rows[1].windowEnd.toISOString()).toBe("2026-07-17T15:00:00.000Z");
  });

  it("keeps the existing appointment and raises attention when the new line cannot be read", async () => {
    const { org, load } = await withStops();
    await apply(load.id, org.id, { apptText: "PU: 07/14 - 12:00\nDEL: 07/17 - 10:00" });
    const r = await apply(load.id, org.id, { apptText: "PU: 07/14 - 12:00\nDEL: whenever" });
    expect(r.attention).toEqual(['can\'t read DEL appointment: "PU: 07/14 - 12:00 / DEL: whenever"']);
    const rows = await appointments(load.id);
    expect(rows).toHaveLength(2);
    expect(rows[1].windowEnd.toISOString()).toBe("2026-07-17T15:00:00.000Z");   // untouched
    // and the text is stored exactly as typed
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.apptText).toBe("PU: 07/14 - 12:00\nDEL: whenever");
  });

  it("clears the attention once the line reads again", async () => {
    const { org, load } = await withStops();
    await apply(load.id, org.id, { apptText: "PU: 07/14 - 12:00\nDEL: whenever" });
    const r = await apply(load.id, org.id, { apptText: "PU: 07/14 - 12:00\nDEL: 07/18 - 09:00" });
    expect(r.attention).toEqual([]);
    expect(await prisma.agentUpdate.count({ where: { loadId: load.id } })).toBe(0);
  });

  it("reads an FCFS range as an fcfs window", async () => {
    const { org, load } = await withStops();
    await apply(load.id, org.id, { apptText: "PU: 07/14 - 12:00\nDEL: 07/17 - 08-15:00 FCFS" });
    const rows = await appointments(load.id);
    expect(rows[1].kind).toBe("fcfs");
    expect(rows[1].windowStart?.toISOString()).toBe("2026-07-17T13:00:00.000Z");
    expect(rows[1].windowEnd.toISOString()).toBe("2026-07-17T20:00:00.000Z");
  });

  it("under force, creates an appointment only where the stop has none — a Cockpit-set one is truth", async () => {
    const { org, load } = await withStops();
    await prisma.load.update({ where: { id: load.id }, data: { apptText: "PU: 07/14 - 12:00\nDEL: 07/17 - 10:00" } });
    const del = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "delivery" } });
    await prisma.appointment.create({ data: { stopId: del!.id, windowEnd: new Date("2026-07-20T12:00:00Z"), type: "delivery", kind: "appointment" } });
    await apply(load.id, org.id, {}, { force: true });
    const rows = await appointments(load.id);
    expect(rows.map((a) => [a.stop.type, a.windowEnd.toISOString()])).toEqual([
      ["pickup", "2026-07-14T17:00:00.000Z"],    // created from the text
      ["delivery", "2026-07-20T12:00:00.000Z"],  // the Cockpit's value, not the text's
    ]);
  });
});

describe("applyLoadChange — UPDATE drives status", () => {
  beforeEach(resetDb);

  const brokered = async () => {
    const { org, load } = await setup();
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    await prisma.load.update({ where: { id: load.id }, data: { carrierId: carrier.id } });
    return { org, load };
  };

  it("moves a brokered load through their words, tracing each step with the text that drove it", async () => {
    const { org, load } = await brokered();
    let r = await apply(load.id, org.id, { updateText: "SCHEDULED" });
    expect(r.status).toBe("assigned");
    r = await apply(load.id, org.id, { updateText: "PICKED UP 07/15/2026" });
    expect(r.status).toBe("in_progress");
    r = await apply(load.id, org.id, { updateText: "DELIVERED 07/17/2026" });
    expect(r.status).toBe("delivered");
    const trace = await prisma.loadChange.findMany({ where: { loadId: load.id, field: "status" }, orderBy: { atMs: "asc" } });
    expect(trace.map((t) => [t.before, t.after, t.note])).toEqual([
      ["open", "assigned", "SCHEDULED"],
      ["assigned", "in_progress", "PICKED UP 07/15/2026"],
      ["in_progress", "delivered", "DELIVERED 07/17/2026"],
    ]);
  });

  it("changes nothing for text that matches no rule, and raises no attention for it", async () => {
    const { org, load } = await brokered();
    const r = await apply(load.id, org.id, { updateText: "waiting on POD" });
    expect(r.status).toBe("open");
    expect(r.statusRefused).toBeNull();
    expect(r.attention).toEqual([]);
    expect(await prisma.loadChange.count({ where: { field: "status" } })).toBe(0);
  });

  it("re-derives when the carrier changes: SCHEDULED becomes assigned the moment a carrier is booked", async () => {
    const { org, load } = await setup();
    let r = await apply(load.id, org.id, { updateText: "SCHEDULED" });
    expect(r.status).toBe("open");                       // no carrier yet
    r = await apply(load.id, org.id, { carrier: { name: "Blue Road LLC" } });
    expect(r.status).toBe("assigned");
  });

  it("refuses to move a load one of our drivers runs, stores the cell, and says where to do it", async () => {
    const { org, load } = await brokered();
    const driver = await prisma.driver.create({ data: { email: "j@x.com", passwordHash: "x", name: "Jake", orgId: org.id } });
    await prisma.assignment.create({ data: { orgId: org.id, loadId: load.id, driverId: driver.id, status: "dispatched", plannedStart: new Date(), plannedEnd: new Date() } });
    await prisma.load.update({ where: { id: load.id }, data: { status: "assigned" } });
    const r = await apply(load.id, org.id, { updateText: "DELIVERED 07/17/2026" });
    expect(r.status).toBe("assigned");
    expect(r.statusRefused).toMatch(/record says assigned/);
    expect(r.statusRefused).toMatch(/Cockpit/);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.updateText).toBe("DELIVERED 07/17/2026");
    expect(await prisma.loadChange.count({ where: { field: "status" } })).toBe(0);
  });

  it("never moves an archived load by text", async () => {
    const { org, load } = await brokered();
    await prisma.load.update({ where: { id: load.id }, data: { status: "archived" } });
    const r = await apply(load.id, org.id, { updateText: "DELIVERED 07/17/2026" });
    expect(r.status).toBe("archived");
    expect(r.statusRefused).toMatch(/archived/);
  });

  it("uses the org's own rules, seeding the defaults the first time it needs them", async () => {
    const { org, load } = await brokered();
    expect(await prisma.updateRule.count({ where: { orgId: org.id } })).toBe(0);
    await apply(load.id, org.id, { updateText: "LOADED" });
    expect(await prisma.updateRule.count({ where: { orgId: org.id } })).toBe(10);
    // a human's rule wins: disable DELIVERED, add their own word
    await prisma.updateRule.update({ where: { orgId_prefix: { orgId: org.id, prefix: "DELIVERED" } }, data: { enabled: false } });
    await prisma.updateRule.create({ data: { orgId: org.id, prefix: "DONE", status: "delivered" } });
    let r = await apply(load.id, org.id, { updateText: "DELIVERED 07/17/2026" });
    expect(r.status).toBe("in_progress");
    r = await apply(load.id, org.id, { updateText: "DONE" });
    expect(r.status).toBe("delivered");
  });

  it("re-derives under force from the text already stored — the backfill", async () => {
    const { org, load } = await brokered();
    await prisma.load.update({ where: { id: load.id }, data: { updateText: "DELIVERED 07/16/2026" } });
    const r = await apply(load.id, org.id, {}, { force: true, source: "backfill" });
    expect(r.status).toBe("delivered");
    const t = await prisma.loadChange.findFirst({ where: { field: "status" } });
    expect(t?.source).toBe("backfill");
  });
});

describe("applyLoadChange — locks and the version backstop (spec §7)", () => {
  beforeEach(resetDb);
  const actorMaria = { dispatcherId: "disp-maria", name: "Maria" };
  const actorJake = { dispatcherId: "disp-jake", name: "Jake" };
  const write = (loadId: string, orgId: string, actor: { dispatcherId: string | null; name: string }, extra: Partial<Parameters<typeof applyLoadChange>[1]> = {}) =>
    prisma.$transaction((tx) => applyLoadChange(tx, { loadId, orgId, actor, source: "board", patch: { customerName: "NEW" }, ...extra }));

  it("refuses a load another dispatcher is editing, naming them, and writes nothing", async () => {
    const { org, load } = await setup();
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    await expect(write(load.id, org.id, actorJake)).rejects.toMatchObject({ lock: { by: "Maria" } });
    await expect(write(load.id, org.id, actorJake)).rejects.toBeInstanceOf(LoadLocked);
    const after = await prisma.load.findUnique({ where: { id: load.id } });
    expect([after?.customerName, after?.version]).toEqual(["ACME", 0]);
  });

  it("lets the holder write, and lets anyone write once the lock has expired", async () => {
    const { org, load } = await setup();
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    expect((await write(load.id, org.id, actorMaria)).version).toBe(1);
    await prisma.loadLock.update({ where: { loadId: load.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await write(load.id, org.id, actorJake, { patch: { customerName: "NEWER" } })).version).toBe(2);
  });

  it("refuses the truth arriving under an open editor too — an import does not land on a held load", async () => {
    const { org, load } = await setup();
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    await expect(write(load.id, org.id, { dispatcherId: null, name: "import" }, { source: "import" })).rejects.toBeInstanceOf(LoadLocked);
  });

  it("refuses a write whose baseVersion is not the row's version, and says both", async () => {
    const { org, load } = await setup();
    await write(load.id, org.id, actorMaria); // version 1
    await expect(write(load.id, org.id, actorJake, { baseVersion: 0, patch: { customerName: "STALE" } })).rejects.toMatchObject({ current: 1, base: 0 });
    await expect(write(load.id, org.id, actorJake, { baseVersion: 0, patch: { customerName: "STALE" } })).rejects.toBeInstanceOf(StaleVersion);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.customerName).toBe("NEW");
    expect((await write(load.id, org.id, actorJake, { baseVersion: 1, patch: { customerName: "FRESH" } })).version).toBe(2);
  });

  it("skips the version check for import and backfill — they are the truth, not a view of it", async () => {
    const { org, load } = await setup();
    await write(load.id, org.id, actorMaria);
    const r = await write(load.id, org.id, { dispatcherId: null, name: "import" }, { source: "import", baseVersion: 0, patch: { customerName: "FROM SHEET" } });
    expect(r.version).toBe(2);
  });
});

describe("applyLoadChange — the Cockpit's fields and a full stop set (plan A3)", () => {
  beforeEach(resetDb);

  it("writes the TMS scalars, traces them, and bumps the version once", async () => {
    const { org, load } = await setup();
    const r = await apply(load.id, org.id, { requiredEquip: "Reefer", commodity: "Frozen peas", weightLbs: 41000, hazmatClass: null, brokerName: "TQL", fscCents: 12000 }, { source: "loadboard" });
    expect(r.version).toBe(1);
    expect(r.changed.sort()).toEqual(["brokerName", "commodity", "fscCents", "requiredEquip", "weightLbs"]);
    const after = await prisma.load.findUnique({ where: { id: load.id } });
    expect([after?.requiredEquip, after?.commodity, after?.weightLbs, after?.fscCents]).toEqual(["Reefer", "Frozen peas", 41000, 12000]);
    expect(await prisma.loadChange.count({ where: { loadId: load.id, field: "requiredEquip", before: "DryVan", after: "Reefer" } })).toBe(1);
  });

  it("replaces the whole stop set with explicit windows, geocodes what the gazetteer knows, and traces the change", async () => {
    const { org, load } = await setup();
    const r = await apply(load.id, org.id, { stopSet: [
      { sequence: 1, type: "pickup", address: "Kansas City, MO", dwellMin: 60, windowStart: new Date("2026-07-14T15:00:00Z"), windowEnd: new Date("2026-07-14T17:00:00Z") },
      { sequence: 2, type: "intermediate", address: "Nowhere, ZZ", dwellMin: 30 },
      { sequence: 3, type: "delivery", address: "Dallas, TX", windowEnd: new Date("2026-07-16T12:00:00Z") },
    ] }, { source: "loadboard" });
    expect(r.version).toBe(1);
    expect(r.changed).toContain("stopSet");
    const stops = await prisma.loadStop.findMany({ where: { loadId: load.id }, orderBy: { sequence: "asc" }, include: { appointment: true } });
    expect(stops.map((s) => [s.type, s.geocodeStatus, s.appointment?.windowEnd?.toISOString() ?? null])).toEqual([
      ["pickup", "ok", "2026-07-14T17:00:00.000Z"],
      ["intermediate", "pending", null],
      ["delivery", "ok", "2026-07-16T12:00:00.000Z"],
    ]);
    expect(stops[0].appointment?.windowStart?.toISOString()).toBe("2026-07-14T15:00:00.000Z");
    expect(r.attention).toEqual(['can\'t place intermediate "Nowhere, ZZ" on the map']);
    expect(await prisma.loadChange.count({ where: { loadId: load.id, field: "stopSet" } })).toBe(1);
  });

  // F6: `before` renders from `before.stops`, which loadRow() always returns
  // sequence-ordered; `after` used to render from `patch.stopSet` in whatever
  // order the caller sent it. A save that both changes a stop AND submits the
  // set out of sequence order used to write a trace row whose two sides read
  // in two different orders and could not be compared against each other.
  it("traces the stopSet's `after` side in sequence order, even when the patch itself arrives out of order", async () => {
    const { org, load } = await setup();
    await apply(load.id, org.id, { stopSet: [
      { sequence: 1, type: "pickup", address: "Kansas City, MO" },
      { sequence: 2, type: "delivery", address: "Dallas, TX" },
    ] }, { source: "loadboard" });
    // A real change (the delivery address) submitted with sequence 2 BEFORE
    // sequence 1 in the array — the Cockpit's own field order, not the load's.
    await apply(load.id, org.id, { stopSet: [
      { sequence: 2, type: "delivery", address: "Houston, TX" },
      { sequence: 1, type: "pickup", address: "Kansas City, MO" },
    ] }, { source: "loadboard" });
    const trace = await prisma.loadChange.findMany({ where: { loadId: load.id, field: "stopSet" }, orderBy: { atMs: "asc" } });
    expect(trace).toHaveLength(2);
    // Sequence order (1 then 2), not the caller's array order (2 then 1).
    expect(trace[1].after).toBe("Kansas City, MO → Houston, TX");
  });

  it("keeps coordinates the caller supplied instead of re-geocoding them", async () => {
    const { org, load } = await setup();
    await apply(load.id, org.id, { stopSet: [
      { sequence: 1, type: "pickup", address: "Somewhere Farm Rd", lat: 39.1, lng: -94.6 },
      { sequence: 2, type: "delivery", address: "Dallas, TX" },
    ] }, { source: "loadboard" });
    const pu = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "pickup" } });
    expect([pu?.lat, pu?.lng, pu?.geocodeStatus]).toEqual([39.1, -94.6, "ok"]);
  });

  it("applyStatusChange: moves the status, traces it with its note, bumps the version, and refuses a held load", async () => {
    const { org, load } = await setup();
    const r = await prisma.$transaction((tx) => applyStatusChange(tx, { loadId: load.id, orgId: org.id, actor: maria, source: "loadboard", status: "assigned", note: "assignment a1 committed" }));
    expect(r).toEqual({ version: 1, before: "open" });
    const row = await prisma.loadChange.findFirst({ where: { loadId: load.id, field: "status" } });
    expect([row?.before, row?.after, row?.note, row?.source]).toEqual(["open", "assigned", "assignment a1 committed", "loadboard"]);
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-jake", dispatcherName: "Jake", expiresAt: new Date(Date.now() + 60_000) } });
    await expect(prisma.$transaction((tx) => applyStatusChange(tx, { loadId: load.id, orgId: org.id, actor: maria, source: "loadboard", status: "in_progress", note: null }))).rejects.toMatchObject({ lock: { by: "Jake" } });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.status).toBe("assigned");
  });

  // Fix round 1, defect 1 (HIGH): the Cockpit's GET → PUT round trip resubmits
  // the same list it was handed. That must not bump the version, duplicate
  // the trace, or hand every stop and appointment a new id.
  it("is a no-op when the stop set resubmitted is identical to what's stored", async () => {
    const { org, load } = await setup();
    const stopSet: StopSetEntry[] = [
      { sequence: 1, type: "pickup", address: "Kansas City, MO", dwellMin: 60, windowStart: new Date("2026-07-14T15:00:00Z"), windowEnd: new Date("2026-07-14T17:00:00Z") },
      { sequence: 2, type: "delivery", address: "Dallas, TX", windowEnd: new Date("2026-07-16T12:00:00Z") },
    ];
    const r1 = await apply(load.id, org.id, { stopSet }, { source: "loadboard" });
    expect(r1.version).toBe(1);
    const before = await prisma.loadStop.findMany({ where: { loadId: load.id }, orderBy: { sequence: "asc" }, include: { appointment: true } });
    const r2 = await apply(load.id, org.id, { stopSet }, { source: "loadboard" });
    expect(r2.version).toBe(1);
    expect(r2.changed).not.toContain("stopSet");
    expect(await prisma.loadChange.count({ where: { loadId: load.id, field: "stopSet" } })).toBe(1);
    const after = await prisma.loadStop.findMany({ where: { loadId: load.id }, orderBy: { sequence: "asc" }, include: { appointment: true } });
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(after.map((s) => s.appointment?.id)).toEqual(before.map((s) => s.appointment?.id));
  });

  // Fix round 1, defect 2 (MEDIUM): two entries claiming the same sequence
  // cannot both land — reject before anything is written.
  it("rejects a stop set with duplicate sequences, writing nothing", async () => {
    const { org, load } = await setup();
    await expect(apply(load.id, org.id, { stopSet: [
      { sequence: 1, type: "pickup", address: "Kansas City, MO" },
      { sequence: 1, type: "delivery", address: "Dallas, TX" },
    ] }, { source: "loadboard" })).rejects.toBeInstanceOf(InvalidStopSet);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.version).toBe(0);
    expect(await prisma.loadStop.count({ where: { loadId: load.id } })).toBe(0);
  });

  // Fix round 1, defect 3 (LOW): the board's by-role edit and the Cockpit's
  // whole-list edit are two different write shapes for the same stops —
  // sending both at once cannot mean anything.
  it("rejects a patch carrying both stops and stopSet, writing nothing", async () => {
    const { org, load } = await setup();
    await expect(apply(load.id, org.id, {
      stops: { pickup: { address: "Kansas City, MO" } },
      stopSet: [{ sequence: 1, type: "pickup", address: "Kansas City, MO" }],
    }, { source: "loadboard" })).rejects.toBeInstanceOf(InvalidStopSet);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.version).toBe(0);
    expect(await prisma.loadStop.count({ where: { loadId: load.id } })).toBe(0);
  });

  // Fix round 1, defect 4 (ruling R11): Appointment.windowEnd is NOT NULL —
  // a half window (windowStart with no windowEnd) would otherwise be
  // silently dropped on write, and stopSetUnchanged() could then never match
  // it back on a resubmit. Reject before anything is written, same as the
  // duplicate-sequence check above (checked in the same scan).
  it("rejects a stop set with windowStart but no windowEnd, writing nothing", async () => {
    const { org, load } = await setup();
    await expect(apply(load.id, org.id, { stopSet: [
      { sequence: 1, type: "pickup", address: "Kansas City, MO", windowStart: new Date("2026-07-14T15:00:00Z") },
      { sequence: 2, type: "delivery", address: "Dallas, TX", windowEnd: new Date("2026-07-16T12:00:00Z") },
    ] }, { source: "loadboard" })).rejects.toBeInstanceOf(InvalidStopSet);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.version).toBe(0);
    expect(await prisma.loadStop.count({ where: { loadId: load.id } })).toBe(0);
  });
});
