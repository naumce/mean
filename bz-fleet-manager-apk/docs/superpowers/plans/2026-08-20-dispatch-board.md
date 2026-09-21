# Dispatch Board (Bertschi-inspired) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the fleet portal's landing page into a time-axis **dispatch board** — the control-room view where a dispatcher sees every driver as a lane and every trip as a time-positioned brick.

**Architecture:** A thin backend change (planned schedule fields on Trip + a board-read endpoint + a dispatcher WebSocket channel that connects but doesn't yet push) plus a Vue 3/Pinia board built on a ported, pure-function time↔pixel geometry core (lifted from Bertschi's `useBrick`/`useBoardBrickCalculus`, rewritten for Vue 3). This first increment is **read-only**: it renders trips on lanes by time. Drag-to-plan, real-time, occupancy, fleet-actions, locking, and search each land in later increments.

**Tech Stack:** Backend — Node 22, TypeScript ESM (strict, `.js` import specifiers), Express 4, Prisma 5 + SQLite, Zod, Vitest + Supertest. Portal — Vue 3 (`<script setup>`, TS), Pinia (setup stores), Vue Router, Tailwind v3, axios; Vitest + jsdom + @vue/test-utils.

**Spec:** `docs/BERTSCHI-TEARDOWN.md` (the teardown this program argues from — §4 crown jewels, §6 adoption map) + this repo's `SESSION-STATE.json` (current stack, conventions, security invariants).

## Global Constraints

- Backend is TypeScript ESM: **all relative imports use `.js` specifiers** (e.g. `import { prisma } from "../db.js"`). Strict mode; no `any` in new code.
- Run backend tests with `npx vitest run` (NOT `npm test` — it intermittently segfaults in this Windows shell). Portal gate: `npx vitest run` + `npx vue-tsc --noEmit` + `npm run build`.
- Security invariants stay intact: dispatcher routes sit under `dispatcherRouter` (already `requireAuth` + `requireDispatcher`); the driver realtime channel and driver ownership filters are untouched.
- Geometry code is **pure functions** — no `Date.now()`, no module-level clock, no DOM reads inside the math. Time and board width are passed in, so every function is deterministic and unit-testable.
- Frontend stack is **Vue 3 + Pinia** — port Bertschi's *concepts and math*, never its Vue 2 / Vuex code verbatim.
- Tailwind palette stays as-is (primary `#2563eb`); no new CDN fonts/assets.
- Commit after every task with a `feat:`/`test:`/`chore:` message (no attribution footer — disabled globally).

---

## Program Roadmap (context — only INC-1 is detailed below)

- **INC-1 (this plan): Board data foundation + read-only board dashboard.** Planned schedule on Trip, board-read endpoint, dispatcher WS channel (connect-only), ported geometry core, read-only BoardView made the dashboard.
- **INC-2: Drag-to-plan.** Drag a trip onto a driver lane + time → persists (assign + reschedule) via a `PATCH /dispatcher/trips/:id/plan` endpoint returning the `{info,warnings,errors}` validation-details protocol.
- **INC-3: Real-time.** Dispatcher WS channel pushes trip/plan changes; board updates live with `viaSocket`/`viaLocal` echo suppression.
- **INC-4: Occupancy guard.** Grey "busy/off-shift" blocks + drop rejection on double-booking.
- **INC-5: Fleet actions.** Maintenance/leave/break blocks as non-trip bricks on the same timeline.
- **INC-6: Locking + presence.** `lockedBy` + lock/unlock endpoints + "locked by X" toast.
- **INC-7: Search + saved views.** flexsearch spotting/focus + per-dispatcher board profiles.
- **INC-M: Live geographic map.** Replace the mockup's schematic SVG network with a real slippy map (proper tile provider + **server-side geocoded addresses** + live driver positions + optional road-routed polylines), hardened for production. **Full hardened spec at the end of this document ("Increment M — Live Map").**

> **Note — the mockup is now the richer visual spec.** After this plan was written, an interactive front-end
> mockup (`mockups/dispatch-board.html`, published as an Artifact; see the `dispatch-board-mockup` memory) grew
> well beyond INC-1..7: separate tractor/trailer/driver pools, trailer types, equipment/HOS/hazmat/IFTA
> compliance, per-load rate/RPM/margin economics + FSC, auto-dispatch, a tender accept/reject flow, driver
> messaging, and Board/Map/Market/Money/Fuel views. **Treat that mockup as the authoritative visual + behaviour
> spec** and re-scope the increments against it before building. INC-1's geometry core and backend foundation
> still stand as the correct starting point.

---

## File Structure (INC-1)

- Backend
  - Modify `fleet-backend/prisma/schema.prisma` — add `scheduledStart`/`scheduledEnd` to `Trip`.
  - New migration under `fleet-backend/prisma/migrations/`.
  - Modify `fleet-backend/src/routes/dispatcherTrips.ts` — accept optional schedule on create; return schedule fields.
  - New `fleet-backend/src/routes/dispatcherBoard.ts` — `GET /dispatcher/board` (lanes + windowed trips).
  - Mount it in `fleet-backend/src/routes/dispatcher.ts` (or wherever `dispatcherRouter` composes sub-routers — verify at task time).
  - Modify `fleet-backend/src/realtime.ts` — add a dispatcher registry + `emitToDispatchers` + accept dispatcher tokens (connect-only this increment).
  - Modify `fleet-backend/seed-demo.mjs` — give demo trips schedules across an operating day.
  - Tests: `fleet-backend/tests/dispatcher-board.test.ts`, additions to `fleet-backend/tests/dispatcher-trips.test.ts`, `fleet-backend/tests/realtime-dispatcher.test.ts`.
- Portal
  - New `fleet-portal/src/lib/board/geometry.ts` — pure time↔pixel core + `BoardConfig` type.
  - New `fleet-portal/src/stores/board.ts` — Pinia store: viewport + geometry getters + data fetch.
  - New `fleet-portal/src/views/BoardView.vue` — the board (lanes, time ruler, trip bricks). Read-only.
  - New `fleet-portal/src/components/board/TripBrick.vue`, `TimeRuler.vue`, `FleetLane.vue`.
  - Modify `fleet-portal/src/router/index.ts` — `/` (name `dashboard`) → `BoardView`.
  - Modify `fleet-portal/src/lib/api.ts` only if a typed helper is warranted (else call through existing client).
  - Tests: `geometry.spec.ts`, `stores/board.spec.ts`, `views/BoardView.spec.ts`, router spec addition.

---

### Task 1: Trip planned-schedule fields + migration

**Files:**
- Modify: `fleet-backend/prisma/schema.prisma` (the `Trip` model)
- Create: migration via `prisma migrate dev`
- Test: `fleet-backend/tests/dispatcher-trips.test.ts` (add cases)

**Interfaces:**
- Consumes: existing `Trip` model, `dispatcherTripsRouter` create/list handlers.
- Produces: `Trip.scheduledStart: DateTime?`, `Trip.scheduledEnd: DateTime?` (nullable ISO datetimes) present on every trip create/list/get response; create accepts optional `scheduledStart`/`scheduledEnd` ISO strings.

