import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";

// T3 Break and Rest Planning, Task 3 — the RestStop table. This is a model
// round-trip test, not an API test: RestStop has no routes yet (Task 4).
//
// The assertion that matters most: a stop created without `spaces` must read
// back as null, never 0. This codebase's invariant is "absent must never
// render as measured" — 0 means "we know it has no parking", null means "we
// have not been told", and collapsing the two would make the (future) break
// conflict lie about capacity it never actually observed.

beforeEach(resetDb);

describe("RestStop model", () => {
  it("a stop created without spaces reads back as null, not 0", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });

    const stop = await prisma.restStop.create({
      data: { orgId: org.id, name: "I-80 Travel Plaza", kind: "truck_stop", lat: 41.0, lng: -95.0 },
    });

    expect(stop.spaces).toBeNull();
    expect(stop.spaces).not.toBe(0);

    const reread = await prisma.restStop.findUniqueOrThrow({ where: { id: stop.id } });
    expect(reread.spaces).toBeNull();
  });

  it("amenities defaults to an empty array, not null", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });

    const stop = await prisma.restStop.create({
      data: { orgId: org.id, name: "Rest Area 12", kind: "rest_area", lat: 41.0, lng: -95.0 },
    });

    expect(stop.amenities).toEqual([]);

    const reread = await prisma.restStop.findUniqueOrThrow({ where: { id: stop.id } });
    expect(reread.amenities).toEqual([]);
  });

  it("a bounding-box query on (orgId, lat, lng) returns only the rows inside it", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });

    const inside = await prisma.restStop.create({
      data: { orgId: org.id, name: "Inside Stop", kind: "truck_stop", lat: 41.0, lng: -95.0 },
    });
    const outsideLat = await prisma.restStop.create({
      data: { orgId: org.id, name: "Outside Lat", kind: "truck_stop", lat: 50.0, lng: -95.0 },
    });
    const outsideLng = await prisma.restStop.create({
      data: { orgId: org.id, name: "Outside Lng", kind: "truck_stop", lat: 41.0, lng: -70.0 },
    });

    const results = await prisma.restStop.findMany({
      where: {
        orgId: org.id,
        lat: { gte: 40.0, lte: 42.0 },
        lng: { gte: -96.0, lte: -94.0 },
      },
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain(inside.id);
    expect(ids).not.toContain(outsideLat.id);
    expect(ids).not.toContain(outsideLng.id);
  });

  it("two orgs' stops never appear in each other's bounding-box results", async () => {
    const orgA = await prisma.org.create({ data: { name: "Alpha" } });
    const orgB = await prisma.org.create({ data: { name: "Beta" } });

    // Same coordinates, different orgs — the only thing distinguishing them
    // is tenancy, so a leak here would be a scoping bug, not a geometry bug.
    const stopA = await prisma.restStop.create({
      data: { orgId: orgA.id, name: "Alpha Stop", kind: "truck_stop", lat: 41.0, lng: -95.0 },
    });
    const stopB = await prisma.restStop.create({
      data: { orgId: orgB.id, name: "Beta Stop", kind: "truck_stop", lat: 41.0, lng: -95.0 },
    });

    const resultsA = await prisma.restStop.findMany({
      where: {
        orgId: orgA.id,
        lat: { gte: 40.0, lte: 42.0 },
        lng: { gte: -96.0, lte: -94.0 },
      },
    });
    const idsA = resultsA.map((r) => r.id);
    expect(idsA).toContain(stopA.id);
    expect(idsA).not.toContain(stopB.id);

    const resultsB = await prisma.restStop.findMany({
      where: {
        orgId: orgB.id,
        lat: { gte: 40.0, lte: 42.0 },
        lng: { gte: -96.0, lte: -94.0 },
      },
    });
    const idsB = resultsB.map((r) => r.id);
    expect(idsB).toContain(stopB.id);
    expect(idsB).not.toContain(stopA.id);
  });
});
