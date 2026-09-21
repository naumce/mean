# Realtime Unification (One honest record, slice A4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One socket per tab, one event that says a load changed, and two boards that patch the rows that actually changed instead of re-reading everything.

**Architecture:** The backend already emits `load_changed { orgId, loadId, version, fields }` from nine sites (slices A1–A3); seven more Load-writing sites still announce themselves only through the blunt `board_update`. This slice closes those gaps behind one helper, gives both board GETs an `ids` filter so a client can re-read exactly what moved, moves the portal's two remaining private WebSockets onto the `lib/realtime.ts` singleton that A2 built, teaches the loadboard and broker-board stores to patch by id, and then retires `board_update` from every site where `load_changed` now carries the same news.

**Tech Stack:** Express 4, Prisma 5 (Postgres in docker `fleet-postgres` on :5434), zod, vitest + supertest, `ws`; Vue 3, Pinia, TanStack Query, vitest + @vue/test-utils.

**Spec:** `docs/superpowers/specs/2026-09-09-one-honest-record-design.md` — §9 Realtime, §7 Locks, §10 The marks.

**Research:** `E:\meeting-copilot\.superpowers\sdd\a4-realtime-research.md` — the current realtime surface with `file:line` anchors for every emit site, store and socket named below. Read it before Task 1; it is the map this plan argues from.

## Global Constraints

- **No git commits, no `git add`** — the user's standing rule. Every "Commit" step is skipped; the working tree is the deliverable.
- **One socket per tab.** After Task 5 no store constructs a `WebSocket`. The only `new WebSocket(...)` in `fleet-portal/src` is the one inside `lib/realtime.ts`. A test asserts this.
- **`load_changed` payload is fixed:** `{ orgId, loadId, version, fields: string[] }`. `fields` is never empty; a write that changed nothing emits nothing. Row removal is `fields: ["deleted"]`, row creation `fields: ["created"]`.
- **Absence means removal.** For both `ids`-filtered GETs, a requested id missing from the response means "this load is no longer on your board" — the client removes that row. Never interpret absence as "unchanged".
- **Every new query is org-scoped**; every query string validated with zod; the actor is the session's dispatcher (`actorOf(req)`).
- **Realtime is an enhancement.** Every store must render correctly with the socket never connecting. No `await` on a frame, no spinner that only a frame can clear.
- Lock semantics from A2 hold: a load held by another dispatcher refuses every writer (`LoadLocked` → 409 `LOAD_LOCKED`); the `$open` frame means "you missed frames, re-read your snapshot".
- Checks: backend `npx vitest run` and `npx tsc --noEmit`; portal `npx vitest run` and `npx vue-tsc --noEmit -p tsconfig.app.json` (only the five pre-existing errors in `RoutePlanCard.spec.ts` ×4 and `FleetMap.vue` ×1 are permitted).

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `fleet-backend/src/lib/loadEvents.ts` | The one place that emits `load_changed`. Holds the payload shape and the "no fields, no frame" rule. |
| `fleet-backend/src/lib/idList.ts` | Parses and caps a comma-separated `ids` query parameter. Shared by both board GETs. |
| `fleet-backend/tests/load-changed-events.test.ts` | Proves every Load-writing route emits `load_changed` with a real version. |
| `fleet-portal/src/lib/wsUrl.ts` | `boardWsUrl(token)`, moved out of the loadboard store to break the import cycle. |
| `fleet-portal/src/stores/loadboard.patch.spec.ts` | Patch-by-id behaviour of the loadboard store. |

**Modified**

| File | Change |
|---|---|
| `fleet-backend/src/routes/dispatcherLoads.ts`, `dispatcherAssignments.ts`, `dispatcherBrokerBoard.ts`, `dispatcherLoadTruth.ts`, `webhooks.ts`, `src/lib/assignmentActions.ts` | Emit through `loadEvents.ts`; fill the seven silent sites; drop `board_update` in Task 9. |
| `fleet-backend/src/routes/dispatcherLoadboard.ts` | `ids` query filter; loads-only response when it is present. |
| `fleet-portal/src/stores/loadboard.ts` | Loses its private socket; gains `patchLoads`, `refreshDerived`, `load_changed` handling. |
| `fleet-portal/src/stores/tracking.ts` | Loses its private socket. |
| `fleet-portal/src/stores/brokerBoard.ts` | Subscribes to `load_changed`; `conflict` becomes a per-load map. |
| `fleet-portal/src/stores/cockpit.ts`, `src/views/CockpitView.vue` | Cockpit subscribes directly instead of watching `loadboard.lastEvent`. |
| `fleet-portal/src/components/cockpit/LegBrick.vue`, `GanttBoard.vue` | Lock badge on a load another dispatcher holds. |
| `fleet-portal/src/views/BrokerBoardView.vue` | Reads the conflict map by load id. |

---

### Task 1: One helper emits `load_changed`, and the seven silent writes start announcing themselves

**Files:**
- Create: `fleet-backend/src/lib/loadEvents.ts`
- Create: `fleet-backend/tests/load-changed-events.test.ts`
- Modify: `fleet-backend/src/routes/dispatcherLoads.ts`, `fleet-backend/src/routes/dispatcherAssignments.ts`, `fleet-backend/src/routes/dispatcherBrokerBoard.ts`, `fleet-backend/src/routes/dispatcherLoadTruth.ts`, `fleet-backend/src/routes/webhooks.ts`, `fleet-backend/src/lib/assignmentActions.ts`

**Interfaces:**
- Consumes: `emitToDispatchers(orgId: string | null, type: string, payload?: Record<string, unknown>)` from `../realtime.js`; `applyLoadChange` returning `{ version, changed, attention, status, statusRefused }` and `applyStatusChange` returning `{ version, before }` from `../lib/loadWriter.js`.
- Produces: `emitLoadChanged(orgId, change)` and `emitLoadsChanged(orgId, changes)` with the `LoadChange` type below. Tasks 2, 3 and 9 depend on nothing here; Tasks 6 and 7 depend on the wire payload being exactly `{ orgId, loadId, version, fields }`.

- [ ] **Step 1: Write the helper**

