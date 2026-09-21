# Cockpit S2a — Interaction API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server side of every cockpit gesture — pessimistic lane locks, replanning (`PATCH /plan`), and tenders — so the board can move a leg without the client ever deciding whether the move is legal.

**Architecture:** Three additions to the existing dispatcher API, all org-scoped and mounted on the existing `dispatcherRouter`. Locks live in process memory (a `Map<orgId, Map<laneId, Lock>>`) with a 90 s TTL and a 15 s sweeper — deliberately not in Postgres, because a lock that outlives a crashed browser is worse than one that expires. `PATCH /assignments/:id/plan` is *unassign + assign inside one Serializable transaction*: restore the old HOS snapshot, re-run `evaluate()` with the new inputs, re-snapshot. Tenders are the existing commit path with `status='tendered'` and HOS still decremented, because a tendered truck's capacity is genuinely held.

**Tech Stack:** Node 22, TypeScript ESM (`.js` import specifiers), Express 4, Prisma 5 + PostgreSQL, Zod, Vitest + Supertest.

**Spec:** `docs/superpowers/specs/2026-08-28-cockpit-control-tower-design.md` — §6.2 (locks), §6.3 (`/plan`), §6.4 (tenders), §6.10 (realtime), §8 (interaction flows). The spec is the binding authority; this plan argues from it.

## Global Constraints

- **NO GIT COMMITS.** Standing user rule for this repo. Plan steps say "commit" nowhere; the task report and the SDD ledger are the record. Leave work in the working tree.
- **ESM:** every relative import ends in `.js` (e.g. `import { prisma } from "../db.js"`). A missing extension fails at runtime, not at `tsc`.
- **Never trust the client's feasibility.** Every mutation re-runs `evaluate()` server-side. The client's dry-run verdict is advisory only.
- **Org scoping:** every route uses the existing `outsideOrg(req, row.orgId)` guard. A cross-org id returns 404, never 403 (do not leak existence).
- **Zod at the boundary:** `validateBody(schema)` on every body-carrying route.
- **Serializable transactions** for anything that writes an Assignment, with `P2034`/`P2002` mapped to 409, matching `dispatcherAssignments.ts:280-290`.
- **Real data only:** absent must never be reported as measured. A missing HOS import stays a `warn` conflict; it never becomes a silent pass.
- **Tests:** Vitest + Supertest against the shared Postgres, `resetDb()` per test. **The full-suite run SIGSEGVs before the reporter flushes (pre-existing).** Verify in batches: `npx vitest run tests/a.test.ts tests/b.test.ts`.
- **Reseed after testing.** The test DB *is* the dev DB. After a test run: `node seed-control-tower.mjs && node seed-demo.mjs`.
- Backend gate per task: the touched test files pass, plus `npx tsc --noEmit` clean.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/activeStatuses.ts` | **new** — the single `ACTIVE_STATUSES` definition, now including `tendered` |
| `src/lib/locks.ts` | **new** — pure lock table: acquire / release / get / sweep. No Express, no Prisma |
| `src/routes/dispatcherLocks.ts` | **new** — `GET/POST/DELETE /locks`, emits `lane_lock` / `lane_unlock` |
| `src/lib/laneId.ts` | **new** — resolves a mutation's target to its lane id (driver id) |
| `src/routes/dispatcherAssignments.ts` | modify — lock guard, `tender` flag, `PATCH /:id/plan`, tender accept/decline |
| `src/routes/dispatcherDrivers.ts` | modify — `PATCH /drivers/:id/pairing` (the yard hook's write side) |
| `src/routes/driver.ts` | modify — driver-side tender accept/decline |
| `src/lib/rankDrivers.ts` | modify — import the shared `ACTIVE_STATUSES` |
| `prisma/schema.prisma` + migration | modify — `Assignment.tenderedAt DateTime?` |

Ten tasks. Tasks 1–2 are pure and fast; Task 8 (`/plan`) is the one that needs care.

---

### Task 1: Shared active-statuses constant

**Why first:** `ACTIVE_STATUSES` is currently defined twice (`routes/dispatcherAssignments.ts:28`, `lib/rankDrivers.ts:13`). Tenders must count as active everywhere — a tendered truck is not free — and two copies guarantee they drift. This is the same single-definition discipline the S1 review forced on `isExpired`.

**Files:**
- Create: `src/lib/activeStatuses.ts`
- Modify: `src/routes/dispatcherAssignments.ts:28`, `src/lib/rankDrivers.ts:13`
- Test: `tests/active-statuses.test.ts`

**Interfaces:**
- Produces: `export const ACTIVE_STATUSES: readonly string[]` — used by every busy/overlap query in this plan.

- [ ] **Step 1: Write the failing test**

```ts
// tests/active-statuses.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ACTIVE_STATUSES } from "../src/lib/activeStatuses.js";