- [ ] **Step 1: Write the failing test** — append to `fleet-backend/tests/dispatcher-trips.test.ts`:

```ts
it("creates a trip with a planned schedule and returns it on the trip", async () => {
  const auth = await dispatcherAuth();
  const res = await request(app).post("/api/dispatcher/trips").set("authorization", auth).send({
    identifier: "TR-SCHED-1",
    stops: [{ sequence: 1, address: "A St" }],
    scheduledStart: "2026-08-21T08:00:00.000Z",
    scheduledEnd: "2026-08-21T11:00:00.000Z",
  });
  expect(res.status).toBe(201);
  expect(res.body.scheduledStart).toBe("2026-08-21T08:00:00.000Z");
  expect(res.body.scheduledEnd).toBe("2026-08-21T11:00:00.000Z");
});

it("creates a trip with no schedule (nulls) — schedule is optional", async () => {
  const auth = await dispatcherAuth();
  const res = await request(app).post("/api/dispatcher/trips").set("authorization", auth)
    .send({ identifier: "TR-SCHED-2", stops: [{ sequence: 1, address: "A" }] });
  expect(res.status).toBe(201);
  expect(res.body.scheduledStart).toBeNull();
  expect(res.body.scheduledEnd).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd fleet-backend && npx vitest run tests/dispatcher-trips.test.ts`
Expected: FAIL — `scheduledStart` unknown field / undefined.

- [ ] **Step 3: Add the schema fields** — in `fleet-backend/prisma/schema.prisma`, inside `model Trip`, add after `completedAt`:

```prisma
  scheduledStart        DateTime?
  scheduledEnd          DateTime?
```

- [ ] **Step 4: Generate the migration + client**

Run:
```
cd fleet-backend
DATABASE_URL="file:./dev.db" npx prisma migrate dev --name trip_scheduled_window
```
Expected: a new migration folder is created and the Prisma client regenerates. (Tests use `file:./dev.db` via vitest.config — confirm the migration is applied to the test DB; if tests run against a separate DB, run `prisma migrate deploy` against it as the existing suite does.)

- [ ] **Step 5: Accept + return schedule in the create handler** — in `fleet-backend/src/routes/dispatcherTrips.ts`, extend `createTripSchema` and the `create` call:

```ts
const createTripSchema = z.object({
  identifier: z.string().min(1),
  stops: z.array(z.object({ sequence: z.number().int(), address: z.string().min(1) })).min(1),
  checklistItems: z.array(z.object({ label: z.string().min(1), required: z.boolean().optional() })).optional(),
  scheduledStart: z.string().datetime().optional(),
  scheduledEnd: z.string().datetime().optional(),
});
```

In the `prisma.trip.create({ data: { ... } })` call add:

```ts
      scheduledStart: req.body.scheduledStart ? new Date(req.body.scheduledStart) : undefined,
      scheduledEnd: req.body.scheduledEnd ? new Date(req.body.scheduledEnd) : undefined,
```

(Scalar fields `scheduledStart`/`scheduledEnd` are returned automatically by Prisma; no `include` change needed. Prisma serializes `DateTime` as ISO strings in JSON.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd fleet-backend && npx vitest run tests/dispatcher-trips.test.ts`
Expected: PASS (new cases + all existing trip tests still green).

- [ ] **Step 7: Commit**

```bash
git add fleet-backend/prisma fleet-backend/src/routes/dispatcherTrips.ts fleet-backend/tests/dispatcher-trips.test.ts
git commit -m "feat: add planned scheduledStart/scheduledEnd to Trip"
```

---

### Task 2: Board-read endpoint (`GET /dispatcher/board`)

**Files:**
- Create: `fleet-backend/src/routes/dispatcherBoard.ts`
- Modify: the dispatcher router composition file (find where `dispatcherTripsRouter` is mounted — grep `dispatcherTripsRouter`; mount `dispatcherBoardRouter` the same way)
- Test: `fleet-backend/tests/dispatcher-board.test.ts`

**Interfaces:**
- Consumes: `prisma`, `requireAuth`+`requireDispatcher` (already applied by the parent dispatcher router).
- Produces: `GET /api/dispatcher/board?from=<ISO>&to=<ISO>` → `{ lanes: Array<{ id, name, status }>, trips: Array<Trip & { stopCount: number }> }`. `lanes` = all drivers (the Y-axis). `trips` = trips whose `scheduledStart` falls in `[from,to)` **or** that are unscheduled (`scheduledStart: null`, surfaced so they can be planned). Each trip includes `id, identifier, status, driverId, scheduledStart, scheduledEnd, stopCount`.

- [ ] **Step 1: Write the failing test** — `fleet-backend/tests/dispatcher-board.test.ts`:

```ts
import request from "supertest";
import { app, resetDb, createDispatcher, createDriver } from "./helpers.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

async function auth() {
  const d = await createDispatcher();
  return `Bearer ${signDispatcherAccess(d.id)}`;
}

it("returns every driver as a lane", async () => {
  const a = await auth();
  await createDriver({ email: "lane1@fleet.com", name: "Lane One" });
  await createDriver({ email: "lane2@fleet.com", name: "Lane Two" });
  const res = await request(app).get("/api/dispatcher/board?from=2026-08-21T00:00:00.000Z&to=2026-08-22T00:00:00.000Z").set("authorization", a);
  expect(res.status).toBe(200);
  expect(res.body.lanes.map((l: { name: string }) => l.name)).toEqual(expect.arrayContaining(["Lane One", "Lane Two"]));
});

it("returns scheduled trips inside the window with a stopCount", async () => {
  const a = await auth();
  await request(app).post("/api/dispatcher/trips").set("authorization", a).send({
    identifier: "TR-IN", stops: [{ sequence: 1, address: "A" }, { sequence: 2, address: "B" }],
    scheduledStart: "2026-08-21T09:00:00.000Z", scheduledEnd: "2026-08-21T12:00:00.000Z",
  });
  const res = await request(app).get("/api/dispatcher/board?from=2026-08-21T00:00:00.000Z&to=2026-08-22T00:00:00.000Z").set("authorization", a);
  const t = res.body.trips.find((x: { identifier: string }) => x.identifier === "TR-IN");
  expect(t).toBeTruthy();
  expect(t.stopCount).toBe(2);
});

it("excludes scheduled trips outside the window but includes unscheduled trips", async () => {
  const a = await auth();
  await request(app).post("/api/dispatcher/trips").set("authorization", a).send({
    identifier: "TR-OUT", stops: [{ sequence: 1, address: "A" }],
    scheduledStart: "2026-09-01T09:00:00.000Z", scheduledEnd: "2026-09-01T12:00:00.000Z",
  });
  await request(app).post("/api/dispatcher/trips").set("authorization", a)
    .send({ identifier: "TR-UNSCHED", stops: [{ sequence: 1, address: "A" }] });
  const res = await request(app).get("/api/dispatcher/board?from=2026-08-21T00:00:00.000Z&to=2026-08-22T00:00:00.000Z").set("authorization", a);
  const ids = res.body.trips.map((x: { identifier: string }) => x.identifier);
  expect(ids).not.toContain("TR-OUT");
  expect(ids).toContain("TR-UNSCHED");
});

it("rejects a missing/invalid window with 400", async () => {
  const a = await auth();
  const res = await request(app).get("/api/dispatcher/board").set("authorization", a);
  expect(res.status).toBe(400);
});
```

> Verify at task time that `createDriver` in `tests/helpers.ts` accepts a `name`; if not, adapt the assertion to whatever name it assigns.

- [ ] **Step 2: Run to verify it fails**

Run: `cd fleet-backend && npx vitest run tests/dispatcher-board.test.ts`
Expected: FAIL — 404 (route not mounted).

- [ ] **Step 3: Implement the router** — `fleet-backend/src/routes/dispatcherBoard.ts`:

```ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";

// Read model for the dispatch board: the fleet lanes (drivers) plus the trips
// visible in a time window. A trip is "visible" if its planned start falls in
// the window, or if it is unscheduled (so dispatchers can drag it onto the
// board). Mounted under dispatcherRouter — auth + role are already enforced.
export const dispatcherBoardRouter = Router();

const windowSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

dispatcherBoardRouter.get("/board", async (req, res) => {
  const parsed = windowSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "from and to (ISO datetimes) are required" });
  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);

  const [drivers, trips] = await Promise.all([
    prisma.driver.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, status: true } }),
    prisma.trip.findMany({
      where: {
        OR: [
          { scheduledStart: { gte: from, lt: to } },
          { scheduledStart: null },
        ],
      },
      orderBy: [{ scheduledStart: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, identifier: true, status: true, driverId: true,
        scheduledStart: true, scheduledEnd: true,
        _count: { select: { stops: true } },
      },
    }),
  ]);

  res.json({
    lanes: drivers,
    trips: trips.map((t) => ({
      id: t.id, identifier: t.identifier, status: t.status, driverId: t.driverId,
      scheduledStart: t.scheduledStart, scheduledEnd: t.scheduledEnd,
      stopCount: t._count.stops,
    })),
  });
});
```

- [ ] **Step 4: Mount it** — grep for `dispatcherTripsRouter` to find the composition (e.g. `dispatcher.ts`), and add beside it:

```ts
import { dispatcherBoardRouter } from "./dispatcherBoard.js";
// ...
dispatcherRouter.use(dispatcherBoardRouter);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd fleet-backend && npx vitest run tests/dispatcher-board.test.ts`
Expected: PASS.

- [ ] **Step 6: Full backend suite (no regressions)**

Run: `cd fleet-backend && npx vitest run`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add fleet-backend/src/routes/dispatcherBoard.ts fleet-backend/tests/dispatcher-board.test.ts fleet-backend/src/routes/dispatcher.ts
git commit -m "feat: GET /dispatcher/board read endpoint (lanes + windowed trips)"
```