```ts
// fleet-backend/src/lib/loadEvents.ts
import { emitToDispatchers } from "../realtime.js";

/** What one Load write is worth telling the room about. `version` is the
 *  load's value AFTER the write, so a client can compare it against what it
 *  has rendered and ignore its own echo. */
export type LoadChange = { loadId: string; version: number; fields: string[] };

/**
 * The one place `load_changed` is emitted (spec §9).
 *
 * A write that changed nothing sends nothing: an empty `fields` is not a
 * quiet event, it is the absence of an event, and a board that re-reads on
 * every no-op write is exactly the traffic this slice exists to remove.
 * Row removal is `fields: ["deleted"]` and creation `fields: ["created"]` —
 * one event type carries the whole lifecycle so a subscriber needs one
 * handler, not three.
 */
export function emitLoadChanged(orgId: string | null, change: LoadChange): void {
  if (change.fields.length === 0) return;
  emitToDispatchers(orgId, "load_changed", {
    orgId,
    loadId: change.loadId,
    version: change.version,
    fields: change.fields,
  });
}

/** One frame per load. Deliberately not one frame carrying many ids: the
 *  client coalesces ids itself (plan A4 Task 6), and a per-load frame keeps
 *  the payload shape identical whether one row or a whole import moved. */
export function emitLoadsChanged(orgId: string | null, changes: LoadChange[]): void {
  for (const change of changes) emitLoadChanged(orgId, change);
}
```

- [ ] **Step 2: Route the nine existing emit sites through it**

Replace each inline `emitToDispatchers(orgId, "load_changed", { ... })` with `emitLoadChanged(orgId, { loadId, version, fields })`, preserving the exact `loadId`, `version` and `fields` each site already passes. The sites (from the research map) are `dispatcherAssignments.ts:556,690`, `dispatcherBrokerBoard.ts:318,479,573,725`, `dispatcherLoads.ts:221,254,328`, `dispatcherLoadTruth.ts:147`. Line numbers drift as you edit — find them by searching for `"load_changed"`. After this step that string literal appears only in `loadEvents.ts`.

- [ ] **Step 3: Fill the seven silent sites**

Each of these writes a `Load` (or removes one) and today announces itself only through `board_update`. Add an `emitLoadChanged` / `emitLoadsChanged` call after the transaction commits, never inside it — a frame emitted inside a transaction that later rolls back is a lie.

| Site | `fields` to send | Where the version comes from |
|---|---|---|
| `dispatcherLoads.ts` `POST /loads/:id/geocode` | the writer's `changed` (the stops it resolved) | the `applyLoadChange` result |
| `dispatcherAssignments.ts` `DELETE /assignments/:id` (unassign) | `["status"]` | the `applyStatusChange` result returned through `unassign` |
| `dispatcherBrokerBoard.ts` `POST /broker-board/loads` (add) | `["created"]` | the created load's `version` |
| `dispatcherBrokerBoard.ts` `POST /broker-board/loads/delete` | `["deleted"]` | the load's version before deletion |
| `dispatcherBrokerBoard.ts` `POST /broker-board/import/confirm` | per load, the writer's `changed` | each `applyLoadChange` result in the loop |
| `webhooks.ts` inbound load webhook | per load, the writer's `changed` | each `applyLoadChange` result |
| `dispatcherAssignments.ts` `PATCH /assignments/:id/plan` (replan) | **none — do not emit** | — |

`unassign` in `src/lib/assignmentActions.ts` already returns nothing useful to its callers. Widen it to return `{ loadId: string; version: number }` (the values it already has from `applyStatusChange`) so `DELETE /assignments/:id` can emit without a second query. Update every caller for the new return type; no caller has to use it.

The replan row is a deliberate non-change: a replan edits the `Assignment`'s plan, not the `Load` record, so `load_changed` would be a false statement. It keeps `board_update`, and Task 9 keeps `board_update` alive for exactly this class of event.

- [ ] **Step 4: Write the failing test**

```ts
// fleet-backend/tests/load-changed-events.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "src");
const CANONICAL = "src/lib/loadEvents.ts";

function tsFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...tsFilesUnder(full));
    else if (entry.endsWith(".ts")) found.push(full);
  }
  return found;
}

describe("load_changed", () => {
  it('is emitted from exactly one module', () => {
    // The payload shape is a contract two portal stores decode. A second
    // place that builds the frame by hand is how the two drift apart.
    const offenders: string[] = [];
    for (const file of tsFilesUnder(srcDir)) {
      const rel = relative(repoRoot, file).split("\\").join("/");
      if (rel === CANONICAL) continue;
      if (readFileSync(file, "utf8").includes('"load_changed"')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `cd fleet-backend && npx vitest run tests/load-changed-events.test.ts`
Expected before Step 2's edits: FAIL, listing the four route files. After Step 2: PASS.

- [ ] **Step 6: Add the behavioural tests**

In the same file, add a `describe("every Load write announces itself")` block with one supertest case per site in Step 3's table. Each case: open a dispatcher WebSocket with `tests/realtime-helpers.ts`, perform the HTTP call, and assert a `load_changed` frame arrives whose `loadId` matches, whose `version` equals the load's version read back from the database afterwards, and whose `fields` contains the expected entry. For the delete case assert `fields` is `["deleted"]` and that the row is gone. For the import-confirm case assert one frame per imported load.

- [ ] **Step 7: Assert no-op silence**

```ts
it("says nothing when a write changed nothing", async () => {
  // A resubmitted identical cell is not news. A board that refetches on it
  // is a board that refetches on every keystroke a dispatcher undoes.
  const frames = await collectFrames(ws, async () => {
    await agent.patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).send(sameValueAsStored);
  });
  expect(frames.filter((f) => f.type === "load_changed")).toHaveLength(0);
});
```

- [ ] **Step 8: Run the suite**

Run: `cd fleet-backend && npx vitest run` then `npx tsc --noEmit`
Expected: all green, type check clean.

- [ ] **Step 9: Commit** — skipped (Global Constraints).

---

### Task 2: `GET /broker-board?ids=` — re-read only the rows that moved

**Files:**
- Create: `fleet-backend/src/lib/idList.ts`
- Modify: `fleet-backend/src/routes/dispatcherBrokerBoard.ts` (the `GET /broker-board` handler)
- Test: `fleet-backend/tests/broker-board-ids.test.ts` (create)

**Interfaces:**
- Consumes: the existing private helper `boardRows(orgId: string, includeArchived: boolean, ids?: string[])`, which already accepts an id list and is used by the write routes.
- Produces: `parseIdList(raw: unknown, max?: number): string[] | undefined` in `lib/idList.ts`, consumed by Task 3. `GET /api/dispatcher/broker-board?ids=a,b,c` answering `{ layout, loads }` with `loads` narrowed to those ids.

- [ ] **Step 1: Write the id-list parser**

```ts
// fleet-backend/src/lib/idList.ts
/** Default ceiling on a client-supplied id list. A paste can touch a lot of
 *  rows; an unbounded `IN (...)` is a query a client gets to size. */
