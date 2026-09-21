import request from "supertest";
import type { Express } from "express";
import type { Prisma } from "@prisma/client";
import { app, resetDb } from "./helpers.js";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

// Tenancy must not depend on mount order.
//
// /api/dispatcher used to be gated by repeating
// `requireAuth, requireDispatcher, attachOrgScope` on all 22 feature mounts.
// Express runs a mount's whole middleware chain for every path-matching
// request — including the mounts whose router then falls through — so
// req.orgScope was set by whichever scoped mount came FIRST, not by the
// router that served the request. Every per-mount copy was individually
// redundant (deleting any one of them broke nothing), which is precisely why
// the existing scope suite could not see a reorder: it asserts what a
// dispatcher may read, and a fall-through mount kept supplying orgScope no
// matter where the serving router sat.
//
// So a behavioural cross-tenant assertion alone cannot pin this down. The
// invariant that actually has to hold is structural — "the gate is mounted
// once, and it precedes every router that can serve an /api/dispatcher
// request" — and that is what the first test below asserts, against the real
// router stack of the real createApp(). Insert a feature mount above the
// gate, drop the gate, split it back across the mounts, or widen its path,
// and it fails. The second test pins the same invariant from the outside:
// exactly ONE dispatcher lookup per request (not zero — unscoped — and not
// one per fall-through mount), on a route served by the LAST-mounted
// dispatcher router, i.e. the one a fall-through would have covered for.

// Express 4 keeps its mounted layers on `app._router.stack`. @types/express
// does not expose it and `any` is banned, so this is the minimum shape the
// invariant needs. `handle.stack` is what distinguishes a mounted Router from
// a plain middleware function.
interface StackLayer {
  readonly name: string;
  readonly regexp: RegExp;
  readonly handle: { readonly stack?: readonly unknown[] };
}
interface AppWithStack {
  readonly _router?: { readonly stack: readonly StackLayer[] };
}

const DISPATCHER_PATH = "/api/dispatcher/loadboard";

function stackOf(target: Express): readonly StackLayer[] {
  const stack = (target as unknown as AppWithStack)._router?.stack;
  if (!stack) {
    throw new Error(
      "Express router stack unreachable — this guard must be re-pointed at the installed Express's stack",
    );
  }
  return stack;
}

const isMountedRouter = (l: StackLayer): boolean => Array.isArray(l.handle.stack);
const indexOfName = (stack: readonly StackLayer[], name: string): number =>
  stack.findIndex((l) => l.name === name);
const countOfName = (stack: readonly StackLayer[], name: string): number =>
  stack.filter((l) => l.name === name).length;

describe("the /api/dispatcher tenant gate is structural, not order-dependent", () => {
  it("is mounted exactly once, ahead of every router that can serve an /api/dispatcher request", () => {
    const stack = stackOf(createApp());

    // 1. One gate, not 22 — and not zero. Re-spreading attachOrgScope back
    //    across the feature mounts (the order-dependent shape) fails here.
    expect(countOfName(stack, "attachOrgScope")).toBe(1);
    expect(countOfName(stack, "requireAuth")).toBe(1);
    expect(countOfName(stack, "requireDispatcher")).toBe(1);

    const authAt = indexOfName(stack, "requireAuth");
    const roleAt = indexOfName(stack, "requireDispatcher");
    const scopeAt = indexOfName(stack, "attachOrgScope");

    // 2. Authentication, then role, then tenant — attachOrgScope reads
    //    req.auth.dispatcherId, so it is meaningless ahead of requireAuth.
    expect(authAt).toBeLessThan(roleAt);
    expect(roleAt).toBeLessThan(scopeAt);

    // 3. The gate covers /api/dispatcher and nothing else. Collapsing it onto
    //    a broader prefix would silently 403 the driver app.
    for (const at of [authAt, roleAt, scopeAt]) {
      const layer = stack[at]!;
      expect(isMountedRouter(layer)).toBe(false);
      expect(layer.regexp.test(DISPATCHER_PATH)).toBe(true);
      expect(layer.regexp.test("/api/driver/location")).toBe(false);
      expect(layer.regexp.test("/api/auth/dispatcher/login")).toBe(false);
      expect(layer.regexp.test("/api/webhooks/loads")).toBe(false);
    }

    // 4. THE assertion. Every mounted router that a request to
    //    /api/dispatcher/* can reach must sit after the gate — including the
    //    broad "/api" routers, whose prefix also matches this path. A feature
    //    router mounted above the gate would run with req.orgScope
    //    undefined, i.e. orgWhere() === {}, i.e. every tenant's rows.
    const reachable = stack
      .map((layer, index) => ({ layer, index }))
      .filter(({ layer }) => isMountedRouter(layer) && layer.regexp.test(DISPATCHER_PATH));

    // Guards the filter itself: a typo that matched nothing would make the
    // loop below vacuously true.
    expect(reachable.length).toBeGreaterThanOrEqual(22);
    for (const { index } of reachable) expect(index).toBeGreaterThan(scopeAt);
  });
});

