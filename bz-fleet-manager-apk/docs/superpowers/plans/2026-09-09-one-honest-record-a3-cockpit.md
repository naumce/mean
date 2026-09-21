# One Honest Record — Plan A3: The Cockpit sees the brokered loads

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A brokered load that Their Board says is covered appears in the Cockpit as a brick in a lane named after its carrier; the backlog shows exactly the loads nobody has confirmed; and every Cockpit write to a Load goes through the same writer Their Board uses, so the record stays honest in both directions.

**Architecture:** The loadboard projection gains the brokered fields and a second population — loads with no `Assignment`, a `carrierId`, and a covered status — filtered to the requested window by their `Appointment` rows. The portal's `projectLanes` adds a lane kind `brokered` (id `carrier:<carrierId>`) fed from those loads; a brick spans PU `windowStart` → DEL `windowEnd`, or renders unplaced at the lane's left edge with the load's Attention when the windows are missing. The backlog rule is unchanged; backlog rows with a `carrierId` get a "carrier · pending" chip. The writer gains the TMS scalars, a full stop-set patch, and a status entry point, and `PATCH /loads/:id`, the assignment lifecycle and `reopen` move onto it — replacing A2's interim `version: { increment: 1 }` lines. Risk gains brokered candidates: `late_start` fires from the PU window; `behind_schedule` cannot (no GPS) until slice B.

**Tech Stack:** fleet-backend — Express 4, Prisma 5 (Postgres), zod, vitest + supertest. fleet-portal — Vue 3, Pinia, vitest + @vue/test-utils, vue-tsc (`-p tsconfig.app.json`).

**Spec:** `docs/superpowers/specs/2026-09-09-one-honest-record-design.md` — §8 (the Cockpit side: 8.1 projection, 8.2 coverage by status, 8.3 carrier lanes and the backlog, 8.4 risk, 8.5 acceptance), §4 (every Load mutation through the writer — the `/loadboard` PATCH and the assignment lifecycle were deferred here by plan A1), §12 (honesty rules). This plan implements spec §15 build step 4. Plans A1 (writer) and A2 (locks + version backstop) precede it in the same working tree.

## Global Constraints

- **No git commits, no `git add`** — the user's standing rule. Every "Commit" step is skipped; the working tree is the deliverable.
- **Coverage is decided by status (§8.2):** a brokered load is covered when `status ∈ {assigned, in_progress, delivered}`; `open` with a carrier is a carrier *lined up*, not booked, and stays in the backlog. The backlog rule is unchanged: `!assignment && status ∈ {open, tendered}`.
- **A carrier lane** exists only for a load with **no `Assignment`, a `carrierId`, and a covered status**; its id is `carrier:<carrierId>`, its label the carrier's name and MC; it has no driver, tractor or trailer; gestures (drag/resize/drop) do not apply to its bricks.
- **The single write path:** `applyLoadChange(tx, { loadId, orgId, actor, source, patch, attention?, attentionOwned?, force?, baseVersion? })` in `fleet-backend/src/lib/loadWriter.ts`; status changes that are not derived from UPDATE text go through the new `applyStatusChange(tx, { loadId, orgId, actor, source, status, note })` in the same file. After this plan no route writes `Load` scalars, stops, appointments or status directly — except `POST /loads/:id/cancel` (its own pre-existing ruling: a cancellation is external reality), which keeps its direct write with `version: { increment: 1 }`.
- Lock semantics from A2 hold: a load held by another dispatcher refuses every writer (`LoadLocked` → 409 `LOAD_LOCKED`); `baseVersion` is optional for `source: "loadboard"` (the Cockpit has no cell editor sending it yet) and never checked for `import`/`backfill`.
- Every new query is org-scoped; every body validated with zod; the actor is the session's dispatcher (`actorOf(req)`).
- Checks: backend `npx vitest run` (per-process Postgres schema; container `fleet-postgres` on :5434) and `npx tsc --noEmit`; portal `npx vitest run` and `npx vue-tsc --noEmit -p tsconfig.app.json` (only the two pre-existing files `RoutePlanCard.spec.ts` and `FleetMap.vue` may show errors).

---

## File structure

**fleet-backend**
- `src/lib/loadWriter.ts` — `LoadPatch` gains `requiredEquip`, `fscCents`, `hazmatClass`, `commodity`, `brokerName`, `weightLbs`, `stopSet`; `deriveStops` handles `stopSet`; new `applyStatusChange`.
- `src/routes/dispatcherLoads.ts` — `PATCH /loads/:id` and `POST /loads/:id/reopen` onto the writer.
- `src/lib/assignmentActions.ts`, `src/routes/dispatcherAssignments.ts` — status writes via `applyStatusChange`.
- `src/routes/dispatcherLoadboard.ts` — projection fields, brokered covered loads, carrier filter on `Load.carrierId`.
- `src/routes/dispatcherRisk.ts`, `src/lib/lateRisk.ts` — brokered candidates.
- Tests: `tests/load-writer.test.ts`, `tests/dispatcher-loads.test.ts`, `tests/dispatcher-assignments.test.ts`, `tests/dispatcher-loadboard.test.ts`, `tests/loadboard-carrier.test.ts`, `tests/dispatcher-risk.test.ts`.

**fleet-portal**
- `src/stores/loadboard.ts` — `BoardLoad` gains the brokered fields.
- `src/lib/cockpit/lanes.ts` — lane kind `brokered`, `carrierLanesOf`, `spanOf`; `groupLanesByCarrier` buckets brokered lanes under their carrier.
- `src/components/cockpit/GanttBoard.vue`, `LegBrick.vue`, new `LaneHeadCarrier.vue` — brokered bricks and lane heads.
- `src/components/cockpit/BacklogPanel.vue` — the carrier chip.
- `src/components/board/RiskFeed.vue`, `src/stores/loadboard.ts` risk types — tolerate `assignmentId: null`.
- Specs: `src/lib/cockpit/lanes.spec.ts`, `src/components/cockpit/GanttBoard.spec.ts`, `src/components/cockpit/LaneHead.spec.ts`, `src/components/cockpit/Panels.spec.ts`.

**Deliberately not here:** GPS for brokered `in_progress` loads (`behind_schedule`; slice B), the shared socket and patch-by-id (A4), the Cockpit brick's "Maria is editing" badge (A4 — it needs the shared socket), a Cockpit editor for brokered loads (the cell lives on Their Board).

---

### Task 1: The writer accepts the Cockpit's fields, a full stop set, and a status

**Files:**
- Modify: `fleet-backend/src/lib/loadWriter.ts` (`LoadPatch`, `SCALARS`, `deriveStops`, new `applyStatusChange`)
- Test: `fleet-backend/tests/load-writer.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  // LoadPatch gains:
  requiredEquip?: string; fscCents?: number; hazmatClass?: string | null; commodity?: string | null; brokerName?: string | null; weightLbs?: number | null;
  /** The Cockpit edits stops as a whole list (N stops, explicit windows). Mutually exclusive with `stops` (the board's by-role city edit). */
  stopSet?: StopSetEntry[];
  export interface StopSetEntry { sequence: number; type: "pickup" | "delivery" | "intermediate"; address: string; lat?: number | null; lng?: number | null; dwellMin?: number | null; windowStart?: Date | null; windowEnd?: Date | null }
  export interface StatusArgs { loadId: string; orgId: string; actor: Actor; source: ChangeSource; status: string; note: string | null }
  export async function applyStatusChange(tx: Tx, args: StatusArgs): Promise<{ version: number; before: string }>
  ```
  `applyStatusChange` refuses a held load (`assertWritable`), writes `status` + `version: { increment: 1 }`, one `LoadChange { field: "status", before, after, note }` stamped with `nextAtMs()`, and returns the new version. It does NOT run derivation (the lifecycle owns these transitions — spec §6.3) and does not check `baseVersion`.

