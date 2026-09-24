import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { applyLoadChange, InvalidCustomer, type Actor } from "../src/lib/loadWriter.js";
import { resetDb } from "./helpers.js";

// AI Dispatch Foundation, Task 3 — deriveCustomer, the writer's one-door
// derivation that links a Load to a real Customer row. board-cell-write.test.ts
// proves a board "customer" cell becomes a plain `customerName` patch; this
// file proves what the writer then does with that patch (and with a direct
// `customerId`), the same level dispatcherCarriers.ts's resolveCarrier get
// covered at in load-writer.test.ts's own carrier describe block.

const maria: Actor = { dispatcherId: "d-maria", name: "Maria" };

async function setup(over: { customerName?: string | null; customerEmail?: string | null } = {}) {
  const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
  const load = await prisma.load.create({
    data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 400000, ...over },
  });
  return { org, load };
}

const apply = (loadId: string, orgId: string, patch: Parameters<typeof applyLoadChange>[1]["patch"]) =>
  prisma.$transaction((tx) => applyLoadChange(tx, { loadId, orgId, actor: maria, source: "board", patch }));

describe("deriveCustomer — a typed or changed name", () => {
  beforeEach(resetDb);

  it("creates a Customer the first time a name lands on a load with none", async () => {
    const { org, load } = await setup({ customerName: null });
    const r = await apply(load.id, org.id, { customerName: "ACME FOODS" });
    expect(r.changed.sort()).toEqual(["customerId", "customerName"]);
    const customer = await prisma.customer.findFirstOrThrow({ where: { orgId: org.id, name: "ACME FOODS" } });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.customerId).toBe(customer.id);
  });

  it("finds the org's existing Customer by exact trimmed name instead of making a second one", async () => {
    const { org, load } = await setup({ customerName: null });
    const existing = await prisma.customer.create({ data: { orgId: org.id, name: "ACME FOODS" } });
    await apply(load.id, org.id, { customerName: "  ACME FOODS  " });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.customerId).toBe(existing.id);
    expect(await prisma.customer.count({ where: { orgId: org.id } })).toBe(1);
  });

  it("does NOT case-fold: a name differing only by case is a different customer", async () => {
    const { org, load } = await setup({ customerName: null });
    await prisma.customer.create({ data: { orgId: org.id, name: "acme foods" } });
    await apply(load.id, org.id, { customerName: "ACME FOODS" });
    expect(await prisma.customer.count({ where: { orgId: org.id } })).toBe(2);
  });

  it("relinks to a different (found-or-created) customer when the name is edited", async () => {
    const { org, load } = await setup({ customerName: "ACME FOODS" });
    // Retyping the SAME name is a no-op (proven below), so an unrelated
    // field bootstrap-links "ACME FOODS" first (rung 3).
    const first = await apply(load.id, org.id, { revenueCents: 1 });
    const linkedId = (await prisma.load.findUnique({ where: { id: load.id } }))!.customerId;
    expect(first.changed).toContain("customerId");
    const r = await apply(load.id, org.id, { customerName: "GLOBE FREIGHT" });
    expect(r.changed).toContain("customerId");
    const after = await prisma.load.findUnique({ where: { id: load.id } });
    const globe = await prisma.customer.findFirstOrThrow({ where: { orgId: org.id, name: "GLOBE FREIGHT" } });
    expect(after?.customerId).toBe(globe.id);
    expect(after?.customerId).not.toBe(linkedId);
    // The old Customer row is untouched, never deleted.
    expect(await prisma.customer.findUnique({ where: { id: linkedId! } })).not.toBeNull();
  });

  it("retyping the exact value already there is a true no-op — no Customer created, no version bump", async () => {
    const { org, load } = await setup({ customerName: "ACME FOODS" });
    const r = await apply(load.id, org.id, { customerName: "ACME FOODS" });
    expect(r.version).toBe(0);
    expect(r.changed).toEqual([]);
    expect(await prisma.customer.count({ where: { orgId: org.id } })).toBe(0);
  });

  it("emptying the name detaches without ever deleting the Customer row", async () => {
    const { org, load } = await setup({ customerName: "ACME FOODS" });
    await apply(load.id, org.id, { revenueCents: 1 }); // bootstrap-links it first (rung 3)
    const customerId = (await prisma.load.findUnique({ where: { id: load.id } }))!.customerId!;
    const r = await apply(load.id, org.id, { customerName: "" });
    expect(r.changed).toContain("customerId");
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.customerId).toBeNull();
    expect(await prisma.customer.findUnique({ where: { id: customerId } })).not.toBeNull();
  });

  it("two different orgs may each have a customer with the same name", async () => {
    const { org: orgA, load: loadA } = await setup({ customerName: null });
    const { org: orgB, load: loadB } = await setup({ customerName: null });
    await apply(loadA.id, orgA.id, { customerName: "ACME FOODS" });
    await apply(loadB.id, orgB.id, { customerName: "ACME FOODS" });
    const a = await prisma.load.findUnique({ where: { id: loadA.id } });
    const b = await prisma.load.findUnique({ where: { id: loadB.id } });
    expect(a?.customerId).not.toBe(b?.customerId);
    expect(await prisma.customer.count()).toBe(2);
  });

  it("a create with no customerEmail on the patch falls back to the load's own, then to null", async () => {
    const { org, load } = await setup({ customerName: null, customerEmail: "ap@acme.example" });
    await apply(load.id, org.id, { customerName: "ACME FOODS" });
    const customer = await prisma.customer.findFirstOrThrow({ where: { orgId: org.id, name: "ACME FOODS" } });
    expect(customer.primaryEmail).toBe("ap@acme.example");
  });
});

