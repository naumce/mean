import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { STANDARD_POLICY, agentPolicySchema, policyFor } from "../src/lib/agentPolicies.js";
beforeEach(resetDb);

const signup = (over: Record<string, unknown> = {}) =>
  request(app).post("/api/auth/dispatcher/signup").send({
    orgName: "Acme Freight", name: "Dana Ops", email: "dana@acme.com", password: "hunter2secret", ...over,
  });

it("every org gets a Standard policy with the live-run thresholds", async () => {
  const res = await signup();
  expect(res.status).toBe(201);
  const policy = await prisma.agentPolicy.findUnique({
    where: { orgId_name: { orgId: res.body.org.id, name: "Standard" } },
  });
  expect(policy).not.toBeNull();
  expect(policy?.stopMin).toBe(15);
  expect(policy?.shadow).toBe(true);
  expect(policy?.dispatcherEmail).toBe("dana@acme.com");
});

it("policyFor prefers the load's own policy and falls back to Standard", () => {
  const std = { id: "std-1", name: "Standard", stopMin: 15 };
  const own = { id: "own-1", name: "Aggressive", stopMin: 5 };
  const policies = [std, own];

  expect(policyFor({ agentPolicyId: own.id }, policies)).toBe(own);
  expect(policyFor({ agentPolicyId: null }, policies)).toBe(std);
  // Unknown id (e.g. a policy deleted out from under a load) falls back too.
  expect(policyFor({ agentPolicyId: "missing" }, policies)).toBe(std);
});

it("policyFor throws when an org has no Standard — never silently guesses", () => {
  const own = { id: "own-1", name: "Aggressive", stopMin: 5 };
  expect(() => policyFor({ agentPolicyId: null }, [own])).toThrow(/Standard/);
  expect(() => policyFor({ agentPolicyId: "missing" }, [own])).toThrow(/Standard/);
  expect(() => policyFor({ agentPolicyId: null }, [])).toThrow(/Standard/);
});

it("the schema refuses a phone that is not E.164 and a quiet time that is not HH:MM", () => {
  const base = {
    ...STANDARD_POLICY,
    dispatcherEmail: "d@fleet.com", dispatcherPhone: null as string | null,
  };
  expect(agentPolicySchema.safeParse(base).success).toBe(true);

  const badPhone = { ...base, dispatcherPhone: "555-1234" };
  expect(agentPolicySchema.safeParse(badPhone).success).toBe(false);

  const goodPhone = { ...base, dispatcherPhone: "+15551234567" };
  expect(agentPolicySchema.safeParse(goodPhone).success).toBe(true);

  const badQuiet = { ...base, quietFrom: "10pm" };
  expect(agentPolicySchema.safeParse(badQuiet).success).toBe(false);

  const goodQuiet = { ...base, quietFrom: "22:00", quietTo: "06:00" };
  expect(agentPolicySchema.safeParse(goodQuiet).success).toBe(true);
});