export const MAX_IDS = 200;

/**
 * Parse a comma-separated `ids` query parameter.
 *
 * Returns `undefined` when the parameter is absent — meaning "no filter",
 * which is a different answer from `[]` ("filter to nothing"). Callers must
 * keep those apart: collapsing them is how an id filter silently becomes a
 * full board read.
 */
export function parseIdList(raw: unknown, max: number = MAX_IDS): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw);
  if (text.length === 0) return [];
  const ids = [...new Set(text.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];
  return ids.slice(0, max);
}
```

- [ ] **Step 2: Write the failing test**

```ts
// fleet-backend/tests/broker-board-ids.test.ts
it("returns only the rows asked for, and omits an id that left the board", async () => {
  const { a, b, archived } = await threeLoads();
  const res = await agent.get(`/api/dispatcher/broker-board?ids=${a.id},${archived.id}`).expect(200);
  const ids = res.body.loads.map((l: { id: string }) => l.id);
  expect(ids).toContain(a.id);
  expect(ids).not.toContain(b.id);        // not asked for
  expect(ids).not.toContain(archived.id); // asked for, but not on this board — absence means remove
  expect(res.body.layout).toBeTruthy();   // layout still travels: a client may be re-reading after a reconnect
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd fleet-backend && npx vitest run tests/broker-board-ids.test.ts`
Expected: FAIL — every load comes back, because the handler ignores `ids`.

- [ ] **Step 4: Give the handler a zod schema and the filter**

```ts
const boardQuerySchema = z.object({
  archived: z.enum(["0", "1"]).optional(),
  // Comma-separated. Absent = the whole board; present = re-read exactly
  // these rows (plan A4, spec §9). An id that is not in the answer is a row
  // the client must drop, not a row it should keep as-is.
  ids: z.string().optional(),
});

dispatcherBrokerBoardRouter.get("/broker-board", async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  const parsed = boardQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "archived must be 0 or 1; ids must be a comma-separated list" });
  const layout: BoardColumn[] = await layoutFor(orgId);
  const includeArchived = parsed.data.archived === "1";
  const ids = parseIdList(parsed.data.ids);
  const loads = await boardRows(orgId, includeArchived, ids);
  res.json({ layout, loads });
});
```

Confirm by reading `boardRows` that an `ids` array is applied as a `where.id.in` condition **combined with** the org filter, never instead of it. If it is not, fix `boardRows` and say so in the report.

- [ ] **Step 5: Add the org-scoping test**

```ts
it("refuses to hand another org's load back even when its id is asked for by name", async () => {
  const res = await agent.get(`/api/dispatcher/broker-board?ids=${otherOrgLoad.id}`).expect(200);
  expect(res.body.loads).toEqual([]);
});
```

- [ ] **Step 6: Add the cap test**

```ts
it("caps the id list instead of letting a client size the query", async () => {
  const many = Array.from({ length: 500 }, (_, i) => `id-${i}`).join(",");
  await agent.get(`/api/dispatcher/broker-board?ids=${many}`).expect(200); // no 500, no timeout
  expect(parseIdList(many)).toHaveLength(200);
});
```

- [ ] **Step 7: Run the suite**

Run: `cd fleet-backend && npx vitest run` then `npx tsc --noEmit`
Expected: all green, type check clean.

- [ ] **Step 8: Commit** — skipped.

---

### Task 3: `GET /loadboard?ids=` — the same narrowing for the Cockpit's projection

**Files:**
- Modify: `fleet-backend/src/routes/dispatcherLoadboard.ts`
- Test: `fleet-backend/tests/dispatcher-loadboard.test.ts` (extend)

**Interfaces:**
- Consumes: `parseIdList` from `../lib/idList.js` (Task 2).
- Produces: `GET /api/dispatcher/loadboard?from&to&carrierId?&ids?`. When `ids` is present the response is `{ loads }` **only** — no `lanes`, `tractors` or `trailers`. Task 6's `patchLoads` decodes exactly that.

- [ ] **Step 1: Write the failing test**

```ts
it("narrows to the ids asked for and answers loads only", async () => {
  const res = await agent
    .get(`/api/dispatcher/loadboard?from=${from}&to=${to}&ids=${inView.id},${outOfWindow.id}`)
    .expect(200);
  expect(res.body.loads.map((l: { id: string }) => l.id)).toEqual([inView.id]);
  // A patch response carries no lanes: the lane list did not change, and
  // sending it would make a "cheap" patch as expensive as a full read.
  expect(res.body.lanes).toBeUndefined();
  expect(res.body.tractors).toBeUndefined();
  expect(res.body.trailers).toBeUndefined();
});
```

`outOfWindow` is a load outside `[from, to)` by the projection's own window rule (slice A3). Its absence is the signal the Cockpit uses to drop a brick that moved out of view.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd fleet-backend && npx vitest run tests/dispatcher-loadboard.test.ts -t "narrows to the ids"`
Expected: FAIL — `lanes` is defined and both loads come back.

- [ ] **Step 3: Extend the query schema**

