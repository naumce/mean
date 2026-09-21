import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";

// T5 Dwell and Detention, Task 3 — per-stop and per-org detention free time.
// Model round-trip test, not an API test: no routes consume these fields yet.
//
// The assertion that matters most: a stop with an explicit 0 must be
// preserved as 0 and stay distinguishable from null. They mean genuinely
// different things — 0 is "detention starts on arrival, we negotiated no
// free time"; null is "we were never told, use the org default". Collapsing
// them would silently hand a broker free hours the carrier never agreed to.

beforeEach(resetDb);

describe("detentionFreeMin (LoadStop + Org)", () => {
  it("Org.detentionFreeMin defaults to 120", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });

    expect(org.detentionFreeMin).toBe(120);

    const reread = await prisma.org.findUniqueOrThrow({ where: { id: org.id } });
    expect(reread.detentionFreeMin).toBe(120);
  });

  it("a stop created without detentionFreeMin reads back as null, not 0", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const load = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan" },
    });

    const stop = await prisma.loadStop.create({
      data: { loadId: load.id, sequence: 1, address: "123 Main St" },
    });

    expect(stop.detentionFreeMin).toBeNull();
    expect(stop.detentionFreeMin).not.toBe(0);

    const reread = await prisma.loadStop.findUniqueOrThrow({ where: { id: stop.id } });
    expect(reread.detentionFreeMin).toBeNull();
  });

  it("a stop with an explicit 0 is preserved as 0 and is distinguishable from null", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const load = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan" },
    });

    const zeroStop = await prisma.loadStop.create({
      data: { loadId: load.id, sequence: 1, address: "123 Main St", detentionFreeMin: 0 },
    });
    const nullStop = await prisma.loadStop.create({
      data: { loadId: load.id, sequence: 2, address: "456 Oak Ave" },
    });

    expect(zeroStop.detentionFreeMin).toBe(0);
    expect(zeroStop.detentionFreeMin).not.toBeNull();
    expect(zeroStop.detentionFreeMin).not.toBe(nullStop.detentionFreeMin);

    const rereadZero = await prisma.loadStop.findUniqueOrThrow({ where: { id: zeroStop.id } });
    const rereadNull = await prisma.loadStop.findUniqueOrThrow({ where: { id: nullStop.id } });
    expect(rereadZero.detentionFreeMin).toBe(0);
    expect(rereadNull.detentionFreeMin).toBeNull();
    expect(rereadZero.detentionFreeMin).not.toBe(rereadNull.detentionFreeMin);
  });

  it("a stop can override the org default with a non-zero value other than 120", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const load = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan" },
    });

    const stop = await prisma.loadStop.create({
      data: { loadId: load.id, sequence: 1, address: "123 Main St", detentionFreeMin: 60 },
    });

    expect(stop.detentionFreeMin).toBe(60);
    expect(org.detentionFreeMin).toBe(120);

    const reread = await prisma.loadStop.findUniqueOrThrow({ where: { id: stop.id } });
    expect(reread.detentionFreeMin).toBe(60);
  });
});