describe("deriveCustomer — bootstrap (rung 3: no customerName in this patch at all)", () => {
  beforeEach(resetDb);

  it("links a load that already carries a name but has never linked one, on a write that never mentions customerName", async () => {
    const { org, load } = await setup({ customerName: "ACME FOODS" });
    const r = await apply(load.id, org.id, { revenueCents: 500000 });
    expect(r.changed.sort()).toEqual(["customerId", "revenueCents"]);
    const customer = await prisma.customer.findFirstOrThrow({ where: { orgId: org.id, name: "ACME FOODS" } });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.customerId).toBe(customer.id);
  });

  // Rung 1 and rung 2 each have a direct trace-content assertion of their own
  // (load-writer.test.ts:24-38 and the direct-customerId tests below); this
  // is that same trace-content proof for the bootstrap rung, which otherwise
  // only ever had `r.changed`/`Load.customerId` checked.
  it("traces the bootstrap link as its own LoadChange row: field customerId, before null, after the created customer's id", async () => {
    const { org, load } = await setup({ customerName: "ACME FOODS" });
    await apply(load.id, org.id, { revenueCents: 500000 });
    const customer = await prisma.customer.findFirstOrThrow({ where: { orgId: org.id, name: "ACME FOODS" } });
    const trace = await prisma.loadChange.findMany({ where: { loadId: load.id, field: "customerId" } });
    expect(trace.map((t) => [t.field, t.before, t.after, t.actorName, t.source])).toEqual([
      ["customerId", null, customer.id, maria.name, "board"],
    ]);
  });

  it("does nothing when the load has no customerName to bootstrap", async () => {
    const { org, load } = await setup({ customerName: null });
    const r = await apply(load.id, org.id, { revenueCents: 500000 });
    expect(r.changed).toEqual(["revenueCents"]);
    expect(await prisma.customer.count({ where: { orgId: org.id } })).toBe(0);
  });

  it("does nothing on a second unrelated write once already linked", async () => {
    const { org, load } = await setup({ customerName: "ACME FOODS" });
    await apply(load.id, org.id, { revenueCents: 500000 }); // bootstraps
    const r = await apply(load.id, org.id, { revenueCents: 600000 });
    expect(r.changed).toEqual(["revenueCents"]);
  });
});

describe("deriveCustomer — a direct customerId (a picker, not free text)", () => {
  beforeEach(resetDb);

  it("links the named customer and syncs customerName to its own name", async () => {
    const { org, load } = await setup({ customerName: null });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: "ACME FOODS" } });
    const r = await apply(load.id, org.id, { customerId: customer.id });
    expect(r.changed.sort()).toEqual(["customerId", "customerName"]);
    const after = await prisma.load.findUnique({ where: { id: load.id } });
    expect(after?.customerId).toBe(customer.id);
    expect(after?.customerName).toBe("ACME FOODS");
  });

  it("rejects a customerId belonging to another org, writing nothing", async () => {
    const { org, load } = await setup({ customerName: "OLD NAME" });
    const otherOrg = await prisma.org.create({ data: { name: "Other" } });
    const foreign = await prisma.customer.create({ data: { orgId: otherOrg.id, name: "FOREIGN CO" } });
    await expect(apply(load.id, org.id, { customerId: foreign.id })).rejects.toBeInstanceOf(InvalidCustomer);
    const after = await prisma.load.findUnique({ where: { id: load.id } });
    expect(after?.customerId).toBeNull();
    expect(after?.customerName).toBe("OLD NAME");
    expect(after?.version).toBe(0);
  });

  it("rejects a customerId that does not exist at all", async () => {
    const { org, load } = await setup();
    await expect(apply(load.id, org.id, { customerId: "does-not-exist" })).rejects.toBeInstanceOf(InvalidCustomer);
  });

  it("a direct null detaches without touching customerName", async () => {
    const { org, load } = await setup({ customerName: "ACME FOODS" });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: "ACME FOODS" } });
    await prisma.load.update({ where: { id: load.id }, data: { customerId: customer.id } });
    const r = await apply(load.id, org.id, { customerId: null });
    expect(r.changed).toEqual(["customerId"]);
    const after = await prisma.load.findUnique({ where: { id: load.id } });
    expect(after?.customerId).toBeNull();
    expect(after?.customerName).toBe("ACME FOODS");
  });
});