```ts
const querySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  carrierId: z.string().min(1).optional(),
  // Plan A4: re-read exactly these loads. Every other filter — the window,
  // the carrier, the coverage rules of spec §8.2 — still applies, so an id
  // that is asked for but is not in view comes back absent, and the client
  // drops it. That is deliberate: `ids` narrows the answer, it never widens
  // it past what the board would have shown anyway.
  ids: z.string().optional(),
});
```

- [ ] **Step 4: Apply the filter and shorten the response**

In the handler, after parsing: `const ids = parseIdList(parsed.data.ids);`. Add `...(ids ? { id: { in: ids } } : {})` to the **existing** load `where` clause (keep every other condition, including `orgFilter`). At the response, branch:

```ts
if (ids) return res.json({ loads });
res.json({ lanes, loads, tractors, trailers });
```

Skip the lane, tractor and trailer queries entirely when `ids` is present — the point of the endpoint is that it is cheap.

- [ ] **Step 5: Add the cross-org test**

```ts
it("does not hand back another org's load by id", async () => {
  const res = await agent.get(`/api/dispatcher/loadboard?from=${from}&to=${to}&ids=${otherOrgLoad.id}`).expect(200);
  expect(res.body.loads).toEqual([]);
});
```

- [ ] **Step 6: Run the suite**

Run: `cd fleet-backend && npx vitest run` then `npx tsc --noEmit`
Expected: all green, type check clean.

- [ ] **Step 7: Commit** — skipped.

---

### Task 4: The loadboard store gives up its private socket

**Files:**
- Create: `fleet-portal/src/lib/wsUrl.ts`
- Modify: `fleet-portal/src/stores/loadboard.ts`, `fleet-portal/src/lib/realtime.ts`
- Test: `fleet-portal/src/stores/loadboard.spec.ts` (extend), `fleet-portal/src/lib/realtime.spec.ts` (extend)

**Interfaces:**
- Consumes: `subscribe(type: string, handler: (frame: Frame) => void): () => void` and `OPEN` from `../lib/realtime`.
- Produces: `boardWsUrl(token: string): string` now lives in `lib/wsUrl.ts`; `stores/loadboard.ts` re-exports it so existing importers keep working. `connectRealtime()` / `disconnectRealtime()` keep their names and their meaning. Task 5 consumes the same `subscribe`.

- [ ] **Step 1: Break the import cycle first**

`lib/realtime.ts` imports `boardWsUrl` from `stores/loadboard`. The moment the store imports `subscribe` from `lib/realtime`, that is a cycle — and under Vite it surfaces as an intermittently `undefined` import, not a clean error. Move the function:

```ts
// fleet-portal/src/lib/wsUrl.ts
import { API_BASE_URL } from './constants'

/** The dispatcher WebSocket URL. Lives here, not on a store: `lib/realtime.ts`
 *  needs it, and every store that subscribes needs `lib/realtime.ts` — with
 *  the function on a store those two imports form a cycle whose symptom is an
 *  undefined import at module-eval time, not a build error. */
export function boardWsUrl(token: string): string {
  const base = API_BASE_URL.replace(/^http/, 'ws').replace(/\/api\/?$/, '')
  return `${base}/ws?token=${encodeURIComponent(token)}`
}
```

Copy the body from the current `boardWsUrl` in `stores/loadboard.ts` **verbatim** — the base-URL rewriting rules there are load-bearing and already tested. Point `lib/realtime.ts` at the new module. In `stores/loadboard.ts` replace the definition with `export { boardWsUrl } from '../lib/wsUrl'` so no other importer has to change.

- [ ] **Step 2: Write the failing test**

```ts
// fleet-portal/src/stores/loadboard.spec.ts
it('opens no socket of its own — realtime is the singleton (plan A4)', async () => {
  const spy = vi.spyOn(globalThis, 'WebSocket' as never)
  const store = useLoadboardStore()
  store.connectRealtime()
  expect(spy).not.toHaveBeenCalled()          // the store itself constructs nothing
  expect(__state().types).toContain('board_update')
  expect(__state().types).toContain('driver_status')
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd fleet-portal && npx vitest run src/stores/loadboard.spec.ts -t "opens no socket"`
Expected: FAIL — the store constructs a `WebSocket`.

- [ ] **Step 4: Replace the socket with subscriptions**

Delete the module-level `socket`, `wantRealtime` and `reconnectTimer` variables and the whole `new WebSocket(...)` block. Replace `connectRealtime` with:

```ts
let unsubscribers: Array<() => void> = []

/** Live board: the shared socket (lib/realtime.ts) delivers frames; this
 *  store only says which ones it wants. Reconnection, retry and the `$open`
 *  replay all live in the singleton now — there is nothing left here to get
 *  out of step with the other stores. */
connectRealtime(): void {
  if (unsubscribers.length) return
  unsubscribers = [
    subscribe('board_update', (frame) => {
      this.lastEvent = { type: frame.type, payload: frame, at: Date.now(), seq: ++eventSeq }
      this.load()
      this.loadAlerts()
      this.loadKpis()
      this.loadYard()
      this.loadRisk()
    }),
    subscribe('driver_status', (frame) => {
      this.lastEvent = { type: frame.type, payload: frame, at: Date.now(), seq: ++eventSeq }
      const driverId = typeof frame.driverId === 'string' ? frame.driverId : null
      const status = typeof frame.status === 'string' ? frame.status : null
      if (!driverId || !status) return
      // Lane dot only — no reload needed for a presence change.
      this.lanes = this.lanes.map((lane) => (lane.id === driverId ? { ...lane, status } : lane))
    }),
  ]
},

disconnectRealtime(): void {
  for (const off of unsubscribers) off()
  unsubscribers = []
},
```

Keep `lastEvent` fed exactly as before: Task 8 moves the Cockpit off it, and until then removing it would break the activity feed.

- [ ] **Step 5: Run the store's tests**

Run: `cd fleet-portal && npx vitest run src/stores/loadboard.spec.ts`
Expected: PASS, including the pre-existing reconnect tests — delete the ones that assert on the store's own retry timer, which is now the singleton's job, and say in the report which ones you removed and why.

- [ ] **Step 6: Commit** — skipped.

---

