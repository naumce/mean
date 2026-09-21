# One Honest Record — Plan A2: Load locks + the version backstop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While one dispatcher edits a load, everyone else sees "Maria is editing" and cannot write it; and no write ever lands on a version of the record the writer did not see — an expired lock never silently loses an edit.

**Architecture:** `LoadLock` rows in Postgres (TTL 60 s, heartbeat 20 s, released on commit/cancel and on socket close) — rows rather than process memory so a paste can take every target inside the same transaction that writes them. Enforcement lives in the one write path: `applyLoadChange` refuses a load held by another dispatcher (`LoadLocked` → 409 `LOAD_LOCKED`) and refuses a write whose `baseVersion` is not the row's `version` (`StaleVersion` → 409 `STALE_VERSION` with the field's current rendered value, so the cell can offer *keep mine / take theirs*). The portal gets a tiny socket singleton (`lib/realtime.ts`) that the new `loadLocks` store subscribes to; the Cockpit gesture pipeline takes the load lock beside the lane lock it already takes.

**Tech Stack:** fleet-backend — Express 4, Prisma 5 (Postgres), zod, vitest + supertest, `ws`. fleet-portal — Vue 3, Pinia, TanStack table, vitest + @vue/test-utils, vue-tsc.

**Spec:** `docs/superpowers/specs/2026-09-09-one-honest-record-design.md` — §5.3 (`LoadLock`), §7 (locks), §7.4 (version backstop), §9 (events `load_lock`/`load_unlock`), §13 (lock routes, `baseVersion`), §14 (tests). This plan implements spec §15 build step 3. Plan A1 (`2026-09-09-one-honest-record-a1-writer.md`) built the writer this plan enforces in.

## Global Constraints

- **No git commits, no `git add`** — the user's standing rule. Every "Commit" step is skipped; the working tree is the deliverable. Never run a git command that writes.
- The single write path is `applyLoadChange(tx, { loadId, orgId, actor, source, patch, attention?, attentionOwned?, force?, baseVersion? })` in `fleet-backend/src/lib/loadWriter.ts`. Lock enforcement and the version check live THERE, once — routes translate the thrown errors into HTTP.
- Lock shape (spec §5.3/§7.1): `LoadLock { id, loadId @unique, orgId, dispatcherId, dispatcherName, since, expiresAt } @@index([orgId, expiresAt])`; TTL **60 000 ms**; client heartbeat **20 000 ms**; a lock is live while `now <= expiresAt` (equality holds, as `lib/locks.ts` does for lanes).
- Refusal shapes (spec §7.3/§7.4): `409 { error: "LOAD_LOCKED", lock: { loadId, orgId, dispatcherId, by, since, expiresAt }, message }` and `409 { error: "STALE_VERSION", current, theirs, load }` where `theirs` is the cell's current rendered text and `load` the fresh board row. A paste refused by locks answers `409 { error: "LOAD_LOCKED", holders: [{ loadId, loadNo, by }], message }` naming the holder and the LOAD#s; nothing partial lands.
- `source: "import"` and `"backfill"` skip the `baseVersion` check (they are the truth arriving), but a load held by a dispatcher still refuses them — the importer skips that row and says so; the CLI counts it under `failed`.
- Events: `load_lock { orgId, loadId, by, dispatcherId, since }` on a FRESH acquire only; `load_unlock { loadId }` on release, expiry sweep is silent (clients synthesize `expiresAt`), and on socket close for every lock the dispatcher held.
- Every new query is org-scoped; every body validated with zod; the holder's name comes from the session's dispatcher row, never from the body.
- Tests run against the per-process Postgres schema (`npx vitest run` in `fleet-backend`; container `fleet-postgres` on :5434). Type checks: `npx tsc --noEmit` (and `--noUnusedLocals --noUnusedParameters`, which the tsconfig does not set — five pre-existing errors in untouched files are known), `npx vue-tsc --noEmit` in `fleet-portal`.
- Windows note for the migration: the dev backend (`tsx watch`, :3001) holds Prisma's engine DLL; stop it before `prisma generate`, restart it after (`npm run dev` in the background).

---

## File structure

**fleet-backend**
- `prisma/schema.prisma` — `LoadLock` model; `Load.lock LoadLock?`.
- `prisma/migrations/<ts>_load_locks/migration.sql` — generated.
- `tests/helpers.ts` — `resetDb` clears `loadLock` before `load`.
- `src/lib/loadLocks.ts` (new) — the lock table's operations: `heldBy`, `acquireLoadLock`, `releaseLoadLock`, `assertWritable`, `releaseAllLoadLocksFor`, `sweepLoadLocks`, `snapshotLoadLocks`, `LoadLocked`.
- `src/lib/loadWriter.ts` — `baseVersion`, `StaleVersion`, lock enforcement.
- `src/lib/loadGuard.ts` (new) — `guardLoad(req, res, loadId)` for the Cockpit routes.
- `src/routes/dispatcherLoadLocks.ts` (new) — `POST /loads/:id/lock`, `POST /loads/:id/lock/heartbeat`, `DELETE /loads/:id/lock`, `GET /load-locks`; sweeper.
- `src/app.ts` — mount. `src/realtime.ts` — release on socket close.
- `src/routes/dispatcherBrokerBoard.ts` — `baseVersion` in schemas; 409 translations; paste acquires; bulk/duplicate refuse.
- `src/lib/brokerImport.ts` — locked rows skipped, counted, noted.
- `src/routes/dispatcherAssignments.ts`, `src/routes/dispatcherLoads.ts` — `guardLoad` beside `guardLane`.
- Tests: `tests/load-locks-lib.test.ts` (new), `tests/load-locks-routes.test.ts` (new), `tests/load-writer.test.ts`, `tests/realtime.test.ts`, `tests/broker-board-cell-route.test.ts`, `tests/broker-board-paste.test.ts`, `tests/broker-board-bulk.test.ts`, `tests/broker-import.test.ts`, `tests/dispatcher-assignments.test.ts` (append).

**fleet-portal**
- `src/lib/api.ts` — `LoadLock`, lock calls, `baseVersion` on `BoardCellWrite`, 409 body types.
- `src/lib/realtime.ts` (new) — one socket per tab; `subscribe(type, handler)`.
- `src/stores/loadLocks.ts` (new) — hold / heartbeat / release / `applyEvent` / `theirs`.
- `src/components/broker/BrokerGrid.vue` — `locks` prop, badge + read-only rows, `edit-start`/`edit-end`, `baseVersion` in every emitted cell.
- `src/stores/brokerBoard.ts` — `conflict`, `resolveConflict`, lock refusals.
- `src/views/BrokerBoardView.vue` — hold on edit-start, release after the save, conflict panel.
- `src/stores/cockpit.ts` — `runGesture` holds the load lock beside the lane lock.
- Specs: `src/lib/realtime.spec.ts`, `src/stores/loadLocks.spec.ts`, `src/components/broker/BrokerGrid.locks.spec.ts`, `src/stores/brokerBoard.spec.ts`, `src/views/BrokerBoardView.spec.ts`, `src/stores/cockpit.spec.ts` (append).

**Deliberately not here:** a "Maria is editing" badge on the Cockpit brick (A3 reworks lanes and bricks; the gesture refusal toast covers the behaviour), `/loadboard`'s editor (the portal has no such editor today — the backend `PATCH /dispatcher/loads/:id` gets the guard), migrating `loadboard`/`tracking` onto the socket singleton and `GET /broker-board?ids=` (A4).

---

### Task 1: `LoadLock` — schema, migration, and the lock table's operations

**Files:**
- Modify: `fleet-backend/prisma/schema.prisma` (model `Load`: add `lock LoadLock?`; new model `LoadLock`)
- Create: `fleet-backend/prisma/migrations/<timestamp>_load_locks/migration.sql`
- Modify: `fleet-backend/tests/helpers.ts` (`resetDb`)
- Create: `fleet-backend/src/lib/loadLocks.ts`
- Test: `fleet-backend/tests/load-locks-lib.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const LOAD_LOCK_TTL_MS = 60_000;
  export type LockTx = Prisma.TransactionClient | PrismaClient;
  export interface LoadLockRow { loadId: string; orgId: string; dispatcherId: string; by: string; since: number; expiresAt: number }
  export class LoadLocked extends Error { readonly lock: LoadLockRow }
  export interface Holder { loadId: string; orgId: string; dispatcherId: string; dispatcherName: string }
  export function toRow(l: LoadLock): LoadLockRow
  export async function heldBy(tx: LockTx, loadId: string, nowMs?: number): Promise<LoadLockRow | null>
  export async function acquireLoadLock(tx: LockTx, h: Holder, nowMs?: number): Promise<{ ok: true; lock: LoadLockRow; fresh: boolean } | { ok: false; lock: LoadLockRow }>
  export async function releaseLoadLock(tx: LockTx, loadId: string, dispatcherId: string, nowMs?: number): Promise<boolean>
  export async function assertWritable(tx: LockTx, loadId: string, dispatcherId: string | null, nowMs?: number): Promise<void>
  export async function releaseAllLoadLocksFor(dispatcherId: string): Promise<Array<{ loadId: string; orgId: string }>>
  export async function sweepLoadLocks(nowMs?: number): Promise<number>
  export async function snapshotLoadLocks(orgId: string, nowMs?: number): Promise<LoadLockRow[]>
  ```

- [ ] **Step 1: Write the failing test**

