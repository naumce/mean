import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";

// Spec §5: a version on every load, a trace of who changed what, and the
// org's own words for UPDATE → status.
describe("one honest record — schema", () => {
  beforeEach(resetDb);

  it("gives every load a version that starts at 0 and only goes up", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
    const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0 } });
    expect(load.version).toBe(0);
    const bumped = await prisma.load.update({ where: { id: load.id }, data: { version: { increment: 1 } } });
    expect(bumped.version).toBe(1);
  });

  it("keeps a trace row per changed field, and drops it with the load", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
    const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0 } });
    await prisma.loadChange.create({
      data: { loadId: load.id, orgId: org.id, atMs: BigInt(1_760_000_000_000), actorId: null, actorName: "import", source: "import", field: "status", before: "open", after: "delivered", note: "DELIVERED 07/17/2026" },
    });
    expect(await prisma.loadChange.count({ where: { loadId: load.id } })).toBe(1);
    await prisma.load.delete({ where: { id: load.id } });
    expect(await prisma.loadChange.count()).toBe(0);
  });

  it("stores one rule per prefix per org, and lets another org use the same word", async () => {
    const a = await prisma.org.create({ data: { name: "A", timezone: "UTC" } });
    const b = await prisma.org.create({ data: { name: "B", timezone: "UTC" } });
    await prisma.updateRule.create({ data: { orgId: a.id, prefix: "DELIVERED", status: "delivered" } });
    await expect(prisma.updateRule.create({ data: { orgId: a.id, prefix: "DELIVERED", status: "canceled" } })).rejects.toThrow();
    const theirs = await prisma.updateRule.create({ data: { orgId: b.id, prefix: "DELIVERED", status: "delivered" } });
    expect(theirs.enabled).toBe(true);
  });
});