### Task 5: The tracking store gives up its private socket, and a test pins "one socket"

**Files:**
- Modify: `fleet-portal/src/stores/tracking.ts`
- Test: `fleet-portal/src/stores/tracking.spec.ts` (extend), `fleet-portal/src/lib/realtime.spec.ts` (extend)

**Interfaces:**
- Consumes: `subscribe` from `../lib/realtime`, `boardWsUrl` no longer needed here.
- Produces: nothing new. After this task, `new WebSocket(` appears exactly once in `fleet-portal/src`.

- [ ] **Step 1: Write the failing guard test**

```ts
// fleet-portal/src/lib/realtime.spec.ts
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

it('is the only module in src/ that constructs a WebSocket', () => {
  // Spec §9: one socket per tab. Two sockets means two reconnect policies,
  // two auth refreshes and two chances to miss a frame — which is what this
  // slice exists to end.
  const root = new URL('../..', import.meta.url).pathname
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|vue)$/.test(e)) files.push(full)
    }
  }
  walk(join(root, 'src'))
  const offenders = files
    .filter((f) => readFileSync(f, 'utf8').includes('new WebSocket('))
    .map((f) => relative(root, f).split('\\').join('/'))
  expect(offenders).toEqual(['src/lib/realtime.ts'])
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd fleet-portal && npx vitest run src/lib/realtime.spec.ts -t "only module"`
Expected: FAIL, listing `src/stores/tracking.ts`.

- [ ] **Step 3: Replace tracking's socket**

```ts
let unsubscribers: Array<() => void> = []

/** Live map: `driver_location` frames upsert markers instantly; the polling
 *  in `startPolling` stays on as the fallback net, unchanged. */
connectRealtime(): void {
  if (unsubscribers.length) return
  unsubscribers = [
    subscribe('driver_location', (frame) => {
      const driverId = typeof frame.driverId === 'string' ? frame.driverId : null
      const latitude = typeof frame.latitude === 'number' ? frame.latitude : null
      const longitude = typeof frame.longitude === 'number' ? frame.longitude : null
      if (!driverId || latitude === null || longitude === null) return
      const next: DriverLocation = {
        driverId,
        driverName: typeof frame.driverName === 'string' ? frame.driverName : undefined,
        latitude,
        longitude,
        createdAt: typeof frame.at === 'string' ? frame.at : new Date().toISOString(),
      }
      const known = this.locations.some((l) => l.driverId === driverId)
      this.locations = known
        ? this.locations.map((l) => (l.driverId === driverId ? next : l))
        : [...this.locations, next]
    }),
  ]
},

disconnectRealtime(): void {
  for (const off of unsubscribers) off()
  unsubscribers = []
},
```

Keep the polling fallback exactly as it is. The old socket had no reconnect because polling covered it; the singleton reconnects anyway, which is strictly better and changes no behaviour the map depends on.

- [ ] **Step 4: Run both stores' tests**

Run: `cd fleet-portal && npx vitest run src/stores/tracking.spec.ts src/lib/realtime.spec.ts src/stores/loadboard.spec.ts`
Expected: PASS, guard test green.

- [ ] **Step 5: Commit** — skipped.

---

### Task 6: The loadboard patches the loads that changed instead of re-reading five endpoints

**Files:**
- Modify: `fleet-portal/src/stores/loadboard.ts`
- Create: `fleet-portal/src/stores/loadboard.patch.spec.ts`

**Interfaces:**
- Consumes: `GET /dispatcher/loadboard?from&to&carrierId?&ids=` answering `{ loads }` (Task 3); frames `{ type: 'load_changed', orgId, loadId, version, fields }` (Task 1).
- Produces: `patchLoads(ids: string[]): Promise<void>` and `refreshDerived(): Promise<void>` on the store, both public so a test and the Cockpit can call them.

- [ ] **Step 1: Write the failing test**

```ts
// fleet-portal/src/stores/loadboard.patch.spec.ts
it('re-reads only the changed load, and only once for a burst', async () => {
  const store = useLoadboardStore()
  store.loads = [loadA, loadB]
  store.connectRealtime()
  emit({ type: 'load_changed', loadId: 'a', version: 4, fields: ['status'] })
  emit({ type: 'load_changed', loadId: 'a', version: 5, fields: ['rate'] })
  emit({ type: 'load_changed', loadId: 'c', version: 1, fields: ['created'] })
  await flushCoalesce()
  const calls = api.get.mock.calls.filter(([url]) => url === '/dispatcher/loadboard')
  expect(calls).toHaveLength(1)                       // one request for the whole burst
  expect(calls[0][1].params.ids).toBe('a,c')          // both ids, each once
  expect(api.get).not.toHaveBeenCalledWith('/dispatcher/alerts', expect.anything())
})

it('drops a load the server no longer returns', async () => {
  const store = useLoadboardStore()
  store.loads = [loadA, loadB]
  api.get.mockResolvedValueOnce({ data: { loads: [] } })
  await store.patchLoads(['a'])
  expect(store.loads.map((l) => l.id)).toEqual(['b'])  // absence means removal
})

it('ignores a frame for a version it has already rendered', async () => {
  const store = useLoadboardStore()
  store.loads = [{ ...loadA, version: 7 }]
  store.connectRealtime()
  emit({ type: 'load_changed', loadId: 'a', version: 7, fields: ['rate'] })
  await flushCoalesce()
  expect(api.get).not.toHaveBeenCalled()              // our own echo
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd fleet-portal && npx vitest run src/stores/loadboard.patch.spec.ts`
Expected: FAIL — `patchLoads` does not exist.

- [ ] **Step 3: Add the coalescing subscriber**

```ts
/** Ids collected from `load_changed` frames since the last flush. A paste
 *  across thirty cells is thirty frames; the board owes the dispatcher one
 *  request, not thirty. */
const pendingIds = new Set<string>()
let coalesceTimer: number | null = null
/** Long enough to swallow a paste's burst, short enough that a single edit
 *  still feels immediate. */
const COALESCE_MS = 50
```

In `connectRealtime`, add a third subscription:

```ts
subscribe('load_changed', (frame) => {
  this.lastEvent = { type: frame.type, payload: frame, at: Date.now(), seq: ++eventSeq }
  const loadId = typeof frame.loadId === 'string' ? frame.loadId : null
  const version = typeof frame.version === 'number' ? frame.version : null
  if (!loadId) return
  // Our own write already put the new row on screen with this version (or a
  // newer one). Re-reading it would repaint a cell the dispatcher is still
  // looking at, for no new information.
  const known = this.loads.find((l) => l.id === loadId)
  if (known && version !== null && typeof known.version === 'number' && known.version >= version) return
  pendingIds.add(loadId)
  if (coalesceTimer == null) {
    coalesceTimer = window.setTimeout(() => {
      coalesceTimer = null
      const ids = [...pendingIds]
      pendingIds.clear()
      void this.patchLoads(ids)
    }, COALESCE_MS)
  }
}),
```

Also subscribe to `OPEN`: a reconnect means frames were missed, so call the full `load()` + `refreshDerived()` rather than trying to patch a gap you cannot enumerate.

- [ ] **Step 4: Add `patchLoads` and `refreshDerived`**

```ts
/**
 * Re-read exactly these loads and swap them into `loads` in place.
 *
 * An id that comes back absent is a load that left this board — it moved out
 * of the window, was archived, was deleted, or the carrier filter no longer
 * matches it. It is removed, not kept stale. Anything else would leave a
 * brick on the board that the server says is not there.
 */
async patchLoads(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const from = this.windowOverride?.from ?? utcMidnight(this.fromDate).toISOString()
  const to = this.windowOverride?.to ?? addDays(utcMidnight(this.toDate), 1).toISOString()
  const carrierId = useCarriersStore().selectedCarrierId
  try {
    const { data } = await api.get<{ loads: BoardLoad[] }>('/dispatcher/loadboard', {
      params: { from, to, ids: ids.join(','), ...(carrierId ? { carrierId } : {}) },
    })
    const fresh = new Map(data.loads.map((l) => [l.id, l]))
    const asked = new Set(ids)
    const kept = this.loads
      .filter((l) => !asked.has(l.id) || fresh.has(l.id))
      .map((l) => fresh.get(l.id) ?? l)
    const added = data.loads.filter((l) => !this.loads.some((existing) => existing.id === l.id))
    this.loads = [...kept, ...added]
  } catch (error) {
    // A failed patch must not leave the board wrong: fall back to the full
    // read, which is the behaviour this whole path replaced.
    this.error = extractApiErrorMessage(error)
    await this.load()
  }
  void this.refreshDerived()
},

/** The numbers that are computed from loads rather than rendered from them:
 *  alerts, KPIs and the risk feed. Trailing-debounced, because they are a
 *  summary — a second late is invisible, a request per keystroke is not. */
async refreshDerived(): Promise<void> {
  if (derivedTimer != null) return
  derivedTimer = window.setTimeout(() => {
    derivedTimer = null
    void Promise.all([this.loadAlerts(), this.loadKpis(), this.loadRisk()])
  }, DERIVED_MS)
},
```

with `let derivedTimer: number | null = null` and `const DERIVED_MS = 3_000` beside the coalescing state. `loadYard()` is deliberately not in there: yard is tractors and trailers, which no load write touches.

- [ ] **Step 5: Run the tests**

Run: `cd fleet-portal && npx vitest run src/stores/loadboard.patch.spec.ts src/stores/loadboard.spec.ts`
Expected: PASS.

- [ ] **Step 6: Verify the type check**

Run: `cd fleet-portal && npx vue-tsc --noEmit -p tsconfig.app.json`
Expected: only the five pre-existing errors. `BoardLoad` may need a `version?: number` field added — add it if the projection sends one; confirm against Task 3's response before assuming.

- [ ] **Step 7: Commit** — skipped.

---

### Task 7: The broker board listens, and a conflict is per load

**Files:**
- Modify: `fleet-portal/src/stores/brokerBoard.ts`, `fleet-portal/src/views/BrokerBoardView.vue`
- Test: `fleet-portal/src/stores/brokerBoard.spec.ts` (extend), `fleet-portal/src/views/BrokerBoardView.spec.ts` (extend)

**Interfaces:**
- Consumes: `subscribe`, `OPEN` from `../lib/realtime`; `GET /dispatcher/broker-board?ids=` (Task 2).
- Produces: `conflicts: Record<string, ConflictEntry>` replacing the single `conflict` slot; `conflictFor(loadId): ConflictEntry | null`; `resolveConflict(loadId, choice)`.

**Carried finding:** A2 ruling R14 parked this — `BrokerBoardView` attributes a pending conflict to whichever save settles next, because `store.conflict` is one slot. Two saves in flight and the second gets marked with the first's conflict. That is the second half of this task.

- [ ] **Step 1: Write the failing conflict-map test**

```ts
it('keeps two conflicts apart instead of blaming the last save', async () => {
  const store = useBrokerBoardStore()
  api.patch
    .mockRejectedValueOnce(staleVersion({ loadId: 'a', current: 4, theirs: 'MEIBORG' }))
    .mockRejectedValueOnce(staleVersion({ loadId: 'b', current: 9, theirs: 'ACME' }))
  await Promise.all([store.writeCell('a', writeA), store.writeCell('b', writeB)])
  expect(store.conflictFor('a')!.current).toBe(4)
  expect(store.conflictFor('b')!.current).toBe(9)
  store.resolveConflict('a', 'theirs')
  expect(store.conflictFor('a')).toBeNull()
  expect(store.conflictFor('b')!.theirs).toBe('ACME')   // resolving one leaves the other standing
})
```

- [ ] **Step 2: Write the failing listen test**

```ts
it('swaps in a row another dispatcher changed, and drops one that left the board', async () => {
  const store = useBrokerBoardStore()
  store.loads = [rowA, rowB]
  store.connectRealtime()
  api.get.mockResolvedValueOnce({ data: { layout, loads: [{ ...rowA, version: 6, cells: { ...rowA.cells, RATE: '2450' } }] } })
  emit({ type: 'load_changed', loadId: 'a', version: 6, fields: ['rate'] })
  emit({ type: 'load_changed', loadId: 'b', version: 3, fields: ['deleted'] })
  await flushCoalesce()
  expect(api.get.mock.calls.at(-1)![1].params.ids).toBe('a,b')
  expect(store.loads.map((l) => l.id)).toEqual(['a'])
  expect(store.loads[0].cells.RATE).toBe('2450')
})
```

