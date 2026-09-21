import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs against the real database named by DATABASE_URL (the dev one on
// :5434). Skipped, with a printed reason, when it is not set — an adapter
// test that silently passes without its dependency is not a test.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
if (!url) console.warn("prismaEvents.test: DATABASE_URL not set — skipped");
// Imported at the top level (ESM top-level await) so the describe callback
// stays synchronous — Vitest does not collect tests from an async describe.
const mod = url ? await import("../../src/live/prismaEvents.js") : null;
const db = url ? await import("../../../fleet-backend/src/db.js") : null;

run("PrismaEvents", () => {
  // A describe.skip body still RUNS at collection; only its hooks and tests
  // are skipped. So nothing here may dereference the null modules — the
  // locals are typed as present and only touched inside hooks and tests.
  const PrismaEvents = mod?.PrismaEvents as NonNullable<typeof mod>["PrismaEvents"];
  const prisma = db?.prisma as NonNullable<typeof db>["prisma"];
  const tripId = "t_test_" + Date.now();

  beforeAll(async () => {
    await PrismaEvents.createTrip({ tripId, loadRef: "T-01", driverToken: "tok_" + tripId, brief: { loadRef: "T-01" } });
  });
  afterAll(async () => {
    await prisma.agentEvent.deleteMany({ where: { tripId } });
    await prisma.agentTrip.deleteMany({ where: { id: tripId } });
    await prisma.$disconnect();
  });

  it("appends and reads back in order, scoped to its trip", async () => {
    const store = new PrismaEvents(tripId);
    await store.append({ atMs: 2000, kind: "action", evidence: { kind: "b" } });
    await store.append({ atMs: 1000, kind: "plan", evidence: { distanceMi: 12 }, actionTaken: "planned" });
    const all = await store.all();
    expect(all.map((e) => e.atMs)).toEqual([1000, 2000]);
    expect(all[0].evidence).toEqual({ distanceMi: 12 });
    expect(all[0].actionTaken).toBe("planned");
    // Another trip sees nothing of this one.
    expect(await new PrismaEvents(tripId + "_other").all()).toEqual([]);
  });

  it("keeps millisecond precision on atMs across the BigInt column", async () => {
    const store = new PrismaEvents(tripId);
    await store.append({ atMs: 1788696660123, kind: "ping", evidence: {} });
    const last = (await store.all()).at(-1)!;
    expect(last.atMs).toBe(1788696660123);
  });
});
