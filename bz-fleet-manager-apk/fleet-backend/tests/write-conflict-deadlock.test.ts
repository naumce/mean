import request from "supertest";
import type { Response } from "express";
import { Prisma } from "@prisma/client";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { __resetLocks } from "../src/lib/locks.js";
import { respondToWriteConflict } from "../src/lib/writeConflict.js";

// A Postgres DEADLOCK (SQLSTATE 40P01) does NOT arrive as a
// PrismaClientKnownRequestError. It comes back as a
// PrismaClientUnknownRequestError wrapping a ConnectorError, with `code`
// undefined and the SQLSTATE only present in the message text — so
// respondToWriteConflict()'s `instanceof PrismaClientKnownRequestError` branch
// never saw it, `throw err` ran out of an async Express 4 handler, and NO HTTP
// RESPONSE WAS EVER SENT. That is verbatim the failure lib/writeConflict.ts's
// header comment exists to prevent, and it is reachable in production without
// any test harness: POST /assignments' commit transaction writes
// Assignment -> Rate -> Load -> ... -> HosState while unassign() writes
// HosState -> ... -> Load -> Assignment, so two dispatchers working the same
// driver and load take the same row locks in opposite orders.
//
// Both tests below induce a REAL deadlock — two transactions, opposite lock
// order, Postgres's own detector — rather than throwing a hand-built error
// object. A fabricated error would have whatever shape the test gave it, and
// the shape IS the bug: it would have "passed" against the broken code.
//
// Making the victim deterministic: Postgres aborts whichever backend's
// deadlock_timeout fires first and finds a cycle. Every blocking transaction
// here therefore raises its OWN deadlock_timeout (SET LOCAL, session-scoped to
// the interactive transaction's connection), so the transaction under test —
// still on the 1s default — is always the one that detects and dies.

beforeEach(async () => {
  await resetDb();
  __resetLocks();
});

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const FAR = new Date("2027-01-01T00:00:00.000Z");

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let seq = 0;

// Same fixture shape as tests/tender-commit.test.ts's seed() — driver parked
// on the pickup, so the plan is feasible and the commit reaches its
// transaction rather than being refused up front.
async function seed() {
  seq += 1;
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const dispatcher = await prisma.dispatcher.create({
    data: { email: `dl-disp${seq}@x.com`, passwordHash: "x", name: "D", orgId: org.id },
  });
  const driver = await prisma.driver.create({
    data: {
      email: `dl-drv${seq}@x.com`, passwordHash: "x", name: "Jake", orgId: org.id,
      hazmatEndorsed: true, lastLat: KC.lat, lastLng: KC.lng,
      hos: { create: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 } },
    },
  });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: `T-${seq}`, status: "active" } });
  const trailer = await prisma.trailer.create({
    data: { orgId: org.id, unit: `RF-${seq}`, type: "Reefer", status: "active" },
  });
  const load = await prisma.load.create({
    data: {
      orgId: org.id, requiredEquip: "Reefer", revenueCents: 30000, fscCents: 4000, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "KC dock", lat: KC.lat, lng: KC.lng,
            appointment: { create: { windowEnd: FAR, type: "pickup" } } },
          { sequence: 2, type: "delivery", address: "Omaha dock", lat: OMAHA.lat, lng: OMAHA.lng,
            appointment: { create: { windowEnd: FAR, type: "delivery" } } },
        ],
      },
    },
  });
  return { org, driver, tractor, trailer, load, auth: `Bearer ${signDispatcherAccess(dispatcher.id)}` };
}

/** Block until some OTHER backend in this run's schema is waiting on a lock
 *  for `table`. The schema name is per-vitest-process (vitest.config.ts), so
 *  this can never observe a concurrent run's backends. */