`fleet-backend/tests/load-locks-lib.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  acquireLoadLock, assertWritable, heldBy, LOAD_LOCK_TTL_MS, LoadLocked, releaseAllLoadLocksFor, releaseLoadLock, snapshotLoadLocks, sweepLoadLocks,
} from "../src/lib/loadLocks.js";
import { resetDb } from "./helpers.js";

// Rows, not process memory (spec §5.3): a paste takes every target inside the
// transaction that writes them, and a restart forgets nothing a dispatcher
// still holds. The TTL is the guarantee; release is the optimisation.
async function setup() {
  const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
  const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME" } });
  const maria = { dispatcherId: "disp-maria", dispatcherName: "Maria" };
  const jake = { dispatcherId: "disp-jake", dispatcherName: "Jake" };
  return { org, load, maria, jake };
}

describe("load locks — the table", () => {
  beforeEach(resetDb);

  it("grants a free load, extends the same holder, and refuses another holder naming the first", async () => {
    const { org, load, maria, jake } = await setup();
    const t0 = 1_760_000_000_000;
    const first = await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0);
    expect(first).toMatchObject({ ok: true, fresh: true, lock: { loadId: load.id, by: "Maria", since: t0, expiresAt: t0 + LOAD_LOCK_TTL_MS } });
    const again = await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0 + 20_000);
    expect(again).toMatchObject({ ok: true, fresh: false, lock: { since: t0, expiresAt: t0 + 20_000 + LOAD_LOCK_TTL_MS } });
    const other = await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...jake }, t0 + 30_000);
    expect(other).toMatchObject({ ok: false, lock: { by: "Maria", dispatcherId: "disp-maria" } });
    expect(await heldBy(prisma, load.id, t0 + 30_000)).toMatchObject({ by: "Maria" });
  });

  it("is held at exactly its expiry and free one millisecond later — then anyone may take it fresh", async () => {
    const { org, load, maria, jake } = await setup();
    const t0 = 1_760_000_000_000;
    await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0);
    expect(await heldBy(prisma, load.id, t0 + LOAD_LOCK_TTL_MS)).not.toBeNull();
    expect(await heldBy(prisma, load.id, t0 + LOAD_LOCK_TTL_MS + 1)).toBeNull();
    const r = await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...jake }, t0 + LOAD_LOCK_TTL_MS + 1);
    expect(r).toMatchObject({ ok: true, fresh: true, lock: { by: "Jake", since: t0 + LOAD_LOCK_TTL_MS + 1 } });
  });

  it("releases only for the holder; releasing a free or expired lock is a success", async () => {
    const { org, load, maria, jake } = await setup();
    const t0 = 1_760_000_000_000;
    expect(await releaseLoadLock(prisma, load.id, maria.dispatcherId, t0)).toBe(true);
    await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0);
    expect(await releaseLoadLock(prisma, load.id, jake.dispatcherId, t0 + 1)).toBe(false);
    expect(await releaseLoadLock(prisma, load.id, jake.dispatcherId, t0 + LOAD_LOCK_TTL_MS + 1)).toBe(true);
    expect(await prisma.loadLock.count()).toBe(0);
  });

  it("assertWritable: the holder passes, another dispatcher and a system writer are refused with the holder", async () => {
    const { org, load, maria, jake } = await setup();
    const t0 = 1_760_000_000_000;
    await expect(assertWritable(prisma, load.id, null, t0)).resolves.toBeUndefined();
    await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0);
    await expect(assertWritable(prisma, load.id, maria.dispatcherId, t0 + 1)).resolves.toBeUndefined();
    await expect(assertWritable(prisma, load.id, jake.dispatcherId, t0 + 1)).rejects.toBeInstanceOf(LoadLocked);
    await expect(assertWritable(prisma, load.id, null, t0 + 1)).rejects.toMatchObject({ lock: { by: "Maria" } });
  });

  it("sweeps expired rows, snapshots one org's live locks, and releases everything a dispatcher held", async () => {
    const { org, load, maria, jake } = await setup();
    const other = await prisma.org.create({ data: { name: "Other", timezone: "UTC" } });
    const theirs = await prisma.load.create({ data: { orgId: other.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "THEIRS" } });
    const second = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME 2" } });
    const t0 = 1_760_000_000_000;
    await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0);
    await acquireLoadLock(prisma, { loadId: second.id, orgId: org.id, ...maria }, t0);
    await acquireLoadLock(prisma, { loadId: theirs.id, orgId: other.id, ...jake }, t0 - LOAD_LOCK_TTL_MS - 5);
    expect((await snapshotLoadLocks(org.id, t0 + 1)).map((l) => l.loadId).sort()).toEqual([load.id, second.id].sort());
    expect(await snapshotLoadLocks(other.id, t0 + 1)).toEqual([]);
    expect(await sweepLoadLocks(t0 + 1)).toBe(1);
    expect((await releaseAllLoadLocksFor(maria.dispatcherId)).map((r) => r.loadId).sort()).toEqual([load.id, second.id].sort());
    expect(await prisma.loadLock.count()).toBe(0);
  });

  it("goes away with its load", async () => {
    const { org, load, maria } = await setup();
    await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria });
    await prisma.load.delete({ where: { id: load.id } });
    expect(await prisma.loadLock.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd fleet-backend && npx vitest run tests/load-locks-lib.test.ts`
Expected: FAIL — cannot resolve `../src/lib/loadLocks.js`.

- [ ] **Step 3: Schema and migration**

In `fleet-backend/prisma/schema.prisma`, model `Load`, directly after `changes LoadChange[]`, add:
```prisma
  /// One editor at a time (spec §7); rows so a paste can take every target
  /// inside the transaction that writes them.
  lock               LoadLock?
```
Add the model after `LoadChange`:
```prisma
/// Who is editing a load right now (spec §5.3). TTL 60 s, heartbeat 20 s,
/// released on commit/cancel and on socket close; a lock is live while
/// now <= expiresAt. Rows, not process memory: a paste takes every target
/// inside the same transaction that writes them, and a restart forgets
/// nothing a dispatcher still holds.
model LoadLock {
  id             String   @id @default(uuid())
  loadId         String   @unique
  load           Load     @relation(fields: [loadId], references: [id], onDelete: Cascade)
  orgId          String
  dispatcherId   String
  dispatcherName String
  since          DateTime @default(now())
  expiresAt      DateTime

  @@index([orgId, expiresAt])
  @@index([dispatcherId])
}
```
Generate and apply (stop the dev backend on :3001 first; restart it after):
```bash
cd fleet-backend
mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_load_locks
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<that dir>/migration.sql
npx prisma migrate deploy
npx prisma generate
```
In `fleet-backend/tests/helpers.ts` `resetDb`, directly before `prisma.loadChange.deleteMany(),` add:
```ts
    // A2: locks cascade with their load, but a live one on a load another
    // suite created must not survive into the next suite's org — clear first.
    prisma.loadLock.deleteMany(),
```

- [ ] **Step 4: The lock table's operations**

`fleet-backend/src/lib/loadLocks.ts`:
```ts
import type { LoadLock, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db.js";

// Load locks (spec §5.3, §7). Same family as the lane locks in lib/locks.ts,
// with one difference on purpose: these are ROWS. A paste takes every target
// inside the transaction that writes them and releases with it; a restart
// forgets nothing a dispatcher still holds. The TTL is the guarantee;
// explicit release and socket-close cleanup are the optimisations.

export const LOAD_LOCK_TTL_MS = 60_000;
export type LockTx = Prisma.TransactionClient | PrismaClient;

export interface LoadLockRow { loadId: string; orgId: string; dispatcherId: string; by: string; since: number; expiresAt: number }
export interface Holder { loadId: string; orgId: string; dispatcherId: string; dispatcherName: string }

/** Thrown by the writer for a load another dispatcher holds; routes answer
 *  409 LOAD_LOCKED with the holder so the badge and the sentence agree. */
export class LoadLocked extends Error {
  constructor(public readonly lock: LoadLockRow) {
    super(`${lock.by} is editing this load`);
  }
}

export const toRow = (l: LoadLock): LoadLockRow => ({
  loadId: l.loadId, orgId: l.orgId, dispatcherId: l.dispatcherId, by: l.dispatcherName, since: l.since.getTime(), expiresAt: l.expiresAt.getTime(),
});

/** Live until strictly past its expiry — at exactly `expiresAt` it is still
 *  held, the same rounding lib/locks.ts chose for lanes and for the same
 *  reason: releasing on the tick it expires lets two people believe they
 *  own it. */
const live = (l: LoadLock, nowMs: number): boolean => nowMs <= l.expiresAt.getTime();

export async function heldBy(tx: LockTx, loadId: string, nowMs = Date.now()): Promise<LoadLockRow | null> {
  const l = await tx.loadLock.findUnique({ where: { loadId } });
  return l && live(l, nowMs) ? toRow(l) : null;
}

/** Take or re-affirm a load. The holder re-affirming keeps `since` (held
 *  continuously) and gets `fresh: false` so callers do not announce it
 *  again; a free or expired lock is a genuine new hold. */
export async function acquireLoadLock(tx: LockTx, h: Holder, nowMs = Date.now()): Promise<{ ok: true; lock: LoadLockRow; fresh: boolean } | { ok: false; lock: LoadLockRow }> {
  const current = await tx.loadLock.findUnique({ where: { loadId: h.loadId } });
  const held = current && live(current, nowMs) ? current : null;
  if (held && held.dispatcherId !== h.dispatcherId) return { ok: false, lock: toRow(held) };
  const expiresAt = new Date(nowMs + LOAD_LOCK_TTL_MS);
  try {
    const row = held
      ? await tx.loadLock.update({ where: { loadId: h.loadId }, data: { expiresAt } })
      : await tx.loadLock.upsert({
          where: { loadId: h.loadId },
          create: { loadId: h.loadId, orgId: h.orgId, dispatcherId: h.dispatcherId, dispatcherName: h.dispatcherName, since: new Date(nowMs), expiresAt },
          update: { orgId: h.orgId, dispatcherId: h.dispatcherId, dispatcherName: h.dispatcherName, since: new Date(nowMs), expiresAt },
        });
    return { ok: true, lock: toRow(row), fresh: held === null };
  } catch (e) {
    // Two first acquires raced on the unique loadId; the other one won.
    if ((e as { code?: string }).code === "P2002") {
      const winner = await tx.loadLock.findUnique({ where: { loadId: h.loadId } });
      if (winner) return { ok: false, lock: toRow(winner) };
    }
    throw e;
  }
}

/** `false` ONLY when someone else holds it live; releasing a free or expired
 *  lock succeeds, so cleanup on blur, unmount and route-leave is idempotent. */
export async function releaseLoadLock(tx: LockTx, loadId: string, dispatcherId: string, nowMs = Date.now()): Promise<boolean> {
  const current = await tx.loadLock.findUnique({ where: { loadId } });
  if (!current) return true;
  if (live(current, nowMs) && current.dispatcherId !== dispatcherId) return false;
  await tx.loadLock.deleteMany({ where: { loadId } });
  return true;
}

/** The writer's gate (spec §7.3): a load someone else holds refuses every
 *  writer — a dispatcher, and a system source (`dispatcherId: null`) too,
 *  because an import landing under an open editor is exactly the lost write
 *  the lock exists to prevent. */
export async function assertWritable(tx: LockTx, loadId: string, dispatcherId: string | null, nowMs = Date.now()): Promise<void> {
  const held = await heldBy(tx, loadId, nowMs);
  if (held && held.dispatcherId !== dispatcherId) throw new LoadLocked(held);
}

/** Socket close: everything this dispatcher held goes, and the caller emits
 *  `load_unlock` per row. Not transactional — it runs outside any request. */
export async function releaseAllLoadLocksFor(dispatcherId: string): Promise<Array<{ loadId: string; orgId: string }>> {
  const rows = await prisma.loadLock.findMany({ where: { dispatcherId }, select: { loadId: true, orgId: true } });
  if (rows.length > 0) await prisma.loadLock.deleteMany({ where: { dispatcherId } });
  return rows;
}

export async function sweepLoadLocks(nowMs = Date.now()): Promise<number> {
  return (await prisma.loadLock.deleteMany({ where: { expiresAt: { lt: new Date(nowMs) } } })).count;
}

export async function snapshotLoadLocks(orgId: string, nowMs = Date.now()): Promise<LoadLockRow[]> {
  const rows = await prisma.loadLock.findMany({ where: { orgId, expiresAt: { gte: new Date(nowMs) } } });
  return rows.map(toRow);
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/load-locks-lib.test.ts` → PASS (6). Then `npx vitest run` → every suite green (the new `resetDb` line must not break any). `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit** — skipped (user rule); ledger.

---

### Task 2: The writer refuses a held load and a stale version

**Files:**
- Modify: `fleet-backend/src/lib/loadWriter.ts` (`ApplyArgs`, new `StaleVersion`, two checks after `loadRow`)
- Test: `fleet-backend/tests/load-writer.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 `assertWritable`, `LoadLocked`.
- Produces: `ApplyArgs.baseVersion?: number`; `export class StaleVersion extends Error { readonly current: number; readonly base: number }`; `applyLoadChange` throws `LoadLocked` / `StaleVersion` before writing anything.

- [ ] **Step 1: Write the failing tests**