---

### Task 3: Dispatcher realtime channel (connect-only)

**Files:**
- Modify: `fleet-backend/src/realtime.ts`
- Test: `fleet-backend/tests/realtime-dispatcher.test.ts`

**Interfaces:**
- Consumes: existing `attachRealtime(server)`, `verifyAccess`.
- Produces: exported `emitToDispatchers(type, payload)` (no-op broadcast to connected dispatcher sockets — unused until INC-3) and dispatcher-token acceptance on the same WS endpoint. Driver behavior unchanged.

This task exists so INC-3 can push without touching the socket handshake again. It is connect-only now: a dispatcher token connects and pings; nothing is pushed yet.

- [ ] **Step 1: Write the failing test** — `fleet-backend/tests/realtime-dispatcher.test.ts`. Start an http server, attach realtime, connect a `ws` client with a dispatcher token, assert the socket stays open (a driver-only guard would close it with 4401). Mirror the existing realtime test's harness (find it: grep `attachRealtime` under `tests/`; reuse its server-boot + token helpers).

```ts
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { attachRealtime, emitToDispatchers } from "../src/realtime.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { createDispatcher, resetDb } from "./helpers.js";
beforeEach(resetDb);

it("accepts a dispatcher token and keeps the socket open", async () => {
  const server = createServer();
  attachRealtime(server);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const disp = await createDispatcher();
  const token = signDispatcherAccess(disp.id);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  const opened = await new Promise<boolean>((resolve) => {
    ws.on("open", () => resolve(true));
    ws.on("close", () => resolve(false));
  });
  expect(opened).toBe(true);
  expect(typeof emitToDispatchers).toBe("function");
  ws.close();
  await new Promise<void>((r) => server.close(() => r()));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd fleet-backend && npx vitest run tests/realtime-dispatcher.test.ts`
Expected: FAIL — dispatcher token is rejected (4401) and/or `emitToDispatchers` is not exported.

- [ ] **Step 3: Implement** — in `fleet-backend/src/realtime.ts`, add a dispatcher registry and branch on role. Replace the token-verify block so a dispatcher role registers in a separate set:

```ts
const dispatcherSockets = new Set<WebSocket>();

export function emitToDispatchers(type: string, payload: Record<string, unknown> = {}) {
  const msg = JSON.stringify({ type, ...payload });
  for (const ws of dispatcherSockets) if (ws.readyState === ws.OPEN) ws.send(msg);
}
```

In the `connection` handler, after verifying the token, branch:

```ts
    let payload;
    try {
      payload = verifyAccess(token ?? "");
    } catch {
      ws.close(4401, "unauthorized");
      return;
    }
    if (payload.role === "dispatcher") {
      dispatcherSockets.add(ws);
      ws.on("message", (raw) => {
        try { if (JSON.parse(raw.toString()).type === "ping") ws.send(JSON.stringify({ type: "pong" })); } catch { /* ignore */ }
      });
      ws.on("close", () => dispatcherSockets.delete(ws));
      return;
    }
    if (payload.role !== "driver") { ws.close(4401, "unauthorized"); return; }
    const driverId = payload.driverId;
    // ...existing driver-registry logic unchanged...
```

> Keep the existing driver path byte-for-byte below the dispatcher branch. Verify `verifyAccess` returns `role`; the driver route already reads `payload.role`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd fleet-backend && npx vitest run tests/realtime-dispatcher.test.ts` then `npx vitest run` (whole suite; the existing driver realtime test must stay green).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fleet-backend/src/realtime.ts fleet-backend/tests/realtime-dispatcher.test.ts
git commit -m "feat: dispatcher realtime channel (connect-only) + emitToDispatchers"
```

---

### Task 4: Portal geometry core (ported, pure)

**Files:**
- Create: `fleet-portal/src/lib/board/geometry.ts`
- Test: `fleet-portal/src/lib/board/geometry.spec.ts`