async function waitUntilBlockedOn(table: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock'
          and pid <> pg_backend_pid()
          and query like '%"' || current_schema() || '"."${table}"%'`,
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error(`no backend ever blocked on ${table}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

it(
  "a REAL Postgres deadlock inside POST /assignments answers 409 — not silence",
  async () => {
    const { driver, tractor, trailer, load, auth } = await seed();

    const holdsHos = deferred();
    const releaseBlocker = deferred();
    let blockerErr: unknown = null;

    // The opposite-order writer: it takes HosState FIRST and Load SECOND,
    // which is exactly what unassign() does. The commit transaction takes them
    // the other way round.
    const blocker = prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL deadlock_timeout = '20s'");
          await tx.hosState.update({ where: { driverId: driver.id }, data: { minutesSinceBreak: 1 } });
          holdsHos.resolve();
          await releaseBlocker.promise;
          await tx.load.update({ where: { id: load.id }, data: { commodity: "blocked" } });
        },
        { timeout: 30000, maxWait: 20000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((err: unknown) => {
        blockerErr = err;
      });

    await holdsHos.promise;

    // Dispatch the request without awaiting it: superagent sends on .then().
    const pending = request(app)
      .post("/api/dispatcher/assignments")
      .set("authorization", auth)
      .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id })
      .then((r) => r);

    // The commit has now taken the Load row and is stuck on HosState.
    await waitUntilBlockedOn("HosState");
    // Close the cycle: the blocker now wants the Load the commit holds.
    releaseBlocker.resolve();

    // Race the response against a silence window. Without the fix the handler
    // rethrows into an un-awaited async Express handler and this resolves
    // "silence" — which is the production symptom (a spinning button), not a
    // slow test.
    const SILENCE_MS = 10000;
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      pending.then((res) => ({ kind: "response" as const, status: res.status, body: res.body as { error?: string } })),
      new Promise<{ kind: "silence" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "silence" }), SILENCE_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    await blocker;

    expect(outcome.kind, `no HTTP response within ${SILENCE_MS}ms — the deadlock went unmapped`).toBe("response");
    if (outcome.kind !== "response") return;
    expect(outcome.status).toBe(409);
    // The write-conflict wording, not the "row vanished" one: a deadlock is a
    // concurrent-write loss the client retries, exactly like P2034.
    expect(outcome.body.error).toBe("A concurrent commit touched this driver or load — retry");

    // The commit rolled back whole: no half-written assignment behind the 409.
    expect(await prisma.assignment.count({ where: { loadId: load.id } })).toBe(0);
    // ...and the OTHER transaction was allowed to finish, which is what makes
    // this a deadlock (one victim) rather than both sides failing.
    expect(blockerErr).toBeNull();
  },
  30000,
);

it(
  "a genuine 40P01 is a PrismaClientUnknownRequestError, and respondToWriteConflict maps it to 409",
  async () => {
    // Documents the exact shape the mapper has to match. The error object
    // below is produced by Postgres, never constructed here: `code` is
    // undefined (so no `err.code === "P2034"` test can ever see it) and the
    // SQLSTATE lives only in the message.
    const a = await prisma.driver.create({
      data: {
        email: "dl-a@x.com", passwordHash: "x", name: "A",
        hos: { create: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 } },
      },
    });
    const b = await prisma.driver.create({
      data: {
        email: "dl-b@x.com", passwordHash: "x", name: "B",
        hos: { create: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 } },
      },
    });

    const patientHolds = deferred();
    const victimHolds = deferred();
    const cross = deferred();
    let victimErr: unknown = null;
    let patientErr: unknown = null;

    const patient = prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL deadlock_timeout = '20s'");
          await tx.hosState.update({ where: { driverId: a.id }, data: { minutesSinceBreak: 1 } });
          patientHolds.resolve();
          await cross.promise;
          await tx.hosState.update({ where: { driverId: b.id }, data: { minutesSinceBreak: 2 } });
        },
        { timeout: 30000, maxWait: 20000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((err: unknown) => {
        patientErr = err;
      });

    const victim = prisma
      .$transaction(
        async (tx) => {
          await tx.hosState.update({ where: { driverId: b.id }, data: { minutesSinceBreak: 3 } });
          victimHolds.resolve();
          await cross.promise;
          await tx.hosState.update({ where: { driverId: a.id }, data: { minutesSinceBreak: 4 } });
        },
        { timeout: 30000, maxWait: 20000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((err: unknown) => {
        victimErr = err;
      });

    await Promise.all([patientHolds.promise, victimHolds.promise]);
    cross.resolve();
    await Promise.all([patient, victim]);

    expect(patientErr).toBeNull();
    expect(victimErr).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    // The two facts that broke the old mapper.
    expect(victimErr).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((victimErr as Prisma.PrismaClientUnknownRequestError).message).toContain("40P01");

    let status = 0;
    let payload: { error?: string } = {};
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(body: { error?: string }) {
        payload = body;
        return this;
      },
    } as unknown as Response;

    expect(respondToWriteConflict(res, victimErr, "irrelevant here")).toBe(true);
    expect(status).toBe(409);
    expect(payload.error).toBe("A concurrent commit touched this driver or load — retry");
  },
  30000,
);
