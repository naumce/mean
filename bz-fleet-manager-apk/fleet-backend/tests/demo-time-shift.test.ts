import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";
import {
  DAY_MS,
  shiftDays,
  shiftDemoTime,
  timestampColumns,
  writeAnchorMs,
} from "../src/lib/demoTimeShift.js";

// This moves every date in the database. The tests below guard the cases where
// getting it wrong leaves a scenario that is internally inconsistent — which
// looks like a working demo right up until someone reads two panels at once.

describe("shiftDays", () => {
  const anchor = Date.UTC(2026, 8, 1, 9, 0);

  it("advances by the WHOLE days elapsed, so times of day survive", () => {
    // A 06:00 departure has to still be a 06:00 departure. Shifting by a raw
    // millisecond delta slides every appointment window off the hour and makes
    // the board look subtly wrong in a way nobody can name.
    expect(shiftDays(anchor, anchor + 3 * DAY_MS).days).toBe(3);
    expect(shiftDays(anchor, anchor + 3 * DAY_MS + 17 * 3_600_000).days).toBe(3);
  });

  it("does nothing when the scenario is less than a day old", () => {
    const p = shiftDays(anchor, anchor + 5 * 3_600_000);
    expect(p.shifted).toBe(false);
    expect(p.reason).toMatch(/already current/i);
  });

  it("never shifts BACKWARDS, even if the anchor is in the future", () => {
    // Someone already moved the scenario past today. Quietly dragging it back
    // would undo their work with no way to tell that it happened.
    const p = shiftDays(anchor, anchor - 4 * DAY_MS);
    expect(p.shifted).toBe(false);
    expect(p.days).toBe(0);
  });

  it("refuses without an anchor rather than guessing one", () => {
    const p = shiftDays(null, anchor);
    expect(p.shifted).toBe(false);
    expect(p.reason).toMatch(/seed the week first/i);
  });
});

describe("timestampColumns", () => {
  it("reads the catalogue rather than a hand-written list", async () => {
    const cols = await timestampColumns();
    // A hand-kept list is one migration away from missing the column that
    // matters, and a half-shifted scenario is worse than an unshifted one.
    expect(cols.length).toBeGreaterThan(30);
    expect(cols).toContainEqual({ table: "Assignment", column: "plannedStart" });
    expect(cols).toContainEqual({ table: "Stop", column: "arrivedAt" });
  });

  it("never touches Prisma's migration ledger", async () => {
    // Those timestamps record when this database was migrated. That is
    // history, not scenario.
    const cols = await timestampColumns();
    expect(cols.some((c) => c.table === "_prisma_migrations")).toBe(false);
  });
});

describe("shiftDemoTime", () => {
  beforeEach(async () => {
    await resetDb();
    await prisma.demoAnchor.deleteMany();
  });

  const seedOrg = async (createdAt: Date) =>
    prisma.org.create({ data: { name: "Shift Test Org", createdAt } });

  it("moves every timestamp by the same whole number of days", async () => {
    const t0 = new Date(Date.UTC(2026, 8, 1, 6, 30));
    const org = await seedOrg(t0);
    await writeAnchorMs(t0.getTime());

    const plan = await shiftDemoTime(t0.getTime() + 5 * DAY_MS);
    expect(plan).toMatchObject({ shifted: true, days: 5 });

    const after = await prisma.org.findUniqueOrThrow({ where: { id: org.id } });
    expect(after.createdAt.getTime()).toBe(t0.getTime() + 5 * DAY_MS);
    // Time of day preserved — 06:30 is still 06:30.
    expect(after.createdAt.getUTCHours()).toBe(6);
    expect(after.createdAt.getUTCMinutes()).toBe(30);
  });

  it("keeps the SPACING between events, not just their absolute times", async () => {
    // The whole point. If two rows move by different amounts the scenario
    // becomes incoherent: a delivery before its pickup, a dwell of -3 hours.
    const t0 = new Date(Date.UTC(2026, 8, 1, 0, 0));
    const a = await seedOrg(t0);
    const b = await seedOrg(new Date(t0.getTime() + 9 * 3_600_000));
    await writeAnchorMs(t0.getTime());

    await shiftDemoTime(t0.getTime() + 4 * DAY_MS);

    const [aa, bb] = await Promise.all([
      prisma.org.findUniqueOrThrow({ where: { id: a.id } }),
      prisma.org.findUniqueOrThrow({ where: { id: b.id } }),
    ]);
    expect(bb.createdAt.getTime() - aa.createdAt.getTime()).toBe(9 * 3_600_000);
  });

  it("re-anchors, so pressing twice in one day is a no-op", async () => {
    const t0 = new Date(Date.UTC(2026, 8, 1, 12, 0));
    const org = await seedOrg(t0);
    await writeAnchorMs(t0.getTime());

    const now = t0.getTime() + 6 * DAY_MS;
    expect((await shiftDemoTime(now)).days).toBe(6);
    const second = await shiftDemoTime(now);
    expect(second.shifted).toBe(false);

    // And the data moved exactly once — a second shift would have doubled it.
    const after = await prisma.org.findUniqueOrThrow({ where: { id: org.id } });
    expect(after.createdAt.getTime()).toBe(t0.getTime() + 6 * DAY_MS);
  });

  it("does nothing at all without an anchor", async () => {
    const t0 = new Date(Date.UTC(2026, 8, 1));
    const org = await seedOrg(t0);
    const plan = await shiftDemoTime(t0.getTime() + 10 * DAY_MS);
    expect(plan.shifted).toBe(false);
    const after = await prisma.org.findUniqueOrThrow({ where: { id: org.id } });
    expect(after.createdAt.getTime()).toBe(t0.getTime());
  });
});

// Regression: the remainder between presses.
//
// The first version of this module re-anchored to `nowMs`, which looks right
// and quietly loses up to a day. Every test above still passed — the hole only
// showed up when a deliberate mutation (dropping the re-anchor entirely) failed
// to break anything, because DemoAnchor.anchorAt was being swept along with
// every other timestamp anyway.
describe("shiftDemoTime across consecutive presses", () => {
  beforeEach(async () => {
    await resetDb();
    await prisma.demoAnchor.deleteMany();
  });

  it("carries the sub-day remainder, so the next press is not swallowed", async () => {
    const t0 = Date.UTC(2026, 8, 1, 9, 0); // anchor: 09:00
    const org = await prisma.org.create({ data: { name: "Remainder Org", createdAt: new Date(t0) } });
    await writeAnchorMs(t0);

    // Pressed late in the day: 5.25 days elapsed -> 5 whole days move.
    expect((await shiftDemoTime(t0 + 5 * DAY_MS + 6 * 3_600_000)).days).toBe(5);

    // Next morning. Only 0.79 days since the button was PRESSED, but a full
    // 6 days since the scenario was anchored — so this must still move a day.
    const second = await shiftDemoTime(t0 + 6 * DAY_MS + 1 * 3_600_000);
    expect(second.shifted).toBe(true);
    expect(second.days).toBe(1);

    const after = await prisma.org.findUniqueOrThrow({ where: { id: org.id } });
    expect(after.createdAt.getTime()).toBe(t0 + 6 * DAY_MS);
    // And the time of day survived both presses.
    expect(after.createdAt.getUTCHours()).toBe(9);
  });
});