- [ ] **Step 3: Run both and watch them fail**

Run: `cd fleet-portal && npx vitest run src/stores/brokerBoard.spec.ts`
Expected: FAIL — `conflictFor` and `connectRealtime` do not exist on this store.

- [ ] **Step 4: Turn the conflict slot into a map**

```ts
export type ConflictEntry = { loadId: string; write: BoardCellWrite; current: number; theirs: string; load: BoardLoad }

// state
conflicts: {} as Record<string, ConflictEntry>,
```

Replace the single assignment at the STALE_VERSION catch with `this.conflicts = { ...this.conflicts, [loadId]: entry }`, and the clear with a key delete built immutably. Add:

```ts
conflictFor(loadId: string): ConflictEntry | null { return this.conflicts[loadId] ?? null },
```

Update `BrokerBoardView.vue` to read `store.conflictFor(loadId)` per row rather than a single `store.conflict`, and to render one conflict panel per conflicted row. Every existing `store.conflict` reference must go; grep for it and list what you changed in the report.

- [ ] **Step 5: Add the subscription**

Mirror Task 6's shape: the same `pendingIds` Set, the same `COALESCE_MS = 50`, the same echo guard (`known.version >= frame.version` → ignore), and a `patchRows(ids)` that calls `GET /dispatcher/broker-board` with `ids` and the store's current `archived` flag, then swaps rows in place and drops ids the answer omits. Subscribe to `OPEN` with a full `load()` — a reconnect's gap is not enumerable.

Do **not** apply an incoming frame to a row whose cell the dispatcher is editing right now. The store already knows which cell is in flight (the per-load in-flight save map from A2); skip those ids and re-request them when the save settles. Overwriting a half-typed cell from a socket frame is the one behaviour a dispatcher will never forgive.

- [ ] **Step 6: Run the tests**

Run: `cd fleet-portal && npx vitest run src/stores/brokerBoard.spec.ts src/views/BrokerBoardView.spec.ts src/components/broker`
Expected: PASS.

- [ ] **Step 7: Commit** — skipped.

---

### Task 8: The Cockpit subscribes for itself, and shows who is holding a load

**Files:**
- Modify: `fleet-portal/src/stores/cockpit.ts`, `fleet-portal/src/views/CockpitView.vue`, `fleet-portal/src/components/cockpit/LegBrick.vue`, `fleet-portal/src/components/cockpit/GanttBoard.vue`
- Test: `fleet-portal/src/stores/cockpit.spec.ts` (extend), `fleet-portal/src/components/cockpit/GanttBoard.spec.ts` (extend)

**Interfaces:**
- Consumes: `subscribe` from `../lib/realtime`; `useLoadLocksStore().theirs` (A2) — a map of `loadId → { by: string; until: number }` for locks held by another dispatcher.
- Produces: `cockpit.connectRealtime()` / `disconnectRealtime()`; a `[data-locked]` attribute on a brick whose load someone else holds.

- [ ] **Step 1: Write the failing badge test**

```ts
it('marks a brick whose load another dispatcher is holding', async () => {
  useLoadLocksStore().theirs = { l1: { by: 'Maria', until: Date.now() + 60_000 } }
  const w = mount(GanttBoard, { props: { nowMs: NOW } })
  const brick = w.find('[data-bid="l1"]')
  expect(brick.attributes('data-locked')).toBe('Maria')
  expect(brick.text()).toContain('Maria')
  // The badge is information, not a barrier: the Cockpit's own writes are
  // already refused server-side by the lock, and a brick that silently
  // stopped responding would read as a bug rather than as someone else's edit.
  expect(w.find('[data-bid="l2"]').attributes('data-locked')).toBeUndefined()
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd fleet-portal && npx vitest run src/components/cockpit/GanttBoard.spec.ts -t "another dispatcher is holding"`
Expected: FAIL — no such attribute.

- [ ] **Step 3: Render the badge**

In `GanttBoard.vue`, read `useLoadLocksStore()` and pass `lockedBy: locks.theirs[l.id]?.by ?? null` into each brick's props. In `LegBrick.vue`, add `:data-locked="lockedBy || undefined"` on the root and, when `lockedBy` is set, a small badge showing the holder's name — the same treatment the broker grid already gives a locked row, so a dispatcher meets one visual language on both boards. The badge renders at every brick width, including the 96 px unplaced width (the same lesson as A3 Task 6).

- [ ] **Step 4: Move the Cockpit off `lastEvent`**

Give `stores/cockpit.ts` its own `connectRealtime()` that subscribes to `board_update`, `driver_status` and `load_changed` and calls the existing `ingestEvent` with each frame. Remove the `watch(() => lb.lastEvent, ev => ck.ingestEvent(ev))` in `CockpitView.vue` and call `ck.connectRealtime()` on mount / `ck.disconnectRealtime()` on unmount beside the loadboard store's existing pair.

`ingestEvent` keeps its signature and its behaviour for the two types it already knows; add a `load_changed` arm that appends an activity-feed entry naming the load and the fields that changed. Do not make it refetch — Task 6's store already did.

- [ ] **Step 5: Delete `lastEvent` if nothing reads it**

Grep for `lastEvent`. If the Cockpit was its only consumer, remove it from `stores/loadboard.ts` along with the `eventSeq` counter and the three assignments that feed it. If anything else reads it, leave it and say what in the report.

- [ ] **Step 6: Run the portal suites**

Run: `cd fleet-portal && npx vitest run src/components/cockpit src/stores src/lib` then `npx vue-tsc --noEmit -p tsconfig.app.json`
Expected: green; type check shows only the five pre-existing errors.

- [ ] **Step 7: Commit** — skipped.

---

### Task 9: `board_update` retires from every site `load_changed` now covers