Append to `fleet-backend/tests/load-writer.test.ts` (the file already imports `prisma`, `applyLoadChange`, `resetDb`, and defines `setup()` returning `{ org, load }` and `apply(loadId, orgId, patch)`; add `LoadLocked` from `../src/lib/loadLocks.js` and `StaleVersion` to the `loadWriter` import):
```ts
describe("applyLoadChange — locks and the version backstop (spec §7)", () => {
  beforeEach(resetDb);
  const actorMaria = { dispatcherId: "disp-maria", name: "Maria" };
  const actorJake = { dispatcherId: "disp-jake", name: "Jake" };
  const write = (loadId: string, orgId: string, actor: { dispatcherId: string | null; name: string }, extra: Partial<Parameters<typeof applyLoadChange>[1]> = {}) =>
    prisma.$transaction((tx) => applyLoadChange(tx, { loadId, orgId, actor, source: "board", patch: { customerName: "NEW" }, ...extra }));

  it("refuses a load another dispatcher is editing, naming them, and writes nothing", async () => {
    const { org, load } = await setup();
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    await expect(write(load.id, org.id, actorJake)).rejects.toMatchObject({ lock: { by: "Maria" } });
    await expect(write(load.id, org.id, actorJake)).rejects.toBeInstanceOf(LoadLocked);
    const after = await prisma.load.findUnique({ where: { id: load.id } });
    expect([after?.customerName, after?.version]).toEqual(["ACME", 0]);
  });

  it("lets the holder write, and lets anyone write once the lock has expired", async () => {
    const { org, load } = await setup();
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    expect((await write(load.id, org.id, actorMaria)).version).toBe(1);
    await prisma.loadLock.update({ where: { loadId: load.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await write(load.id, org.id, actorJake, { patch: { customerName: "NEWER" } })).version).toBe(2);
  });

  it("refuses the truth arriving under an open editor too — an import does not land on a held load", async () => {
    const { org, load } = await setup();
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    await expect(write(load.id, org.id, { dispatcherId: null, name: "import" }, { source: "import" })).rejects.toBeInstanceOf(LoadLocked);
  });

  it("refuses a write whose baseVersion is not the row's version, and says both", async () => {
    const { org, load } = await setup();
    await write(load.id, org.id, actorMaria); // version 1
    await expect(write(load.id, org.id, actorJake, { baseVersion: 0, patch: { customerName: "STALE" } })).rejects.toMatchObject({ current: 1, base: 0 });
    await expect(write(load.id, org.id, actorJake, { baseVersion: 0, patch: { customerName: "STALE" } })).rejects.toBeInstanceOf(StaleVersion);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.customerName).toBe("NEW");
    expect((await write(load.id, org.id, actorJake, { baseVersion: 1, patch: { customerName: "FRESH" } })).version).toBe(2);
  });

  it("skips the version check for import and backfill — they are the truth, not a view of it", async () => {
    const { org, load } = await setup();
    await write(load.id, org.id, actorMaria);
    const r = await write(load.id, org.id, { dispatcherId: null, name: "import" }, { source: "import", baseVersion: 0, patch: { customerName: "FROM SHEET" } });
    expect(r.version).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/load-writer.test.ts -t "locks and the version backstop"` → FAIL (`baseVersion` unknown / no refusal).

- [ ] **Step 3: Enforce in the writer**

In `fleet-backend/src/lib/loadWriter.ts`:
- Import: `import { assertWritable } from "./loadLocks.js";`
- In `ApplyArgs`, after `force?: boolean;`:
  ```ts
  /** The `Load.version` the caller rendered (spec §7.4). A view of the record
   *  that has moved on does not overwrite it; import and backfill carry none
   *  and are never checked — they are the truth arriving. */
  baseVersion?: number;
  ```
- Next to `LoadNotFound`:
  ```ts
  /** The version backstop: the row moved since the caller rendered it. */
  export class StaleVersion extends Error {
    constructor(public readonly current: number, public readonly base: number) {
      super(`the record moved on (version ${current}; you rendered ${base})`);
    }
  }
  const SKIPS_BASE_VERSION: ReadonlySet<ChangeSource> = new Set(["import", "backfill"]);
  ```
