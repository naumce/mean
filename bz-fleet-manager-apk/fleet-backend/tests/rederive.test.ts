import { beforeEach, describe, expect, it, vi } from "vitest";
import { rederiveOrg } from "../src/cli/rederive.js";
import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";

// Spec §11.2: derive the truth from what is already stored, once per org.
// This is how the org's real board — 26 loads all "open", three of them
// saying DELIVERED — becomes honest.
describe("rederiveOrg", () => {
  beforeEach(resetDb);

  it("moves status from stored UPDATE text and places stored cities, and is idempotent", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    const delivered = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "MEIBORG", carrierId: carrier.id, updateText: "DELIVERED 07/16/2026",
        stops: { create: [{ sequence: 1, type: "pickup", address: "Kansas City, MO 64120", geocodeStatus: "pending" }, { sequence: 2, type: "delivery", address: "Nowhere, ZZ", geocodeStatus: "pending" }] } },
    });
    const pending = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "MEIBORG", carrierId: carrier.id, updateText: "PENDING RATE CONFIRMATION" } });
    const lines: string[] = [];
    const first = await rederiveOrg(org.id, (l) => lines.push(l));
    expect(first).toEqual({ loads: 2, statusChanged: 1, placed: 1, failed: 0 });
    expect((await prisma.load.findUnique({ where: { id: delivered.id } }))?.status).toBe("delivered");
    expect((await prisma.load.findUnique({ where: { id: pending.id } }))?.status).toBe("open");
    const pu = await prisma.loadStop.findFirst({ where: { loadId: delivered.id, type: "pickup" } });
    expect(pu?.lat).not.toBeNull();
    expect(lines.some((l) => l.includes(delivered.id) && l.includes("delivered"))).toBe(true);
    const second = await rederiveOrg(org.id, () => {});
    expect(second).toEqual({ loads: 2, statusChanged: 0, placed: 0, failed: 0 });
  });

  it("counts a load whose write fails and keeps processing the rest", async () => {
    const org = await prisma.org.create({ data: { name: "Broker2", timezone: "America/Chicago" } });
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    const a = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "MEIBORG", carrierId: carrier.id, updateText: "DELIVERED 07/16/2026" } });
    const b = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "MEIBORG", carrierId: carrier.id, updateText: "DELIVERED 07/16/2026" } });
    // Staging a real mid-run failure by racing a `prisma.load.delete` against
    // the loop from inside a `say` callback is not deterministic: `say` is
    // typed `(line: string) => void` and rederiveOrg never awaits it, so a
    // fire-and-forget delete has no guaranteed ordering against the next
    // iteration's own DB round trip. Instead: rederiveOrg calls
    // `prisma.$transaction` exactly once per load, in `loads` order, so
    // stubbing that call itself is deterministic by call count — first call
    // passes through to the real transaction, second call rejects the way a
    // thrown LoadNotFound (or any other writer failure) would.
    const real = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction")
      .mockImplementationOnce(((...args: unknown[]) => (real as (...a: unknown[]) => unknown)(...args)) as unknown as typeof prisma.$transaction)
      .mockImplementationOnce((() => Promise.reject(new Error("simulated write failure"))) as unknown as typeof prisma.$transaction);

    const lines: string[] = [];
    const result = await rederiveOrg(org.id, (l) => lines.push(l));
    spy.mockRestore();

    expect(result.loads).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.statusChanged).toBe(1);
    expect(lines.some((l) => l.includes("failed") && (l.includes(a.id) || l.includes(b.id)))).toBe(true);
    const statuses = await prisma.load.findMany({ where: { id: { in: [a.id, b.id] } }, select: { status: true } });
    expect(statuses.filter((s) => s.status === "delivered").length).toBe(1);
    expect(statuses.filter((s) => s.status === "open").length).toBe(1);
  });
});