**Files:**
- Modify: `fleet-backend/src/routes/dispatcherLoads.ts`, `dispatcherAssignments.ts`, `dispatcherBrokerBoard.ts`, `dispatcherLoadTruth.ts`, `webhooks.ts`, `src/lib/assignmentActions.ts`
- Test: `fleet-backend/tests/dispatcher-board-realtime.test.ts` (update), `fleet-backend/tests/load-changed-events.test.ts` (extend)

**Interfaces:**
- Consumes: everything Tasks 1–8 built.
- Produces: `board_update` surviving at exactly two sites, both documented.

**This task runs last on purpose.** Until Tasks 6 and 7 ship, `board_update` is the only thing keeping the two boards live; removing it earlier regresses the product between tasks.

- [ ] **Step 1: Write the failing guard test**

```ts
// fleet-backend/tests/load-changed-events.test.ts
const BOARD_UPDATE_SURVIVORS = [
  // A replan edits the Assignment's plan, not the Load record — `load_changed`
  // would be a false statement about the load, so this one keeps the blunt
  // event and the board keeps its full refresh for it.
  "src/routes/dispatcherAssignments.ts",
  // Pairing a tractor or trailer to a driver changes neither a Load nor an
  // Assignment; the lane's equipment is read from the yard endpoint.
  "src/routes/dispatcherDrivers.ts",
];

it("fires board_update only where no load actually changed", () => {
  const offenders: string[] = [];
  for (const file of tsFilesUnder(srcDir)) {
    const rel = relative(repoRoot, file).split("\\").join("/");
    if (!readFileSync(file, "utf8").includes('"board_update"')) continue;
    if (!BOARD_UPDATE_SURVIVORS.includes(rel)) offenders.push(rel);
  }
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd fleet-backend && npx vitest run tests/load-changed-events.test.ts -t "only where no load"`
Expected: FAIL, listing five files.

- [ ] **Step 3: Remove the covered emits**

Delete the `emitToDispatchers(orgId, "board_update", …)` call at each of the 18 Load-change sites in the research map's table, leaving only the replan site in `dispatcherAssignments.ts` and the pairing site in `dispatcherDrivers.ts`. Every one of those 18 must already emit `load_changed` from Task 1 — check each before deleting, and if one does not, that is a Task 1 miss: fix it here and say so in the report.

The `trip_*`, `lane_*`, `driver_*`, `status_change`, `signs_proof_*`, `general_notification` and `route_pre_assignment` events are untouched by this slice. Do not remove them.

- [ ] **Step 4: Update the realtime tests**

`tests/dispatcher-board-realtime.test.ts` asserts `board_update` arrives for route calls that now send `load_changed`. Rewrite each such assertion to expect `load_changed` with the right `loadId` and a `version` matching the database, rather than deleting the case. A deleted assertion is coverage lost; a rewritten one is coverage moved.

- [ ] **Step 5: Run both suites**

Run: `cd fleet-backend && npx vitest run` then `npx tsc --noEmit`; then `cd ../fleet-portal && npx vitest run` and `npx vue-tsc --noEmit -p tsconfig.app.json`
Expected: backend green and clean; portal green with only the five pre-existing type errors.

- [ ] **Step 6: Commit** — skipped.

---

### Task 10: Live acceptance — two browsers, one socket, one honest board

**Files:** none changed. This task proves the slice on the running system and writes its evidence into the ledger.

**Interfaces:** Consumes the running dev backend on :3001 and portal on :5173, the dev Postgres in `fleet-postgres`, and a second dispatcher account created for the probe and deleted afterwards.

**Standing constraint:** the user's real MEIBORG board rows are not test fixtures. Use probe rows you create and delete. If any real cell is changed, restore it and record the restoration, with the load's version, in the ledger.

- [ ] **Step 1: Bring the system up**

```bash
docker start fleet-postgres
cd fleet-backend && NODE_OPTIONS=--max-http-header-size=65536 npx tsx watch src/server.ts &
cd fleet-portal && NODE_OPTIONS=--max-http-header-size=65536 npm run dev -- --port 5173 &
```

Confirm both answer before driving the browser. If Vite serves a stale module graph after this slice's edits, `rm -rf node_modules/.vite` and restart — it has happened in every slice so far.

- [ ] **Step 2: Prove one socket**

Open the portal, log in, visit the Cockpit, the Tracking map and the Broker board in turn without reloading. In DevTools' Network panel filtered to WS, confirm exactly one `/ws` connection exists for the whole tab across all three views. Screenshot it.

- [ ] **Step 3: Prove patch-by-id**

With the Network panel filtered to XHR, edit one cell on the broker board. Confirm: one `PATCH`, then at most one `GET /broker-board?ids=<that id>` — and specifically **no** `GET /dispatcher/loadboard` without `ids`, and no burst of five endpoint calls. Paste a block across ten rows and confirm the follow-up is a single `ids=` request, not ten.

- [ ] **Step 4: Prove the two boards agree**

Two browsers, two dispatcher accounts, same org. In browser A change a load's status on the Cockpit. In browser B, without touching anything, confirm the broker board's row for that load updates in place within a second or two and that the rest of the board does not flicker. Then archive a row in B and confirm it disappears from A.

- [ ] **Step 5: Prove the lock badge on the Cockpit**

In browser A take the edit lock on a load (open its editor on the broker board). In browser B's Cockpit, confirm the brick for that load shows the holder's name. Release in A and confirm the badge clears in B within the lock's TTL.

- [ ] **Step 6: Prove two conflicts stay apart (ruling R14)**

In browser A, hold two different loads' rows stale (render, then let B bump both versions). Save both in A. Confirm two separate conflict panels appear, each naming its own load's `theirs` value, and that resolving one leaves the other standing.

- [ ] **Step 7: Clean up and record**

Delete the probe rows and the probe dispatcher account. Restore any real cell touched, and note the load id and resulting version. Append to the ledger: what was observed at each step, the screenshot paths (under the session scratchpad, not the repo), and anything that did not behave as the plan predicted.

- [ ] **Step 8: Commit** — skipped.