- In `applyLoadChange`, immediately after `const before = await loadRow(tx, loadId, orgId);`:
  ```ts
  // §7.3 — a load someone else is editing refuses every writer; §7.4 — a
  // stale view refuses itself. Both before a single row is touched.
  await assertWritable(tx, loadId, args.actor.dispatcherId);
  if (args.baseVersion !== undefined && !SKIPS_BASE_VERSION.has(args.source) && before.version !== args.baseVersion) {
    throw new StaleVersion(before.version, args.baseVersion);
  }
  ```
  (`args` is the second parameter's name; if the function destructures it, use the destructured names — `actor.dispatcherId`, `baseVersion`, `source`.)

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/load-writer.test.ts` → PASS (38). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 3: Lock routes, events, socket-close release, sweeper

**Files:**
- Create: `fleet-backend/src/routes/dispatcherLoadLocks.ts`
- Modify: `fleet-backend/src/app.ts` (mount next to `dispatcherBrokerBoardRouter`)
- Modify: `fleet-backend/src/realtime.ts` (dispatcher socket `close` handler)
- Test: `fleet-backend/tests/load-locks-routes.test.ts` (new), `fleet-backend/tests/realtime.test.ts` (append)

**Interfaces:**
- Consumes: Task 1.
- Produces: `POST /api/dispatcher/loads/:id/lock` → `200 { lock }` / `409 { error: "LOAD_LOCKED", lock, message }` / `404`; `POST …/lock/heartbeat` (same contract); `DELETE …/lock` → `204` / `409`; `GET /api/dispatcher/load-locks` → `{ locks }`. Events `load_lock { orgId, loadId, by, dispatcherId, since }` (fresh only), `load_unlock { loadId }`.

- [ ] **Step 1: Write the failing tests**

`fleet-backend/tests/load-locks-routes.test.ts`:
```ts
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { LOAD_LOCK_TTL_MS } from "../src/lib/loadLocks.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

async function setup() {
  const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
  await prisma.dispatcher.create({ data: { email: "maria@x.com", passwordHash: await hashPassword("pw"), name: "Maria", orgId: org.id } });
  await prisma.dispatcher.create({ data: { email: "jake@x.com", passwordHash: await hashPassword("pw"), name: "Jake", orgId: org.id } });
  const maria = { Authorization: `Bearer ${(await loginDispatcher("maria@x.com", "pw")).token}` };
  const jake = { Authorization: `Bearer ${(await loginDispatcher("jake@x.com", "pw")).token}` };
  const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME" } });
  return { org, load, maria, jake };
}
const lock = (auth: Record<string, string>, id: string) => request(app).post(`/api/dispatcher/loads/${id}/lock`).set(auth);
const heartbeat = (auth: Record<string, string>, id: string) => request(app).post(`/api/dispatcher/loads/${id}/lock/heartbeat`).set(auth);
const unlock = (auth: Record<string, string>, id: string) => request(app).delete(`/api/dispatcher/loads/${id}/lock`).set(auth);

describe("load locks — the routes", () => {
  beforeEach(resetDb);

  it("acquires, heartbeats, lists, refuses the other dispatcher with the holder, and releases", async () => {
    const { load, maria, jake } = await setup();
    const a = await lock(maria, load.id);
    expect(a.status).toBe(200);
    expect(a.body.lock).toMatchObject({ loadId: load.id, by: "Maria" });
    expect(a.body.lock.expiresAt - a.body.lock.since).toBe(LOAD_LOCK_TTL_MS);
    const hb = await heartbeat(maria, load.id);
    expect(hb.status).toBe(200);
    expect(hb.body.lock.since).toBe(a.body.lock.since);
    expect(hb.body.lock.expiresAt).toBeGreaterThanOrEqual(a.body.lock.expiresAt);
    const refused = await lock(jake, load.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" }, message: "Maria is editing this load" });
    const list = await request(app).get("/api/dispatcher/load-locks").set(jake);
    expect(list.body.locks.map((l: { loadId: string }) => l.loadId)).toEqual([load.id]);
    expect((await unlock(jake, load.id)).status).toBe(409);
    expect((await unlock(maria, load.id)).status).toBe(204);
    expect((await lock(jake, load.id)).status).toBe(200);
  });

  it("treats an expired lock as free", async () => {
    const { org, load, jake } = await setup();
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: "gone", dispatcherName: "Gone", expiresAt: new Date(Date.now() - 1) } });
    expect((await lock(jake, load.id)).status).toBe(200);
  });

  it("never shows or locks another org's load", async () => {
    const { maria } = await setup();
    const other = await prisma.org.create({ data: { name: "Other", timezone: "UTC" } });
    const theirs = await prisma.load.create({ data: { orgId: other.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "THEIRS" } });
    expect((await lock(maria, theirs.id)).status).toBe(404);
    expect((await unlock(maria, theirs.id)).status).toBe(404);
    await prisma.loadLock.create({ data: { loadId: theirs.id, orgId: other.id, dispatcherId: "x", dispatcherName: "X", expiresAt: new Date(Date.now() + 60_000) } });
    const list = await request(app).get("/api/dispatcher/load-locks").set(maria);
    expect(list.body.locks).toEqual([]);
  });
});
```
Append to `fleet-backend/tests/realtime.test.ts` (it already has `connect`, `waitForOpen`, `waitForClose`, `createDispatcher`, `signDispatcherAccess`; add `import { prisma } from "../src/db.js";` if missing and use supertest `request(app)` as the file's `acquireLock` helper does):
```ts
it("releases a dispatcher's load locks when their socket disconnects, and tells the org", async () => {
  const org = await prisma.org.create({ data: { name: "RT Broker", timezone: "UTC" } });
  const dispatcher = await prisma.dispatcher.create({ data: { email: "rt-loadlock@fleet.com", passwordHash: "x", name: "Maria", orgId: org.id } });
  const watcher = await prisma.dispatcher.create({ data: { email: "rt-loadlock-watch@fleet.com", passwordHash: "x", name: "Jake", orgId: org.id } });
  const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME" } });
  const token = signDispatcherAccess(dispatcher.id);
  const ws = connect(token);
  const watcherWs = connect(signDispatcherAccess(watcher.id));
  await Promise.all([waitForOpen(ws), waitForOpen(watcherWs)]);
  const frames: Array<{ type: string; loadId?: string }> = [];
  watcherWs.on("message", (d) => frames.push(JSON.parse(String(d))));

  expect((await request(app).post(`/api/dispatcher/loads/${load.id}/lock`).set({ Authorization: `Bearer ${token}` })).status).toBe(200);
  expect(await prisma.loadLock.count({ where: { loadId: load.id } })).toBe(1);

  ws.close();
  await waitForClose(ws);
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(await prisma.loadLock.count({ where: { loadId: load.id } })).toBe(0);
  expect(frames.some((f) => f.type === "load_lock" && f.loadId === load.id)).toBe(true);
  expect(frames.some((f) => f.type === "load_unlock" && f.loadId === load.id)).toBe(true);
  watcherWs.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/load-locks-routes.test.ts tests/realtime.test.ts` → the new tests FAIL (404 on the routes; lock row survives the close).

- [ ] **Step 3: The router**

`fleet-backend/src/routes/dispatcherLoadLocks.ts`:
```ts
import { Router } from "express";
import { prisma } from "../db.js";
import { acquireLoadLock, heldBy, releaseLoadLock, snapshotLoadLocks, sweepLoadLocks } from "../lib/loadLocks.js";
import { emitToDispatchers } from "../realtime.js";

// Load locks over HTTP (spec §13): acquire/heartbeat are one call — the
// holder re-affirming extends the TTL and announces nothing; a fresh hold
// tells the org. Release tells the org too. Expiry is silent: clients
// synthesize `expiresAt` from `since`, and the sweeper only tidies rows.
export const dispatcherLoadLocksRouter = Router();

const sweeper = setInterval(() => { void sweepLoadLocks().catch(() => { /* next tick */ }); }, 15_000);
sweeper.unref?.();

async function ownLoad(orgId: string, id: string): Promise<{ id: string } | null> {
  return prisma.load.findFirst({ where: { id, orgId }, select: { id: true } });
}

async function acquireFor(req: { orgScope?: string | null; auth?: { dispatcherId?: string } }, loadId: string) {
  const orgId = req.orgScope!;
  const dispatcherId = req.auth!.dispatcherId!;
  const me = await prisma.dispatcher.findUnique({ where: { id: dispatcherId }, select: { name: true } });
  const r = await acquireLoadLock(prisma, { loadId, orgId, dispatcherId, dispatcherName: me?.name ?? "Dispatcher" });
  if (r.ok && r.fresh) emitToDispatchers(orgId, "load_lock", { orgId, loadId, by: r.lock.by, dispatcherId, since: r.lock.since });
  return r;
}

for (const path of ["/loads/:id/lock", "/loads/:id/lock/heartbeat"]) {
  dispatcherLoadLocksRouter.post(path, async (req, res) => {
    const orgId = req.orgScope;
    if (!orgId) return res.status(400).json({ error: "Locks require an org-scoped dispatcher account" });
    const load = await ownLoad(orgId, req.params.id as string);
    if (!load) return res.status(404).json({ error: "Load not found" });
    const r = await acquireFor(req, load.id);
    if (!r.ok) return res.status(409).json({ error: "LOAD_LOCKED", lock: r.lock, message: `${r.lock.by} is editing this load` });
    res.json({ lock: r.lock });
  });
}

dispatcherLoadLocksRouter.delete("/loads/:id/lock", async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Locks require an org-scoped dispatcher account" });
  const load = await ownLoad(orgId, req.params.id as string);
  if (!load) return res.status(404).json({ error: "Load not found" });
  const dispatcherId = req.auth!.dispatcherId!;
  const held = await heldBy(prisma, load.id);
  if (!(await releaseLoadLock(prisma, load.id, dispatcherId))) {
    return res.status(409).json({ error: "LOAD_LOCKED", lock: held, message: `${held?.by ?? "Someone"} is editing this load` });
  }
  if (held) emitToDispatchers(orgId, "load_unlock", { loadId: load.id });
  res.status(204).end();
});

dispatcherLoadLocksRouter.get("/load-locks", async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Locks require an org-scoped dispatcher account" });
  res.json({ locks: await snapshotLoadLocks(orgId) });
});
```
Mount in `fleet-backend/src/app.ts` next to the broker board router: `import { dispatcherLoadLocksRouter } from "./routes/dispatcherLoadLocks.js";` and `app.use("/api/dispatcher", dispatcherLoadLocksRouter);` after the `dispatcherBrokerBoardRouter` line.

In `fleet-backend/src/realtime.ts`, add `import { releaseAllLoadLocksFor } from "./lib/loadLocks.js";` and, inside the dispatcher socket's `ws.on("close", …)` handler right after the existing `for (const laneId of releaseAllFor(payload.dispatcherId)) { … }` loop:
```ts
          // Load locks (spec §7.1): everything this dispatcher was editing
          // is free again, and their org hears it per load.
          void releaseAllLoadLocksFor(payload.dispatcherId)
            .then((rows) => { for (const { loadId, orgId } of rows) emitToDispatchers(orgId, "load_unlock", { loadId }); })
            .catch((e: unknown) => console.error("load lock release on close failed", e));
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/load-locks-routes.test.ts tests/realtime.test.ts` → PASS. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 4: The board routes carry `baseVersion`, translate the refusals, and take the paste's locks

**Files:**
- Modify: `fleet-backend/src/routes/dispatcherBrokerBoard.ts` (`cellSchema`, cell route catch, paste route, `archive`/`delete`/`duplicate` routes)
- Test: `fleet-backend/tests/broker-board-cell-route.test.ts`, `tests/broker-board-paste.test.ts`, `tests/broker-board-bulk.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 `acquireLoadLock`, `releaseLoadLock`, `assertWritable`, `LoadLocked`; Task 2 `StaleVersion`.
- Produces: cell/paste bodies REQUIRE `baseVersion` (400 without); `409 { error: "STALE_VERSION", current, theirs, load }` on the cell route; `409 { error: "STALE_VERSION", loadIds, message }` on the paste; `409 { error: "LOAD_LOCKED", … }` on cell, paste (`holders` naming LOAD#s), archive/unarchive, delete, duplicate.

- [ ] **Step 1: Write the failing tests**

Append to `tests/broker-board-cell-route.test.ts` (it has `setup()` → `{ org, auth, load }` or similar — reuse the file's own helper names; the load's rendered `customer` is `"OLD"`-style seeded text; add `loadLock` rows directly):
```ts
describe("PATCH cell — locks and the version backstop (spec §7)", () => {
  beforeEach(resetDb);

  it("requires baseVersion", async () => {
    const { auth, load } = await setup();
    const res = await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth).send({ row: "top", key: "customer", value: "A" });
    expect(res.status).toBe(400);
  });

  it("refuses a stale view with both values and the fresh row, then accepts the re-based write", async () => {
    const { auth, load } = await setup();
    await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth).send({ row: "top", key: "customer", value: "THEIRS", baseVersion: 0 }).expect(200);
    const stale = await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth).send({ row: "top", key: "customer", value: "MINE", baseVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "STALE_VERSION", current: 1, theirs: "THEIRS" });
    expect(stale.body.load).toMatchObject({ id: load.id, version: 1 });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.customerName).toBe("THEIRS");
    const rebased = await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth).send({ row: "top", key: "customer", value: "MINE", baseVersion: 1 });
    expect(rebased.status).toBe(200);
    expect(rebased.body.version).toBe(2);
  });

  it("refuses a cell on a load someone else is editing, naming them", async () => {
    const { org, auth, load } = await setup();
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    const res = await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth).send({ row: "top", key: "customer", value: "A", baseVersion: 0 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" }, message: "Maria is editing this load" });
  });
});
```
Append to `tests/broker-board-paste.test.ts` (its `setup()` returns `{ org, auth, loads }` with `bolNumber` `0500001`/`0500002`; the `paste` helper exists — every cell now needs `baseVersion: 0`; update the EXISTING paste tests' cells to carry `baseVersion: 0` where they are expected to land, and note it in the report):
```ts
describe("POST cells — locks and the version backstop (spec §7.2)", () => {
  beforeEach(resetDb);

  it("refuses the whole paste when any target is held by someone else, naming the holder and the LOAD#s", async () => {
    const { org, auth, loads } = await setup();
    await prisma.load.update({ where: { id: loads[1].id }, data: { boardLoadNo: "0563272" } });
    await prisma.loadLock.create({ data: { loadId: loads[1].id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    const res = await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "customer", value: "A", baseVersion: 0 },
      { loadId: loads[1].id, row: "top", key: "customer", value: "B", baseVersion: 0 },
    ]);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("LOAD_LOCKED");
    expect(res.body.holders).toEqual([{ loadId: loads[1].id, loadNo: "0563272", by: "Maria" }]);
    expect(res.body.message).toBe("Maria is editing 0563272 — try again when the badge clears");
    expect((await prisma.load.findUnique({ where: { id: loads[0].id } }))?.customerName).toBe("OLD");
  });

  it("holds every target only for the write, and leaves a lock the paster already held", async () => {
    const { org, auth, loads } = await setup();
    const me = await prisma.dispatcher.findFirst({ where: { orgId: org.id } });
    await prisma.loadLock.create({ data: { loadId: loads[0].id, orgId: org.id, dispatcherId: me!.id, dispatcherName: me!.name, expiresAt: new Date(Date.now() + 60_000) } });
    await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "customer", value: "A", baseVersion: 0 },
      { loadId: loads[1].id, row: "top", key: "customer", value: "B", baseVersion: 0 },
    ]).expect(200);
    const locks = await prisma.loadLock.findMany();
    expect(locks.map((l) => l.loadId)).toEqual([loads[0].id]);
  });

  it("refuses a paste over a row that moved since it was copied", async () => {
    const { auth, loads } = await setup();
    await paste(auth, [{ loadId: loads[0].id, row: "top", key: "customer", value: "FIRST", baseVersion: 0 }]).expect(200);
    const res = await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "customer", value: "SECOND", baseVersion: 0 },
      { loadId: loads[1].id, row: "top", key: "customer", value: "B", baseVersion: 0 },
    ]);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "STALE_VERSION", loadIds: [loads[0].id] });
    expect(res.body.message).toMatch(/changed since you copied/);
    expect((await prisma.load.findUnique({ where: { id: loads[1].id } }))?.customerName).toBe("OLD");
  });
});
```
Append to `tests/broker-board-bulk.test.ts` (reuse its `setup()`/auth helpers):
```ts
describe("bulk actions on a held load", () => {
  beforeEach(resetDb);

  it("refuses archive, delete and duplicate while someone else is editing one of the loads", async () => {
    const { org, auth, loads } = await setup();
    await prisma.loadLock.create({ data: { loadId: loads[0].id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    for (const call of [
      request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: [loads[0].id, loads[1].id], archived: true }),
      request(app).post("/api/dispatcher/broker-board/loads/delete").set(auth).send({ ids: [loads[0].id] }),
      request(app).post("/api/dispatcher/broker-board/loads/duplicate").set(auth).send({ ids: [loads[0].id] }),
    ]) {
      const res = await call;
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" } });
    }
    expect((await prisma.load.findUnique({ where: { id: loads[1].id } }))?.status).not.toBe("archived");
  });
});
```
(If the bulk delete route's path differs from `/loads/delete`, use the path the file's existing tests use.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/broker-board-cell-route.test.ts tests/broker-board-paste.test.ts tests/broker-board-bulk.test.ts` → the new tests FAIL.

- [ ] **Step 3: The routes**

In `fleet-backend/src/routes/dispatcherBrokerBoard.ts`:
- Imports: add `StaleVersion` to the `loadWriter` import; add `import { acquireLoadLock, assertWritable, LoadLocked, releaseLoadLock } from "../lib/loadLocks.js";`.
- `cellSchema`: add `baseVersion: z.number().int().min(0),` (spec §7.4: every write carries it).
- Cell route: pass it — `applyLoadChange(tx, { loadId: load.id, orgId, actor, source: "board", patch, baseVersion: parsed.data.baseVersion })`. In its `catch`, before the `P2002` line:
  ```ts
    if (e instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: e.lock, message: e.message });
    if (e instanceof StaleVersion) {
      // Both values, so the cell can offer keep mine / take theirs (spec §7.4).
      const [fresh] = await boardRows(orgId, true, [load.id]);
      const cells = parsed.data.row === "top" ? fresh?.top : fresh?.bottom;
      return res.status(409).json({ error: "STALE_VERSION", current: e.current, theirs: cells?.[parsed.data.key as keyof typeof cells] ?? "", load: fresh });
    }
  ```
- Paste route, inside the `$transaction` callback, BEFORE the per-load loop:
  ```ts
      // §7.2: every target is held for the write and released with it. A
      // target someone else holds refuses the whole paste, naming them and
      // the LOAD#s — nothing partial lands.
      const me = await tx.dispatcher.findUnique({ where: { id: actor.dispatcherId ?? "" }, select: { name: true } });
      const heldHere: string[] = [];
      const holders: Array<{ loadId: string; loadNo: string; by: string }> = [];
      for (const loadId of ids) {
        const r = await acquireLoadLock(tx, { loadId, orgId, dispatcherId: actor.dispatcherId ?? "", dispatcherName: me?.name ?? actor.name });
        if (!r.ok) {
          const l = await tx.load.findFirst({ where: { id: loadId, orgId }, select: { boardLoadNo: true, externalId: true } });
          holders.push({ loadId, loadNo: l?.boardLoadNo ?? boardLoadNo(l?.externalId ?? null) ?? loadId, by: r.lock.by });
        } else if (r.fresh) heldHere.push(loadId);
      }
      if (holders.length > 0) throw new PasteLocked(holders);
      // The version backstop for the block as a whole: any row that moved
      // since it was copied refuses the paste before a cell lands.
      const versions = await tx.load.findMany({ where: { id: { in: ids }, orgId }, select: { id: true, version: true } });
      const base = new Map<string, number>();
      for (const c of cells) if (!base.has(c.loadId)) base.set(c.loadId, c.baseVersion);
      const stale = versions.filter((v) => base.get(v.id) !== v.version).map((v) => v.id);
      if (stale.length > 0) throw new PasteStale(stale);
  ```
  and AFTER the loop (still inside the callback): `for (const loadId of heldHere) await releaseLoadLock(tx, loadId, actor.dispatcherId ?? "");`. Pass `baseVersion: base.get(loadId)` into each `applyLoadChange` call. Define above the route:
  ```ts
  class PasteLocked extends Error { constructor(public readonly holders: Array<{ loadId: string; loadNo: string; by: string }>) { super("locked"); } }
  class PasteStale extends Error { constructor(public readonly loadIds: string[]) { super("stale"); } }
  ```
  and in the paste route's `catch`, before `P2002`:
  ```ts
    if (e instanceof PasteLocked) {
      const by = [...new Set(e.holders.map((h) => h.by))].join(", ");
      return res.status(409).json({ error: "LOAD_LOCKED", holders: e.holders, message: `${by} is editing ${e.holders.map((h) => h.loadNo).join(", ")} — try again when the badge clears` });
    }
    if (e instanceof PasteStale) return res.status(409).json({ error: "STALE_VERSION", loadIds: e.loadIds, message: "Some rows changed since you copied them — reload the board and paste again" });
    if (e instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: e.lock, message: e.message });
    if (e instanceof StaleVersion) return res.status(409).json({ error: "STALE_VERSION", loadIds: [], message: "Some rows changed since you copied them — reload the board and paste again" });
  ```
  `boardLoadNo(externalId)` already exists in this file's imports (`brokerImport.js`); if it returns `""` for a null, the `?? loadId` fallback needs `||` — use `|| loadId`.
- Archive/unarchive, delete, duplicate routes: inside each transaction, before any write, `for (const id of ids) await assertWritable(tx, id, actor.dispatcherId);` (obtain `actor` with `await actorOf(req)` where the route does not already), and in each `catch` add `if (e instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: e.lock, message: e.message });`.

- [ ] **Step 4: Run the three suites, then everything**

Run: `npx vitest run tests/broker-board-cell-route.test.ts tests/broker-board-paste.test.ts tests/broker-board-bulk.test.ts` → PASS (existing paste tests updated to send `baseVersion: 0`). Then `npx vitest run` and `npx tsc --noEmit` — green, clean. (`tests/dispatcher-broker-board.test.ts` and the export/line suites call no write route with a body, so they need no change; if one does, add `baseVersion: 0` to it and say so.)

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 5: The importer skips a held row and says who holds it; the CLI counts it

**Files:**
- Modify: `fleet-backend/src/lib/brokerImport.ts` (`confirmImport` loop; `BrokerImportResult`)
- Modify: `fleet-backend/src/cli/rederive.ts` (the per-load catch already counts `failed` — the `LoadLocked` message is what it prints; no code change unless the catch swallows the message)
- Test: `fleet-backend/tests/broker-import.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 `LoadLocked`.
- Produces: `BrokerImportResult.locked: number`; a note per skipped row `row <line>: <by> is editing this load — not imported`.