**Interfaces:**
- Produces:
  - `interface BoardConfig { fromDate: Date; toDate: Date; dayStartHour: number; dayEndHour: number; boardWidthPx: number }`
  - `daysInWindow(cfg): number` — inclusive calendar-day count.
  - `hourWidth(cfg): number` — px per hour = `boardWidthPx / (hoursPerDay * days)`.
  - `timeToX(t: Date, cfg): number` — clamped to `[0, boardWidthPx]`.
  - `xToTime(x: number, cfg): Date` — inverse, minutes snapped to 15.
  - `brickWidth(start: Date, end: Date, cfg): number` — `≥ quarterHourWidth`.
- No weekend handling yet (INC-7). Pure — all inputs explicit.

- [ ] **Step 1: Write the failing test** — `fleet-portal/src/lib/board/geometry.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { type BoardConfig, brickWidth, daysInWindow, hourWidth, timeToX, xToTime } from './geometry'

// One UTC day, 08:00–20:00 (12h), 1200px wide → 100px/hour.
const cfg: BoardConfig = {
  fromDate: new Date('2026-08-21T00:00:00.000Z'),
  toDate: new Date('2026-08-21T00:00:00.000Z'),
  dayStartHour: 8,
  dayEndHour: 20,
  boardWidthPx: 1200,
}

describe('board geometry', () => {
  it('counts inclusive days', () => {
    expect(daysInWindow(cfg)).toBe(1)
    expect(daysInWindow({ ...cfg, toDate: new Date('2026-08-23T00:00:00.000Z') })).toBe(3)
  })

  it('computes hour width', () => {
    expect(hourWidth(cfg)).toBe(100) // 1200 / (12h * 1 day)
  })

  it('maps day-start to x=0 and places 12:00 at 4 hours in', () => {
    expect(timeToX(new Date('2026-08-21T08:00:00.000Z'), cfg)).toBe(0)
    expect(timeToX(new Date('2026-08-21T12:00:00.000Z'), cfg)).toBe(400)
  })

  it('clamps out-of-window times to the board edges', () => {
    expect(timeToX(new Date('2026-08-21T06:00:00.000Z'), cfg)).toBe(0)
    expect(timeToX(new Date('2026-08-21T23:00:00.000Z'), cfg)).toBe(1200)
  })

  it('xToTime inverts timeToX and snaps to 15 minutes', () => {
    const t = xToTime(400, cfg)
    expect(t.toISOString()).toBe('2026-08-21T12:00:00.000Z')
    // 100px = 1h; 25px = 15min
    expect(xToTime(425, cfg).toISOString()).toBe('2026-08-21T12:15:00.000Z')
  })

  it('brickWidth spans start→end with a quarter-hour floor', () => {
    expect(brickWidth(new Date('2026-08-21T08:00:00.000Z'), new Date('2026-08-21T11:00:00.000Z'), cfg)).toBe(300)
    // zero-length brick floors to a quarter hour (25px)
    expect(brickWidth(new Date('2026-08-21T08:00:00.000Z'), new Date('2026-08-21T08:00:00.000Z'), cfg)).toBe(25)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd fleet-portal && npx vitest run src/lib/board/geometry.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `fleet-portal/src/lib/board/geometry.ts`:

```ts
// Pure time↔pixel core for the dispatch board — ported in spirit from
// Bertschi's useBrick/useBoardBrickCalculus, rewritten for Vue 3 with no DOM
// or clock dependency. Every function takes an explicit BoardConfig so it is
// deterministic and unit-testable. Days are counted in UTC to match the API's
// ISO timestamps; timezone-aware windows are a later concern (INC-7).
export interface BoardConfig {
  fromDate: Date
  toDate: Date
  dayStartHour: number
  dayEndHour: number
  boardWidthPx: number
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

export function daysInWindow(cfg: BoardConfig): number {
  return Math.round((utcMidnight(cfg.toDate) - utcMidnight(cfg.fromDate)) / MS_PER_DAY) + 1
}

function hoursPerDay(cfg: BoardConfig): number {
  return cfg.dayEndHour - cfg.dayStartHour
}

export function hourWidth(cfg: BoardConfig): number {
  return cfg.boardWidthPx / (hoursPerDay(cfg) * daysInWindow(cfg))
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export function timeToX(t: Date, cfg: BoardConfig): number {
  const dayIndex = Math.round((utcMidnight(t) - utcMidnight(cfg.fromDate)) / MS_PER_DAY)
  const hourOfDay = t.getUTCHours() + t.getUTCMinutes() / 60
  const hoursIntoDay = clamp(hourOfDay - cfg.dayStartHour, 0, hoursPerDay(cfg))
  const totalHours = dayIndex * hoursPerDay(cfg) + hoursIntoDay
  return clamp(totalHours * hourWidth(cfg), 0, cfg.boardWidthPx)
}

export function xToTime(x: number, cfg: BoardConfig): Date {
  const totalHours = clamp(x, 0, cfg.boardWidthPx) / hourWidth(cfg)
  const dayIndex = Math.floor(totalHours / hoursPerDay(cfg))
  const hoursIntoDay = totalHours - dayIndex * hoursPerDay(cfg)
  const rawMinutes = (cfg.dayStartHour + hoursIntoDay) * 60
  const snapped = Math.round(rawMinutes / 15) * 15
  const base = utcMidnight(cfg.fromDate) + dayIndex * MS_PER_DAY
  return new Date(base + snapped * 60 * 1000)
}

export function brickWidth(start: Date, end: Date, cfg: BoardConfig): number {
  const w = timeToX(end, cfg) - timeToX(start, cfg)
  const quarterHour = hourWidth(cfg) / 4
  return Math.max(quarterHour, w)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd fleet-portal && npx vitest run src/lib/board/geometry.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fleet-portal/src/lib/board/geometry.ts fleet-portal/src/lib/board/geometry.spec.ts
git commit -m "feat: pure time-to-pixel board geometry core"
```

---

### Task 5: Board Pinia store

**Files:**
- Create: `fleet-portal/src/stores/board.ts`
- Test: `fleet-portal/src/stores/board.spec.ts`

**Interfaces:**
- Consumes: `geometry.ts` (`BoardConfig` + helpers), the axios client from `src/lib/api.ts` (match how `stores/trips.ts` calls it — verify the exact export/usage at task time).
- Produces a setup store `useBoardStore` with:
  - state refs: `fromDate`, `toDate` (Date), `dayStartHour=6`, `dayEndHour=20`, `boardWidthPx=1200`, `lanes: BoardLane[]`, `trips: BoardTrip[]`, `loading`, `error`.
  - getter `config: BoardConfig` (assembled from the refs).
  - action `load()` → `GET /dispatcher/board?from&to` (ISO of `fromDate` at 00:00 UTC and `toDate`+1day) populating `lanes`/`trips`.
  - action `setBoardWidth(px)`.
  - types `BoardLane { id; name; status }`, `BoardTrip { id; identifier; status; driverId: string | null; scheduledStart: string | null; scheduledEnd: string | null; stopCount: number }`.

- [ ] **Step 1: Write the failing test** — `fleet-portal/src/stores/board.spec.ts`. Mock the api client the same way `stores/trips.spec.ts` does (open it first to copy the mock shape), assert `load()` populates lanes/trips and `config` reflects the refs.

```ts
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useBoardStore } from './board'

vi.mock('../lib/api', () => ({ api: { get: vi.fn() } }))
const mockedGet = vi.mocked(api.get)

describe('board store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
  })