// Counts attachOrgScope's tenant resolution from inside Prisma. A
// $use middleware rather than vi.spyOn(prisma.dispatcher, "findUnique"):
// spying on a Prisma delegate method replaces it with a stub that resolves
// undefined instead of calling through (verified — attachOrgScope then 403s),
// so the spy would have measured a request it had itself broken. The flag
// keeps the middleware inert outside the one request under measurement;
// $use has no deregister, and vitest isolates each test file's module graph,
// so it never reaches another suite.
let counting = false;
let tenantLookups = 0;
prisma.$use(async (params: Prisma.MiddlewareParams, next: (p: Prisma.MiddlewareParams) => Promise<unknown>) => {
  if (counting && params.model === "Dispatcher" && params.action === "findUnique") tenantLookups++;
  return next(params);
});

describe("the gate — not a fall-through mount — is what scopes a request", () => {
  beforeEach(resetDb);

  it("resolves the dispatcher's tenant exactly once, on a route the LAST mount serves", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.org.create({ data: { name: "GateA" } }),
      prisma.org.create({ data: { name: "GateB" } }),
    ]);
    const driverA = await prisma.driver.create({
      data: { email: "gate-a@x.com", passwordHash: "x", name: "GateA Driver", orgId: orgA.id },
    });
    const driverB = await prisma.driver.create({
      data: { email: "gate-b@x.com", passwordHash: "x", name: "GateB Driver", orgId: orgB.id },
    });
    await prisma.conversation.create({ data: { driverId: driverA.id, tripId: null } });
    const convB = await prisma.conversation.create({ data: { driverId: driverB.id, tripId: null } });
    const dispatcher = await prisma.dispatcher.create({
      data: { email: "gate-disp@x.com", passwordHash: "x", name: "Gate", orgId: orgB.id },
    });
    const auth = `Bearer ${signDispatcherAccess(dispatcher.id)}`;

    // GET /conversations is served by dispatcherCommsRouter, the LAST
    // dispatcher mount — under the old shape its req.orgScope came from the
    // FIRST mount, 21 fall-throughs earlier.
    tenantLookups = 0;
    counting = true;
    const res = await request(app).get("/api/dispatcher/conversations").set("authorization", auth);
    counting = false;
    const calls = tenantLookups;

    // Exactly one resolution of the caller's tenant. Zero means the request
    // was served ahead of the gate (unscoped — a cross-tenant read); more
    // than one means the per-mount repetition is back, and with it the
    // order-dependence, because each copy re-resolves on fall-through.
    expect(calls).toBe(1);

    // And it is a real scope, not just a lookup: org A's conversation must
    // not be in the response.
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((c) => c.id);
    expect(ids).toEqual([convB.id]);
    expect(JSON.stringify(res.body)).not.toContain("GateA Driver");
  });
});