- [ ] **Step 1: Write the failing test**

Append to `tests/broker-import.test.ts` (it has `org()`, `brokerWorkbook()`, `confirmImport`):
```ts
  it("skips a row someone is editing, says who, and imports the rest", async () => {
    const o = await org();
    const first = await confirmImport(o.id, brokerWorkbook());
    expect(first.created).toBe(5);
    const held = await prisma.load.findFirst({ where: { orgId: o.id, bolNumber: "0500001" } });
    await prisma.loadLock.create({ data: { loadId: held!.id, orgId: o.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    const rows = brokerWorkbook();
    const again = await confirmImport(o.id, rows);
    expect(again).toMatchObject({ created: 0, updated: 4, locked: 1 });
    expect(again.notes.some((n) => /Maria is editing this load — not imported/.test(n))).toBe(true);
    expect((await prisma.load.findUnique({ where: { id: held!.id } }))?.version).toBe(1);
  });
```
(`version` stays 1 — the second import never wrote that row.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/broker-import.test.ts -t "skips a row someone is editing"` → FAIL (the transaction throws `LoadLocked` out of `confirmImport`).

- [ ] **Step 3: Skip, count, note**

In `fleet-backend/src/lib/brokerImport.ts`: import `LoadLocked` from `./loadLocks.js`; add `locked: number` to `BrokerImportResult`; `let locked = 0;` beside the other counters; wrap the per-row `prisma.$transaction(...)` call:
```ts
    let written;
    try {
      written = await prisma.$transaction(async (tx) => { /* unchanged body */ }, { timeout: 30_000 });
    } catch (e) {
      // A row under someone's open editor is theirs right now (spec §7.2):
      // the sheet does not land on it, and the dialog says so by name.
      if (e instanceof LoadLocked) { locked += 1; notes.push(`row ${pair.line}: ${e.lock.by} is editing this load — not imported`); continue; }
      throw e;
    }
```
and return `locked` in the result object. In `src/cli/rederive.ts` no change is needed: the per-load catch prints `load <id>: failed — Maria is editing this load` and counts `failed` (verify by reading it; if the catch discards the message, print `e.message`).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/broker-import.test.ts tests/rederive.test.ts` → PASS. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 6: The Cockpit's writes respect the load lock

**Files:**
- Create: `fleet-backend/src/lib/loadGuard.ts`
- Modify: `fleet-backend/src/routes/dispatcherAssignments.ts` (every `guardLane(...)` call site — lines ≈264, 596, 705, 751, 782, 858, 878), `fleet-backend/src/routes/dispatcherLoads.ts` (`PATCH /loads/:id`)
- Test: `fleet-backend/tests/dispatcher-assignments.test.ts` (append one), `fleet-backend/tests/dispatcher-loads.test.ts` or the suite that covers `PATCH /loads/:id` (append one)

**Interfaces:**
- Consumes: Task 1 `heldBy`.
- Produces: `export async function guardLoad(req: Request, res: Response, loadId: string): Promise<boolean>` — `false` after answering `409 { error: "LOAD_LOCKED", lock, message }` when another dispatcher holds the load.

- [ ] **Step 1: Write the failing tests**

Append to `tests/dispatcher-assignments.test.ts`, inside its main describe, reusing the file's own setup helper that yields an org, a dispatcher `auth`, a driver and an unassigned load (read the file: copy the shortest existing "assigns a load" test's setup lines verbatim, then):
```ts
  it("refuses to assign a load someone is editing on Their Board", async () => {
    // <the copied setup lines: org, auth, driver, load>
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) } });
    const res = await request(app).post("/api/dispatcher/assignments").set(auth).send({ /* the copied assign body */ });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" } });
    expect(await prisma.assignment.count({ where: { loadId: load.id } })).toBe(0);
  });
```
And for `PATCH /api/dispatcher/loads/:id` in the suite that already tests it (grep `patch(\`/api/dispatcher/loads/` under `tests/`): the same shape — a lock row for `disp-maria`, the existing PATCH body, expect 409 `LOAD_LOCKED` and the load unchanged.

- [ ] **Step 2: Run to verify they fail**

Run the two suites with `-t "someone is editing"` → FAIL (200/201 instead of 409).

- [ ] **Step 3: The guard**