  it('load() fetches the window and populates lanes and trips', async () => {
    mockedGet.mockResolvedValue({
      data: {
        lanes: [{ id: 'd1', name: 'Dana', status: 'active' }],
        trips: [{ id: 't1', identifier: 'TR-1', status: 'assigned', driverId: 'd1', scheduledStart: '2026-08-21T09:00:00.000Z', scheduledEnd: '2026-08-21T12:00:00.000Z', stopCount: 2 }],
      },
    })
    const board = useBoardStore()
    board.fromDate = new Date('2026-08-21T00:00:00.000Z')
    board.toDate = new Date('2026-08-21T00:00:00.000Z')
    await board.load()
    expect(mockedGet).toHaveBeenCalledOnce()
    expect(board.lanes).toHaveLength(1)
    expect(board.trips[0].identifier).toBe('TR-1')
    expect(board.config.dayStartHour).toBe(6)
  })
})
```

> Adjust the `vi.mock` target + call style to match `stores/trips.ts` exactly (it may `import api from` default, or call `api.get(url)` vs a wrapper). The test above assumes a named `api` with `.get`; reconcile before implementing.

- [ ] **Step 2: Run to verify it fails**

Run: `cd fleet-portal && npx vitest run src/stores/board.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `fleet-portal/src/stores/board.ts` (reconcile the api import with `stores/trips.ts`):

```ts
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../lib/api'
import type { BoardConfig } from '../lib/board/geometry'

export interface BoardLane { id: string; name: string; status: string }
export interface BoardTrip {
  id: string; identifier: string; status: string; driverId: string | null
  scheduledStart: string | null; scheduledEnd: string | null; stopCount: number
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000)
}

export const useBoardStore = defineStore('board', () => {
  const fromDate = ref<Date>(utcMidnight(new Date()))
  const toDate = ref<Date>(utcMidnight(new Date()))
  const dayStartHour = ref(6)
  const dayEndHour = ref(20)
  const boardWidthPx = ref(1200)
  const lanes = ref<BoardLane[]>([])
  const trips = ref<BoardTrip[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  const config = computed<BoardConfig>(() => ({
    fromDate: fromDate.value,
    toDate: toDate.value,
    dayStartHour: dayStartHour.value,
    dayEndHour: dayEndHour.value,
    boardWidthPx: boardWidthPx.value,
  }))

  function setBoardWidth(px: number) {
    if (px > 0) boardWidthPx.value = px
  }

  async function load() {
    loading.value = true
    error.value = null
    try {
      const from = utcMidnight(fromDate.value).toISOString()
      const to = addDays(utcMidnight(toDate.value), 1).toISOString()
      const res = await api.get(`/dispatcher/board?from=${from}&to=${to}`)
      lanes.value = res.data.lanes
      trips.value = res.data.trips
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load board'
    } finally {
      loading.value = false
    }
  }

  return { fromDate, toDate, dayStartHour, dayEndHour, boardWidthPx, lanes, trips, loading, error, config, setBoardWidth, load }
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd fleet-portal && npx vitest run src/stores/board.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fleet-portal/src/stores/board.ts fleet-portal/src/stores/board.spec.ts
git commit -m "feat: board Pinia store (viewport + geometry config + load)"
```

---

### Task 6: Board components + read-only BoardView

**Files:**
- Create: `fleet-portal/src/components/board/TimeRuler.vue`, `FleetLane.vue`, `TripBrick.vue`
- Create: `fleet-portal/src/views/BoardView.vue`
- Test: `fleet-portal/src/views/BoardView.spec.ts`

**Interfaces:**
- Consumes: `useBoardStore`, `geometry.ts`, `StatusPill.vue` (reuse for brick status).
- Produces: a board that, on mount, calls `board.load()` and renders one `FleetLane` per lane; each lane renders its trips (`trip.driverId === lane.id`) as `TripBrick`s positioned with `left = timeToX(scheduledStart)`, `width = brickWidth(...)`. Unscheduled trips render in a "Backlog" strip below the board (they have no X). A `TimeRuler` renders hour labels across the top. Read-only (no drag yet). Uses `data-lane="<id>"` and `data-trip="<id>"` for test hooks.

- [ ] **Step 1: Write the failing test** — `fleet-portal/src/views/BoardView.spec.ts`:

```ts
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBoardStore } from '../stores/board'
import BoardView from './BoardView.vue'

vi.mock('../stores/board', () => ({ useBoardStore: vi.fn() }))
const mockedUseBoardStore = vi.mocked(useBoardStore)

function stub(overrides: Record<string, unknown> = {}) {
  return {
    lanes: [{ id: 'd1', name: 'Dana', status: 'active' }],
    trips: [
      { id: 't1', identifier: 'TR-1', status: 'assigned', driverId: 'd1', scheduledStart: '2026-08-21T09:00:00.000Z', scheduledEnd: '2026-08-21T12:00:00.000Z', stopCount: 2 },
      { id: 't2', identifier: 'TR-BACKLOG', status: 'pending', driverId: null, scheduledStart: null, scheduledEnd: null, stopCount: 1 },
    ],
    loading: false,
    error: null,
    config: { fromDate: new Date('2026-08-21T00:00:00.000Z'), toDate: new Date('2026-08-21T00:00:00.000Z'), dayStartHour: 6, dayEndHour: 20, boardWidthPx: 1200 },
    load: vi.fn(),
    setBoardWidth: vi.fn(),
    ...overrides,
  }
}

describe('BoardView', () => {
  beforeEach(() => { setActivePinia(createPinia()); mockedUseBoardStore.mockReset() })
  afterEach(() => { document.body.innerHTML = '' })

  it('loads on mount and renders a lane per driver with its scheduled trip', () => {
    const s = stub()
    mockedUseBoardStore.mockReturnValue(s as unknown as ReturnType<typeof useBoardStore>)
    const wrapper = mount(BoardView)
    expect(s.load).toHaveBeenCalled()
    const lane = wrapper.find('[data-lane="d1"]')
    expect(lane.exists()).toBe(true)
    expect(lane.text()).toContain('Dana')
    expect(lane.find('[data-trip="t1"]').exists()).toBe(true)
  })

  it('positions a scheduled brick by time (09:00 at 6h-start, 100px/h)', () => {
    const s = stub()
    mockedUseBoardStore.mockReturnValue(s as unknown as ReturnType<typeof useBoardStore>)
    const wrapper = mount(BoardView)
    const brick = wrapper.find('[data-trip="t1"]')
    // dayStart 06:00, 14h/day, 1200px → ~85.7px/h; 09:00 = 3h in → ~257px
    const style = brick.attributes('style') ?? ''
    expect(style).toMatch(/left:\s*257/)
  })

  it('shows unscheduled trips in the backlog strip', () => {
    const s = stub()
    mockedUseBoardStore.mockReturnValue(s as unknown as ReturnType<typeof useBoardStore>)
    const wrapper = mount(BoardView)
    const backlog = wrapper.find('[data-testid="board-backlog"]')
    expect(backlog.text()).toContain('TR-BACKLOG')
    expect(backlog.find('[data-trip="t1"]').exists()).toBe(false)
  })
})
```

