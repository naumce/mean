import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";
import { laneKey, laneRunCounts } from "../src/lib/lanes.js";

// AI Dispatch Foundation, Task 4, review fix round 1 (Important #1) —
// laneRunCounts (src/lib/lanes.ts:114-142) shipped with no test coverage at
// all. Kept in its own file rather than folded into driver-metrics.test.ts:
// that file is already 450 lines, and these fixtures don't need the fuller
// on-time/detention/agent-trip machinery seedFixture there builds — just
// plain completed assignments on a lane.

beforeEach(resetDb);

const KC = { lat: 39.0997, lng: -94.5786, address: "Kansas City, MO 64101" };
const DALLAS = { lat: 32.7767, lng: -96.797, address: "Dallas, TX 75201" };
const TULSA = { lat: 36.154, lng: -95.9928, address: "Tulsa, OK 74101" };
const AMARILLO = { lat: 35.222, lng: -101.8313, address: "Amarillo, TX 79101" };

async function seedOrg(name = "Acme") {
  return prisma.org.create({ data: { name } });
}

async function seedDriver(orgId: string, name: string) {
  return prisma.driver.create({
    data: { email: `${name.replace(/\s+/g, ".").toLowerCase()}@x.com`, passwordHash: "x", name, orgId },
  });
}

async function seedLoad(orgId: string, pickup: typeof KC, delivery: typeof DALLAS) {
  return prisma.load.create({
    data: {
      orgId,
      requiredEquip: "DryVan",
      revenueCents: 100000,
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: pickup.address, lat: pickup.lat, lng: pickup.lng },
          { sequence: 2, type: "delivery", address: delivery.address, lat: delivery.lat, lng: delivery.lng },
        ],
      },
    },
  });
}

async function seedAssignment(
  orgId: string,
  driverId: string,
  loadId: string,
  status: string,
  completedAt: Date | null,
) {
  // plannedStart/plannedEnd are required columns with no bearing on
  // laneRunCounts itself — anchored to completedAt (or a fixed date for the
  // in_progress case) purely so every row is a valid Assignment.
  const anchor = completedAt ?? new Date("2026-01-01T00:00:00.000Z");
  return prisma.assignment.create({
    data: { orgId, loadId, driverId, status, plannedStart: anchor, plannedEnd: anchor, completedAt },
  });
}

describe("laneRunCounts", () => {
  it("aggregates runs across two different drivers on the same lane, org-wide", async () => {
    const org = await seedOrg();
    const driver1 = await seedDriver(org.id, "Driver One");
    const driver2 = await seedDriver(org.id, "Driver Two");
    const load1 = await seedLoad(org.id, KC, DALLAS);
    const load2 = await seedLoad(org.id, KC, DALLAS);
    await seedAssignment(org.id, driver1.id, load1.id, "completed", new Date("2026-07-01T12:00:00.000Z"));
    await seedAssignment(org.id, driver2.id, load2.id, "completed", new Date("2026-07-05T12:00:00.000Z"));

    const runs = await laneRunCounts(org.id);

    expect(runs.size).toBe(1);
    const key = laneKey(KC, DALLAS);
    expect(runs.get(key)).toMatchObject({ laneKey: key, runs: 2 });
  });

  it("the driverId filter restricts the count to that driver's own runs", async () => {
    const org = await seedOrg();
    const driver1 = await seedDriver(org.id, "Driver One");
    const driver2 = await seedDriver(org.id, "Driver Two");
    const load1 = await seedLoad(org.id, KC, DALLAS);
    const load2 = await seedLoad(org.id, KC, DALLAS);
    await seedAssignment(org.id, driver1.id, load1.id, "completed", new Date("2026-07-01T12:00:00.000Z"));
    await seedAssignment(org.id, driver2.id, load2.id, "completed", new Date("2026-07-05T12:00:00.000Z"));

    const runs = await laneRunCounts(org.id, driver1.id);

    const key = laneKey(KC, DALLAS);
    expect(runs.size).toBe(1);
    expect(runs.get(key)).toMatchObject({ runs: 1 }); // driver2's run on the same lane is excluded
  });

  it("counts only completed assignments — an in_progress one on the same lane is not counted", async () => {
    const org = await seedOrg();
    const driver = await seedDriver(org.id, "Driver One");
    const completedLoad = await seedLoad(org.id, KC, DALLAS);
    const inProgressLoad = await seedLoad(org.id, KC, DALLAS);
    await seedAssignment(org.id, driver.id, completedLoad.id, "completed", new Date("2026-07-01T12:00:00.000Z"));
    await seedAssignment(org.id, driver.id, inProgressLoad.id, "in_progress", null);

    const runs = await laneRunCounts(org.id);

    const key = laneKey(KC, DALLAS);
    expect(runs.get(key)).toMatchObject({ runs: 1 }); // the in_progress row never counts
  });

  it("lastRunAt is the max completedAt across a lane's runs, not the last one inserted", async () => {
    const org = await seedOrg();
    const driver = await seedDriver(org.id, "Driver One");
    const earlierLoad = await seedLoad(org.id, KC, DALLAS);
    const laterLoad = await seedLoad(org.id, KC, DALLAS);
    const earlier = new Date("2026-05-01T12:00:00.000Z");
    const later = new Date("2026-07-15T12:00:00.000Z");
    // Inserted in reverse chronological order on purpose: lastRunAt must be
    // the max completedAt by VALUE, not whichever row happened to be written
    // (or Map-inserted) last.
    await seedAssignment(org.id, driver.id, laterLoad.id, "completed", later);
    await seedAssignment(org.id, driver.id, earlierLoad.id, "completed", earlier);

    const runs = await laneRunCounts(org.id);

    const key = laneKey(KC, DALLAS);
    expect(runs.get(key)?.lastRunAt).toEqual(later);
  });

  it("originCity/destCity are parsed from the pickup/delivery stop addresses", async () => {
    const org = await seedOrg();
    const driver = await seedDriver(org.id, "Driver One");
    const load = await seedLoad(org.id, TULSA, AMARILLO);
    await seedAssignment(org.id, driver.id, load.id, "completed", new Date("2026-07-01T12:00:00.000Z"));

    const runs = await laneRunCounts(org.id);

    const key = laneKey(TULSA, AMARILLO);
    expect(runs.get(key)).toMatchObject({ originCity: "Tulsa", destCity: "Amarillo" });
  });

  it("an org with no completed assignments returns an empty Map", async () => {
    const org = await seedOrg();
    const driver = await seedDriver(org.id, "Driver One");
    const load = await seedLoad(org.id, KC, DALLAS);
    // Only a non-completed assignment exists for this org.
    await seedAssignment(org.id, driver.id, load.id, "assigned", null);

    const runs = await laneRunCounts(org.id);

    expect(runs.size).toBe(0);

    // A second org with NO assignments at all behaves identically.
    const emptyOrg = await seedOrg("Empty Co");
    expect((await laneRunCounts(emptyOrg.id)).size).toBe(0);
  });
});
