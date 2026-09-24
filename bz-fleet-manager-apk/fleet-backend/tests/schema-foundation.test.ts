import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";

// AI Dispatch Foundation, Task 1 — schema-only round-trip tests for the new
// driver enrichment / availability / preference / customer / simulation / AI
// audit tables (docs/superpowers/plans/2026-09-24-ai-dispatch-foundation.md).
// No routes or services exist yet; these assert the Prisma layer behaves the
// way the migration and later tasks assume.

beforeEach(resetDb);

describe("AI Dispatch Foundation schema (Task 1)", () => {
  it("creating a Driver leaves availability/preference/simState null — nothing auto-creates them", async () => {
    const driver = await prisma.driver.create({
      data: { email: "d@x.com", passwordHash: "x", name: "Test Driver" },
    });

    const availability = await prisma.driverAvailability.findUnique({ where: { driverId: driver.id } });
    const preference = await prisma.driverPreference.findUnique({ where: { driverId: driver.id } });
    expect(availability).toBeNull();
    expect(preference).toBeNull();

    const reread = await prisma.driver.findUniqueOrThrow({
      where: { id: driver.id },
      include: { availability: true, preference: true, simState: true },
    });
    expect(reread.availability).toBeNull();
    expect(reread.preference).toBeNull();
    expect(reread.simState).toBeNull();
  });

  it("a Customer name is unique per org, but the same name is allowed across orgs", async () => {
    const orgA = await prisma.org.create({ data: { name: "Org A" } });
    const orgB = await prisma.org.create({ data: { name: "Org B" } });

    await prisma.customer.create({ data: { orgId: orgA.id, name: "Acme Foods" } });

    await expect(
      prisma.customer.create({ data: { orgId: orgA.id, name: "Acme Foods" } }),
    ).rejects.toThrow();

    const otherOrgCustomer = await prisma.customer.create({ data: { orgId: orgB.id, name: "Acme Foods" } });
    expect(otherOrgCustomer.name).toBe("Acme Foods");
    expect(otherOrgCustomer.orgId).toBe(orgB.id);
  });

  it("deleting a Customer sets Load.customerId to null rather than blocking or cascading", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: "Acme Foods" } });
    const load = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan", customerName: "Acme Foods", customerId: customer.id },
    });

    await prisma.customer.delete({ where: { id: customer.id } });

    const reread = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(reread.customerId).toBeNull();
  });

  it("AiDecisionRecord cascades with its experiment", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const experiment = await prisma.aiExperiment.create({
      data: { orgId: org.id, name: "Run 1", model: "claude-sonnet-5" },
    });
    const decision = await prisma.aiDecisionRecord.create({
      data: {
        experimentId: experiment.id,
        orgId: org.id,
        kind: "dispatch_candidate",
        context: {},
        toolCalls: [],
        toolResults: [],
      },
    });

    await prisma.aiExperiment.delete({ where: { id: experiment.id } });

    const reread = await prisma.aiDecisionRecord.findUnique({ where: { id: decision.id } });
    expect(reread).toBeNull();
  });
});