> The exact pixel (257) depends on the geometry; compute it from `timeToX` at implementation time and set the assertion to the real value (use a tolerance/`Math.round` in the component's inline style so it's stable).

- [ ] **Step 2: Run to verify it fails**

Run: `cd fleet-portal && npx vitest run src/views/BoardView.spec.ts`
Expected: FAIL — components not found.

- [ ] **Step 3: Implement `TripBrick.vue`**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import StatusPill from '../StatusPill.vue'
import type { BoardConfig } from '../../lib/board/geometry'
import { brickWidth, timeToX } from '../../lib/board/geometry'
import type { BoardTrip } from '../../stores/board'

const props = defineProps<{ trip: BoardTrip; config: BoardConfig }>()

const style = computed(() => {
  if (!props.trip.scheduledStart || !props.trip.scheduledEnd) return {}
  const start = new Date(props.trip.scheduledStart)
  const end = new Date(props.trip.scheduledEnd)
  return {
    left: `${Math.round(timeToX(start, props.config))}px`,
    width: `${Math.round(brickWidth(start, end, props.config))}px`,
  }
})
</script>

<template>
  <div
    :data-trip="trip.id"
    class="absolute top-1 h-12 rounded-md border border-primary-600 bg-primary-50 px-2 py-1 text-xs shadow-sm overflow-hidden"
    :style="style"
  >
    <div class="flex items-center gap-1">
      <span class="font-semibold text-primary-700">{{ trip.identifier }}</span>
      <StatusPill :status="trip.status" />
    </div>
    <div class="text-gray-500">{{ trip.stopCount }} stops</div>
  </div>
</template>
```

- [ ] **Step 4: Implement `FleetLane.vue`** (a lane label + a relative track holding its bricks):

```vue
<script setup lang="ts">
import type { BoardConfig } from '../../lib/board/geometry'
import type { BoardLane, BoardTrip } from '../../stores/board'
import TripBrick from './TripBrick.vue'

const props = defineProps<{ lane: BoardLane; trips: BoardTrip[]; config: BoardConfig }>()
</script>

<template>
  <div :data-lane="lane.id" class="flex border-b border-gray-200">
    <div class="w-40 shrink-0 border-r border-gray-200 px-3 py-2 text-sm font-medium text-gray-700">
      {{ lane.name }}
    </div>
    <div class="relative h-14 flex-1" :style="{ width: `${config.boardWidthPx}px` }">
      <TripBrick v-for="t in trips" :key="t.id" :trip="t" :config="config" />
    </div>
  </div>
</template>
```

- [ ] **Step 5: Implement `TimeRuler.vue`** — hour labels from `dayStartHour` to `dayEndHour` across `boardWidthPx`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import type { BoardConfig } from '../../lib/board/geometry'
import { hourWidth } from '../../lib/board/geometry'

const props = defineProps<{ config: BoardConfig }>()

const hours = computed(() => {
  const out: { label: string; left: number }[] = []
  const w = hourWidth(props.config)
  const perDay = props.config.dayEndHour - props.config.dayStartHour
  const days = Math.round((Date.UTC(props.config.toDate.getUTCFullYear(), props.config.toDate.getUTCMonth(), props.config.toDate.getUTCDate()) - Date.UTC(props.config.fromDate.getUTCFullYear(), props.config.fromDate.getUTCMonth(), props.config.fromDate.getUTCDate())) / 86400000) + 1
  for (let d = 0; d < days; d++) {
    for (let h = props.config.dayStartHour; h < props.config.dayEndHour; h++) {
      out.push({ label: `${String(h).padStart(2, '0')}:00`, left: Math.round((d * perDay + (h - props.config.dayStartHour)) * w) })
    }
  }
  return out
})
</script>

<template>
  <div class="flex border-b border-gray-300 bg-gray-50">
    <div class="w-40 shrink-0 border-r border-gray-200" />
    <div class="relative h-8 flex-1" :style="{ width: `${config.boardWidthPx}px` }">
      <span v-for="hr in hours" :key="hr.left" class="absolute top-1 text-[10px] text-gray-400" :style="{ left: `${hr.left}px` }">
        {{ hr.label }}
      </span>
    </div>
  </div>
</template>
```

- [ ] **Step 6: Implement `BoardView.vue`**