- [ ] **Step 1: Write the failing tests**

Append to `fleet-backend/tests/load-writer.test.ts` (it has `setup()` → `{ org, load }`, `apply(loadId, orgId, patch, extra?)`, `maria`; add `applyStatusChange` to the loadWriter import):
```ts
describe("applyLoadChange — the Cockpit's fields and a full stop set (plan A3)", () => {
  beforeEach(resetDb);

  it("writes the TMS scalars, traces them, and bumps the version once", async () => {
    const { org, load } = await setup();
    const r = await apply(load.id, org.id, { requiredEquip: "Reefer", commodity: "Frozen peas", weightLbs: 41000, hazmatClass: null, brokerName: "TQL", fscCents: 12000 }, { source: "loadboard" });
    expect(r.version).toBe(1);
    expect(r.changed.sort()).toEqual(["brokerName", "commodity", "fscCents", "requiredEquip", "weightLbs"]);
    const after = await prisma.load.findUnique({ where: { id: load.id } });
    expect([after?.requiredEquip, after?.commodity, after?.weightLbs, after?.fscCents]).toEqual(["Reefer", "Frozen peas", 41000, 12000]);
    expect(await prisma.loadChange.count({ where: { loadId: load.id, field: "requiredEquip", before: "DryVan", after: "Reefer" } })).toBe(1);
  });

  it("replaces the whole stop set with explicit windows, geocodes what the gazetteer knows, and traces the change", async () => {
    const { org, load } = await setup();
    const r = await apply(load.id, org.id, { stopSet: [
      { sequence: 1, type: "pickup", address: "Kansas City, MO", dwellMin: 60, windowStart: new Date("2026-07-14T15:00:00Z"), windowEnd: new Date("2026-07-14T17:00:00Z") },
      { sequence: 2, type: "intermediate", address: "Nowhere, ZZ", dwellMin: 30 },
      { sequence: 3, type: "delivery", address: "Dallas, TX", windowEnd: new Date("2026-07-16T12:00:00Z") },
    ] }, { source: "loadboard" });
    expect(r.version).toBe(1);
    expect(r.changed).toContain("stopSet");
    const stops = await prisma.loadStop.findMany({ where: { loadId: load.id }, orderBy: { sequence: "asc" }, include: { appointment: true } });
    expect(stops.map((s) => [s.type, s.geocodeStatus, s.appointment?.windowEnd?.toISOString() ?? null])).toEqual([
      ["pickup", "ok", "2026-07-14T17:00:00.000Z"],
      ["intermediate", "pending", null],
      ["delivery", "ok", "2026-07-16T12:00:00.000Z"],
    ]);
    expect(stops[0].appointment?.windowStart?.toISOString()).toBe("2026-07-14T15:00:00.000Z");
    expect(r.attention).toEqual(['can\'t place intermediate "Nowhere, ZZ" on the map']);
    expect(await prisma.loadChange.count({ where: { loadId: load.id, field: "stopSet" } })).toBe(1);
  });

  it("keeps coordinates the caller supplied instead of re-geocoding them", async () => {
    const { org, load } = await setup();
    await apply(load.id, org.id, { stopSet: [
      { sequence: 1, type: "pickup", address: "Somewhere Farm Rd", lat: 39.1, lng: -94.6 },
      { sequence: 2, type: "delivery", address: "Dallas, TX" },
    ] }, { source: "loadboard" });
    const pu = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "pickup" } });
    expect([pu?.lat, pu?.lng, pu?.geocodeStatus]).toEqual([39.1, -94.6, "ok"]);
  });

  it("applyStatusChange: moves the status, traces it with its note, bumps the version, and refuses a held load", async () => {
    const { org, load } = await setup();
    const r = await prisma.$transaction((tx) => applyStatusChange(tx, { loadId: load.id, orgId: org.id, actor: maria, source: "loadboard", status: "assigned", note: "assignment a1 committed" }));
    expect(r).toEqual({ version: 1, before: "open" });
    const row = await prisma.loadChange.findFirst({ where: { loadId: load.id, field: "status" } });
    expect([row?.before, row?.after, row?.note, row?.source]).toEqual(["open", "assigned", "assignment a1 committed", "loadboard"]);
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-jake", dispatcherName: "Jake", expiresAt: new Date(Date.now() + 60_000) } });
    await expect(prisma.$transaction((tx) => applyStatusChange(tx, { loadId: load.id, orgId: org.id, actor: maria, source: "loadboard", status: "in_progress", note: null }))).rejects.toMatchObject({ lock: { by: "Jake" } });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.status).toBe("assigned");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd fleet-backend && npx vitest run tests/load-writer.test.ts -t "plan A3"` → FAIL (unknown patch keys; `applyStatusChange` not exported).

- [ ] **Step 3: Extend the writer**

In `fleet-backend/src/lib/loadWriter.ts`:
- `LoadPatch`: add
  ```ts
  // The Cockpit's own fields (plan A3) — TMS scalars a dispatcher edits in /loadboard.
  requiredEquip?: string; fscCents?: number; hazmatClass?: string | null; commodity?: string | null; brokerName?: string | null; weightLbs?: number | null;
  /** The Cockpit edits stops as a whole ordered list with explicit windows.
   *  Mutually exclusive with `stops` (the board's by-role city edit). */
  stopSet?: StopSetEntry[];
  ```
  and export `StopSetEntry` as in Interfaces.
