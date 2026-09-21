import { describe, it, expect } from "vitest";
import { prisma } from "../src/db.js";
import { ensurePlan, planOf } from "../src/lib/plans.js";

describe("plans", () => {
  it("ensurePlan creates once and never changes an existing tier", async () => {
    // `ensurePlan` is not on the Org-insert path any more (the DB trigger
    // owns that); it is for scripts/back-fills that need the same
    // create-if-missing behavior against an org that, for whatever reason,
    // has none right now — so the test removes the trigger-created row
    // first to exercise that "no plan yet" case.
    const org = await prisma.org.create({ data: { name: "Plan Co" } });
    await prisma.plan.delete({ where: { orgId: org.id } });
    await prisma.$transaction((tx) => ensurePlan(tx, org.id, "sheet"));
    await prisma.$transaction((tx) => ensurePlan(tx, org.id, "tower"));
    expect((await planOf(org.id)).tier).toBe("sheet");
  });
  it("planOf throws for an org with no plan — never guesses", async () => {
    // The `org_default_plan` DB trigger gives every new Org a Plan the
    // instant it's inserted, so exercising "no plan" now means removing the
    // row the trigger just created, not skipping some app-level step.
    const org = await prisma.org.create({ data: { name: "bare" } });
    await prisma.plan.delete({ where: { orgId: org.id } });
    await expect(planOf(org.id)).rejects.toThrow(/no plan/);
  });
});