```vue
<script setup lang="ts">
import { computed, onMounted } from 'vue'
import FleetLane from '../components/board/FleetLane.vue'
import TimeRuler from '../components/board/TimeRuler.vue'
import StatusPill from '../components/StatusPill.vue'
import { useBoardStore } from '../stores/board'

const board = useBoardStore()

const backlog = computed(() => board.trips.filter((t) => !t.scheduledStart))
function laneTrips(laneId: string) {
  return board.trips.filter((t) => t.driverId === laneId && t.scheduledStart)
}

onMounted(() => board.load())
</script>

<template>
  <div class="flex flex-col gap-4">
    <div>
      <h1 class="text-xl font-semibold text-gray-900">Dispatch board</h1>
      <p class="text-sm text-gray-500">Every driver a lane, every trip a slot. This is the control room.</p>
    </div>

    <p v-if="board.error" class="text-sm text-red-600" role="alert">{{ board.error }}</p>

    <div class="overflow-x-auto rounded-lg border border-gray-200">
      <TimeRuler :config="board.config" />
      <FleetLane v-for="lane in board.lanes" :key="lane.id" :lane="lane" :trips="laneTrips(lane.id)" :config="board.config" />
      <p v-if="board.lanes.length === 0" class="p-6 text-sm text-gray-400">No drivers yet.</p>
    </div>

    <div data-testid="board-backlog" class="rounded-lg border border-dashed border-gray-300 p-3">
      <h2 class="mb-2 text-sm font-semibold text-gray-700">Backlog — unscheduled trips</h2>
      <div class="flex flex-wrap gap-2">
        <div v-for="t in backlog" :key="t.id" :data-trip="t.id" class="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs">
          <span class="font-semibold text-gray-700">{{ t.identifier }}</span>
          <StatusPill :status="t.status" />
          <span class="text-gray-400">{{ t.stopCount }} stops</span>
        </div>
        <p v-if="backlog.length === 0" class="text-sm text-gray-400">Nothing waiting.</p>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 7: Run tests; fix the pixel assertion to the real computed value**

Run: `cd fleet-portal && npx vitest run src/views/BoardView.spec.ts`
Expected: PASS (after setting the `left:` assertion to the actual `timeToX` output).

- [ ] **Step 8: Commit**

```bash
git add fleet-portal/src/components/board fleet-portal/src/views/BoardView.vue fleet-portal/src/views/BoardView.spec.ts
git commit -m "feat: read-only dispatch board view (lanes, ruler, bricks, backlog)"
```

---

### Task 7: Make the board the dashboard

**Files:**
- Modify: `fleet-portal/src/router/index.ts` (route named `dashboard` at `/` → `BoardView`)
- Modify: `fleet-portal/src/layouts/AppShell.vue` (nav label/order, if it lists a "Dashboard" item — verify)
- Test: `fleet-portal/src/router/guard.spec.ts` (already asserts `/` resolves to name `dashboard`; keep it green) + a small assertion that `/` renders BoardView

**Interfaces:**
- Consumes: `BoardView`, existing `routes` array + `authGuard`.
- Produces: `/` (name `dashboard`) renders `BoardView`; the old `DashboardView` is either removed from routing or kept at `/overview`. **Ruling:** keep `DashboardView` reachable at `/overview` (named `overview`) so the status counts aren't lost, and point `/` at the board. Record this in the ledger.

- [ ] **Step 1: Write/adjust the failing test** — extend `fleet-portal/src/router/guard.spec.ts` (or a new `router/board-route.spec.ts`) to assert the component at `/` is `BoardView`:

```ts
it('resolves / (dashboard) to the BoardView component', () => {
  const match = routes.find((r) => r.name === 'dashboard' || (r.children ?? []).some((c) => c.name === 'dashboard'))
  expect(match).toBeTruthy()
})
```

> If routes are nested under `AppShell` children, assert against the child whose `name === 'dashboard'` and that its `component` is the BoardView import. Match the existing route shape in `router/index.ts`.

- [ ] **Step 2: Run to verify current state**

Run: `cd fleet-portal && npx vitest run src/router`
Expected: existing guard tests PASS; the new assertion may already pass structurally — the real change is the component wired to `dashboard`.

- [ ] **Step 3: Rewire the route** — in `fleet-portal/src/router/index.ts`: import `BoardView`, set the `dashboard`/`/` route's `component` to `BoardView`, and add an `overview` route (`/overview`) pointing at `DashboardView`. Update the sidebar nav in `AppShell.vue` so the first item ("Dashboard" or "Board") targets `/` and an "Overview" item targets `/overview`.

- [ ] **Step 4: Run the router + full portal suite**

Run: `cd fleet-portal && npx vitest run src/router && npx vitest run`
Expected: all green (guard still lands authenticated users on `dashboard`, now the board).

- [ ] **Step 5: Type-check + build gate**

Run: `cd fleet-portal && npx vue-tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add fleet-portal/src/router/index.ts fleet-portal/src/layouts/AppShell.vue fleet-portal/src/router/*.spec.ts
git commit -m "feat: dispatch board is the portal dashboard; status overview moves to /overview"
```

---

### Task 8: Seed the board demo + live smoke

**Files:**
- Modify: `fleet-backend/seed-demo.mjs`
- Create: `fleet-backend/board-smoke.mjs` (optional live check)

**Interfaces:**
- Consumes: existing seed helpers/patterns in `seed-demo.mjs`.
- Produces: demo trips carry `scheduledStart`/`scheduledEnd` spread across a single operating day (≈06:00–20:00), assigned to the demo drivers, so the board is populated on first open. Not TDD (a seed utility) — fold verification into a live smoke.

- [ ] **Step 1: Extend the demo seed** — when creating demo trips, set schedules relative to a fixed base day (pass a base date into the script as an arg or hardcode a near date; avoid `Date.now()` inside pure code but a seed script may use the clock). Assign each scheduled trip to a driver and stagger start times (e.g. driver1 08:00–11:00, 12:00–14:00; driver2 09:30–13:00; leave 1–2 unscheduled for the backlog).

- [ ] **Step 2: Run the seed against a fresh smoke DB**

Run (from `SESSION-STATE.json` resume block):
```
cd fleet-backend
rm -f smoke.db smoke.db-journal && DATABASE_URL="file:./smoke.db" npx prisma migrate deploy
DATABASE_URL="file:./smoke.db" node seed-demo.mjs
```
Expected: seeds without error; a quick `GET /api/dispatcher/board?from&to` (with a dispatcher token) returns lanes + scheduled trips.

- [ ] **Step 3: Manual board check** — boot backend + portal per `SESSION-STATE.json` `resume.run_the_system`, open `http://localhost:5173`, log in `d@fleet.com / pass123`, confirm the board shows lanes with time-positioned bricks + a backlog. (Keep `NODE_OPTIONS=--max-http-header-size=65536` on both.)

- [ ] **Step 4: Commit**

```bash
git add fleet-backend/seed-demo.mjs fleet-backend/board-smoke.mjs
git commit -m "chore: seed demo trips with schedules so the board is populated"
```

---

## Self-Review (author checklist — done)

- **Spec coverage:** INC-1 delivers the board-as-dashboard (adoption map Tier-1 flagship, read-only slice); geometry core is the ported crown jewel (teardown §4.1); dispatcher WS channel is scaffolded for INC-3 (teardown §4.5). Drag/realtime/occupancy/actions/locking/search are explicitly deferred to INC-2..7 and listed in the roadmap.
- **Placeholder scan:** every code step carries real code; test steps carry real assertions. Two flagged verification points (the exact `left:` pixel in Task 6, and reconciling the api-client import/mocks in Tasks 5–6 against `stores/trips.ts`) are called out for the implementer to confirm against live code, not left as vague TODOs.
- **Type consistency:** `BoardConfig`, `BoardLane`, `BoardTrip` are defined once (geometry.ts / board.ts) and imported everywhere; endpoint field names (`scheduledStart`, `scheduledEnd`, `stopCount`, `lanes`, `trips`) match between Task 2 (server), Task 5 (store), Task 6 (view). `emitToDispatchers` produced in Task 3 is consumed only in INC-3.
- **Assumptions to verify at execution time (not guesses to hardcode):** the dispatcher-router composition file name; `tests/helpers.ts` `createDriver` signature; `verifyAccess` returning `role`; the `src/lib/api.ts` export shape and how `stores/trips.ts` calls it; whether portal routes are flat or nested under `AppShell`.

---

# Increment M — Live Map (hardened)

**Goal:** Replace the mockup's schematic SVG "network map" with a real geographic **slippy map** that plots
stops at their true coordinates, shows live driver positions, and (optionally) draws road-routed polylines —
built so it is safe, cheap, and resilient in production, not a fragile demo.

**Why this is its own increment:** a real map introduces three external dependencies (tiles, geocoding,
routing) each with cost, rate-limits, keys, and failure modes. The mockup deliberately faked it with an SVG
because an artifact's CSP blocks external tiles. The production portal has no such block — but "just drop in
Leaflet + OSM" is the classic way to ship something that works in dev and gets **rate-limited/banned in prod**.
Hence: harden it.

## Hardening decisions (make these explicit, don't default)

1. **Tiles — do NOT use OSM's public tile server in production.** `tile.openstreetmap.org` is fine for local
   dev only; its usage policy forbids heavy/commercial use and will 418/ban you. Choose a real provider with a
   plan and a **domain-restricted** key: **MapTiler**, **Stadia Maps**, **Thunderforest**, or **Mapbox**.
   Requirements: raster or vector tiles via Leaflet/MapLibre; set the provider's required **attribution**;
   put the tile key in an env var (`VITE_MAP_TILE_KEY`) and restrict it by HTTP referrer/domain in the
   provider console (the key is necessarily client-visible — restriction, not secrecy, is the control).
   Ship a **fallback**: if tiles fail to load (`tileerror`), show the existing schematic view + a banner, never
   a blank grey box.
2. **Geocoding — server-side and cached, never per-render client calls.** Stop addresses are free-text. Add
   nullable `latitude`/`longitude` (Float) to the `Stop` model. Geocode **once, on the server, when a stop is
   created or its address changes**, and persist the result. Provider: **MapTiler/Mapbox geocoding** (keyed,
   server-side only — key never reaches the browser) or **Nominatim** (free, but 1 req/sec max, requires a
   real `User-Agent`, and its policy forbids bulk/uncached use — so a **server-side queue + persistent cache +
   respect the rate limit** is mandatory if chosen). On geocode failure: store null, flag the stop
   "location unknown" in the UI, and never block trip creation. Batch/backfill existing stops with a one-off
   script that respects the rate limit.
3. **Routing polylines — optional, cached, with straight-line fallback.** To draw actual road routes between
   stops use **OSRM** (self-hosted for prod; the public demo server is rate-limited and not for production) or
   the tile provider's directions API. Cache the returned polyline on the trip/leg. If routing is unavailable
   or errors, **fall back to a great-circle straight line** (what the mockup already draws) — the map must
   still render.
4. **Live positions — from `DriverLocation`, throttled + clustered.** Plot the latest `DriverLocation` per
   active driver (already in the schema and written by `POST /driver/location`). Push updates over the
   dispatcher WS channel (INC-3), not by polling every marker. Use **marker clustering** (Leaflet.markercluster
   or Supercluster) so 100+ drivers don't tank the frame rate; only render markers in the current viewport.
5. **Bundle, don't CDN.** Install Leaflet/MapLibre + plugins from npm and bundle them (pinned versions) — no
   `<script src="cdn…">`. Keeps CSP tight and builds reproducible. Lazy-load the map chunk (`defineAsyncComponent`
   / dynamic import) so the board's initial load isn't paying for the map library.
6. **Failure & empty states everywhere.** No stops geocoded yet → friendly empty state. Tiles down → schematic
   fallback + banner. Geocoder over quota → degrade to last-known cached coords + a "stale" note. A driver with
   no recent ping → show at last known stop, dimmed.
7. **Cost guardrails.** Cache aggressively (geocode results are near-immutable per address; tiles are
   provider-cached; routes cached per stop-pair). Add a simple server-side geocode-call counter/log so cost is
   observable. Never geocode in a render loop or a Vue `computed`.

## File structure (INC-M)

- Backend
  - Modify `fleet-backend/prisma/schema.prisma` — add `latitude Float?`, `longitude Float?`, `geocodedAt DateTime?`,
    `geocodeStatus String?` to `Stop`.
  - New `fleet-backend/src/lib/geocode.ts` — a keyed, rate-limited, cached geocoding client (provider behind an
    interface so it can be swapped; returns `{lat, lng} | null`). Env: `GEOCODE_PROVIDER`, `GEOCODE_KEY`.
  - Hook geocoding into stop create/update (in `dispatcherTrips.ts` and wherever stops are edited) — enqueue,
    don't block the response.
  - New `fleet-backend/scripts/backfill-geocode.mjs` — one-off backfill respecting the rate limit.
  - Optional: `fleet-backend/src/lib/routing.ts` — OSRM/provider directions with straight-line fallback + cache.
  - Extend `GET /dispatcher/board` (or a new `GET /dispatcher/map`) to include stop coordinates + latest driver
    positions for the window.
  - Tests: geocode client (mock the provider HTTP; assert caching + rate-limit + null-on-failure), the map
    endpoint payload, schema migration.
- Portal
  - New `fleet-portal/src/components/board/LiveMap.vue` — Leaflet/MapLibre map, lazy-loaded; props: stops with
    coords, driver positions, routes. Emits marker clicks → the existing detail drawer.
  - New `fleet-portal/src/lib/map/tiles.ts` — tile-layer config from `VITE_MAP_TILE_KEY` + attribution + the
    `tileerror` → schematic-fallback logic.
  - Modify the Map view to mount `LiveMap` when coords are available, else the schematic fallback.
  - Env: `VITE_MAP_TILE_KEY` (domain-restricted). Tests: LiveMap mounts with stubbed Leaflet; fallback renders
    on tile error; markers map to the right trips.

## Task outline (INC-M) — right-sized, each independently testable

- [ ] **Task M1: Stop coordinates + migration.** Add lat/lng/geocodedAt/geocodeStatus to `Stop`; migration; the
  board/map endpoint returns them. Test: a stop round-trips coords; null coords are allowed.
- [ ] **Task M2: Geocoding client.** `geocode.ts` behind a provider interface, with in-DB cache lookup, a
  1-req/sec limiter (if Nominatim), a real User-Agent, and `null` on any failure. Tests mock the provider HTTP:
  cache hit avoids a call; rate limit is respected; failure returns null and never throws.
- [ ] **Task M3: Geocode on write + backfill.** Enqueue geocoding on stop create/update without blocking the
  HTTP response; write results back. `backfill-geocode.mjs` for existing stops. Test: creating a stop with a
  known address eventually persists coords (with the provider mocked).
- [ ] **Task M4: Map endpoint.** `GET /dispatcher/map?from&to` → `{ stops:[{tripId,seq,lat,lng,status}],
  drivers:[{driverId,lat,lng,at}] }`. Test the payload shape + windowing + that unlocated stops are omitted or
  flagged.
- [ ] **Task M5: LiveMap component (lazy).** Bundled Leaflet/MapLibre, tiles from env key + attribution, markers
  for stops + drivers, clustering, viewport-only rendering, click → drawer. Lazy-loaded chunk. Component test
  with Leaflet stubbed.
- [ ] **Task M6: Tile-failure fallback + empty states.** `tileerror` and "no geocoded stops" both degrade
  gracefully to the schematic view + a banner. Test both fallbacks render.
- [ ] **Task M7 (optional): Routed polylines.** OSRM/provider directions with straight-line fallback + per-pair
  cache. Test the fallback path when routing errors.

## Global constraints (INC-M)

- The tile key is **domain-restricted**, not secret; the **geocoding key is server-side only** and never sent to
  the browser. Both come from env, never hardcoded (honors the repo's no-hardcoded-secrets rule).
- **No CDN** for the map library — bundle pinned versions.
- Every external call (tiles, geocode, routing) has a **defined failure path** that keeps the page usable.
- Geocoding is **cached and rate-limited**; never called from a render/computed path.
- Reuse the existing detail **drawer** for marker clicks (don't build a second detail surface).