- `SCALARS`: append `"requiredEquip", "fscCents", "hazmatClass", "commodity", "brokerName", "weightLbs"` (the generic scalar loop then writes and traces them; `rendered()` already handles numbers/strings/null).
- In `deriveStops`, before the by-role logic: if `patch.stopSet` is present, replace the set:
  ```ts
  if (patch.stopSet) {
    // The Cockpit's list replaces the whole set (N stops, explicit windows).
    // Coordinates the caller supplied are kept; every other address meets
    // the gazetteer, and a miss is `pending` plus its Attention line — the
    // same words the by-role path uses, so one aspect per role.
    await tx.appointment.deleteMany({ where: { stop: { loadId: before.id } } });
    await tx.loadStop.deleteMany({ where: { loadId: before.id } });
    for (const role of ["pickup", "delivery", "intermediate"]) aspects.add(`can't place ${role}`);
    for (const s of patch.stopSet) {
      const own = s.lat != null && s.lng != null;
      const hit = own ? { lat: s.lat!, lng: s.lng! } : gazetteerLookup(geocodeQuery(s.address));
      const stop = await tx.loadStop.create({ data: {
        loadId: before.id, sequence: s.sequence, type: s.type, address: s.address, dwellMin: s.dwellMin ?? undefined,
        lat: hit?.lat ?? null, lng: hit?.lng ?? null, geocodeStatus: hit ? "ok" : "pending",
      } });
      if (!hit) attention.push(`can't place ${s.type} "${s.address}" on the map`);
      if (s.windowEnd) await tx.appointment.create({ data: { stopId: stop.id, windowStart: s.windowStart ?? null, windowEnd: s.windowEnd, type: s.type === "intermediate" ? "delivery" : s.type, kind: "appointment" } });
    }
    changed.push("stopSet");
    return;
  }
  ```
  (`geocodeQuery` and `gazetteerLookup` are already imported/defined in this file from A1/A2; `aspects`, `attention`, `changed` are the parameters `deriveStops` already receives. The trace loop must write one `LoadChange { field: "stopSet", before: <old addresses joined by " → ">, after: <new addresses joined> }` — add `stopSet` to the trace filter beside `stops.pickup`/`stops.delivery`, computing `before` from `before.stops` and `after` from the patch.) `deriveAppointments` must skip when `patch.stopSet` was given (the windows were explicit): add `if (patch.stopSet) return;` at its top.
- New export, after `applyLoadChange`:
  ```ts
  export interface StatusArgs { loadId: string; orgId: string; actor: Actor; source: ChangeSource; status: string; note: string | null }

  /** The lifecycle's door (spec §6.3): assign, start, deliver, unassign,
   *  reopen move a load's status by structure, not by text. One row of trace,
   *  one version tick, the same lock gate as every other write; no derivation
   *  — the text on the board did not change, only what we know. */
  export async function applyStatusChange(tx: Tx, args: StatusArgs): Promise<{ version: number; before: string }> {
    const before = await tx.load.findFirst({ where: { id: args.loadId, orgId: args.orgId }, select: { status: true } });
    if (!before) throw new LoadNotFound(`load ${args.loadId} is not in org ${args.orgId}`);
    await assertWritable(tx, args.loadId, args.actor.dispatcherId);
    if (before.status === args.status) {
      const same = await tx.load.findUnique({ where: { id: args.loadId }, select: { version: true } });
      return { version: same?.version ?? 0, before: before.status };
    }
    const row = await tx.load.update({ where: { id: args.loadId }, data: { status: args.status, version: { increment: 1 } }, select: { version: true } });
    await tx.loadChange.create({ data: {
      loadId: args.loadId, orgId: args.orgId, atMs: nextAtMs(), actorId: args.actor.dispatcherId, actorName: args.actor.name,
      source: args.source, field: "status", before: before.status, after: args.status, note: args.note,
    } });
    return { version: row.version, before: before.status };
  }
  ```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/load-writer.test.ts` → PASS (all prior + 4). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 2: `PATCH /loads/:id`, `reopen`, and the assignment lifecycle go through the writer

