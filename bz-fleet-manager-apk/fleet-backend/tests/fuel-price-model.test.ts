import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";

// T4 Fuel and Stops, Task 2 — the FuelPrice table. This is a model
// round-trip test, not an API test: FuelPrice has no routes yet.
//
// FuelPrice is NOT the costing assumption — RateConfig.dieselCentsPerGal still
// prices every margin and every committed Rate snapshot. This table only
// answers "where should the driver buy", so these tests exercise the model's
// own invariants: the (org, state, date) uniqueness that keeps one observed
// price per day, org isolation, and "no rows" reading back as [] rather than
// throwing.

beforeEach(resetDb);

describe("FuelPrice model", () => {
  it("rejects a duplicate (org, state, effectiveOn)", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const effectiveOn = new Date("2026-09-01T00:00:00.000Z");

    await prisma.fuelPrice.create({
      data: { orgId: org.id, state: "IA", centsPerGal: 385, effectiveOn },
    });

    await expect(
      prisma.fuelPrice.create({
        data: { orgId: org.id, state: "IA", centsPerGal: 399, effectiveOn },
      }),
    ).rejects.toThrow();
  });

  it("two orgs may hold different prices for the same state on the same day", async () => {
    const orgA = await prisma.org.create({ data: { name: "Alpha" } });
    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const effectiveOn = new Date("2026-09-01T00:00:00.000Z");

    const priceA = await prisma.fuelPrice.create({
      data: { orgId: orgA.id, state: "IA", centsPerGal: 385, effectiveOn },
    });
    const priceB = await prisma.fuelPrice.create({
      data: { orgId: orgB.id, state: "IA", centsPerGal: 410, effectiveOn },
    });

    expect(priceA.centsPerGal).toBe(385);
    expect(priceB.centsPerGal).toBe(410);

    const reread = await prisma.fuelPrice.findMany({
      where: { state: "IA", effectiveOn },
    });
    const ids = reread.map((p) => p.id);
    expect(ids).toContain(priceA.id);
    expect(ids).toContain(priceB.id);
  });

  it("a query for a state with no rows returns [] rather than throwing", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });

    const results = await prisma.fuelPrice.findMany({
      where: { orgId: org.id, state: "ZZ" },
    });

    expect(results).toEqual([]);
  });
});