`fleet-backend/src/lib/loadGuard.ts`:
```ts
import type { Request, Response } from "express";
import { prisma } from "../db.js";
import { heldBy } from "./loadLocks.js";

/** The Cockpit's half of spec §7.3: assign, replan, unassign and the load
 *  editor refuse a load another dispatcher is editing on Their Board, the
 *  same way guardLane refuses a lane another dispatcher holds. Answers the
 *  409 itself and returns false, so a route reads `if (!(await guardLoad(…))) return;`. */
export async function guardLoad(req: Request, res: Response, loadId: string): Promise<boolean> {
  const held = await heldBy(prisma, loadId);
  if (held && held.dispatcherId !== req.auth?.dispatcherId) {
    res.status(409).json({ error: "LOAD_LOCKED", lock: held, message: `${held.by} is editing this load` });
    return false;
  }
  return true;
}
```
In `dispatcherAssignments.ts`, at every `guardLane(req, res, <driverId>)` call site add, on the next line, `if (!(await guardLoad(req, res, <loadId>))) return;` — the load id in scope is the request body's load id where the assignment is being created (line ≈264; read the route's zod schema for the field name) and `assignment.loadId` at the others (line ≈878 moves an assignment to another driver: guard the assignment's load once). In `dispatcherLoads.ts`, in `PATCH /loads/:id` after the load is resolved and before any write: `if (!(await guardLoad(req, res, load.id))) return;`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/dispatcher-assignments.test.ts <the loads suite>` → PASS. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 7: Portal — API surface, the socket singleton, and the `loadLocks` store

**Files:**
- Modify: `fleet-portal/src/lib/api.ts` (`LoadLock`, four calls, `baseVersion` on `BoardCellWrite`, 409 body types)
- Create: `fleet-portal/src/lib/realtime.ts`
- Create: `fleet-portal/src/stores/loadLocks.ts`
- Test: `fleet-portal/src/lib/realtime.spec.ts`, `fleet-portal/src/stores/loadLocks.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  // api.ts
  export interface LoadLock { loadId: string; orgId: string; dispatcherId: string; by: string; since: number; expiresAt: number }
  export async function acquireLoadLock(loadId: string): Promise<{ lock: LoadLock }>     // POST /dispatcher/loads/:id/lock
  export async function heartbeatLoadLock(loadId: string): Promise<{ lock: LoadLock }>   // POST /dispatcher/loads/:id/lock/heartbeat
  export async function releaseLoadLock(loadId: string): Promise<void>                    // DELETE /dispatcher/loads/:id/lock
  export async function fetchLoadLocks(): Promise<{ locks: LoadLock[] }>                  // GET /dispatcher/load-locks
  export interface BoardCellWrite { row: BoardRow; key: BoardColumnKey; source?: string; value: string; baseVersion: number }
  export interface StaleVersionBody { error: 'STALE_VERSION'; current: number; theirs: string; load: BoardLoad }
  export interface LoadLockedBody { error: 'LOAD_LOCKED'; message: string; lock?: LoadLock; holders?: Array<{ loadId: string; loadNo: string; by: string }> }
  // lib/realtime.ts
  export type Frame = { type: string } & Record<string, unknown>
  export function subscribe(type: string, handler: (frame: Frame) => void): () => void
  export function close(): void
  export function __state(): { open: boolean; types: string[] }
  // stores/loadLocks.ts
  useLoadLocksStore(): { held, byLoad, theirs (getter), heldBy(loadId), hold(loadId), release(), refresh(), applyEvent(frame), listen(), unlisten() }
  export const LOAD_HEARTBEAT_MS = 20_000
  ```

- [ ] **Step 1: Write the failing tests**

`fleet-portal/src/lib/realtime.spec.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOKEN_STORAGE_KEY } from './constants'

// One socket per tab (spec §9): every subscriber shares it, and it closes
// when the last one leaves.
class FakeSocket {
  static instances: FakeSocket[] = []
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) { FakeSocket.instances.push(this) }
  close() { this.closed = true; this.onclose?.() }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}

describe('lib/realtime', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
    localStorage.setItem(TOKEN_STORAGE_KEY, 'tok')
  })
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

  it('opens one socket for many subscribers, routes frames by type, and closes with the last unsubscribe', async () => {
    const rt = await import('./realtime')
    const locks: unknown[] = []
    const board: unknown[] = []
    const offA = rt.subscribe('load_lock', (f) => locks.push(f))
    const offB = rt.subscribe('board_update', (f) => board.push(f))
    expect(FakeSocket.instances).toHaveLength(1)
    FakeSocket.instances[0].emit({ type: 'load_lock', loadId: 'a', by: 'Maria' })
    FakeSocket.instances[0].emit({ type: 'board_update', ids: ['a'] })
    FakeSocket.instances[0].emit('not json at all')
    expect(locks).toEqual([{ type: 'load_lock', loadId: 'a', by: 'Maria' }])
    expect(board).toEqual([{ type: 'board_update', ids: ['a'] }])
    offA()
    expect(rt.__state().open).toBe(true)
    offB()
    expect(rt.__state().open).toBe(false)
    expect(FakeSocket.instances[0].closed).toBe(true)
  })

  it('does not open without a token, and reconnects after a drop while someone still listens', async () => {
    vi.useFakeTimers()
    localStorage.removeItem(TOKEN_STORAGE_KEY)
    const rt = await import('./realtime')
    rt.subscribe('load_lock', () => {})
    expect(FakeSocket.instances).toHaveLength(0)
    localStorage.setItem(TOKEN_STORAGE_KEY, 'tok')
    rt.subscribe('load_unlock', () => {})
    expect(FakeSocket.instances).toHaveLength(1)
    FakeSocket.instances[0].onclose?.()
    vi.advanceTimersByTime(5_000)
    expect(FakeSocket.instances).toHaveLength(2)
    rt.close()
    vi.useRealTimers()
  })
})
```
`fleet-portal/src/stores/loadLocks.spec.ts`:
```ts
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api', () => ({
  acquireLoadLock: vi.fn(),
  heartbeatLoadLock: vi.fn(),
  releaseLoadLock: vi.fn(),
  fetchLoadLocks: vi.fn(),
}))
vi.mock('../lib/realtime', () => ({ subscribe: vi.fn(() => () => {}) }))

import * as api from '../lib/api'
import { LOAD_HEARTBEAT_MS, useLoadLocksStore } from './loadLocks'
import { useAuthStore } from './auth'

const lock = (loadId: string, dispatcherId: string, by: string) => ({ loadId, orgId: 'o', dispatcherId, by, since: 1, expiresAt: 61_001 })

describe('stores/loadLocks', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.useFakeTimers(); vi.mocked(api.releaseLoadLock).mockResolvedValue() })
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('holds a load, heartbeats every 20 s, and releases on demand', async () => {
    vi.mocked(api.acquireLoadLock).mockResolvedValue({ lock: lock('a', 'me', 'Me') })
    vi.mocked(api.heartbeatLoadLock).mockResolvedValue({ lock: lock('a', 'me', 'Me') })
    const s = useLoadLocksStore()
    expect(await s.hold('a')).toBe(true)
    expect(s.held).toBe('a')
    vi.advanceTimersByTime(LOAD_HEARTBEAT_MS)
    expect(api.heartbeatLoadLock).toHaveBeenCalledWith('a')
    s.release()
    expect(s.held).toBeNull()
    expect(api.releaseLoadLock).toHaveBeenCalledWith('a')
    vi.advanceTimersByTime(LOAD_HEARTBEAT_MS * 2)
    expect(api.heartbeatLoadLock).toHaveBeenCalledTimes(1)
  })

  it('reports the holder when refused, and shows only other people\'s locks as theirs', async () => {
    const auth = useAuthStore()
    auth.dispatcher = { id: 'me', email: 'me@x.com', name: 'Me' } as never
    vi.mocked(api.acquireLoadLock).mockRejectedValue({ response: { status: 409, data: { error: 'LOAD_LOCKED', lock: lock('a', 'maria', 'Maria') } } })
    const s = useLoadLocksStore()
    expect(await s.hold('a')).toBe(false)
    expect(s.heldBy('a')?.by).toBe('Maria')
    s.applyEvent({ type: 'load_lock', loadId: 'b', dispatcherId: 'me', by: 'Me', since: 5 })
    s.applyEvent({ type: 'load_lock', loadId: 'c', dispatcherId: 'jake', by: 'Jake', since: 5 })
    expect(Object.keys(s.theirs).sort()).toEqual(['a', 'c'])
    s.applyEvent({ type: 'load_unlock', loadId: 'c' })
    expect(Object.keys(s.theirs)).toEqual(['a'])
  })
})
```
(`useAuthStore().dispatcher` is the signed-in dispatcher with `id`; the cast keeps the fixture short.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd fleet-portal && npx vitest run src/lib/realtime.spec.ts src/stores/loadLocks.spec.ts` → FAIL (modules missing).

- [ ] **Step 3: API surface**

In `fleet-portal/src/lib/api.ts`: change `BoardCellWrite` to `{ row: BoardRow; key: BoardColumnKey; source?: string; value: string; baseVersion: number }` (`BoardCellPaste` inherits it); add after the lane-lock functions:
```ts
/** A load lock (spec §5.3/§7): who is editing a load on Their Board or in
 *  the Cockpit. `by` is the holder's name; `since`/`expiresAt` are epoch ms. */
export interface LoadLock { loadId: string; orgId: string; dispatcherId: string; by: string; since: number; expiresAt: number }
export async function acquireLoadLock(loadId: string): Promise<{ lock: LoadLock }> {
  const { data } = await api.post<{ lock: LoadLock }>(`/dispatcher/loads/${loadId}/lock`)
  return data
}
export async function heartbeatLoadLock(loadId: string): Promise<{ lock: LoadLock }> {
  const { data } = await api.post<{ lock: LoadLock }>(`/dispatcher/loads/${loadId}/lock/heartbeat`)
  return data
}
export async function releaseLoadLock(loadId: string): Promise<void> {
  await api.delete(`/dispatcher/loads/${loadId}/lock`)
}
export async function fetchLoadLocks(): Promise<{ locks: LoadLock[] }> {
  const { data } = await api.get<{ locks: LoadLock[] }>('/dispatcher/load-locks')
  return data
}
/** The two 409s a board write can answer with (spec §7.3, §7.4). */
export interface StaleVersionBody { error: 'STALE_VERSION'; current: number; theirs: string; load: BoardLoad }
export interface LoadLockedBody { error: 'LOAD_LOCKED'; message: string; lock?: LoadLock; holders?: Array<{ loadId: string; loadNo: string; by: string }> }
```

- [ ] **Step 4: The socket singleton**

`fleet-portal/src/lib/realtime.ts`:
```ts
import { TOKEN_STORAGE_KEY } from './constants'
import { boardWsUrl } from '../stores/loadboard'

// One socket per tab (spec §9). Stores subscribe by frame type; the socket
// opens with the first subscriber and closes with the last. `loadboard` and
// `tracking` still own their own sockets until plan A4 moves them here —
// this is the seam they move onto, not a third way of doing it.
export type Frame = { type: string } & Record<string, unknown>
type Handler = (frame: Frame) => void

const RETRY_MS = 5_000
const handlers = new Map<string, Set<Handler>>()
let socket: WebSocket | null = null
let retry: number | null = null

function open(): void {
  if (socket) return
  const token = localStorage.getItem(TOKEN_STORAGE_KEY)
  if (!token) return
  let ws: WebSocket
  try { ws = new WebSocket(boardWsUrl(token)) } catch { return }
  socket = ws
  ws.onmessage = (event) => {
    let frame: Frame
    try { frame = JSON.parse(String(event.data)) as Frame } catch { return }
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return
    for (const h of handlers.get(frame.type) ?? []) h(frame)
  }
  ws.onclose = () => {
    if (socket === ws) socket = null
    // Realtime is an enhancement: retry quietly while anyone still listens.
    if (handlers.size > 0 && retry == null) retry = window.setTimeout(() => { retry = null; open() }, RETRY_MS)
  }
  ws.onerror = () => { ws.close() }
}

export function subscribe(type: string, handler: Handler): () => void {
  let set = handlers.get(type)
  if (!set) { set = new Set(); handlers.set(type, set) }
  set.add(handler)
  open()
  return () => {
    set!.delete(handler)
    if (set!.size === 0) handlers.delete(type)
    if (handlers.size === 0) close()
  }
}

export function close(): void {
  if (retry != null) { window.clearTimeout(retry); retry = null }
  const ws = socket
  socket = null
  ws?.close()
}

export const __state = (): { open: boolean; types: string[] } => ({ open: socket !== null, types: [...handlers.keys()] })
```
(`boardWsUrl` is exported by `stores/loadboard.ts` today — `tracking.ts` imports it from there; A4 moves it into this file.)

- [ ] **Step 5: The store**

`fleet-portal/src/stores/loadLocks.ts`:
```ts
import { defineStore } from 'pinia'
import { acquireLoadLock, fetchLoadLocks, heartbeatLoadLock, releaseLoadLock, type LoadLock } from '../lib/api'
import { subscribe, type Frame } from '../lib/realtime'
import { useAuthStore } from './auth'

/** A third of the server's 60 s TTL: two heartbeats can be lost before a
 *  held load looks free to anyone else. */
export const LOAD_HEARTBEAT_MS = 20_000
const LOAD_LOCK_TTL_MS = 60_000

function lockFromError(error: unknown): LoadLock | null {
  return (error as { response?: { data?: { lock?: LoadLock } } })?.response?.data?.lock ?? null
}

interface LoadLocksState {
  /** The one load THIS tab holds and heartbeats, or null. */
  held: string | null
  /** Last known lock per load — ours and theirs — from the snapshot, the
   *  acquire/heartbeat responses and the socket. */
  byLoad: Record<string, LoadLock>
  heartbeatId: number | null
  unsubscribe: (() => void) | null
}

export const useLoadLocksStore = defineStore('loadLocks', {
  state: (): LoadLocksState => ({ held: null, byLoad: {}, heartbeatId: null, unsubscribe: null }),
  getters: {
    /** Locks held by someone other than this dispatcher — what a row badge
     *  shows and what makes a row read-only. */
    theirs(state): Record<string, LoadLock> {
      const me = useAuthStore().dispatcher?.id ?? null
      const out: Record<string, LoadLock> = {}
      for (const [id, l] of Object.entries(state.byLoad)) if (l.dispatcherId !== me) out[id] = l
      return out
    },
    heldBy: (state) => (loadId: string): LoadLock | null => state.byLoad[loadId] ?? null,
  },
  actions: {
    /** Take (or re-affirm) a load. `false` means someone else has it — their
     *  lock is recorded so the badge can name them. */
    async hold(loadId: string): Promise<boolean> {
      if (this.held === loadId && this.heartbeatId != null) return true
      if (this.held && this.held !== loadId) this.release()
      try {
        const { lock } = await acquireLoadLock(loadId)
        this.held = loadId
        this.byLoad = { ...this.byLoad, [loadId]: lock }
        this.startHeartbeat(loadId)
        return true
      } catch (error) {
        const lock = lockFromError(error)
        if (lock) this.byLoad = { ...this.byLoad, [loadId]: lock }
        return false
      }
    },
    startHeartbeat(loadId: string): void {
      this.stopHeartbeat()
      this.heartbeatId = window.setInterval(() => {
        heartbeatLoadLock(loadId)
          .then(({ lock }) => { this.byLoad = { ...this.byLoad, [loadId]: lock } })
          .catch(() => { /* the next write's baseVersion is the backstop (spec §7.4) */ })
      }, LOAD_HEARTBEAT_MS)
    },
    stopHeartbeat(): void {
      if (this.heartbeatId != null) { window.clearInterval(this.heartbeatId); this.heartbeatId = null }
    },
    /** Idempotent: releasing nothing is fine, so blur, unmount and route-leave
     *  can all call it. */
    release(): void {
      const loadId = this.held
      this.stopHeartbeat()
      this.held = null
      if (loadId == null) return
      const { [loadId]: _mine, ...rest } = this.byLoad
      this.byLoad = rest
      releaseLoadLock(loadId).catch(() => { /* the TTL releases it */ })
    },
    async refresh(): Promise<void> {
      try {
        const { locks } = await fetchLoadLocks()
        const byLoad: Record<string, LoadLock> = {}
        for (const l of locks) byLoad[l.loadId] = l
        this.byLoad = byLoad
      } catch { /* badges are a courtesy; the server still refuses */ }
    },
    applyEvent(frame: Frame): void {
      if (frame.type === 'load_lock' && typeof frame.loadId === 'string') {
        const since = Number(frame.since ?? Date.now())
        const l: LoadLock = { loadId: frame.loadId, orgId: String(frame.orgId ?? ''), dispatcherId: String(frame.dispatcherId ?? ''), by: String(frame.by ?? ''), since, expiresAt: since + LOAD_LOCK_TTL_MS }
        this.byLoad = { ...this.byLoad, [l.loadId]: l }
      } else if (frame.type === 'load_unlock' && typeof frame.loadId === 'string') {
        const { [frame.loadId]: _gone, ...rest } = this.byLoad
        this.byLoad = rest
      }
    },
    listen(): void {
      if (this.unsubscribe) return
      const offLock = subscribe('load_lock', (f) => this.applyEvent(f))
      const offUnlock = subscribe('load_unlock', (f) => this.applyEvent(f))
      this.unsubscribe = () => { offLock(); offUnlock() }
    },
    unlisten(): void { this.unsubscribe?.(); this.unsubscribe = null },
  },
})
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/realtime.spec.ts src/stores/loadLocks.spec.ts` → PASS. `npx vue-tsc --noEmit`: the `BoardCellWrite.baseVersion` change will now error at every site that builds a cell without it (grid, view, specs) — those are Task 8's; list them in the report, do not fix them here.

- [ ] **Step 7: Commit** — skipped; ledger.

---

### Task 8: Their Board — lock on edit, badges, `baseVersion`, keep mine / take theirs

**Files:**
- Modify: `fleet-portal/src/components/broker/BrokerGrid.vue` (props, emits, `openEditor`/`commitEdit`/`cancelEdit`, cell builders, row markup, styles, `defineExpose`)
- Modify: `fleet-portal/src/stores/brokerBoard.ts` (`conflict`, `editCell`/`pasteCells` catches, `resolveConflict`)
- Modify: `fleet-portal/src/views/BrokerBoardView.vue` (hold/release around an edit, conflict panel, `locks` prop)
- Test: `fleet-portal/src/components/broker/BrokerGrid.locks.spec.ts` (new), `src/stores/brokerBoard.spec.ts` (append), `src/views/BrokerBoardView.spec.ts` (append); existing grid specs that assert the `edit`/`paste` payload shape gain `baseVersion`

**Interfaces:**
- Consumes: Task 7 (`LoadLock`, `useLoadLocksStore`, 409 body types, `baseVersion`).
- Produces: grid props `locks?: Record<string, LoadLock>`; emits `edit-start (loadId)`, `edit-end (loadId)`; every emitted `BoardCellPaste` carries `baseVersion: load.version`; exposed `cancelEdit()`; store `conflict`, `resolveConflict('mine' | 'theirs')`; DOM hooks `[data-lock-badge]`, `tr[data-locked]`, `[data-conflict]`, `[data-keep-mine]`, `[data-take-theirs]`.

- [ ] **Step 1: Write the failing tests**

`fleet-portal/src/components/broker/BrokerGrid.locks.spec.ts`:
```ts
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { BoardColumn, BoardLoad, LoadLock } from '../../lib/api'
import BrokerGrid from './BrokerGrid.vue'

const layout: BoardColumn[] = [{ key: 'bol', label: 'BOL#' }, { key: 'customer', label: 'CUSTOMER /CARRIER' }]
const mk = (id: string, bol: string, version: number): BoardLoad =>
  ({ id, line: 1, top: { bol, customer: 'ACME' }, bottom: null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: Number(bol), version })
const loads = [mk('a', '1', 3), mk('b', '2', 0)]
const maria: LoadLock = { loadId: 'a', orgId: 'o', dispatcherId: 'maria', by: 'Maria', since: 1, expiresAt: 61_001 }
const cell = (w: ReturnType<typeof mount>, id: string) => w.find(`tr[data-load="${id}"][data-row="top"] td[data-col]:nth-of-type(3)`)

describe('the lock on a row', () => {
  it('shows who is editing, refuses to open an editor there, and says so', async () => {
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000, locks: { a: maria } }, attachTo: document.body })
    expect(w.find('tr[data-load="a"][data-row="top"]').attributes('data-locked')).toBe('Maria')
    expect(w.find('tr[data-load="a"] [data-lock-badge]').attributes('title')).toBe('Maria is editing this load')
    expect(w.find('tr[data-load="b"] [data-lock-badge]').exists()).toBe(false)
    await cell(w, 'a').trigger('dblclick')
    expect(w.find('[data-cell-editor]').exists()).toBe(false)
    expect(w.emitted('notice')?.[0]).toEqual(['Maria is editing this load'])
    expect(w.emitted('edit-start')).toBeUndefined()
    w.unmount()
  })

  it('announces an edit, carries the version it rendered, and announces the end on commit and on cancel', async () => {
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000 }, attachTo: document.body })
    await cell(w, 'a').trigger('dblclick')
    expect(w.emitted('edit-start')?.[0]).toEqual(['a'])
    const input = w.find('[data-cell-editor]')
    await input.setValue('BETA')
    await input.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('edit')?.[0]?.[0]).toMatchObject({ loadId: 'a', key: 'customer', value: 'BETA', baseVersion: 3 })
    expect(w.emitted('edit-end')?.[0]).toEqual(['a'])
    await cell(w, 'b').trigger('dblclick')
    await w.find('[data-cell-editor]').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('edit-end')?.[1]).toEqual(['b'])
    expect(w.emitted('edit')).toHaveLength(1)
    w.unmount()
  })
})
```
Append to `src/stores/brokerBoard.spec.ts` (it mocks `../lib/api`'s `api` axios instance; follow the file's existing pattern for `api.patch`):
```ts
describe('the version backstop in the store', () => {
  it('turns STALE_VERSION into a conflict, re-bases on keep mine, and swaps the row on take theirs', async () => {
    const fresh = { id: 'a', version: 4, top: { customer: 'THEIRS' } } as unknown as BoardLoad
    vi.mocked(api.patch).mockRejectedValueOnce({ response: { status: 409, data: { error: 'STALE_VERSION', current: 4, theirs: 'THEIRS', load: fresh } } })
    const s = useBrokerBoardStore()
    s.loads = [{ id: 'a', version: 3, top: { customer: 'OLD' } } as unknown as BoardLoad]
    expect(await s.editCell('a', { row: 'top', key: 'customer', value: 'MINE', baseVersion: 3 })).toBe(false)
    expect(s.conflict).toMatchObject({ loadId: 'a', current: 4, theirs: 'THEIRS' })
    expect(s.error).toBeNull()
    vi.mocked(api.patch).mockResolvedValueOnce({ data: { load: { ...fresh, version: 5, top: { customer: 'MINE' } }, version: 5, statusRefused: null } })
    expect(await s.resolveConflict('mine')).toBe(true)
    expect(vi.mocked(api.patch).mock.calls.at(-1)?.[1]).toMatchObject({ value: 'MINE', baseVersion: 4 })
    expect(s.conflict).toBeNull()
    vi.mocked(api.patch).mockRejectedValueOnce({ response: { status: 409, data: { error: 'STALE_VERSION', current: 6, theirs: 'NEWER', load: { ...fresh, version: 6 } } } })
    await s.editCell('a', { row: 'top', key: 'customer', value: 'X', baseVersion: 5 })
    expect(await s.resolveConflict('theirs')).toBe(true)
    expect(s.loads[0].version).toBe(6)
  })

  it('reports a held load by name, for a cell and for a paste', async () => {
    vi.mocked(api.patch).mockRejectedValueOnce({ response: { status: 409, data: { error: 'LOAD_LOCKED', message: 'Maria is editing this load', lock: { by: 'Maria' } } } })
    const s = useBrokerBoardStore()
    expect(await s.editCell('a', { row: 'top', key: 'customer', value: 'X', baseVersion: 0 })).toBe(false)
    expect(s.error).toBe('Maria is editing this load')
    vi.mocked(api.post).mockRejectedValueOnce({ response: { status: 409, data: { error: 'LOAD_LOCKED', message: 'Maria is editing 0563272 — try again when the badge clears', holders: [] } } })
    expect(await s.pasteCells([{ loadId: 'a', row: 'top', key: 'customer', value: 'X', baseVersion: 0 }])).toBe(false)
    expect(s.error).toBe('Maria is editing 0563272 — try again when the badge clears')
  })
})
```
Append to `src/views/BrokerBoardView.spec.ts` (follow its existing mounting pattern — it stubs the store and the grid; if the view is mounted with a real store, set state directly):
```ts
it('offers keep mine / take theirs when a cell collides with a newer version', async () => {
  const w = mountView()
  const store = useBrokerBoardStore()
  store.conflict = { loadId: 'a', write: { row: 'top', key: 'customer', value: 'MINE', baseVersion: 3 }, current: 4, theirs: 'THEIRS', load: { id: 'a', version: 4 } as never }
  await nextTick()
  expect(w.find('[data-conflict]').text()).toContain('MINE')
  expect(w.find('[data-conflict]').text()).toContain('THEIRS')
  const resolve = vi.spyOn(store, 'resolveConflict').mockResolvedValue(true)
  await w.find('[data-keep-mine]').trigger('click')
  expect(resolve).toHaveBeenCalledWith('mine')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/broker/BrokerGrid.locks.spec.ts src/stores/brokerBoard.spec.ts src/views/BrokerBoardView.spec.ts` → the new tests FAIL.

- [ ] **Step 3: The grid**

In `BrokerGrid.vue`:
- Props: add `/** Locks held by OTHER people, by load id: a badge on the row and no editor there. */ locks?: Record<string, LoadLock>` with default `() => ({})`; import the `LoadLock` type from `../../lib/api`.
- Emits: add `(e: 'edit-start', loadId: string): void` and `(e: 'edit-end', loadId: string): void`.
- Script, after `const col = …`:
  ```ts
  /** Who holds the row, if it is not us (spec §7.3): the badge and the refusal. */
  const lockedBy = (l: BoardLoad): string | null => props.locks?.[l.id]?.by ?? null
  ```
- `openEditor`: after the `agent`/`profit` guard add
  ```ts
  const by = lockedBy(load)
  if (by) { emit('notice', `${by} is editing this load`); return }
  emit('edit-start', load.id)
  ```
- `commitEdit`: it already has `load`; every emitted write gains `baseVersion: load.version`; after the `if (load && id && …)` block add `if (load) emit('edit-end', load.id)`.
- `cancelEdit`: `const cancelEdit = () => { const e = editing.value; editing.value = null; if (e) { const l = loadAt(e.r); if (l) emit('edit-end', l.id) } scroller.value?.focus() }`.
- Every other place a `BoardCellPaste` literal is built (`loadId: load.id, …` at ≈378 and the fill/bulk builders — `vue-tsc` lists them all once `baseVersion` is required): add `baseVersion: load.version` (look the load up by id where only the id is in scope: `loadById(id)?.version ?? 0`, using the grid's existing id→load map).
- Top-line `<tr>`: add `:data-locked="lockedBy((flat[item.index] as LoadRow).load) || undefined"`. In the checkbox gutter `<td>` after the `<input>`: `<span v-if="lockedBy((flat[item.index] as LoadRow).load)" data-lock-badge class="bb-lock" :title="lockedBy((flat[item.index] as LoadRow).load) + ' is editing this load'" aria-label="being edited by someone else">✎</span>`.
- Styles: `.bb-lock { margin-left: 3px; font-size: 10px; line-height: 1; color: var(--bb-accent); }` and `.bb-row[data-locked] .bb-cell { color: color-mix(in oklab, currentColor 70%, transparent); }`.
- `defineExpose`: add `cancelEdit`.
- Existing specs that assert the exact `edit`/`paste` payload now expect `baseVersion` (`BrokerGrid.edit.spec.ts` `mk()` builds loads without `version` — add `version: 0` to its `mk` and to the other spec fixtures that `vue-tsc` flags).

- [ ] **Step 4: The store**

In `stores/brokerBoard.ts`: state `conflict: null as null | { loadId: string; write: BoardCellWrite; current: number; theirs: string; load: BoardLoad }`. In `editCell`'s `catch`, before the generic message:
```ts
        const body = (e as { response?: { data?: Partial<StaleVersionBody & LoadLockedBody> } })?.response?.data
        if (body?.error === 'STALE_VERSION' && body.load) {
          // Both values, nothing written (spec §7.4): the panel offers keep mine / take theirs.
          this.conflict = { loadId, write, current: body.current ?? 0, theirs: body.theirs ?? '', load: body.load }
          return false
        }
        if (body?.error === 'LOAD_LOCKED') { this.error = body.message ?? 'Someone is editing that load'; return false }
```
Add the action:
```ts
    /** keep mine re-sends the same cell on the version that refused it; take
     *  theirs swaps in the fresh row the refusal carried. Either way the
     *  conflict is over. */
    async resolveConflict(choice: 'mine' | 'theirs'): Promise<boolean> {
      const c = this.conflict
      if (!c) return true
      this.conflict = null
      if (choice === 'theirs') { this.replaceLoads([c.load]); return true }
      return this.editCell(c.loadId, { ...c.write, baseVersion: c.current })
    },
```
In `pasteCells`'s `catch`, before the generic message: `LOAD_LOCKED` → `this.error = body.message`; `STALE_VERSION` → `this.error = body.message ?? 'Some rows changed since you copied them — reload the board and paste again'; await this.load()`; both `return false`. Import the two body types from `../lib/api`.

- [ ] **Step 5: The view**

In `BrokerBoardView.vue`: `import { useLoadLocksStore } from '../stores/loadLocks'`; `const loadLocks = useLoadLocksStore()`; `onMounted(() => { void loadLocks.refresh(); loadLocks.listen() })`, `onBeforeUnmount(() => { loadLocks.release(); loadLocks.unlisten() })`. Replace `onEdit` and add the two handlers:
```ts
let lastSave: Promise<boolean> | null = null
const onEdit = (write: BoardCellPaste) => { lastSave = store.editCell(write.loadId, { row: write.row, key: write.key, source: write.source, value: write.value, baseVersion: write.baseVersion }) }
async function onEditStart(loadId: string) {
  if (await loadLocks.hold(loadId)) return
  // Someone else has it: the editor closes and the row says who.
  store.error = `${loadLocks.heldBy(loadId)?.by ?? 'Someone'} is editing this load`
  grid.value?.cancelEdit()
}
function onEditEnd() {
  // The lock outlives the editor by exactly one save: released once the
  // write has landed — or, on a version conflict, once the dispatcher has
  // chosen (resolveConflict below), so nobody grabs the row mid-decision.
  const p = lastSave ?? Promise.resolve(true)
  lastSave = null
  void p.finally(() => { if (!store.conflict) loadLocks.release() })
}
const resolve = async (choice: 'mine' | 'theirs') => { await store.resolveConflict(choice); loadLocks.release() }
```
Template: on `<BrokerGrid …>` add `:locks="loadLocks.theirs" @edit-start="onEditStart" @edit-end="onEditEnd"`. Above the grid, next to the refusal notice:
```vue
    <div v-if="store.conflict" data-conflict class="flex flex-wrap items-center gap-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-500 dark:bg-amber-950/40 dark:text-amber-200">
      <span>This cell changed while you were typing — yours: <b>{{ store.conflict.write.value }}</b> · theirs: <b>{{ store.conflict.theirs }}</b></span>
      <button type="button" data-keep-mine class="rounded border border-amber-400 px-2 py-0.5 font-semibold hover:bg-amber-100" @click="resolve('mine')">Keep mine</button>
      <button type="button" data-take-theirs class="rounded border border-amber-400 px-2 py-0.5 font-semibold hover:bg-amber-100" @click="resolve('theirs')">Take theirs</button>
    </div>
```

- [ ] **Step 6: Run the portal tests, then the type check**

Run: `npx vitest run src/components/broker src/stores src/views` → PASS (including the fixtures updated for `baseVersion`/`version`). `npx vue-tsc --noEmit` clean.

- [ ] **Step 7: Commit** — skipped; ledger.

---

### Task 9: The Cockpit gesture holds the load lock beside the lane lock

**Files:**
- Modify: `fleet-portal/src/stores/cockpit.ts` (`runGesture`; new `toastLoadLockRefused`)
- Test: `fleet-portal/src/stores/cockpit.spec.ts` (append)

**Interfaces:**
- Consumes: Task 7 `useLoadLocksStore`.
- Produces: a gesture on a load someone is editing on Their Board never reaches dry-run; the toast names them; the load lock is released when the gesture settles.

- [ ] **Step 1: Write the failing test**

Append to `src/stores/cockpit.spec.ts`, inside its `runGesture` describe (the file mocks `./locks`' `hold`/`heldBy`; mock `./loadLocks` the same way):
```ts
  it('takes the load lock beside the lane lock, refuses by name when Their Board holds it, and releases when the gesture settles', async () => {
    const loadLocks = useLoadLocksStore()
    const hold = vi.spyOn(loadLocks, 'hold').mockResolvedValue(false)
    loadLocks.byLoad = { L1: { loadId: 'L1', orgId: 'o', dispatcherId: 'maria', by: 'Maria', since: 1, expiresAt: 61_001 } }
    const call = vi.fn()
    const s = useCockpitStore()
    await s.runGesture('lane-1', 'L1', call)
    expect(hold).toHaveBeenCalledWith('L1')
    expect(call).not.toHaveBeenCalled()
    expect(s.toasts.at(-1)?.text ?? s.lastToast).toMatch(/Maria is editing/)
    hold.mockResolvedValue(true)
    const release = vi.spyOn(loadLocks, 'release')
    call.mockResolvedValue({ feasible: true } as never)
    await s.runGesture('lane-1', 'L1', call)
    expect(release).toHaveBeenCalled()
  })
```
(Read the file for how existing tests observe a toast — `s.toasts`, `s.lastToast`, or a spy on `toastLockRefused` — and use that exact hook instead of the `??` guess.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/stores/cockpit.spec.ts -t "load lock beside the lane lock"` → FAIL.

- [ ] **Step 3: Hold both**

In `stores/cockpit.ts`: `import { useLoadLocksStore } from './loadLocks'`. In `runGesture`, right after the lane-lock refusal block:
```ts
      // Spec §7.2: the load lock beside the lane lock — a load someone is
      // editing on Their Board is not moved under their cursor.
      const loadLocks = useLoadLocksStore()
      if (!(await loadLocks.hold(loadId))) {
        locks.release()
        this.toastLoadLockRefused(loadLocks.heldBy(loadId))
        return
      }
      try {
        // …the existing try body, unchanged…
      } catch (error) {
        // …unchanged…
      } finally {
        loadLocks.release()
      }
```
Add `toastLoadLockRefused(lock: LoadLock | null)` next to `toastLockRefused`, built exactly the way that one is (same toast call, same tone) with the text `${lock?.by ?? 'Someone'} is editing this load on Their Board`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/stores/cockpit.spec.ts` → PASS. `npx vue-tsc --noEmit` clean.

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 10: Live check — two dispatchers, one board

**Files:** none (verification).

- [ ] **Step 1: Two tabs**

With both dev servers up, open two browser contexts on `http://localhost:5173/board/broker` as `d@fleet.com` / `pass123` (the same dispatcher in two tabs shares an id, so create a second dispatcher in the demo org first: `docker exec fleet-postgres psql -U fleet -d fleet -c "insert into \"Dispatcher\" (id,email,\"passwordHash\",name,\"orgId\",\"createdAt\",\"updatedAt\") select gen_random_uuid(),'maria@fleet.com',\"passwordHash\",'Maria',\"orgId\",now(),now() from \"Dispatcher\" where email='d@fleet.com'"` — same password hash, so `pass123`; delete the row when done). In tab A (Maria) double-click a CUSTOMER cell on a MEIBORG row and leave the editor open. Expected in tab B within a second: the row carries the ✎ badge with title "Maria is editing this load"; double-clicking any cell on that row does not open an editor and the notice says so; pasting a block that covers that row answers "Maria is editing <LOAD#> — try again when the badge clears" and nothing lands.
- Press Escape in tab A: the badge clears in tab B.
- Version backstop: in tab B change a cell on another row and commit; in tab A open the SAME cell (it rendered the old version), type, commit: the conflict panel shows yours/theirs; "Take theirs" swaps the row in; "Keep mine" writes on the new version.
- Screenshot both tabs into the scratchpad; delete the Maria row; note the results in the ledger.

- [ ] **Step 2: Commit** — skipped; ledger.

---

## Self-review

- **Spec coverage:** §5.3 model — Task 1. §7.1 shape, TTL 60 s, heartbeat 20 s, release on commit/cancel/socket close, events — Tasks 1, 3, 7, 8. §7.2 one cell (Task 8), paste/bulk inside the transaction with the refusal naming holder + LOAD#s (Task 4), Cockpit gesture (Tasks 6, 9), import per row (Task 5). §7.3 server-side 409 in the writer (Task 2) and on every other write path (Tasks 4, 6); badge + read-only rows (Task 8). §7.4 `baseVersion` on every board write, `STALE_VERSION { current, theirs }`, keep mine / take theirs, import/backfill skip (Tasks 2, 4, 8). §13 lock routes (Task 3), `baseVersion` in bodies (Task 4). §14: writer lock + baseVersion (Task 2); lock acquire/heartbeat/expiry/release-on-disconnect (Tasks 1, 3); paste refused naming the holder (Task 4); `STALE_VERSION` on an expired lock (Task 2's expiry test + Task 4's cell test); one socket per tab (Task 7); badges and the paste refusal naming LOAD#s (Tasks 4, 8); live acceptance (Task 10). Not in this plan, by design: the Cockpit brick badge (A3), `?ids=` patching and the two legacy sockets (A4).
- **Placeholders:** none — every step carries its code; the two "copy the file's own setup" instructions in Tasks 6 and 9 point at existing code in the same file, not at another task.
- **Type consistency:** `LoadLockRow { loadId, orgId, dispatcherId, by, since, expiresAt }` (backend) ⇄ `LoadLock` (portal, same fields); `acquireLoadLock(tx, Holder)` used by Tasks 3 and 4; `assertWritable(tx, loadId, dispatcherId | null)` used by Tasks 2, 4; `guardLoad` (Task 6) reads `heldBy`; `baseVersion` is optional on `ApplyArgs` (Task 2) and required on `BoardCellWrite` (Task 7) and in `cellSchema` (Task 4); `StaleVersion { current, base }` → route body `{ current, theirs }` (Task 4) → store `conflict { current, theirs, load }` (Task 8).