**Files:**
- Modify: `fleet-backend/src/routes/dispatcherLoads.ts` (`PATCH /loads/:id`, `POST /loads/:id/reopen`)
- Modify: `fleet-backend/src/lib/assignmentActions.ts` (`unassign`, `acceptTender`), `fleet-backend/src/routes/dispatcherAssignments.ts` (the two `tx.load.update({ … status …, version: { increment: 1 } })` sites at ≈477 and ≈625)
- Test: `fleet-backend/tests/dispatcher-loads.test.ts`, `fleet-backend/tests/dispatcher-assignments.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 `applyLoadChange` with the new fields, `applyStatusChange`, `actorOf`, `LoadNotFound`, `LoadLocked`, `StaleVersion`.
- Produces: every one of these writes leaves a `LoadChange`, bumps `version` exactly once, and emits `load_changed { orgId, loadId, version, fields }`; A2's interim `version: { increment: 1 }` lines at those sites are removed (the writer does it).

- [ ] **Step 1: Write the failing tests**

Append to `tests/dispatcher-loads.test.ts` (reuse its `setup`/auth helpers and an open load; the existing PATCH test shows the body shape):
```ts
describe("the Cockpit's load edit goes through the writer (plan A3)", () => {
  it("traces every field it changed, geocodes the new stops, and bumps the version once", async () => {
    // <copy the existing PATCH test's setup lines: org, auth, an open load with two stops>
    const res = await request(app).patch(`/api/dispatcher/loads/${load.id}`).set(auth).send({
      requiredEquip: "Reefer", commodity: "Frozen peas",
      stops: [
        { sequence: 1, type: "pickup", address: "Kansas City, MO", windowStart: "2026-07-14T15:00:00.000Z", windowEnd: "2026-07-14T17:00:00.000Z" },
        { sequence: 2, type: "delivery", address: "Dallas, TX", windowEnd: "2026-07-16T12:00:00.000Z" },
      ],
    });
    expect(res.status).toBe(200);
    const after = await prisma.load.findUnique({ where: { id: load.id }, include: { stops: { orderBy: { sequence: "asc" }, include: { appointment: true } } } });
    expect(after?.version).toBe(1);
    expect(after?.stops.map((s) => [s.address, s.geocodeStatus, s.appointment?.windowEnd?.toISOString() ?? null])).toEqual([
      ["Kansas City, MO", "ok", "2026-07-14T17:00:00.000Z"], ["Dallas, TX", "ok", "2026-07-16T12:00:00.000Z"],
    ]);
    const fields = (await prisma.loadChange.findMany({ where: { loadId: load.id } })).map((c) => c.field).sort();
    expect(fields).toEqual(["commodity", "requiredEquip", "stopSet"]);
  });

  it("reopen goes through the writer: traced, versioned, and refused while someone edits the load", async () => {
    // <setup: a canceled load>
    await request(app).post(`/api/dispatcher/loads/${load.id}/reopen`).set(auth).expect(200);
    const row = await prisma.loadChange.findFirst({ where: { loadId: load.id, field: "status" } });
    expect([row?.before, row?.after, row?.source]).toEqual(["canceled", "open", "loadboard"]);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.version).toBe(1);
  });
});
```
Append to `tests/dispatcher-assignments.test.ts` (reuse the shortest "assigns a load" setup):
```ts
  it("assigning writes the status through the writer: one trace row naming the assignment, one version tick", async () => {
    // <copied setup + the assign POST>
    expect(res.status).toBe(201);
    const after = await prisma.load.findUnique({ where: { id: load.id } });
    expect([after?.status, after?.version]).toEqual(["assigned", 1]);
    const rows = await prisma.loadChange.findMany({ where: { loadId: load.id, field: "status" } });
    expect(rows).toHaveLength(1);
    expect([rows[0].before, rows[0].after, rows[0].source]).toEqual(["open", "assigned", "loadboard"]);
    expect(rows[0].note).toMatch(/assignment/);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run the two suites with `-t "plan A3|through the writer"` → FAIL (no `LoadChange` rows; `stopSet` field absent).

- [ ] **Step 3: Route the writes**

`fleet-backend/src/routes/dispatcherLoads.ts`:
- Imports: `import { applyLoadChange, applyStatusChange, LoadNotFound, StaleVersion, type LoadPatch } from "../lib/loadWriter.js";`, `import { LoadLocked } from "../lib/loadLocks.js";`, `import { actorOf } from "../lib/actor.js";`.
- `PATCH /loads/:id`: keep the 404, `guardLoad`, the `status !== "open"` 409 and the pickup/delivery validation. Replace the geocode-outside-the-transaction block and the transaction body with:
  ```ts
    const actor = await actorOf(req);
    const { stops, ...fields } = body;
    const patch: LoadPatch = {
      ...fields,
      ...(stops ? { stopSet: stops.map((s) => ({ ...s, windowStart: s.windowStart ? new Date(s.windowStart) : null, windowEnd: s.windowEnd ? new Date(s.windowEnd) : null })) } : {}),
    };
    let result;
    try {
      result = await prisma.$transaction((tx) => applyLoadChange(tx, { loadId: load.id, orgId: load.orgId, actor, source: "loadboard", patch }), { timeout: 15_000 });
    } catch (e) {
      if (e instanceof LoadNotFound) return res.status(404).json({ error: LOAD_EDIT_GONE });
      if (e instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: e.lock, message: e.message });
      if (e instanceof StaleVersion) return res.status(409).json({ error: "STALE_VERSION", current: e.current });
      console.error("PATCH /loads/:id failed", e);
      return res.status(500).json({ error: "That did not go through — try again" });
    }
    await settlePendingStops(load.orgId, [load.id]);
    const fresh = await prisma.load.findUnique({ where: { id: load.id }, include: { stops: { orderBy: { sequence: "asc" }, include: { appointment: true } } } });
    emitToDispatchers(load.orgId, "board_update", { loadId: load.id, edited: true });
    emitToDispatchers(load.orgId, "load_changed", { orgId: load.orgId, loadId: load.id, version: result.version, fields: result.changed });
    res.json(fresh);
  ```
  (`settlePendingStops` from `../lib/geocodeSettle.js`; the previous response shape — the load with stops — is preserved so `/loadboard`'s screen keeps working; remove the now-unused `geocodeAddress` import and `writeConflict` usage if nothing else in the file uses them.)
- `POST /loads/:id/reopen`: replace the `prisma.load.update({ … status: "open", version: { increment: 1 } })` with
  ```ts
    const actor = await actorOf(req);
    const r = await prisma.$transaction((tx) => applyStatusChange(tx, { loadId: load.id, orgId: load.orgId, actor, source: "loadboard", status: "open", note: "reopened from the loadboard" }));
    const updated = await prisma.load.findUnique({ where: { id: load.id } });
    emitToDispatchers(load.orgId, "board_update", { loadId: load.id, reopened: true });
    emitToDispatchers(load.orgId, "load_changed", { orgId: load.orgId, loadId: load.id, version: r.version, fields: ["status"] });
    res.json(updated);
  ```
  wrapped so `LoadLocked` → 409 (the `guardLoad` before it already refuses; keep both — the writer is the authority).

`fleet-backend/src/lib/assignmentActions.ts`: `unassign(tx, assignment)` and `acceptTender(assignment)` gain an `actor: Actor` parameter (callers pass `await actorOf(req)`; the tender-decline/expiry paths that have no request pass `SYSTEM_ACTOR("lifecycle")`) and replace `tx.load.update({ … status: "open" })` / `{ status: "assigned" }` with `await applyStatusChange(tx, { loadId: assignment.loadId, orgId: assignment.orgId, actor, source: "loadboard", status: "open" | "assigned", note: \`assignment ${assignment.id} unassigned\` | \`tender ${assignment.id} accepted\` })`. In `dispatcherAssignments.ts`, the two F6 sites (≈477: `data: { status, version: { increment: 1 } }`; ≈625: the `in_progress`/`delivered` write) become `applyStatusChange(tx, { loadId, orgId, actor, source: "loadboard", status, note: \`assignment ${assignment.id} → ${next}\` })` — remove the interim `version: { increment: 1 }` and read `version` from the returned value for the `load_changed` emit the route already sends. `Assignment.orgId` exists (`tests/load-writer` used it in A1's Task 6 fixtures); `SYSTEM_ACTOR` is in `src/lib/actor.ts`.

- [ ] **Step 4: Run the suites**

Run: `npx vitest run tests/dispatcher-loads.test.ts tests/dispatcher-assignments.test.ts tests/tender-cancel.test.ts tests/load-writer.test.ts` → PASS. Then `npx vitest run` and `npx tsc --noEmit` — green, clean. (A2's F6 tests asserted the version bump at these sites; they must still pass — the writer bumps it.)

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 3: The loadboard projection — brokered fields, covered brokered loads, the carrier filter

**Files:**
- Modify: `fleet-backend/src/routes/dispatcherLoadboard.ts`
- Test: `fleet-backend/tests/dispatcher-loadboard.test.ts`, `fleet-backend/tests/loadboard-carrier.test.ts` (append)

**Interfaces:**
- Produces: every load in `GET /api/dispatcher/loadboard` carries `carrierId: string | null`, `carrierName: string | null`, `carrierMc: string | null`, `customerName: string | null`, `updateText: string | null`, `apptText: string | null`, `shipDate: string | null`, `boardLoadNo: string | null`, `version: number`, `brokered: boolean`, `attention: string[]`, `deliveryWindowEnd: string | null`; the array additionally contains **covered brokered loads** (`assignment: null`, `carrierId ≠ null`, `status ∈ {assigned, in_progress, delivered}`) whose appointment span overlaps the window — or that have no appointments at all and are not `delivered`; `?carrierId=` narrows those to the carrier and leaves the open backlog untouched.

- [ ] **Step 1: Write the failing tests**

Append to `tests/dispatcher-loadboard.test.ts` (it has an org/dispatcher/auth helper and a `from`/`to` window; reuse them):
```ts
it("carries the brokered fields, and a covered brokered load with no assignment rides in the window by its appointments", async () => {
  // <copy the file's org + auth setup>
  const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC", mcNumber: "1000001" } });
  const covered = await prisma.load.create({ data: {
    orgId: org.id, requiredEquip: "DryVan", revenueCents: 250000, customerName: "MEIBORG", status: "assigned", carrierId: carrier.id,
    updateText: "SCHEDULED", apptText: "PU: 07/14 - 12:00\nDEL: 07/16 - 07:00", boardLoadNo: "0563265", shipDate: new Date("2026-07-13T00:00:00Z"), version: 2,
    stops: { create: [
      { sequence: 1, type: "pickup", address: "Kansas City, MO", appointment: { create: { windowStart: new Date("2026-07-14T17:00:00Z"), windowEnd: new Date("2026-07-14T19:00:00Z"), type: "pickup", kind: "appointment" } } },
      { sequence: 2, type: "delivery", address: "Dallas, TX", appointment: { create: { windowEnd: new Date("2026-07-16T12:00:00Z"), type: "delivery", kind: "appointment" } } },
    ] },
  } });
  const linedUp = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, customerName: "MEIBORG", status: "open", carrierId: carrier.id, updateText: "PENDING RATE CONFIRMATION" } });
  const res = await request(app).get("/api/dispatcher/loadboard").query({ from: "2026-07-14T00:00:00.000Z", to: "2026-07-17T00:00:00.000Z" }).set(auth);
  expect(res.status).toBe(200);
  const c = res.body.loads.find((l: { id: string }) => l.id === covered.id);
  expect(c).toMatchObject({ brokered: true, carrierId: carrier.id, carrierName: "Blue Road LLC", carrierMc: "1000001", customerName: "MEIBORG", updateText: "SCHEDULED", boardLoadNo: "0563265", version: 2, assignment: null, status: "assigned", deliveryWindowEnd: "2026-07-16T12:00:00.000Z", attention: [] });
  const o = res.body.loads.find((l: { id: string }) => l.id === linedUp.id);
  expect(o).toMatchObject({ status: "open", carrierId: carrier.id, carrierName: "Blue Road LLC" });
  // Outside the window the covered load is not on the board; the open one still is (the backlog is not windowed).
  const later = await request(app).get("/api/dispatcher/loadboard").query({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" }).set(auth);
  expect(later.body.loads.some((l: { id: string }) => l.id === covered.id)).toBe(false);
  expect(later.body.loads.some((l: { id: string }) => l.id === linedUp.id)).toBe(true);
});

it("a covered brokered load with no appointments rides in every window unplaced, with its Attention; delivered ones without windows stay off", async () => {
  // <setup>
  const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Fast Lane Inc" } });
  const unplaced = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, customerName: "MEIBORG", status: "in_progress", carrierId: carrier.id, updateText: "PICKED UP" } });
  await prisma.agentUpdate.create({ data: { loadId: unplaced.id, atMs: BigInt(1), kind: "attention", text: 'can\'t read PU appointment: "PU: whenever"' } });
  const done = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, customerName: "MEIBORG", status: "delivered", carrierId: carrier.id, updateText: "DELIVERED" } });
  const res = await request(app).get("/api/dispatcher/loadboard").query({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" }).set(auth);
  const u = res.body.loads.find((l: { id: string }) => l.id === unplaced.id);
  expect(u).toMatchObject({ brokered: true, status: "in_progress", attention: ['can\'t read PU appointment: "PU: whenever"'], pickupWindowStart: null, deliveryWindowEnd: null });
  expect(res.body.loads.some((l: { id: string }) => l.id === done.id)).toBe(false);
});
```
Append to `tests/loadboard-carrier.test.ts` (reuse `scopedAuth`):
```ts
  it("?carrierId=<real> keeps only that carrier's covered brokered loads, and never touches the open backlog", async () => {
    // <setup: org, scopedAuth, two carriers A and B, one covered (assigned) brokered load per carrier with a pickup appointment inside the window, one open load with carrierId B>
    const res = await request(app).get("/api/dispatcher/loadboard").query({ from, to, carrierId: carrierA.id }).set(auth);
    const ids = res.body.loads.map((l: { id: string }) => l.id);
    expect(ids).toContain(coveredA.id);
    expect(ids).not.toContain(coveredB.id);
    expect(ids).toContain(openB.id);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/dispatcher-loadboard.test.ts tests/loadboard-carrier.test.ts` → the new tests FAIL (`brokered` undefined; covered loads absent).

- [ ] **Step 3: Project them**

In `fleet-backend/src/routes/dispatcherLoadboard.ts`:
- Delete the stale comment block that says the Load "carries no carrierId column" (≈lines 56-59) and replace it with: `// Loads carry their own carrierId now (plan A1): a brokered load is priced by ITS carrier, not by a driver's. The filter narrows covered brokered loads below; the open backlog stays shared by design.`
- Add beside `OPEN_STATUSES`: `const COVERED_STATUSES = ["assigned", "in_progress", "delivered"];`
- Extend the `prisma.load.findMany` `where.OR` with a third arm for covered brokered loads and widen `include`:
  ```ts
        OR: [
          { assignment: { plannedStart: { lt: to }, plannedEnd: { gt: from } } },
          { status: { in: OPEN_STATUSES } },
          // Plan A3 (spec §8.3): covered brokered loads — no Assignment, a
          // carrier, a covered status. Windowed by their appointments in JS
          // below (Prisma cannot express "overlap OR has no appointments").
          { assignment: null, carrierId: { not: null }, status: { in: COVERED_STATUSES }, ...(parsed.data.carrierId ? { carrierId: parsed.data.carrierId } : {}) },
        ],
  ```
  and in `include`: `carrier: { select: { name: true, mcNumber: true } }, agentUpdates: { where: { kind: "attention" }, orderBy: { atMs: "asc" }, select: { text: true } }`.
- After the query, before `res.json`, filter the brokered arm by window:
  ```ts
  const inWindow = loads.filter((l) => {
    if (l.assignment || OPEN_STATUSES.includes(l.status)) return true;
    const starts = l.stops.map((s) => s.appointment?.windowStart ?? s.appointment?.windowEnd).filter((d): d is Date => !!d);
    const ends = l.stops.map((s) => s.appointment?.windowEnd).filter((d): d is Date => !!d);
    if (starts.length === 0 && ends.length === 0) return l.status !== "delivered"; // unplaced: always on the board until it is done
    const startMs = Math.min(...starts.map((d) => d.getTime()));
    const endMs = Math.max(...ends.map((d) => d.getTime()));
    return startMs < to.getTime() && endMs > from.getTime();
  });
  ```
  and map `inWindow` instead of `loads`. In the projected object add:
  ```ts
        // Plan A3 (spec §8.1): the brokered half of the record.
        carrierId: l.carrierId, carrierName: l.carrier?.name ?? null, carrierMc: l.carrier?.mcNumber ?? null,
        customerName: l.customerName, updateText: l.updateText, apptText: l.apptText, shipDate: l.shipDate, boardLoadNo: l.boardLoadNo,
        version: l.version, brokered: isBrokered(l), attention: l.agentUpdates.map((a) => a.text),
        deliveryWindowEnd: delivery?.appointment?.windowEnd ?? null,
  ```
  (`isBrokered` is exported from `../lib/brokerImport.js`; `from`/`to` are the parsed window `Date`s the route already has.)

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/dispatcher-loadboard.test.ts tests/loadboard-carrier.test.ts` → PASS (all existing + 3). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 4: Risk for brokered loads

**Files:**
- Modify: `fleet-backend/src/lib/lateRisk.ts` (`RiskCandidate.assignmentId`/`driverId` nullable; `carrierName?`), `fleet-backend/src/routes/dispatcherRisk.ts` (brokered candidates)
- Test: `fleet-backend/tests/dispatcher-risk.test.ts` (append)

**Interfaces:**
- Produces: `RiskCandidate { assignmentId: string | null; driverId: string | null; carrierName?: string | null; … }` and `RiskRow` likewise; `GET /api/dispatcher/risk` includes brokered covered loads: `late_start` fires when an `assigned` brokered load's PU `windowStart` has passed; `behind_schedule` never fires for them (no `driverPos`).

- [ ] **Step 1: Write the failing test**

Append to `tests/dispatcher-risk.test.ts` (reuse its org/auth helper):
```ts
  it("a brokered load past its pickup window with no assignment is a late start attributed to its carrier", async () => {
    // <setup>
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    const load = await prisma.load.create({ data: {
      orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, customerName: "MEIBORG", status: "assigned", carrierId: carrier.id, externalId: "0563265",
      stops: { create: [
        { sequence: 1, type: "pickup", address: "Kansas City, MO", appointment: { create: { windowStart: new Date(Date.now() - 3 * 3600_000), windowEnd: new Date(Date.now() - 2 * 3600_000), type: "pickup", kind: "appointment" } } },
        { sequence: 2, type: "delivery", address: "Dallas, TX", appointment: { create: { windowEnd: new Date(Date.now() + 20 * 3600_000), type: "delivery", kind: "appointment" } } },
      ] },
    } });
    const res = await request(app).get("/api/dispatcher/risk").set(auth);
    const row = res.body.risks.find((r: { loadId: string }) => r.loadId === load.id);
    expect(row).toMatchObject({ kind: "late_start", assignmentId: null, driverId: null, carrierName: "Blue Road LLC", ref: "0563265" });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dispatcher-risk.test.ts -t "brokered"` → FAIL (no row).

- [ ] **Step 3: Add the candidates**

`src/lib/lateRisk.ts`: `RiskCandidate.assignmentId: string | null`, `driverId: string | null`, add `carrierName?: string | null`; `RiskRow` the same three; `computeLateRisk` copies `carrierName` onto the row (find where it spreads the candidate's identity fields). `src/routes/dispatcherRisk.ts`: after the assignment candidates, add
```ts
  // Plan A3 (spec §8.4): covered brokered loads run on someone else's truck.
  // No GPS in this slice, so only a missed pickup window can be seen.
  const brokered = await prisma.load.findMany({
    where: { ...scope, assignment: null, carrierId: { not: null }, status: { in: ["assigned", "in_progress"] } },
    select: { id: true, externalId: true, orderRef: true, boardLoadNo: true, status: true, carrier: { select: { name: true } },
      stops: { orderBy: { sequence: "asc" }, select: { type: true, lat: true, lng: true, appointment: { select: { windowStart: true, windowEnd: true } } } } },
  });
  for (const l of brokered) {
    const pickup = l.stops.find((s) => s.type === "pickup");
    const finalDelivery = [...l.stops].reverse().find((s) => s.type === "delivery");
    const startMs = pickup?.appointment?.windowStart?.getTime() ?? pickup?.appointment?.windowEnd?.getTime();
    const endMs = finalDelivery?.appointment?.windowEnd?.getTime();
    if (startMs === undefined || endMs === undefined) continue; // unplaced in time: nothing to be late against
    candidates.push({
      assignmentId: null, loadId: l.id, ref: l.boardLoadNo ?? l.externalId ?? l.orderRef ?? l.id.slice(0, 8),
      driverId: null, driverName: null, carrierName: l.carrier?.name ?? null, status: l.status as ActiveStatus,
      plannedStartMs: startMs, plannedEndMs: endMs, deadlineMs: endMs, driverPos: null,
      finalDrop: finalDelivery?.lat != null && finalDelivery.lng != null ? { lat: finalDelivery.lat, lng: finalDelivery.lng } : null,
    });
  }
```
(`candidates` must become a `let`/mutable array or be built with the brokered rows appended; `ActiveStatus` already covers `assigned`/`in_progress`.) In `computeLateRisk`, the `in_progress` branch already `continue`s when `driverPos` is null, so brokered rolling loads produce nothing — as the spec says.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/dispatcher-risk.test.ts tests/late-risk.test.ts` → PASS. `npx tsc --noEmit` clean. Then in fleet-portal: `grep -rn "assignmentId" src/components/board/RiskFeed.vue src/stores/loadboard.ts` — where a risk row's `assignmentId`/`driverId` is typed `string`, widen to `string | null` and render `carrierName ?? driverName ?? "—"` as the who; `npx vue-tsc --noEmit -p tsconfig.app.json` shows no new error.

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 5: Portal types and the lane projection

**Files:**
- Modify: `fleet-portal/src/stores/loadboard.ts` (`BoardLoad`), `fleet-portal/src/lib/cockpit/lanes.ts`
- Test: `fleet-portal/src/lib/cockpit/lanes.spec.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  // stores/loadboard.ts BoardLoad gains:
  carrierId?: string | null; carrierName?: string | null; carrierMc?: string | null; customerName?: string | null; updateText?: string | null
  apptText?: string | null; shipDate?: string | null; boardLoadNo?: string | null; version?: number; brokered?: boolean; attention?: string[]; deliveryWindowEnd?: string | null
  // lanes.ts
  export type LaneKind = GroupBy | 'brokered'
  export interface CockpitLane { …; kind: LaneKind; carrier?: { id: string; name: string; mc: string | null } }
  export const COVERED_STATUSES = ['assigned', 'in_progress', 'delivered']
  export const isCarrierLaneLoad = (l: BoardLoad): boolean => !l.assignment && !!l.carrierId && COVERED_STATUSES.includes(l.status)
  export function carrierLanesOf(loads: BoardLoad[]): CockpitLane[]   // one lane per carrierId among isCarrierLaneLoad loads, legs sorted by spanOf().startMs, name = carrierName ?? 'Carrier', sub = mc ? `MC ${mc}` : '', id = `carrier:${carrierId}`
  export function spanOf(l: BoardLoad): { startMs: number; endMs: number } | null   // assignment → planned; brokered → PU windowStart (or windowEnd) → deliveryWindowEnd; null when neither
  ```
  `projectLanes` appends `carrierLanesOf(loads)` after the unit lanes in every `groupBy`; `groupLanesByCarrier` buckets a brokered lane under its own carrier id/name.

- [ ] **Step 1: Write the failing tests**

Append to `lanes.spec.ts` (it has `load()`, `jake`, `chuck`, `t1`, `r1`, `iso`, `projectLanes`, `groupLanesByCarrier`):
```ts
describe('carrier lanes (plan A3)', () => {
  const covered = load({ id: 'b1', reference: '0563265', status: 'assigned', brokered: true, carrierId: 'c1', carrierName: 'Blue Road LLC', carrierMc: '1000001',
    pickupWindowStart: iso(Date.UTC(2026, 6, 14, 17)), deliveryWindowEnd: iso(Date.UTC(2026, 6, 16, 12)), assignment: null })
  const rolling = load({ id: 'b2', reference: '0563272', status: 'in_progress', brokered: true, carrierId: 'c1', carrierName: 'Blue Road LLC', carrierMc: '1000001',
    pickupWindowStart: iso(Date.UTC(2026, 6, 13, 12)), deliveryWindowEnd: iso(Date.UTC(2026, 6, 14, 12)), assignment: null })
  const unplaced = load({ id: 'b3', reference: '0563280', status: 'assigned', brokered: true, carrierId: 'c2', carrierName: 'Fast Lane Inc', carrierMc: null, attention: ['can\'t read PU appointment: "PU: whenever"'], assignment: null })
  const linedUp = load({ id: 'b4', status: 'open', brokered: true, carrierId: 'c1', carrierName: 'Blue Road LLC', assignment: null })

  it('projects one lane per carrier for covered brokered loads, sorted by start, and leaves the open one to the backlog', () => {
    const lanes = projectLanes('driver', [jake], [t1], [r1], [covered, rolling, unplaced, linedUp])
    const brokered = lanes.filter((l) => l.kind === 'brokered')
    expect(brokered.map((l) => [l.id, l.name, l.sub, l.legs.map((x) => x.id)])).toEqual([
      ['carrier:c1', 'Blue Road LLC', 'MC 1000001', ['b2', 'b1']],
      ['carrier:c2', 'Fast Lane Inc', '', ['b3']],
    ])
    expect(lanes[0].kind).toBe('driver')
    expect(projectLanes('tractor', [jake], [t1], [r1], [covered]).some((l) => l.kind === 'brokered')).toBe(true)
  })

  it('spanOf: planned window for a leg, appointment windows for a brokered brick, null when unplaced', () => {
    expect(spanOf(covered)).toEqual({ startMs: Date.UTC(2026, 6, 14, 17), endMs: Date.UTC(2026, 6, 16, 12) })
    expect(spanOf(unplaced)).toBeNull()
  })

  it('groups a brokered lane under its own carrier', () => {
    const groups = groupLanesByCarrier(projectLanes('carrier', [jake], [t1], [r1], [covered]))
    const c1 = groups.find((g) => g.id === 'c1')
    expect(c1?.name).toBe('Blue Road LLC')
    expect(c1?.lanes.map((l) => l.kind)).toContain('brokered')
  })
})
```
(`jake` in the existing fixtures may carry `carrierId`; if it is `'c1'` too the group also holds his driver lane — the assertion uses `toContain`.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd fleet-portal && npx vitest run src/lib/cockpit/lanes.spec.ts` → FAIL (no brokered lanes; `spanOf` missing).

- [ ] **Step 3: Project the lanes**

`stores/loadboard.ts` `BoardLoad`: add the optional fields listed in Interfaces (all optional so every existing fixture still type-checks). `lib/cockpit/lanes.ts`:
```ts
export type LaneKind = GroupBy | 'brokered'
// in CockpitLane: kind: LaneKind; carrier?: { id: string; name: string; mc: string | null }

/** Covered on Their Board (spec §8.2): booked, rolling or done — a carrier
 *  lined up on an `open` load is not a lane, it is a chip in the backlog. */
export const COVERED_STATUSES = ['assigned', 'in_progress', 'delivered']
export const isCarrierLaneLoad = (l: BoardLoad): boolean => !l.assignment && !!l.carrierId && COVERED_STATUSES.includes(l.status)

/** Where a brick sits in time: a leg by its planned window, a brokered load by
 *  the Appointment rows the writer guarantees; null means unplaced. */
export function spanOf(l: BoardLoad): { startMs: number; endMs: number } | null {
  if (l.assignment) return { startMs: Date.parse(l.assignment.plannedStart), endMs: Date.parse(l.assignment.plannedEnd) }
  const start = l.pickupWindowStart ?? l.pickupWindowEnd
  const end = l.deliveryWindowEnd
  if (!start || !end) return null
  return { startMs: Date.parse(start), endMs: Date.parse(end) }
}

/** One lane per carrier for the loads that run on that carrier's truck (spec §8.3). */
export function carrierLanesOf(loads: BoardLoad[]): CockpitLane[] {
  const byCarrier = new Map<string, BoardLoad[]>()
  for (const l of loads) {
    if (!isCarrierLaneLoad(l)) continue
    const arr = byCarrier.get(l.carrierId!) ?? []
    arr.push(l)
    byCarrier.set(l.carrierId!, arr)
  }
  const startOf = (l: BoardLoad): number => spanOf(l)?.startMs ?? Number.NEGATIVE_INFINITY // unplaced first: the left edge is where they render
  return [...byCarrier.entries()]
    .map(([carrierId, legs]) => {
      const first = legs[0]
      return {
        id: `carrier:${carrierId}`, kind: 'brokered' as const, name: first.carrierName ?? 'Carrier', sub: first.carrierMc ? `MC ${first.carrierMc}` : '',
        carrier: { id: carrierId, name: first.carrierName ?? 'Carrier', mc: first.carrierMc ?? null },
        legs: legs.slice().sort((a, b) => startOf(a) - startOf(b)),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
```
In `projectLanes`, replace each `return lanes.map(...)` / `return tractors.map(...)` / trailer return with `return [...<the unit lanes>, ...carrierLanesOf(loads)]`. Every function that walks `lane.legs` assuming `l.assignment!` (`startMs`, `pillOf`, `isLiveAt`, `plannedDriveTodayMin`, `committedGrossCents`, `laneMoneyInView`, `utilizationToday`) must use `spanOf(l)` for time and skip brokered lanes where the concept does not apply: `pillOf` for `kind === 'brokered'` returns `{ t: 'BROKERED', c: 'cyan' }`; `hosGate`, `plannedDriveTodayMin`, `utilizationToday` ignore brokered lanes (`lanes.filter((l) => l.kind !== 'brokered')`); `committedGrossCents` and `laneMoneyInView` count brokered legs by `revenueCents` like any other. `groupLanesByCarrier`: `const carrierId = lane.kind === 'brokered' ? lane.carrier!.id : lane.driver?.carrierId ?? null` and the group name from `lane.carrier?.name ?? lane.driver?.carrierName ?? carrierId`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/cockpit` → PASS (existing + 3). `npx vue-tsc --noEmit -p tsconfig.app.json` — no new errors (GanttBoard's `l.assignment!` sites are Task 6's; if the type widening makes them error now, Task 6 follows immediately — list them).

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 6: Bricks and lane heads for carrier lanes

**Files:**
- Modify: `fleet-portal/src/components/cockpit/GanttBoard.vue` (`brickProps`, lane head switch, gesture guards), `fleet-portal/src/components/cockpit/LegBrick.vue` (brokered tag)
- Create: `fleet-portal/src/components/cockpit/LaneHeadCarrier.vue`
- Test: `fleet-portal/src/components/cockpit/GanttBoard.spec.ts`, `fleet-portal/src/components/cockpit/LaneHead.spec.ts` (append)

**Interfaces:**
- Consumes: Task 5 `spanOf`, `isCarrierLaneLoad`, lane kind `brokered`, `CockpitLane.carrier`.
- Produces: a brokered brick spans `spanOf(load)`; an unplaced one renders at `x = 0`, `w = UNPLACED_W` (= 96 px) with `title` = its `attention` joined by ` · ` and a `data-unplaced` attribute; every brokered brick carries `data-brokered` and shows the carrier name; drag/resize/drop handlers return early for brokered bricks; `LaneHeadCarrier` renders name, `MC …`, and `N loads`.

- [ ] **Step 1: Write the failing tests**

Append to `GanttBoard.spec.ts` (reuse its mount helper and fixtures — it mounts with a loadboard store state; add brokered loads to that state):
```ts
describe('carrier lanes on the board (plan A3)', () => {
  it('draws a carrier lane with a placed brick from its appointments and an unplaced brick at the left edge with its Attention', async () => {
    // <mount with the file's helper; window covering 2026-07-13..17; loads: one covered brokered with PU windowStart 07/14 17:00Z and deliveryWindowEnd 07/16 12:00Z (carrier c1 "Blue Road LLC", MC 1000001); one covered brokered with no windows and attention ['can\'t read PU appointment: "PU: whenever"'] (carrier c2 "Fast Lane Inc")>
    const lane = w.find('[data-track="carrier:c1"]')
    expect(lane.exists()).toBe(true)
    const placed = lane.find('[data-brokered]')
    expect(placed.exists()).toBe(true)
    expect(Number.parseFloat(placed.attributes('style')!.match(/left:\s*([\d.]+)px/)![1])).toBeGreaterThan(0)
    const unplaced = w.find('[data-track="carrier:c2"] [data-unplaced]')
    expect(unplaced.attributes('title')).toBe('can\'t read PU appointment: "PU: whenever"')
    expect(unplaced.attributes('style')).toContain('left: 0px')
    expect(w.find('[data-lane-head="carrier:c1"]').text()).toContain('Blue Road LLC')
    expect(w.find('[data-lane-head="carrier:c1"]').text()).toContain('MC 1000001')
  })
})
```
Append to `LaneHead.spec.ts`:
```ts
it('LaneHeadCarrier shows the carrier, its MC and the load count', () => {
  const lane = { id: 'carrier:c1', kind: 'brokered', name: 'Blue Road LLC', sub: 'MC 1000001', carrier: { id: 'c1', name: 'Blue Road LLC', mc: '1000001' }, legs: [{ id: 'b1' }, { id: 'b2' }] } as never
  const w = mount(LaneHeadCarrier, { props: { lane, nowMs: Date.now() } })
  expect(w.text()).toContain('Blue Road LLC')
  expect(w.text()).toContain('MC 1000001')
  expect(w.text()).toContain('2 loads')
  expect(w.find('[data-testid="lane-pill"]').text()).toBe('BROKERED')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/cockpit/GanttBoard.spec.ts src/components/cockpit/LaneHead.spec.ts` → FAIL.

- [ ] **Step 3: Render them**

`LaneHeadCarrier.vue`:
```vue
<script setup lang="ts">
import { computed } from 'vue'
import { pillOf, type CockpitLane } from '../../lib/cockpit/lanes'
import { PILL_CLASSES } from './laneHeadShared'  // if the driver/unit heads share their pill classes from a module; otherwise copy the PILL_CLASSES map LaneHeadUnit.vue uses
// A carrier lane's head (spec §8.3): the carrier's name and MC, how many of
// their loads are on the board. No driver, no tractor, no clocks — we do not
// see their truck; we see what Their Board said about the load.
const props = withDefaults(defineProps<{ lane: CockpitLane; nowMs: number; compact?: boolean }>(), { compact: false })
const pill = computed(() => pillOf(props.lane, props.nowMs))
const count = computed(() => `${props.lane.legs.length} ${props.lane.legs.length === 1 ? 'load' : 'loads'}`)
</script>
<template>
  <div class="flex h-full items-center justify-between gap-2 px-2" :data-lane-head="lane.id">
    <div class="flex min-w-0 items-center gap-2">
      <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line text-base" aria-hidden="true">🚚</div>
      <div class="min-w-0">
        <div class="truncate text-xs font-bold text-ink">{{ lane.name }} <span class="font-mono text-[10px] font-normal text-ink-3">{{ lane.sub }}</span></div>
        <div v-if="!compact" class="mt-0.5 font-mono text-[10px] text-ink-3">{{ count }} · their truck</div>
      </div>
    </div>
    <span class="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold" :class="PILL_CLASSES[pill.c]" data-testid="lane-pill">{{ pill.t }}</span>
  </div>
</template>
```
`GanttBoard.vue`: import `LaneHeadCarrier` and `spanOf`/`isCarrierLaneLoad`; where the lane head component is chosen by `lane.kind` (`LaneHeadDriver` for `driver`, `LaneHeadUnit` otherwise), add `brokered` → `LaneHeadCarrier`. `brickProps(l, laneName)`:
```ts
const UNPLACED_W = 96
function brickProps(l: BoardLoad, laneName: string): BrickVisual | null {
  const a = l.assignment
  const span = a ? brickSpan(Date.parse(a.plannedStart), Date.parse(a.plannedEnd), cfg.value) : (() => { const s = spanOf(l); return s ? brickSpan(s.startMs, s.endMs, cfg.value) : { x: 0, w: UNPLACED_W } })()
  if (!span) return null
  const trailer = a?.trailerId ? trailersById.value.get(a.trailerId) : undefined
  const driver = a ? driversById.value.get(a.driverId) : undefined
  const matches = ck.matchesSearch(l, laneName)
  return {
    x: span.x, w: span.w,
    deadheadPx: a?.deadheadMin ? Math.min(span.w, (a.deadheadMin / 60) * cfg.value.pxPerHour) : 0,
    // …the existing flags unchanged, with `a?.` where they read the assignment…
    brokered: !a, unplaced: !a && spanOf(l) === null,
  }
}
```
(`BrickVisual` gains `brokered: boolean; unplaced: boolean`.) In the template's `<LegBrick v-bind="b.p" …>` the new props pass through; gesture handlers (`onBrickDown`/drag start/resize start/drop target) return early when `b.p.brokered`. `LegBrick.vue`: props `brokered?: boolean`, `unplaced?: boolean`; root element gets `:data-brokered="brokered || undefined"`, `:data-unplaced="unplaced || undefined"`, `:title="unplaced ? (load.attention ?? []).join(' · ') : undefined"`; a small `<span class="…">{{ load.carrierName }}</span>` where the brick shows its second line, and the status pill reads `load.status` when there is no assignment. Every `load.assignment!` inside LegBrick/BrickPopover — the grep in this plan found none — stays none; if one appears, guard it with `load.assignment ?`.

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run src/components/cockpit src/lib/cockpit` → PASS. `npx vue-tsc --noEmit -p tsconfig.app.json` → only the two pre-existing files.

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 7: The backlog's carrier chip

**Files:**
- Modify: `fleet-portal/src/components/cockpit/BacklogPanel.vue`
- Test: `fleet-portal/src/components/cockpit/Panels.spec.ts` (append)

**Interfaces:**
- Produces: a backlog row whose load has a `carrierId` shows `<span data-carrier-chip>` with `"<carrierName> · pending"`; a row without one shows nothing extra. The backlog membership rule in `stores/cockpit.ts` (`!l.assignment && (status open|tendered)`) is untouched.

- [ ] **Step 1: Write the failing test**

Append to `Panels.spec.ts` (reuse its BacklogPanel mount helper):
```ts
it('a backlog load with a carrier lined up shows the carrier chip; one without shows none', () => {
  // <mount BacklogPanel with two open loads: one carrierId 'c1' carrierName 'Blue Road LLC', one with carrierId null>
  const chips = w.findAll('[data-carrier-chip]')
  expect(chips).toHaveLength(1)
  expect(chips[0].text()).toBe('Blue Road LLC · pending')
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/components/cockpit/Panels.spec.ts` → FAIL.

- [ ] **Step 3: The chip**

In `BacklogPanel.vue`'s row meta line (beside the `brokerName` span), add:
```vue
              <span v-if="l.carrierId" data-carrier-chip class="rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[9px] font-bold text-cyan-600">{{ l.carrierName ?? 'Carrier' }} · pending</span>
```

- [ ] **Step 4: Run the tests** — PASS; `vue-tsc -p tsconfig.app.json` unchanged.

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 8: Live acceptance — §8.5 on the real board

**Files:** none (verification; run by the controller with the browser tools).

- [ ] **Step 1:** With both dev servers up, sign in as `d@fleet.com` / `pass123`, open `http://localhost:5173/cockpit`, set the window to the week of 2026-07-13 (the MEIBORG rows' ship dates; use the demo "Move demo to today" only if the board offers no way to pick the week). Expected, per §8.5 after A1's backfill: the backlog shows **exactly the 3 `PENDING …` loads**, each with a "· pending" carrier chip; carrier lanes hold the **10 `SCHEDULED`** as `assigned` bricks plus the 9 `in_progress` and 3 `delivered`; the archived `IN TRANSIT` row is absent; unplaced bricks carry Attention titles for stops the gazetteer did not know. Screenshot to the scratchpad; ledger the counts.
- [ ] **Step 2:** `GET /api/dispatcher/risk` lists brokered `late_start` rows (the July dates are past) attributed to carriers — confirm one and note it.
- [ ] **Step 3: Commit** — skipped; ledger.

---

## Self-review

- **Spec coverage:** §8.1 projection fields + carrier filter + stale comment — Task 3. §8.2 coverage by status — Task 3 (`COVERED_STATUSES` in the query), Task 5 (`isCarrierLaneLoad`). §8.3 carrier lanes (`carrier:<id>`, name + MC, no driver/unit, brick PU→DEL, unplaced brick with Attention, marked brokered) — Tasks 5, 6; backlog rule unchanged + carrier chip — Task 7; "matches no rule stays open in the backlog" — by construction (status `open`). §8.4 risk — Task 4. §8.5 — Task 8. §4 producers deferred by A1 (`/loadboard` PATCH, assignment lifecycle) — Tasks 1, 2 (`reopen` included; `cancel` excluded by its ruling).
- **Placeholders:** the two "<copy the file's setup>" notes in Tasks 2, 3, 4, 6, 7 point at helpers that exist in the same test file (not at another task); every code step carries its code.
- **Type consistency:** `StopSetEntry` (Task 1) ⇄ the route mapping (Task 2: `windowStart`/`windowEnd` ISO strings → `Date`); `applyStatusChange` returns `{ version, before }` (Task 1) and Task 2 reads `version` for `load_changed`; the projection fields (Task 3) match `BoardLoad`'s new optional fields (Task 5) name for name (`carrierId`, `carrierName`, `carrierMc`, `customerName`, `updateText`, `apptText`, `shipDate`, `boardLoadNo`, `version`, `brokered`, `attention`, `deliveryWindowEnd`); `spanOf` (Task 5) is what `brickProps` (Task 6) and `carrierLanesOf` sort on; `RiskCandidate`/`RiskRow` nullable ids (Task 4) match the portal widening in the same task.