describe("ACTIVE_STATUSES", () => {
  it("counts a tendered assignment as occupying the truck", () => {
    // A tender holds capacity — the driver cannot be double-booked while the
    // offer is outstanding.
    expect(ACTIVE_STATUSES).toContain("tendered");
    expect(ACTIVE_STATUSES).toContain("assigned");
    expect(ACTIVE_STATUSES).toContain("in_progress");
  });

  it("excludes finished work so completing a leg frees the driver", () => {
    expect(ACTIVE_STATUSES).not.toContain("completed");
    expect(ACTIVE_STATUSES).not.toContain("delivered");
    expect(ACTIVE_STATUSES).not.toContain("canceled");
  });

  it("is defined exactly once in the codebase", () => {
    // Guards the defect this task exists to fix. A second literal definition
    // must fail this test, not wait for a reviewer to notice.
    for (const f of ["src/routes/dispatcherAssignments.ts", "src/lib/rankDrivers.ts"]) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      expect(src).not.toMatch(/const ACTIVE_STATUSES\s*=/);
      expect(src).toMatch(/from "\.\.\/lib\/activeStatuses\.js"|from "\.\/activeStatuses\.js"/);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/active-statuses.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/activeStatuses.js'`.

- [ ] **Step 3: Implement**

```ts
// src/lib/activeStatuses.ts
/** The statuses in which an assignment still occupies its driver and equipment.
 *  `tendered` counts: an outstanding offer holds capacity, so the truck must
 *  not be double-booked while the driver decides. Defined once — every busy,
 *  overlap and yard query imports this, so they can never disagree about
 *  whether a truck is free. */
export const ACTIVE_STATUSES: readonly string[] = ["assigned", "tendered", "in_progress"];
```

Then in both consumers delete the local `const ACTIVE_STATUSES = [...]` and add:

```ts
import { ACTIVE_STATUSES } from "../lib/activeStatuses.js"; // dispatcherAssignments.ts
import { ACTIVE_STATUSES } from "./activeStatuses.js";      // rankDrivers.ts
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/active-statuses.test.ts tests/dispatcher-assignments.test.ts tests/dispatcher-suggest.test.ts && npx tsc --noEmit`
Expected: PASS. If an existing assignment test now fails, that test was asserting a tendered truck is free — read it before changing it and report the finding.

---

### Task 2: The lock table

**Files:**
- Create: `src/lib/locks.ts`
- Test: `tests/locks-lib.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Lock { laneId: string; dispatcherId: string; name: string; since: number; expiresAt: number }
  export const LOCK_TTL_MS: number            // 90_000
  export function acquire(orgId: string, laneId: string, dispatcherId: string, name: string, nowMs?: number): { ok: true; lock: Lock } | { ok: false; lock: Lock }
  export function release(orgId: string, laneId: string, dispatcherId: string, nowMs?: number): boolean
  export function get(orgId: string, laneId: string, nowMs?: number): Lock | null
  export function snapshot(orgId: string, nowMs?: number): Lock[]
  export function releaseAllFor(orgId: string, dispatcherId: string): string[]
  export function sweep(nowMs?: number): void
  export function __resetLocks(): void          // test-only
  ```
- Every function takes `nowMs` so time is injected, never read from the clock inside a test.

- [ ] **Step 1: Write the failing test**

```ts
// tests/locks-lib.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { __resetLocks, acquire, get, LOCK_TTL_MS, release, releaseAllFor, snapshot, sweep } from "../src/lib/locks.js";

const T0 = 1_800_000_000_000;

describe("lock table", () => {
  beforeEach(() => __resetLocks());

  it("grants a free lane", () => {
    const r = acquire("org1", "drv1", "disp1", "Ann", T0);
    expect(r.ok).toBe(true);
    expect(r.lock).toMatchObject({ laneId: "drv1", dispatcherId: "disp1", name: "Ann", since: T0, expiresAt: T0 + LOCK_TTL_MS });
  });

  it("refuses a lane another dispatcher holds, returning who holds it", () => {
    acquire("org1", "drv1", "disp1", "Ann", T0);
    const r = acquire("org1", "drv1", "disp2", "Bo", T0 + 1_000);
    expect(r.ok).toBe(false);
    expect(r.lock.dispatcherId).toBe("disp1");
    expect(r.lock.name).toBe("Ann"); // the 409 body must name the holder
  });

  it("re-acquiring your own lane refreshes the expiry — this is the heartbeat", () => {
    acquire("org1", "drv1", "disp1", "Ann", T0);
    const r = acquire("org1", "drv1", "disp1", "Ann", T0 + 30_000);
    expect(r.ok).toBe(true);
    expect(r.lock.since).toBe(T0);                        // held continuously
    expect(r.lock.expiresAt).toBe(T0 + 30_000 + LOCK_TTL_MS); // but extended
  });

  it("grants a lane whose lock has expired", () => {
    acquire("org1", "drv1", "disp1", "Ann", T0);
    const r = acquire("org1", "drv1", "disp2", "Bo", T0 + LOCK_TTL_MS + 1);
    expect(r.ok).toBe(true);
    expect(r.lock.dispatcherId).toBe("disp2");
  });

  it("treats the exact expiry instant as still held", () => {
    // Boundary discipline: at expiresAt the lock has not yet expired, matching
    // the `isExpired` convention S1 settled on.
    acquire("org1", "drv1", "disp1", "Ann", T0);
    expect(acquire("org1", "drv1", "disp2", "Bo", T0 + LOCK_TTL_MS).ok).toBe(false);
  });

  it("isolates orgs — same lane id, different tenants", () => {
    acquire("org1", "drv1", "disp1", "Ann", T0);
    expect(acquire("org2", "drv1", "disp9", "Cy", T0).ok).toBe(true);
    expect(snapshot("org2", T0)).toHaveLength(1);
  });

  it("releases only for the holder", () => {
    acquire("org1", "drv1", "disp1", "Ann", T0);
    expect(release("org1", "drv1", "disp2", T0)).toBe(false);
    expect(get("org1", "drv1", T0)?.dispatcherId).toBe("disp1");
    expect(release("org1", "drv1", "disp1", T0)).toBe(true);
    expect(get("org1", "drv1", T0)).toBeNull();
  });

  it("get() reports an expired lock as absent without waiting for the sweeper", () => {
    acquire("org1", "drv1", "disp1", "Ann", T0);
    expect(get("org1", "drv1", T0 + LOCK_TTL_MS + 1)).toBeNull();
  });

  it("snapshot() omits expired locks", () => {
    acquire("org1", "a", "disp1", "Ann", T0);
    acquire("org1", "b", "disp1", "Ann", T0 + 60_000);
    expect(snapshot("org1", T0 + LOCK_TTL_MS + 1).map((l) => l.laneId)).toEqual(["b"]);
  });

  it("releaseAllFor() drops a disconnected dispatcher's lanes and names them", () => {
    acquire("org1", "a", "disp1", "Ann", T0);
    acquire("org1", "b", "disp1", "Ann", T0);
    acquire("org1", "c", "disp2", "Bo", T0);
    expect(releaseAllFor("org1", "disp1").sort()).toEqual(["a", "b"]);
    expect(snapshot("org1", T0).map((l) => l.laneId)).toEqual(["c"]);
  });

  it("sweep() reclaims memory for expired locks", () => {
    acquire("org1", "a", "disp1", "Ann", T0);
    sweep(T0 + LOCK_TTL_MS + 1);
    expect(snapshot("org1", T0 + LOCK_TTL_MS + 1)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/locks-lib.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/locks.ts
// Pessimistic lane locks. Deliberately in process memory, not Postgres: a lock
// is a courtesy between dispatchers looking at the same board, and one that
// outlives a crashed browser is worse than one that expires. The TTL is the
// guarantee; explicit release and socket-disconnect cleanup are optimisations.
//
// Single-process assumption: this is correct for the current single-instance
// deployment. Behind a load balancer the table must move to Redis — see
// "Known limitations" in the S2a report.

export interface Lock {
  laneId: string;
  dispatcherId: string;
  name: string;
  since: number;
  expiresAt: number;
}

export const LOCK_TTL_MS = 90_000;

const table = new Map<string, Map<string, Lock>>();

function laneMap(orgId: string): Map<string, Lock> {
  let m = table.get(orgId);
  if (!m) {
    m = new Map();
    table.set(orgId, m);
  }
  return m;
}

/** A lock is live until strictly past its expiry: at exactly `expiresAt` it is
 *  still held, matching the boundary convention used for compliance clocks. */
function live(l: Lock, nowMs: number): boolean {
  return nowMs <= l.expiresAt;
}

export function get(orgId: string, laneId: string, nowMs = Date.now()): Lock | null {
  const l = table.get(orgId)?.get(laneId);
  return l && live(l, nowMs) ? l : null;
}

export function acquire(
  orgId: string,
  laneId: string,
  dispatcherId: string,
  name: string,
  nowMs = Date.now(),
): { ok: true; lock: Lock } | { ok: false; lock: Lock } {
  const held = get(orgId, laneId, nowMs);
  if (held && held.dispatcherId !== dispatcherId) return { ok: false, lock: held };
  // Own lock: keep `since` (the lane has been held continuously) and extend the
  // expiry. This is exactly the client's 30 s heartbeat.
  const lock: Lock = {
    laneId,
    dispatcherId,
    name,
    since: held?.since ?? nowMs,
    expiresAt: nowMs + LOCK_TTL_MS,
  };
  laneMap(orgId).set(laneId, lock);
  return { ok: true, lock };
}

export function release(orgId: string, laneId: string, dispatcherId: string, nowMs = Date.now()): boolean {
  const held = get(orgId, laneId, nowMs);
  if (!held) {
    table.get(orgId)?.delete(laneId); // clear an expired remnant
    return true;
  }
  if (held.dispatcherId !== dispatcherId) return false;
  table.get(orgId)!.delete(laneId);
  return true;
}

export function snapshot(orgId: string, nowMs = Date.now()): Lock[] {
  return [...(table.get(orgId)?.values() ?? [])].filter((l) => live(l, nowMs));
}

/** Best-effort cleanup when a dispatcher's socket drops. Returns the lanes
 *  freed so the caller can emit `lane_unlock` for each. */
export function releaseAllFor(orgId: string, dispatcherId: string): string[] {
  const m = table.get(orgId);
  if (!m) return [];
  const freed: string[] = [];
  for (const [laneId, l] of m) {
    if (l.dispatcherId === dispatcherId) {
      m.delete(laneId);
      freed.push(laneId);
    }
  }
  return freed;
}

export function sweep(nowMs = Date.now()): void {
  for (const [orgId, m] of table) {
    for (const [laneId, l] of m) if (!live(l, nowMs)) m.delete(laneId);
    if (m.size === 0) table.delete(orgId);
  }
}

/** Test-only: the table is module state, so suites must be able to reset it.
 *  Authorised the same way `__resetThemeMedia` was in S0. */
export function __resetLocks(): void {
  table.clear();
}
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/locks-lib.test.ts && npx tsc --noEmit`
Expected: 11 passing.

---

### Task 3: Lock routes

**Files:**
- Create: `src/routes/dispatcherLocks.ts`
- Modify: `src/app.ts` (mount)
- Test: `tests/dispatcher-locks.test.ts`

**Interfaces:**
- Consumes: `lib/locks.ts` (Task 2).
- Produces: `POST /api/dispatcher/locks {laneId}` → `200 {lock}` | `409 {error:"ENTITY_ALREADY_LOCKED", lock}`; `DELETE /api/dispatcher/locks/:laneId` → 204; `GET /api/dispatcher/locks` → `{locks: Lock[]}`.
- The dispatcher's id and name come from `req.user` — check the exact shape at task time in `src/middleware/auth.ts`; the codebase's other dispatcher routes read it the same way.

- [ ] **Step 1: Write the failing test**

```ts
// tests/dispatcher-locks.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, createDispatcher, loginDispatcher, resetDb } from "./helpers.js";
import { __resetLocks } from "../src/lib/locks.js";

describe("lane locks", () => {
  beforeEach(async () => {
    await resetDb();
    __resetLocks();
  });

  it("grants, reports, and releases a lane", async () => {
    await createDispatcher({ email: "a@f.com" });
    const { token } = await loginDispatcher("a@f.com", "pass123");
    const auth = { Authorization: `Bearer ${token}` };

    const got = await request(app).post("/api/dispatcher/locks").set(auth).send({ laneId: "drv1" });
    expect(got.status).toBe(200);
    expect(got.body.lock).toMatchObject({ laneId: "drv1" });

    const list = await request(app).get("/api/dispatcher/locks").set(auth);
    expect(list.body.locks).toHaveLength(1);

    expect((await request(app).delete("/api/dispatcher/locks/drv1").set(auth)).status).toBe(204);
    expect((await request(app).get("/api/dispatcher/locks").set(auth)).body.locks).toHaveLength(0);
  });

  it("refuses a lane held by another dispatcher with 409 ENTITY_ALREADY_LOCKED and names the holder", async () => {
    await createDispatcher({ email: "a@f.com", name: "Ann" });
    await createDispatcher({ email: "b@f.com", name: "Bo" });
    const a = await loginDispatcher("a@f.com", "pass123");
    const b = await loginDispatcher("b@f.com", "pass123");

    await request(app).post("/api/dispatcher/locks").set({ Authorization: `Bearer ${a.token}` }).send({ laneId: "drv1" });
    const res = await request(app).post("/api/dispatcher/locks").set({ Authorization: `Bearer ${b.token}` }).send({ laneId: "drv1" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ENTITY_ALREADY_LOCKED");
    expect(res.body.lock.name).toBe("Ann"); // the toast must be able to say who
  });

  it("re-POSTing your own lane is a heartbeat, not a conflict", async () => {
    await createDispatcher({ email: "a@f.com" });
    const { token } = await loginDispatcher("a@f.com", "pass123");
    const auth = { Authorization: `Bearer ${token}` };
    await request(app).post("/api/dispatcher/locks").set(auth).send({ laneId: "drv1" });
    expect((await request(app).post("/api/dispatcher/locks").set(auth).send({ laneId: "drv1" })).status).toBe(200);
  });

  it("does not release another dispatcher's lane", async () => {
    await createDispatcher({ email: "a@f.com" });
    await createDispatcher({ email: "b@f.com" });
    const a = await loginDispatcher("a@f.com", "pass123");
    const b = await loginDispatcher("b@f.com", "pass123");
    await request(app).post("/api/dispatcher/locks").set({ Authorization: `Bearer ${a.token}` }).send({ laneId: "drv1" });
    expect((await request(app).delete("/api/dispatcher/locks/drv1").set({ Authorization: `Bearer ${b.token}` })).status).toBe(409);
  });

  it("does not show one org's locks to another", async () => {
    // Uses two dispatchers in different orgs — build the second org the way
    // tests/dispatcher-org-scope.test.ts does.
    // Assert: GET /locks for org B returns [] while org A holds a lane.
  });

  it("rejects an unauthenticated caller", async () => {
    expect((await request(app).post("/api/dispatcher/locks").send({ laneId: "x" })).status).toBe(401);
  });
});
```

> The org-isolation case is left as prose deliberately: copy the two-org fixture from `tests/dispatcher-org-scope.test.ts` verbatim rather than inventing a second one. Fill it in — do not delete it.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/dispatcher-locks.test.ts` → FAIL (404s; route not mounted).

- [ ] **Step 3: Implement**

```ts
// src/routes/dispatcherLocks.ts
import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate.js";
import { emitToDispatchers } from "../realtime.js";
import { acquire, release, snapshot, sweep } from "../lib/locks.js";

// Pessimistic lane locks (§6.2). A lane is a driver id; the client holds one
// while its drawer is open and heartbeats every 30 s against a 90 s TTL.
export const dispatcherLocksRouter = Router();

const lockSchema = z.object({ laneId: z.string().min(1) });

// Reclaim expired locks periodically so memory does not grow with abandoned
// lanes. unref() so this timer never holds the process open in tests.
const sweeper = setInterval(() => sweep(), 15_000);
sweeper.unref?.();

dispatcherLocksRouter.get("/locks", (req, res) => {
  res.json({ locks: snapshot(req.orgId!) });
});

dispatcherLocksRouter.post("/locks", validateBody(lockSchema), (req, res) => {
  const { laneId } = req.body as z.infer<typeof lockSchema>;
  const me = req.dispatcher!; // shape per middleware/auth.ts — verify at task time
  const r = acquire(req.orgId!, laneId, me.id, me.name ?? "Dispatcher");
  if (!r.ok) return res.status(409).json({ error: "ENTITY_ALREADY_LOCKED", lock: r.lock });
  // Only announce a genuinely new hold; a heartbeat must not spam every board.
  if (r.lock.since === r.lock.expiresAt - 90_000)
    emitToDispatchers(req.orgId!, "lane_lock", { laneId, by: r.lock.name, dispatcherId: me.id, since: r.lock.since });
  res.json({ lock: r.lock });
});

dispatcherLocksRouter.delete("/locks/:laneId", (req, res) => {
  const ok = release(req.orgId!, req.params.laneId, req.dispatcher!.id);
  if (!ok) return res.status(409).json({ error: "ENTITY_ALREADY_LOCKED" });
  emitToDispatchers(req.orgId!, "lane_unlock", { laneId: req.params.laneId });
  res.status(204).end();
});
```

Mount it in `src/app.ts` beside the others:

```ts
import { dispatcherLocksRouter } from "./routes/dispatcherLocks.js";
app.use("/api/dispatcher", requireAuth, requireDispatcher, attachOrgScope, dispatcherLocksRouter);
```

> **Ruling to make at task time, and record:** the "only announce a new hold" check above compares `since` to `expiresAt - TTL`, which is fragile. If `acquire()` is cleaner returning `{ ok, lock, fresh: boolean }`, change the Task 2 signature and update its test — a clearer interface beats a clever comparison. Note the deviation in the report.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/dispatcher-locks.test.ts tests/locks-lib.test.ts && npx tsc --noEmit`

---

### Task 4: Lane resolution and the mutation guard

**Files:**
- Create: `src/lib/laneId.ts`
- Modify: `src/routes/dispatcherAssignments.ts` (guard `POST /assignments`, `POST /assignments/:id/status`, `DELETE /assignments/:id`)
- Test: `tests/lock-guard.test.ts`

**Interfaces:**
- Produces: `export function assertNotLockedByOther(orgId: string, laneId: string, dispatcherId: string): void` — throws `LockedError` carrying the holding `Lock`.
- Route layer catches `LockedError` → `409 {error:"ENTITY_ALREADY_LOCKED", lock}`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lock-guard.test.ts
// Ann holds the lane; Bo's commit onto that same driver must be refused with
// 409 ENTITY_ALREADY_LOCKED and must NOT write an assignment.
//
// Build the fixture the way tests/dispatcher-assignments.test.ts does (org,
// driver, tractor, trailer, load) — reuse it, do not invent a parallel one.
//
// Assertions:
//   1. POST /assignments as Bo → 409, body.error === "ENTITY_ALREADY_LOCKED"
//   2. prisma.assignment.count() === 0  ← the guard must run BEFORE the write
//   3. after Ann DELETEs her lock, Bo's identical POST → 201
//   4. Ann committing on her OWN locked lane → 201 (holder is not blocked)
//   5. DELETE /assignments/:id and POST /assignments/:id/status are guarded too
```

> Written as a specification rather than final code because the fixture is
> large and already exists. Copy it; assertion 2 is the one that matters — a
> guard that runs after the transaction is not a guard.

- [ ] **Step 2: Run and watch it fail** — Bo's commit currently returns 201.

- [ ] **Step 3: Implement**

```ts
// src/lib/laneId.ts
import { get } from "./locks.js";

/** A lane is the driver's row on the board, so the lane id is the driver id.
 *  Tractor/trailer groupings lock the driver currently paired to that unit
 *  (S3 adds that resolution); today every mutation names a driver directly. */
export function laneIdForDriver(driverId: string): string {
  return driverId;
}

export class LockedError extends Error {
  constructor(readonly lock: ReturnType<typeof get>) {
    super("ENTITY_ALREADY_LOCKED");
  }
}

/** Throws when someone else holds the lane. The holder is never blocked from
 *  their own lane — that is the whole point of taking the lock. */
export function assertNotLockedByOther(orgId: string, laneId: string, dispatcherId: string): void {
  const held = get(orgId, laneId);
  if (held && held.dispatcherId !== dispatcherId) throw new LockedError(held);
}
```

In `dispatcherAssignments.ts`, call the guard immediately after the org check and **before** any write, in all three mutating handlers:

```ts
try {
  assertNotLockedByOther(load.orgId, laneIdForDriver(body.driverId), req.dispatcher!.id);
} catch (err) {
  if (err instanceof LockedError) return res.status(409).json({ error: "ENTITY_ALREADY_LOCKED", lock: err.lock });
  throw err;
}
```

For `DELETE /assignments/:id` and `POST /assignments/:id/status`, the lane is `assignment.driverId`.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/lock-guard.test.ts tests/dispatcher-assignments.test.ts && npx tsc --noEmit`

---

### Task 5: `tenderedAt` column

**Files:**
- Modify: `prisma/schema.prisma` (`model Assignment`)
- Create: `prisma/migrations/20260831120000_assignment_tendered_at/migration.sql`
- Test: `tests/tendered-at-column.test.ts`

**Interfaces:**
- Produces: `Assignment.tenderedAt: DateTime?` — set when a tender is created, cleared on accept.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tendered-at-column.test.ts
import { describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";

it("Assignment carries a nullable tenderedAt", async () => {
  const cols: Array<{ column_name: string; is_nullable: string }> = await prisma.$queryRawUnsafe(
    `select column_name, is_nullable from information_schema.columns
       where table_name = 'Assignment' and column_name = 'tenderedAt'`,
  );
  expect(cols).toHaveLength(1);
  expect(cols[0].is_nullable).toBe("YES"); // never priced ≠ tendered at epoch 0
});
```

- [ ] **Step 2: Run and watch it fail** — zero rows.

- [ ] **Step 3: Implement**

Add to `model Assignment` beside `startedAt`:

```prisma
  /** When this assignment was offered to the driver. Null = never tendered
   *  (it was assigned directly, or the tender was accepted and cleared). */
  tenderedAt   DateTime?
```

`prisma/migrations/20260831120000_assignment_tendered_at/migration.sql`:

```sql
ALTER TABLE "Assignment" ADD COLUMN "tenderedAt" TIMESTAMP(3);
```

Apply with `npx prisma migrate dev --name assignment_tendered_at` (which writes the file for you — keep the generated name if it differs) then `npx prisma generate`.

> **Do not hand-edit a migration after it is applied** — Prisma checksums applied migrations, and editing one makes `migrate status` report drift for every developer and for CI. This is the S1 Task-4 ruling; it still binds.

- [ ] **Step 4: Verify**

Run: `npx prisma migrate status && npx vitest run tests/tendered-at-column.test.ts`

---

### Task 6: Tender on commit

**Files:**
- Modify: `src/routes/dispatcherAssignments.ts` (`createAssignmentSchema`, the write, the emit)
- Test: `tests/tender-commit.test.ts`

**Interfaces:**
- Consumes: `ACTIVE_STATUSES` (Task 1), `tenderedAt` (Task 5).
- Produces: `POST /assignments {..., tender: true}` → 201, `assignment.status === "tendered"`, `load.status === "tendered"`, `tenderedAt` set, HOS **decremented** exactly as for an assign.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tender-commit.test.ts
// Reuse the commit fixture from tests/dispatcher-assignments.test.ts.
//
//  1. POST /assignments {tender:true} → 201; assignment.status === "tendered";
//     load.status === "tendered"; tenderedAt within 5 s of now
//  2. the driver's HOS clocks moved by the same amount as a plain assign —
//     capacity is held while the offer is outstanding. Assert the exact
//     driveRemainingMin delta, not merely "changed"; a test that accepts any
//     movement cannot tell a tender from a no-op.
//  3. a SECOND load tendered to the same driver over the same interval → 422
//     with an overlap block (proves ACTIVE_STATUSES includes "tendered")
//  4. dryRun + tender does not write
```

- [ ] **Step 2: Run and watch it fail** — `tender` is rejected by the schema.

- [ ] **Step 3: Implement**

Add to `createAssignmentSchema`:

```ts
  /** offer to the driver rather than assigning outright; capacity is still
   *  held (HOS is decremented) because a tender the driver is considering
   *  must not be double-booked */
  tender: z.boolean().optional(),
```

In the transaction, set the statuses from the flag and stamp the time:

```ts
const status = body.tender ? "tendered" : "assigned";
// ...create assignment with { status, tenderedAt: body.tender ? new Date() : null }
// ...load update: { status }
```

Emit the tender variant:

```ts
emitToDriver(body.driverId, body.tender ? "trip_tender" : "trip_assignment", { loadId: load.id, assignmentId: assignment.id });
emitToDispatchers(load.orgId, "board_update", { loadId: load.id, assignmentId: assignment.id, driverId: body.driverId, tendered: body.tender === true });
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/tender-commit.test.ts tests/dispatcher-assignments.test.ts && npx tsc --noEmit`

---

### Task 7: Tender accept / decline

**Files:**
- Modify: `src/routes/dispatcherAssignments.ts`
- Test: `tests/tender-response.test.ts`

**Interfaces:**
- Produces: `POST /assignments/:id/tender/accept` → `{assignment}` with `status:"assigned"`, `tenderedAt:null`; `POST /assignments/:id/tender/decline {reason?}` → `204`, assignment deleted, load back to `open`, HOS restored, a `DispatchConflict{kind:"tender_declined", severity:"warn"}` row written for the alerts feed.
- Decline reuses the existing unassign path in `DELETE /assignments/:id` — **extract that body into a shared `unassign(tx, assignment)` helper rather than copying it.** Duplicating the HOS restore is exactly the defect class the reviewer flags.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tender-response.test.ts
//  1. accept → 200; status "assigned"; tenderedAt null; HOS UNCHANGED by the
//     accept (the hours were already taken at tender time — accepting must not
//     double-charge the driver). Assert the exact clock values before/after.
//  2. decline → 204; assignment gone; load.status back to "open";
//     driver HOS restored to the pre-tender values EXACTLY (compare against
//     hosDriveBefore/hosCycleBefore, not an approximation)
//  3. decline writes a DispatchConflict kind "tender_declined", severity
//     "warn", detail containing the reason when supplied
//  4. accept/decline on an assignment whose status is "assigned" → 409
//  5. cross-org id → 404
//  6. lane lock held by another dispatcher → 409 ENTITY_ALREADY_LOCKED
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement**

```ts
const declineSchema = z.object({ reason: z.string().max(500).optional() });

dispatcherAssignmentsRouter.post("/assignments/:id/tender/accept", async (req, res) => {
  const a = await prisma.assignment.findUnique({ where: { id: req.params.id } });
  if (!a || outsideOrg(req, a.orgId)) return res.status(404).json({ error: "Assignment not found" });
  if (a.status !== "tendered") return res.status(409).json({ error: "Assignment is not tendered" });
  assertNotLockedByOther(a.orgId, laneIdForDriver(a.driverId), req.dispatcher!.id);

  // Accepting only relabels the offer — the HOS was decremented at tender time
  // and must not be charged twice.
  const assignment = await prisma.$transaction(async (tx) => {
    const updated = await tx.assignment.update({
      where: { id: a.id },
      data: { status: "assigned", tenderedAt: null },
    });
    await tx.load.update({ where: { id: a.loadId }, data: { status: "assigned" } });
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  emitToDriver(a.driverId, "trip_assignment", { loadId: a.loadId, assignmentId: a.id });
  emitToDispatchers(a.orgId, "board_update", { loadId: a.loadId, assignmentId: a.id, driverId: a.driverId, accepted: true });
  res.json({ assignment });
});
```

Decline: same guards, then call the extracted `unassign(tx, a)` helper, write the `DispatchConflict`, and emit `board_update {declined:true}`.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/tender-response.test.ts tests/dispatcher-assignments.test.ts && npx tsc --noEmit`

---

### Task 8: `PATCH /assignments/:id/plan`

**The load-bearing task.** Everything the board's drag, move and edge-resize gestures do lands here.

**Files:**
- Modify: `src/routes/dispatcherAssignments.ts`
- Test: `tests/assignment-plan.test.ts`

**Interfaces:**
- Consumes: `evaluate()`, `computeEconomics()`, `orgRateConfig()`, `busyFor()`, `unassign()` (Task 7), the lock guard (Task 4).
- Produces: `PATCH /assignments/:id/plan` with body `{ driverId?, tractorId?, trailerId?, availableAt?, plannedEnd?, force?, dryRun? }` → the **same response shape as the commit** (`{assignment, plan, economics, conflicts, forced}`), so the client has one verdict renderer for drop and move alike.

**Semantics (spec §6.3), in one Serializable transaction:**
1. Restore the old plan's HOS snapshot (`hosDriveBefore` etc.).
2. Re-run `evaluate()` with the new driver/equipment/`availableAt`, **excluding this assignment from its own busy intervals** — otherwise every leg conflicts with itself.
3. Optional `plannedEnd` override for the right-edge resize; must be `≥ proposedEnd − 15 min`, else `422 {error:"plan_too_short"}`.
4. Re-snapshot HOS; rewrite `Rate` / `DeadheadLeg` / `DispatchConflict`.
5. Only when `status ∈ (assigned, tendered)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/assignment-plan.test.ts
//
// GEOMETRY / CORRECTNESS
//  1. move in time: PATCH {availableAt: +3h} → 200; plannedStart moves ~3h;
//     the leg does NOT report an overlap with itself (the exclusion bug)
//  2. move to another driver: PATCH {driverId: other} → assignment.driverId
//     changed; OLD driver's HOS restored exactly to hosDriveBefore; NEW
//     driver's HOS decremented
//  3. right-edge resize: PATCH {plannedEnd: proposedEnd + 2h} → honoured
//  4. resize shorter than the engine's minimum: PATCH {plannedEnd:
//     proposedEnd - 60min} → 422 error "plan_too_short"
//  5. exactly proposedEnd - 15min → 200 (boundary is inclusive)
//
// SAFETY
//  6. dryRun → 200 with verdict + economics, and NOTHING written: assert
//     plannedStart is byte-identical to before and assignment.updatedAt
//     (or the Rate row's id) is unchanged
//  7. blocked move without force → 422, no write
//  8. same with force → 200, forced:true
//  9. status "in_progress" → 409 (a rolling truck is not replanned)
// 10. cross-org → 404
// 11. lane locked by another dispatcher → 409 ENTITY_ALREADY_LOCKED
// 12. moving onto a driver who already has an overlapping leg → 422 overlap
//
// The HOS assertions must compare exact integers. "HOS changed" would pass
// even if the restore wrote garbage.
```

- [ ] **Step 2: Run and watch it fail** — 404, route absent.

- [ ] **Step 3: Implement**

```ts
const planSchema = z.object({
  driverId: z.string().min(1).optional(),
  tractorId: z.string().min(1).optional(),
  trailerId: z.string().min(1).optional(),
  availableAt: z.union([z.string().datetime(), z.number()]).optional(),
  /** right-edge resize: hold the leg open past the engine's proposed end */
  plannedEnd: z.union([z.string().datetime(), z.number()]).optional(),
  force: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

/** A resize may extend a leg freely but may not shrink it more than a quarter
 *  hour below what the engine says the drive actually takes — that would be
 *  planning a trip that cannot physically happen. */
const RESIZE_SLACK_MS = 15 * 60_000;
```

Handler outline (write it out fully at task time — this is the shape, not a placeholder):

```
load assignment (+load, driver, tractor, trailer); 404 if outsideOrg
409 unless status in ("assigned","tendered")
assertNotLockedByOther(orgId, laneIdForDriver(target driverId ?? a.driverId), me)

resolve targets: driverId ?? a.driverId, tractorId ?? a.tractorId, trailerId ?? a.trailerId
availableAt = body.availableAt ?? a.plannedStart

busy intervals for each target EXCLUDING this assignment:
  where: { [field]: id, status: { in: ACTIVE_STATUSES }, NOT: { id: a.id } }

restore HOS snapshot into the driver input BEFORE evaluating, so the engine
sees the clocks as they were without this leg (for a same-driver move this is
essential; for a driver change the old driver is restored in the tx below)

result = evaluate({...})
conflicts = [...result.conflicts] + hosKnown warn
blockers = conflicts.filter(severity === "block")
econ = computeEconomics(...)

if (body.plannedEnd != null && plannedEnd < result.plan.proposedEnd - RESIZE_SLACK_MS)
  return 422 { error: "plan_too_short", plan: result.plan }

if (body.dryRun) return 200 { feasible: !blockers.length, conflicts, plan, economics }
if (blockers.length && !body.force) return 422 { feasible:false, conflicts, plan, economics }

$transaction(Serializable):
  restore old driver's HOS from a.hos*Before (verbatim; fall back to arithmetic
    when null, exactly as DELETE /assignments/:id does)
  re-check overlap for the NEW target under isolation → CommitConflict → 409
  update assignment { driverId, tractorId, trailerId, plannedStart, plannedEnd:
    body.plannedEnd ?? result.plan.proposedEnd, deadheadMi, loadedMi,
    marginCents, driveMin, onDutyMin, tookBreak, hos*Before: <new snapshot> }
  decrement the new driver's HOS
  delete + rewrite Rate, DeadheadLeg, DispatchConflict for this assignment

emit board_update { loadId, assignmentId, driverId, replanned: true }
if driver changed: trip_unassignment → old driver; trip_assignment (or
  trip_tender when status is still "tendered") → new driver
201? no — 200 { assignment, plan, economics, conflicts, forced: blockers.length > 0 }
```

> **Two hazards to get right, both of which a passing test suite can hide:**
> 1. **Self-overlap.** If the busy query does not exclude `a.id`, every move blocks against the leg being moved. Test 1 exists solely to catch this.
> 2. **HOS double-charge.** Restore-then-decrement must be inside one transaction. If the restore is skipped on a same-driver time move, the driver is charged twice for one leg and slowly runs out of hours.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/assignment-plan.test.ts tests/dispatcher-assignments.test.ts tests/dispatch-hos.test.ts && npx tsc --noEmit`

---

### Task 9: Driver-side tender routes and socket cleanup

**Files:**
- Modify: `src/routes/driver.ts`, `src/realtime.ts`
- Test: `tests/driver-tenders.test.ts`

**Interfaces:**
- Produces: `POST /api/driver/tenders/:id/accept` and `/decline` — same handlers as Task 7 but under driver auth, with an ownership check (`assignment.driverId === req.driver.id`, else 404).
- `realtime.ts`: on dispatcher socket disconnect, call `releaseAllFor(orgId, dispatcherId)` and emit `lane_unlock` for each freed lane.

- [ ] **Step 1: Write the failing test**

```ts
// tests/driver-tenders.test.ts
//  1. the tendered driver accepts → 200, status "assigned"
//  2. a DIFFERENT driver accepting the same tender → 404 (not 403 — do not
//     confirm the assignment exists to someone who should not see it)
//  3. driver declines → 204, load back to open, HOS restored
//  4. driver auth required → 401 without a token
//  5. a dispatcher token must NOT satisfy the driver route
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement** — thin wrappers that share the Task 7 helpers; the only new logic is the ownership check. In `realtime.ts`, in the dispatcher socket's `disconnect` handler:

```ts
for (const laneId of releaseAllFor(orgId, dispatcherId))
  emitToDispatchers(orgId, "lane_unlock", { laneId });
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/driver-tenders.test.ts tests/realtime.test.ts && npx tsc --noEmit`

---

### Task 10: Driver pairing write endpoint (the yard hook)

**Gap found in self-review:** S1 added `Driver.defaultTractorId` / `defaultTrailerId` and the loadboard *reads* them (`dispatcherLoadboard.ts:137-162`), but **nothing writes them**. The §8 gesture "drag yard chip on lane" has no endpoint. Without this task S2b's yard hook cannot be built.

**Files:**
- Modify: `src/routes/dispatcherDrivers.ts`
- Test: `tests/driver-pairing-write.test.ts`

**Interfaces:**
- Produces: `PATCH /api/dispatcher/drivers/:id/pairing` body `{ tractorId?: string | null, trailerId?: string | null }` → `{ driver }`. Explicit `null` unhooks; an omitted key leaves that side untouched (so hooking a trailer cannot silently drop the tractor).

- [ ] **Step 1: Write the failing test**

```ts
// tests/driver-pairing-write.test.ts
//  1. PATCH {tractorId} → driver.defaultTractorId set; defaultTrailerId UNCHANGED
//  2. PATCH {tractorId: null} → cleared (explicit unhook)
//  3. PATCH {} → 400 (nothing to do is a client bug, not a silent no-op)
//  4. a tractor id from another org → 404 (do not leak existence)
//  5. lane locked by another dispatcher → 409 ENTITY_ALREADY_LOCKED
//  6. hooking a unit already paired to a DIFFERENT driver → 409 with a message
//     naming that driver; one unit cannot be two drivers' default
//  7. emits board_update {loadId:null, driverId, paired:true}
```

- [ ] **Step 2: Run and watch it fail** — route absent.

- [ ] **Step 3: Implement** — Zod `z.object({ tractorId: z.string().min(1).nullable().optional(), trailerId: …}).refine(has at least one key)`; verify each referenced unit exists **and** is in the caller's org before writing; guard with `assertNotLockedByOther(orgId, laneIdForDriver(id), me)`; emit `board_update`.

> Changing a pairing does **not** replan existing assignments here. The spec's §8 row says the client follows a pairing change with `PATCH /plan` for that lane's assigned legs — that sequencing belongs to S2b, and doing it implicitly server-side would move legs the dispatcher never asked to move.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/driver-pairing-write.test.ts tests/driver-pairing.test.ts && npx tsc --noEmit`

---

## Final gate

```bash
# batched — the full run SIGSEGVs before the reporter flushes
npx vitest run tests/locks-lib.test.ts tests/dispatcher-locks.test.ts tests/lock-guard.test.ts
npx vitest run tests/tender-commit.test.ts tests/tender-response.test.ts tests/driver-tenders.test.ts
npx vitest run tests/assignment-plan.test.ts tests/active-statuses.test.ts tests/tendered-at-column.test.ts
npx tsc --noEmit
node seed-control-tower.mjs && node seed-demo.mjs && node smoke-control-tower.mjs
```

Expected: all green, smoke 26/26. **Reseed after any test run** — tests and the dev app share one database.

## Acceptance (spec §12, S2 backend half)

- Two sessions demonstrate the 409: dispatcher A opens a lane, dispatcher B's commit onto it is refused and names A.
- A leg moves in time and between drivers without HOS drift — the old driver's clocks return to exactly their pre-move values.
- A tender holds capacity: a second load cannot be committed over a tendered interval.

## Known limitation to record in the report

The lock table is process-local. Correct for the current single-instance deployment; behind a load balancer two dispatchers on different instances would both be granted the same lane. Moving it to Redis is a config change to `lib/locks.ts` alone — that is why the table is isolated behind that module's interface rather than inlined into the route.
