# Broker Board — Slice 2A: table power (selection, bulk actions, sort, filter, column tools)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Their board becomes a real table: checkboxes to select loads, a bulk bar (delete, archive, unarchive, export selected), sorting on every column, a search box and filters, column hide/reorder/resize remembered per user, sticky header, density toggle, and virtual scrolling — all without changing how the board looks.

**Architecture:** TanStack Table (headless, v8) owns table state and row models; we keep drawing every cell ourselves, so the two-row load and their colors survive. The backend gains three org-scoped endpoints (bulk archive/unarchive, bulk delete with refusals, export selected) and one column, `Load.boardLine`, so the sheet's order is data. Inline editing, "+ load" and the full export round-trip are slice 2B.

**Tech Stack:** `@tanstack/vue-table@8.21.3`, `@tanstack/vue-virtual@3.13.37` (portal); Express 4 + Prisma 5 + zod + SheetJS `xlsx@0.18.5` (backend, already present).

**Spec:** `docs/superpowers/specs/2026-09-07-broker-board-night-shift-design.md` — §4.1, §4.3, **§4.4 (table power)**, §5.4, §11, §15. This plan implements §4.4 and the `boardLine` item of §15.

## Global Constraints

- **No git commits and no `git add`** in this session (user rule). Every "Commit" step is skipped.
- Backend: ESM `.js` specifiers; `noUnusedLocals`/`noUnusedParameters` on; every dispatcher route reads `req.orgScope` (400 when null) and never returns or touches a record outside it; bulk operations are atomic per request (one transaction) and refuse the whole request when any id is outside the org (404) or ineligible (409 naming the LOAD#s).
- `Load.status = "archived"` is a board state (spec §4.4): the agent never starts an archived load; the cockpit's active lanes never show one. Archive is allowed on any load without an active assignment; unarchive returns it to `open`. Delete is permanent and allowed only for loads with status `open`, `archived`, or `canceled` and no assignment.
- Money integer cents; dates UTC; free text verbatim; nothing invents a value (spec §10). Every user-facing string in American English.
- Portal: Tailwind semantic tokens (`bg-surface`, `bg-surface-2`, `text-ink`, `text-ink-2`, `text-ink-3`, `border-line`, `bg-brand`, `text-brand-ink`); no custom CSS files; specs mock `../lib/api` to `{ api, API_BASE_URL }` and the store calls `api.get`/`api.post` directly (the slice 1 pattern).
- Column state (visibility, order, sizes, density) is a per-browser convenience in `localStorage` under one key, `brokerBoard.columns.v1`, wrapped in try/catch; the server's layout is the source of truth and "Reset to their layout" clears the key.
- Backend tests: `fleet-backend/`, `npx vitest run <file>` against `.env.test` with `resetDb()`; whole suite `npm test`; `npx tsc --noEmit`. Portal: `fleet-portal/`, `npx vitest run <spec>`; `npx vue-tsc -b` (5 pre-existing errors in the untracked T4 files `RoutePlanCard.spec.ts`/`FleetMap.vue` are known and not this plan's).
- Prisma migration: `npx prisma migrate dev --name board_line` from `fleet-backend/`; the dev backend on :3001 (`tsx watch`) holds the engine DLL on Windows — stop it, migrate, restart it, confirm `http://[::1]:3001/health`.
- Fixtures stay anonymized (no real BOL/MC/phone/company from the customer's board).

---

### Task 1: `boardLine` — the sheet's order as data, and the archived state

**Files:**
- Modify: `fleet-backend/prisma/schema.prisma` (`Load.boardLine Int?`, index)
- Create: migration `…_board_line` (generated)
- Modify: `fleet-backend/src/lib/brokerImport.ts` (write `boardLine` from the pair's sheet line), `fleet-backend/src/routes/dispatcherBrokerBoard.ts` (order by `boardLine`, `?archived=1`, `status` and `boardLine` in the response, archived hidden by default)
- Test: `fleet-backend/tests/broker-board-line.test.ts`

**Interfaces:**
- Produces: `Load.boardLine: number | null`; `GET /api/dispatcher/broker-board?archived=1` → includes archived loads; every `BoardLoad` gains `status: string` and `boardLine: number | null`; order is `boardLine ASC NULLS LAST, createdAt ASC`.

- [ ] **Step 1: Write the failing test**

`fleet-backend/tests/broker-board-line.test.ts`:
```ts
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { confirmImport } from "../src/lib/brokerImport.js";
import { hashPassword } from "../src/lib/password.js";
import { BROKER_ROWS, brokerWorkbook } from "./fixtures/brokerBoard.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

async function orgDispatcher() {
  const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Los_Angeles" } });
  await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
  const { token } = await loginDispatcher("b@x.com", "pw");
  return { org, auth: { Authorization: `Bearer ${token}` } };
}

describe("boardLine and archived", () => {
  beforeEach(resetDb);

  it("stores the sheet line on import and serves the board in that order, re-import included", async () => {
    const { org, auth } = await orgDispatcher();
    await confirmImport(org.id, brokerWorkbook());
    const lines = (await prisma.load.findMany({ where: { orgId: org.id }, orderBy: { boardLine: "asc" } })).map((l) => l.boardLine);
    expect(lines).toEqual([3, 6, 9, 12, 15]);
    // Move the third load to the top of the sheet and re-import: the board follows the sheet.
    const rows = BROKER_ROWS.map((r) => [...r]);
    const third = rows.splice(8, 3);      // top, bottom, blank of load 0500003
    rows.splice(2, 0, ...third);
    await confirmImport(org.id, brokerWorkbook(rows));
    const b = await request(app).get("/api/dispatcher/broker-board").set(auth);
    expect(b.body.loads.map((l: { top: { bol: string } }) => l.top.bol)).toEqual(["0500003", "0500001", "0500002", "0500004", "0500005"]);
    expect(b.body.loads[0].boardLine).toBe(3);
    expect(b.body.loads[0].status).toBe("open");
  });

  it("puts loads with no board line after the sheet's, in creation order", async () => {
    const { org, auth } = await orgDispatcher();
    await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, externalId: "F-1" } });
    await confirmImport(org.id, brokerWorkbook());
    const b = await request(app).get("/api/dispatcher/broker-board").set(auth);
    expect(b.body.loads.at(-1).top.loadNo === "" || b.body.loads.at(-1).boardLine === null).toBe(true);
    expect(b.body.loads.slice(0, 5).map((l: { boardLine: number }) => l.boardLine)).toEqual([3, 6, 9, 12, 15]);
  });

  it("hides archived loads unless asked", async () => {
    const { org, auth } = await orgDispatcher();
    await confirmImport(org.id, brokerWorkbook());
    const l = await prisma.load.findFirst({ where: { orgId: org.id, externalId: "145205" } });
    await prisma.load.update({ where: { id: l!.id }, data: { status: "archived" } });
    const hidden = await request(app).get("/api/dispatcher/broker-board").set(auth);
    expect(hidden.body.loads).toHaveLength(4);
    const shown = await request(app).get("/api/dispatcher/broker-board?archived=1").set(auth);
    expect(shown.body.loads).toHaveLength(5);
    expect(shown.body.loads.find((x: { id: string }) => x.id === l!.id).status).toBe("archived");
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — `cd fleet-backend && npx vitest run tests/broker-board-line.test.ts` → FAIL (`boardLine` unknown / order wrong / archived shown).

- [ ] **Step 3: Schema + migration**

In `model Load`, after `driverCell String?`:
```prisma
  /// The load's row in the broker's sheet (the customer row's line). The
  /// board's default order is this, then createdAt for loads that never
  /// came from a sheet.
  boardLine          Int?
```
and inside the model's index block (or add one): `@@index([orgId, boardLine])`.

Stop the dev backend, `npx prisma migrate dev --name board_line`, restart it, confirm health.

- [ ] **Step 4: Import writes it; the route orders by it and filters archived**

`brokerImport.ts`, in `confirmImport`'s `fields` object add `boardLine: pair.line,`.

`dispatcherBrokerBoard.ts`, in the GET:
```ts
  const includeArchived = String(req.query.archived ?? "") === "1";
  const loads = await prisma.load.findMany({
    where: { orgId, ...(includeArchived ? {} : { status: { not: "archived" } }) },
    include: { carrier: true, stops: { orderBy: { sequence: "asc" } }, agentUpdates: { orderBy: { atMs: "desc" } } },
    orderBy: [{ boardLine: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
```
and in the row object add `status: l.status, boardLine: l.boardLine,`. (Prisma 5 supports `{ sort, nulls }` on `orderBy`.)

- [ ] **Step 5: Run to verify it passes** — the new test green; `npm test` whole backend green (the slice 1 route test's ordering assertions still hold because `boardLine` follows the fixture order); `npx tsc --noEmit` clean.

- [ ] **Step 6: Break it** — drop `boardLine` from the `orderBy` → the first test's reorder assertion fails. Restore.

- [ ] **Step 7: Commit** — skipped.

---

### Task 2: Bulk archive, unarchive, delete

**Files:**
- Modify: `fleet-backend/src/routes/dispatcherBrokerBoard.ts`
- Test: `fleet-backend/tests/broker-board-bulk.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/dispatcher/broker-board/loads/archive` body `{ ids: string[], archived: boolean }` → `{ updated: number }`; archived=true sets `status: "archived"` on loads whose status is not `in_progress`/`delivered` and that have no assignment; archived=false sets `open` on loads that are `archived`. Any id outside the org → 404 `{ error }`, nothing written. Any ineligible id → 409 `{ error: "…: <LOAD#>, <LOAD#>" }`, nothing written.
  - `POST /api/dispatcher/broker-board/loads/delete` body `{ ids: string[] }` → `{ deleted: number }`; only `open`/`archived`/`canceled` loads with no assignment; otherwise 409 naming them; outside org → 404. Deletes stops, appointments, agent lines (cascade), rate row, and the load, in one transaction.
  - Both emit `board_update` `{ brokerBoard: true, ids }` to the org on success.
  - `ids` is 1–500 entries; zod-validated; 400 otherwise.

- [ ] **Step 1: Write the failing test**

`fleet-backend/tests/broker-board-bulk.test.ts`:
```ts
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { confirmImport } from "../src/lib/brokerImport.js";
import { hashPassword } from "../src/lib/password.js";
import { brokerWorkbook } from "./fixtures/brokerBoard.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

async function setup() {
  const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Los_Angeles" } });
  await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
  const { token } = await loginDispatcher("b@x.com", "pw");
  await confirmImport(org.id, brokerWorkbook());
  const loads = await prisma.load.findMany({ where: { orgId: org.id }, orderBy: { boardLine: "asc" } });
  return { org, auth: { Authorization: `Bearer ${token}` }, loads };
}

describe("bulk archive / unarchive", () => {
  beforeEach(resetDb);

  it("archives and unarchives a selection atomically", async () => {
    const { auth, loads } = await setup();
    const ids = [loads[0].id, loads[1].id];
    const a = await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids, archived: true });
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ updated: 2 });
    expect((await prisma.load.findMany({ where: { id: { in: ids } } })).map((l) => l.status)).toEqual(["archived", "archived"]);
    const u = await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids, archived: false });
    expect(u.body).toEqual({ updated: 2 });
    expect((await prisma.load.findMany({ where: { id: { in: ids } } })).map((l) => l.status)).toEqual(["open", "open"]);
  });

  it("refuses the whole request when one load is ineligible, naming it", async () => {
    const { auth, loads } = await setup();
    await prisma.load.update({ where: { id: loads[2].id }, data: { status: "in_progress" } });
    const r = await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: [loads[0].id, loads[2].id], archived: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/145197/);
    expect((await prisma.load.findUnique({ where: { id: loads[0].id } }))!.status).toBe("open");
  });

  it("refuses ids outside the org without touching anything", async () => {
    const { auth, loads } = await setup();
    const other = await prisma.org.create({ data: { name: "Other", timezone: "America/Chicago" } });
    const foreign = await prisma.load.create({ data: { orgId: other.id, requiredEquip: "DryVan", revenueCents: 0 } });
    const r = await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: [loads[0].id, foreign.id], archived: true });
    expect(r.status).toBe(404);
    expect((await prisma.load.findUnique({ where: { id: loads[0].id } }))!.status).toBe("open");
  });

  it("validates the body", async () => {
    const { auth } = await setup();
    expect((await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: [], archived: true })).status).toBe(400);
    expect((await request(app).post("/api/dispatcher/broker-board/loads/archive").set(auth).send({ ids: ["x"] })).status).toBe(400);
  });
});

describe("bulk delete", () => {
  beforeEach(resetDb);

  it("deletes open loads with their stops, appointments and agent lines, in one go", async () => {
    const { auth, loads } = await setup();
    const ids = [loads[3].id, loads[4].id];
    const r = await request(app).post("/api/dispatcher/broker-board/loads/delete").set(auth).send({ ids });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: 2 });
    expect(await prisma.load.count({ where: { id: { in: ids } } })).toBe(0);
    expect(await prisma.loadStop.count({ where: { loadId: { in: ids } } })).toBe(0);
    expect(await prisma.agentUpdate.count({ where: { loadId: { in: ids } } })).toBe(0);
    expect(await prisma.load.count()).toBe(3);
  });

  it("refuses a load with an assignment or a live status, naming it, and deletes nothing", async () => {
    const { org, auth, loads } = await setup();
    const driver = await prisma.driver.create({ data: { email: "d@x.com", passwordHash: "x", name: "D", orgId: org.id } });
    await prisma.assignment.create({ data: { orgId: org.id, loadId: loads[0].id, driverId: driver.id, plannedStart: new Date(), plannedEnd: new Date(), deadheadMi: 0, loadedMi: 0, marginCents: 0, savedMi: 0, driveMin: 0, onDutyMin: 0, tookBreak: false, status: "assigned" } });
    const r = await request(app).post("/api/dispatcher/broker-board/loads/delete").set(auth).send({ ids: [loads[0].id, loads[1].id] });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/145205/);
    expect(await prisma.load.count()).toBe(5);
  });
});
```
(Confirm `Assignment`'s required fields against `schema.prisma` and adapt the create call — never the assertions.)

- [ ] **Step 2: Run it to verify it fails** — 404s.

- [ ] **Step 3: Implement**

Add to `dispatcherBrokerBoard.ts` (imports: `z` from zod; `Prisma` type if needed):
```ts
const idsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });
const archiveSchema = idsSchema.extend({ archived: z.boolean() });

const LOAD_LABEL = (l: { externalId: string | null; bolNumber: string | null; orderRef: string | null; id: string }): string =>
  l.externalId ?? l.bolNumber ?? l.orderRef ?? l.id.slice(0, 8);

/** The org's loads for a list of ids, or null when any id is not the org's. */
async function ownedLoads(orgId: string, ids: string[]) {
  const loads = await prisma.load.findMany({ where: { id: { in: ids } }, include: { assignment: { select: { id: true } } } });
  if (loads.length !== new Set(ids).size || loads.some((l) => l.orgId !== orgId)) return null;
  return loads;
}

dispatcherBrokerBoardRouter.post("/broker-board/loads/archive", async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  const parsed = archiveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const { ids, archived } = parsed.data;
  const loads = await ownedLoads(orgId, ids);
  if (!loads) return res.status(404).json({ error: "One or more loads were not found" });
  const blocked = archived
    ? loads.filter((l) => l.assignment !== null || l.status === "in_progress" || l.status === "delivered")
    : loads.filter((l) => l.status !== "archived");
  if (blocked.length) {
    const what = archived ? "can't be archived while assigned, in progress, or delivered" : "are not archived";
    return res.status(409).json({ error: `These loads ${what}: ${blocked.map(LOAD_LABEL).join(", ")}` });
  }
  const result = await prisma.load.updateMany({ where: { id: { in: ids }, orgId }, data: { status: archived ? "archived" : "open" } });
  emitToDispatchers(orgId, "board_update", { brokerBoard: true, ids });
  res.json({ updated: result.count });
});

dispatcherBrokerBoardRouter.post("/broker-board/loads/delete", async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  const parsed = idsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const { ids } = parsed.data;
  const loads = await ownedLoads(orgId, ids);
  if (!loads) return res.status(404).json({ error: "One or more loads were not found" });
  const blocked = loads.filter((l) => l.assignment !== null || !["open", "archived", "canceled"].includes(l.status));
  if (blocked.length) return res.status(409).json({ error: `These loads can't be deleted while assigned or in progress: ${blocked.map(LOAD_LABEL).join(", ")}` });
  const deleted = await prisma.$transaction(async (tx) => {
    const stopIds = (await tx.loadStop.findMany({ where: { loadId: { in: ids } }, select: { id: true } })).map((s) => s.id);
    await tx.appointment.deleteMany({ where: { stopId: { in: stopIds } } });
    await tx.loadStop.deleteMany({ where: { loadId: { in: ids } } });
    await tx.rate.deleteMany({ where: { loadId: { in: ids } } });
    await tx.dispatchConflict.deleteMany({ where: { loadId: { in: ids } } });
    const r = await tx.load.deleteMany({ where: { id: { in: ids }, orgId } });
    return r.count;
  });
  emitToDispatchers(orgId, "board_update", { brokerBoard: true, ids });
  res.json({ deleted });
});
```
(`AgentUpdate` cascades from `Load`. Check `DispatchConflict`'s relation field name to `Load` in the schema — it is `loadId` per `Load.conflicts`; adapt if different.)

- [ ] **Step 4: Run to verify it passes** — the new test green; `npm test` green; typecheck clean.

- [ ] **Step 5: Break it** — remove the `l.orgId !== orgId` check in `ownedLoads` → the foreign-id test fails (a foreign load gets archived). Restore.

- [ ] **Step 6: Commit** — skipped.

---

### Task 3: Export selected loads as `.xlsx` in their layout

**Files:**
- Create: `fleet-backend/src/lib/brokerExport.ts`
- Modify: `fleet-backend/src/routes/dispatcherBrokerBoard.ts` (one route)
- Test: `fleet-backend/tests/broker-export.test.ts`

**Interfaces:**
- Produces:
  - `renderBoardRows(layout: BoardColumn[], loads: BoardLoad[]): string[][]` — the header row (layout labels minus `agent`), then per load the top cells, the bottom cells when there is a bottom row, then one blank row; cell strings exactly as the GET renders them.
  - `boardWorkbook(rows: string[][]): Buffer` — one sheet named `Board`.
  - `POST /api/dispatcher/broker-board/export` body `{ ids?: string[], archived?: boolean }` → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `Content-Disposition: attachment; filename="board-YYYY-MM-DD.xlsx"`. With `ids`: those loads (404 if any is not the org's) in board order; without: the whole board (archived only when `archived: true`).
  - The GET's row-rendering is extracted into `boardRows(orgId, includeArchived, ids?)` in the route module so the export and the GET share it.

- [ ] **Step 1: Write the failing test**

`fleet-backend/tests/broker-export.test.ts`:
```ts
import request from "supertest";
import * as XLSX from "xlsx";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { confirmImport } from "../src/lib/brokerImport.js";
import { renderBoardRows } from "../src/lib/brokerExport.js";
import { hashPassword } from "../src/lib/password.js";
import { readWorkbook } from "../src/lib/brokerSheet.js";
import { BROKER_ROWS, THEIR_HEADER, brokerWorkbook } from "./fixtures/brokerBoard.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

async function setup() {
  const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Los_Angeles" } });
  await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
  const { token } = await loginDispatcher("b@x.com", "pw");
  await confirmImport(org.id, brokerWorkbook());
  return { org, auth: { Authorization: `Bearer ${token}` } };
}

describe("renderBoardRows", () => {
  it("renders the header, two rows per load, a blank row between, no agent column", () => {
    const layout = [{ key: "bol", label: "BOL#" }, { key: "customer", label: "CUSTOMER /CARRIER" }, { key: "agent", label: "AGENT" }] as const;
    const loads = [
      { id: "a", line: 1, top: { bol: "1", customer: "ACME" }, bottom: { customer: "CARRIER" }, pill: { state: "none" as const, text: null }, agentLine: null, status: "open", boardLine: 3 },
      { id: "b", line: 2, top: { bol: "2", customer: "ACME" }, bottom: null, pill: { state: "none" as const, text: null }, agentLine: null, status: "open", boardLine: 6 },
    ];
    expect(renderBoardRows([...layout], loads)).toEqual([
      ["BOL#", "CUSTOMER /CARRIER"],
      ["1", "ACME"], ["", "CARRIER"], ["", ""],
      ["2", "ACME"], ["", ""],
    ]);
  });
});

describe("POST /broker-board/export", () => {
  beforeEach(resetDb);

  it("round-trips: what was imported comes back cell for cell in their layout", async () => {
    const { auth } = await setup();
    const r = await request(app).post("/api/dispatcher/broker-board/export").set(auth).send({}).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/spreadsheetml/);
    expect(r.headers["content-disposition"]).toMatch(/board-\d{4}-\d{2}-\d{2}\.xlsx/);
    const wb = readWorkbook(r.body as Buffer);
    expect(wb.header).toEqual(THEIR_HEADER);
    const exported = wb.rows.map((x) => x.cells);
    const original = BROKER_ROWS.slice(2);            // after the title and header rows
    // Load 1: the customer row and the carrier row match the fixture cell for cell.
    expect(exported[0]).toEqual(original[0]);
    expect(exported[1]).toEqual(original[1]);
    // The unassigned load exports as one row followed by a blank.
    const last = exported.findIndex((row) => row[0] === "0500005");
    expect(exported[last + 1].every((c) => c === "")).toBe(true);
  });

  it("exports only the selected ids, in board order, and refuses a foreign id", async () => {
    const { org, auth } = await setup();
    const loads = await prisma.load.findMany({ where: { orgId: org.id }, orderBy: { boardLine: "asc" } });
    const r = await request(app).post("/api/dispatcher/broker-board/export").set(auth).send({ ids: [loads[3].id, loads[0].id] }).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
    const wb = readWorkbook(r.body as Buffer);
    expect(wb.rows.filter((x) => x.cells[0] !== "").map((x) => x.cells[0])).toEqual(["0500001", "0500004"]);
    const other = await prisma.org.create({ data: { name: "Other", timezone: "America/Chicago" } });
    const foreign = await prisma.load.create({ data: { orgId: other.id, requiredEquip: "DryVan", revenueCents: 0 } });
    expect((await request(app).post("/api/dispatcher/broker-board/export").set(auth).send({ ids: [foreign.id] })).status).toBe(404);
  });
});
```
The round-trip expectation for the SHIP DATE cell: the fixture has `"7/13/2026"` and the GET renders `usDate` as `7/13/2026` — equal. RATE `$4,000.00` renders as `$4,000.00`. PROFIT `$400.00` equal. The `M.C. #` top cell `MC` equal. LOAD# top = orderRef `2026-34566-00` equal, bottom = `145205` equal. If any cell differs, the rendering is what must change (the export must reproduce their sheet), not the test.

- [ ] **Step 2: Run it to verify it fails** — module not found / 404.

- [ ] **Step 3: Implement**

`fleet-backend/src/lib/brokerExport.ts`:
```ts
import * as XLSX from "xlsx";
import type { BoardColumn } from "./boardLayout.js";
import type { CellsByKey } from "./brokerSheet.js";

// Their board, back out as their file: header labels in their order, two
// rows per load, a blank row between — the same shape the import reads.
// The AGENT column is ours and never exported.

export interface BoardLoadRow {
  id: string;
  top: CellsByKey;
  bottom: CellsByKey | null;
  status: string;
  boardLine: number | null;
}

export function renderBoardRows(layout: BoardColumn[], loads: BoardLoadRow[]): string[][] {
  const columns = layout.filter((c) => c.key !== "agent");
  const cell = (cells: CellsByKey | null, c: BoardColumn): string => (cells ? (cells[c.key] ?? "") : "");
  const rows: string[][] = [columns.map((c) => c.label)];
  for (const l of loads) {
    rows.push(columns.map((c) => cell(l.top, c)));
    if (l.bottom) rows.push(columns.map((c) => cell(l.bottom, c)));
    rows.push(columns.map(() => ""));
  }
  return rows;
}

export function boardWorkbook(rows: string[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Board");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
```

In `dispatcherBrokerBoard.ts`: extract the GET's query + row mapping into
```ts
async function boardRows(orgId: string, includeArchived: boolean, ids?: string[]) { /* the existing findMany + map; when ids is given add `id: { in: ids }` to the where and skip the archived filter */ }
```
so the GET becomes `const loads = await boardRows(orgId, includeArchived); res.json({ layout, loads })`, and add:
```ts
const exportSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(2000).optional(), archived: z.boolean().optional() });

dispatcherBrokerBoardRouter.post("/broker-board/export", async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  const parsed = exportSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const { ids, archived } = parsed.data;
  if (ids) {
    const owned = await ownedLoads(orgId, ids);
    if (!owned) return res.status(404).json({ error: "One or more loads were not found" });
  }
  const layout = await layoutFor(orgId);
  const loads = await boardRows(orgId, archived === true, ids);
  const buf = boardWorkbook(renderBoardRows(layout, loads));
  const day = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="board-${day}.xlsx"`);
  res.send(buf);
});
```

- [ ] **Step 4: Run to verify it passes** — new test green; whole suite green; typecheck clean. If the round-trip assertion fails on a specific cell, fix the GET's rendering for that cell (it must equal the sheet), and say so in the report.

- [ ] **Step 5: Break it** — export the `agent` column too (drop the filter) → the header assertion fails. Restore.

- [ ] **Step 6: Commit** — skipped.

---

### Task 4: The grid on TanStack — selection, sorting, search, sticky, density, virtual rows

**Files:**
- Modify: `fleet-portal/package.json` (deps), `fleet-portal/src/lib/api.ts` (types: `status`, `boardLine`; `fetchBrokerBoard(includeArchived)`)
- Create: `fleet-portal/src/components/broker/useBoardTable.ts`, `fleet-portal/src/components/broker/boardColumns.ts`, `fleet-portal/src/components/broker/columnPrefs.ts`
- Rewrite: `fleet-portal/src/components/broker/BrokerGrid.vue`
- Test: `fleet-portal/src/components/broker/boardColumns.spec.ts`, `fleet-portal/src/components/broker/columnPrefs.spec.ts`, `fleet-portal/src/components/broker/BrokerGrid.spec.ts`

**Interfaces:**
- Consumes: `BoardColumn`, `BoardLoad` (+ `status`, `boardLine`).
- Produces:
  - `buildColumns(layout: BoardColumn[]): ColumnDef<BoardLoad, string>[]` — one TanStack column per layout column (id = `key` for known keys, `extra:<label>` for extras), `accessorFn` = top value, or `top + " " + bottom` for `customer`/`phone`/`contact`/`mc`/`loadNo`/`appt` so sorting and search see both rows; `agent` sorts by pill state; `rate`/`soldRate`/`profit` sort numerically (parse `$1,234.56`); `shipDate` sorts by date.
  - `columnPrefs`: `loadPrefs(): ColumnPrefs | null`, `savePrefs(p)`, `clearPrefs()` with `ColumnPrefs = { visibility: Record<string, boolean>; order: string[]; sizing: Record<string, number>; density: "theirs" | "tight" }` under `localStorage["brokerBoard.columns.v1"]`, every access in try/catch.
  - `useBoardTable(loads: Ref<BoardLoad[]>, layout: Ref<BoardColumn[]>)` → `{ table, sorting, globalFilter, rowSelection, selectedIds: ComputedRef<string[]>, density, setDensity, resetColumns, columnVisibility, columnOrder, columnSizing }` — a `useVueTable` with `getCoreRowModel`, `getSortedRowModel`, `getFilteredRowModel`, `enableRowSelection`, `enableMultiSort`, `columnResizeMode: "onChange"`, `getRowId: (l) => l.id`, a `globalFilterFn` that lowercases and matches any top/bottom cell, and column state initialized from prefs then persisted on change.
  - `BrokerGrid.vue` props `{ layout, loads }`, emits `update:selectedIds (string[])`; renders: a checkbox header cell (`table.getIsAllRowsSelected()` / indeterminate) and a checkbox on each load's top row (spans both rows visually via `rowspan=2`), sortable headers (`aria-sort`, an arrow, the multi-sort index), a resize handle per header, sticky `<thead>` and sticky first two columns (checkbox, BOL#), virtualized loads via `useVirtualizer` (one virtual item per load, `estimateSize` 58 for theirs / 44 for tight, spacer rows above/below), density classes, hover/selection highlight on both rows of a pair, shift-click range selection over the visible (sorted, filtered) order, the same cell rendering as slice 1 (yellow customer only when non-empty, green profit, links, pill).

- [ ] **Step 1: Install**

`cd fleet-portal && npm i @tanstack/vue-table@8.21.3 @tanstack/vue-virtual@3.13.37`

- [ ] **Step 2: Write the failing tests**

`fleet-portal/src/components/broker/boardColumns.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import type { BoardColumn, BoardLoad } from '../../lib/api'
import { buildColumns, moneyValue } from './boardColumns'

const layout: BoardColumn[] = [
  { key: 'bol', label: 'BOL#' }, { key: 'customer', label: 'CUSTOMER /CARRIER' }, { key: 'rate', label: 'RATE' },
  { key: 'shipDate', label: 'SHIP DATE' }, { key: 'extra', label: 'NOTES', source: 'NOTES' }, { key: 'agent', label: 'AGENT' },
]
const load = (over: Partial<BoardLoad['top']>, bottom: BoardLoad['bottom'] = null, pill: BoardLoad['pill'] = { state: 'none', text: null }): BoardLoad =>
  ({ id: Math.random().toString(36).slice(2), line: 1, top: { bol: '1', customer: 'ACME', rate: '$4,000.00', shipDate: '7/13/2026', ...over }, bottom, pill, agentLine: null, status: 'open', boardLine: 1 })

describe('buildColumns', () => {
  it('makes one column per layout column with stable ids', () => {
    expect(buildColumns(layout).map((c) => c.id)).toEqual(['bol', 'customer', 'rate', 'shipDate', 'extra:NOTES', 'agent'])
  })

  it('sees both rows of a pair for the shared columns', () => {
    const cols = buildColumns(layout)
    const customer = cols.find((c) => c.id === 'customer')!
    const l = load({}, { customer: 'BLUE ROAD LLC' })
    expect((customer.accessorFn as (r: BoardLoad, i: number) => string)(l, 0)).toBe('ACME BLUE ROAD LLC')
  })

  it('sorts money as numbers and dates as dates', () => {
    expect(moneyValue('$4,000.00')).toBe(400000)
    expect(moneyValue('')).toBeNull()
    const cols = buildColumns(layout)
    const rate = cols.find((c) => c.id === 'rate')!
    const a = load({ rate: '$900.00' }), b = load({ rate: '$4,000.00' })
    const rows = (x: BoardLoad) => ({ original: x, getValue: () => x.top.rate })
    // @ts-expect-error minimal row shape for the comparator
    expect(rate.sortingFn(rows(a), rows(b), 'rate')).toBeLessThan(0)
    const ship = cols.find((c) => c.id === 'shipDate')!
    const c = load({ shipDate: '12/1/2026' }), d = load({ shipDate: '7/13/2026' })
    // @ts-expect-error minimal row shape for the comparator
    expect(ship.sortingFn({ original: c, getValue: () => c.top.shipDate }, { original: d, getValue: () => d.top.shipDate }, 'shipDate')).toBeGreaterThan(0)
  })

  it('sorts the agent column by pill severity', () => {
    const cols = buildColumns(layout)
    const agent = cols.find((c) => c.id === 'agent')!
    const none = load({}), att = load({}, null, { state: 'attention', text: 'x' })
    expect((agent.accessorFn as (r: BoardLoad, i: number) => string)(att, 0) > (agent.accessorFn as (r: BoardLoad, i: number) => string)(none, 0)).toBe(true)
  })
})
```

`fleet-portal/src/components/broker/columnPrefs.spec.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { clearPrefs, loadPrefs, savePrefs } from './columnPrefs'

describe('columnPrefs', () => {
  beforeEach(() => localStorage.clear())
  it('is null until saved, round-trips, and clears', () => {
    expect(loadPrefs()).toBeNull()
    savePrefs({ visibility: { contact: false }, order: ['bol', 'customer'], sizing: { bol: 90 }, density: 'tight' })
    expect(loadPrefs()).toEqual({ visibility: { contact: false }, order: ['bol', 'customer'], sizing: { bol: 90 }, density: 'tight' })
    clearPrefs()
    expect(loadPrefs()).toBeNull()
  })
  it('ignores garbage in storage instead of throwing', () => {
    localStorage.setItem('brokerBoard.columns.v1', '{not json')
    expect(loadPrefs()).toBeNull()
  })
})
```

`fleet-portal/src/components/broker/BrokerGrid.spec.ts`:
```ts
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'
import type { BoardColumn, BoardLoad } from '../../lib/api'
import BrokerGrid from './BrokerGrid.vue'

const layout: BoardColumn[] = [
  { key: 'bol', label: 'BOL#' }, { key: 'customer', label: 'CUSTOMER /CARRIER' }, { key: 'rate', label: 'RATE' }, { key: 'agent', label: 'AGENT' },
]
const mk = (id: string, bol: string, rate: string, carrier: string | null): BoardLoad =>
  ({ id, line: 1, top: { bol, customer: 'ACME', rate }, bottom: carrier ? { customer: carrier } : null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: Number(bol) })
const loads = [mk('a', '1', '$900.00', 'BLUE'), mk('b', '2', '$4,000.00', null), mk('c', '3', '$2,000.00', 'RED')]

// jsdom has no layout: the virtualizer is given a fixed viewport via the prop so all rows render.
const mountGrid = () => mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000 } })

describe('BrokerGrid', () => {
  beforeEach(() => localStorage.clear())

  it('renders their headers with a checkbox gutter and both rows of a pair', () => {
    const w = mountGrid()
    expect(w.findAll('thead th').map((t) => t.text()).slice(1)).toEqual(['BOL#', 'CUSTOMER /CARRIER', 'RATE', 'AGENT'])
    expect(w.findAll('tbody tr[data-row]')).toHaveLength(5)
    expect(w.findAll('tbody input[type="checkbox"]')).toHaveLength(3)
  })

  it('selects a pair as one, select-all selects every load, and emits the ids', async () => {
    const w = mountGrid()
    await w.findAll('tbody input[type="checkbox"]')[0].setValue(true)
    expect(w.emitted('update:selectedIds')?.at(-1)).toEqual([['a']])
    expect(w.findAll('tr[data-load="a"]').every((tr) => tr.classes().some((c) => c.includes('ring') || c.includes('selected')))).toBe(true)
    await w.find('thead input[type="checkbox"]').setValue(true)
    expect(w.emitted('update:selectedIds')?.at(-1)?.[0]).toHaveLength(3)
  })

  it('sorts by rate as money when the header is clicked, and flips on the second click', async () => {
    const w = mountGrid()
    const rateHeader = w.findAll('thead th')[3]
    await rateHeader.find('button').trigger('click')
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]').map((tr) => tr.find('td[data-col="bol"]').text())).toEqual(['1', '3', '2'])
    expect(rateHeader.attributes('aria-sort')).toBe('ascending')
    await rateHeader.find('button').trigger('click')
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]').map((tr) => tr.find('td[data-col="bol"]').text())).toEqual(['2', '3', '1'])
  })

  it('filters every cell of both rows with the search box', async () => {
    const w = mountGrid()
    await w.setProps({ search: 'red' })
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]')).toHaveLength(1)
    expect(w.find('tbody tr[data-row="top"] td[data-col="bol"]').text()).toBe('3')
  })

  it('remembers a hidden column and resets to their layout', async () => {
    const w = mountGrid()
    await w.vm.$.exposed!.hideColumn('rate')
    await nextTick()
    expect(w.findAll('thead th').map((t) => t.text())).not.toContain('RATE')
    expect(JSON.parse(localStorage.getItem('brokerBoard.columns.v1')!).visibility.rate).toBe(false)
    await w.vm.$.exposed!.resetColumns()
    await nextTick()
    expect(w.findAll('thead th').map((t) => t.text())).toContain('RATE')
    expect(localStorage.getItem('brokerBoard.columns.v1')).toBeNull()
  })
})
```

- [ ] **Step 3: Run them to verify they fail** — modules not found.

- [ ] **Step 4: Implement**

`fleet-portal/src/lib/api.ts` — extend `BoardLoad` with `status: string; boardLine: number | null` and change `fetchBrokerBoard` to `fetchBrokerBoard(includeArchived = false)` calling `api.get('/dispatcher/broker-board' + (includeArchived ? '?archived=1' : ''))`. (The store's direct `api.get` gets the same query.)

`fleet-portal/src/components/broker/columnPrefs.ts`:
```ts
// Column state is a per-browser convenience. The server's layout is the
// truth; "Reset to their layout" clears this.
export interface ColumnPrefs {
  visibility: Record<string, boolean>
  order: string[]
  sizing: Record<string, number>
  density: 'theirs' | 'tight'
}
export const PREFS_KEY = 'brokerBoard.columns.v1'

export function loadPrefs(): ColumnPrefs | null {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<ColumnPrefs>
    if (!p || typeof p !== 'object') return null
    return { visibility: p.visibility ?? {}, order: p.order ?? [], sizing: p.sizing ?? {}, density: p.density === 'tight' ? 'tight' : 'theirs' }
  } catch { return null }
}
export function savePrefs(p: ColumnPrefs): void { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* storage unavailable: a convenience, not a requirement */ } }
export function clearPrefs(): void { try { localStorage.removeItem(PREFS_KEY) } catch { /* same */ } }
```

`fleet-portal/src/components/broker/boardColumns.ts`:
```ts
import type { ColumnDef, Row } from '@tanstack/vue-table'
import type { BoardColumn, BoardColumnKey, BoardLoad } from '../../lib/api'

// One TanStack column per layout column. We never let the library render;
// these definitions exist for sorting, filtering and column state.

const SHARED: ReadonlySet<BoardColumnKey> = new Set(['customer', 'phone', 'contact', 'mc', 'loadNo', 'appt'])

export const columnId = (c: BoardColumn): string => (c.key === 'extra' ? `extra:${c.source ?? c.label}` : c.key)

export function cellOf(cells: BoardLoad['top'] | null, c: BoardColumn): string {
  if (!cells) return ''
  if (c.key === 'extra') return (cells as Record<string, string>)[c.source ?? c.label] ?? ''
  return cells[c.key] ?? ''
}

export function moneyValue(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, '')
  return cleaned && /^-?\d+(\.\d{1,2})?$/.test(cleaned) ? Math.round(Number(cleaned) * 100) : null
}
export function dateValue(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) return Date.UTC(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[1]) - 1, Number(m[2]))
  const iso = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return iso ? Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) : null
}
const PILL_RANK: Record<string, number> = { none: 0, shadow: 1, watching: 2, asked: 3, calling: 4, attention: 5, escalated: 6, delivered: 1 }

const nullsLast = (a: number | null, b: number | null): number => (a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : a - b)

export function buildColumns(layout: BoardColumn[]): ColumnDef<BoardLoad, string>[] {
  return layout.map((c) => {
    const id = columnId(c)
    const base: ColumnDef<BoardLoad, string> = {
      id,
      header: c.label,
      accessorFn: (l) => (SHARED.has(c.key) ? [cellOf(l.top, c), cellOf(l.bottom, c)].filter(Boolean).join(' ') : cellOf(l.top, c)),
      enableSorting: true,
      size: 120,
    }
    if (c.key === 'rate' || c.key === 'soldRate' || c.key === 'profit') {
      base.sortingFn = (a: Row<BoardLoad>, b: Row<BoardLoad>) => nullsLast(moneyValue(cellOf(a.original.top, c)), moneyValue(cellOf(b.original.top, c)))
    }
    if (c.key === 'shipDate') {
      base.sortingFn = (a: Row<BoardLoad>, b: Row<BoardLoad>) => nullsLast(dateValue(cellOf(a.original.top, c)), dateValue(cellOf(b.original.top, c)))
    }
    if (c.key === 'agent') {
      base.accessorFn = (l) => String(PILL_RANK[l.pill.state] ?? 0)
      base.sortingFn = (a: Row<BoardLoad>, b: Row<BoardLoad>) => (PILL_RANK[a.original.pill.state] ?? 0) - (PILL_RANK[b.original.pill.state] ?? 0)
      base.size = 110
    }
    if (c.key === 'bol') base.size = 90
    if (c.key === 'phone') base.size = 220
    return base
  })
}
```

`fleet-portal/src/components/broker/useBoardTable.ts`:
```ts
import { computed, ref, watch, type Ref } from 'vue'
import { getCoreRowModel, getFilteredRowModel, getSortedRowModel, useVueTable, type ColumnOrderState, type ColumnSizingState, type RowSelectionState, type SortingState, type VisibilityState } from '@tanstack/vue-table'
import type { BoardColumn, BoardLoad } from '../../lib/api'
import { buildColumns, cellOf } from './boardColumns'
import { clearPrefs, loadPrefs, savePrefs, type ColumnPrefs } from './columnPrefs'

// The table's brain: TanStack owns sorting, filtering, selection and column
// state; the component draws. Column state is restored from the browser
// and written back on every change; the server's layout wins on reset.
export function useBoardTable(loads: Ref<BoardLoad[]>, layout: Ref<BoardColumn[]>) {
  const prefs = loadPrefs()
  const sorting = ref<SortingState>([])
  const globalFilter = ref('')
  const rowSelection = ref<RowSelectionState>({})
  const columnVisibility = ref<VisibilityState>(prefs?.visibility ?? {})
  const columnOrder = ref<ColumnOrderState>(prefs?.order ?? [])
  const columnSizing = ref<ColumnSizingState>(prefs?.sizing ?? {})
  const density = ref<ColumnPrefs['density']>(prefs?.density ?? 'theirs')
  const columns = computed(() => buildColumns(layout.value))

  const apply = <T,>(target: Ref<T>) => (updater: T | ((old: T) => T)) => { target.value = typeof updater === 'function' ? (updater as (old: T) => T)(target.value) : updater }

  const table = useVueTable<BoardLoad>({
    get data() { return loads.value },
    get columns() { return columns.value },
    state: {
      get sorting() { return sorting.value },
      get globalFilter() { return globalFilter.value },
      get rowSelection() { return rowSelection.value },
      get columnVisibility() { return columnVisibility.value },
      get columnOrder() { return columnOrder.value },
      get columnSizing() { return columnSizing.value },
    },
    onSortingChange: apply(sorting),
    onGlobalFilterChange: apply(globalFilter),
    onRowSelectionChange: apply(rowSelection),
    onColumnVisibilityChange: apply(columnVisibility),
    onColumnOrderChange: apply(columnOrder),
    onColumnSizingChange: apply(columnSizing),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getRowId: (l) => l.id,
    enableRowSelection: true,
    enableMultiSort: true,
    columnResizeMode: 'onChange',
    globalFilterFn: (row, _columnId, value: string) => {
      const needle = String(value ?? '').trim().toLowerCase()
      if (!needle) return true
      const l = row.original
      return layout.value.some((c) => cellOf(l.top, c).toLowerCase().includes(needle) || cellOf(l.bottom, c).toLowerCase().includes(needle))
    },
  })

  watch([columnVisibility, columnOrder, columnSizing, density], () => {
    savePrefs({ visibility: columnVisibility.value, order: columnOrder.value, sizing: columnSizing.value, density: density.value })
  }, { deep: true })

  const selectedIds = computed(() => Object.keys(rowSelection.value).filter((id) => rowSelection.value[id]))
  const clearSelection = () => { rowSelection.value = {} }
  const resetColumns = () => { columnVisibility.value = {}; columnOrder.value = []; columnSizing.value = {}; density.value = 'theirs'; clearPrefs() }
  const hideColumn = (id: string) => { columnVisibility.value = { ...columnVisibility.value, [id]: false } }
  const setDensity = (d: ColumnPrefs['density']) => { density.value = d }

  return { table, sorting, globalFilter, rowSelection, selectedIds, clearSelection, columnVisibility, columnOrder, columnSizing, density, setDensity, resetColumns, hideColumn }
}
```
(Note: the `watch` fires on the first change only, so a fresh page with no prefs writes nothing until the user changes something; `resetColumns` clears storage explicitly after resetting the refs — order matters: clear last.)

`fleet-portal/src/components/broker/BrokerGrid.vue` (rewrite):
```vue
<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { BoardColumn, BoardLoad } from '../../lib/api'
import { cellOf } from './boardColumns'
import { useBoardTable } from './useBoardTable'

// Their sheet, cell for cell, on a real table engine. Two <tr> per load;
// the checkbox spans both; the header is sticky; a thousand loads scroll.
const props = withDefaults(defineProps<{ layout: BoardColumn[]; loads: BoardLoad[]; search?: string; viewportHeight?: number }>(), { search: '', viewportHeight: 0 })
const emit = defineEmits<{ (e: 'update:selectedIds', ids: string[]): void }>()

const t = useBoardTable(toRef(props, 'loads'), toRef(props, 'layout'))
watch(() => props.search, (s) => { t.globalFilter.value = s ?? '' }, { immediate: true })
watch(t.selectedIds, (ids) => emit('update:selectedIds', ids))

const rows = computed(() => t.table.getRowModel().rows)
const scroller = ref<HTMLElement | null>(null)
const rowHeight = computed(() => (t.density.value === 'tight' ? 44 : 58))
const virtualizer = useVirtualizer(computed(() => ({
  count: rows.value.length,
  getScrollElement: () => scroller.value,
  estimateSize: () => rowHeight.value,
  overscan: 12,
  // jsdom has no layout; a caller may pin the viewport so every row renders.
  ...(props.viewportHeight ? { initialRect: { width: 1200, height: props.viewportHeight } } : {}),
})))
const items = computed(() => virtualizer.value.getVirtualItems())
const padTop = computed(() => (items.value.length ? items.value[0].start : 0))
const padBottom = computed(() => (items.value.length ? virtualizer.value.getTotalSize() - items.value[items.value.length - 1].end : 0))

const isUrl = (v: string): boolean => /^https?:\/\//i.test(v)
const layoutById = computed(() => new Map(props.layout.map((c) => [c.key === 'extra' ? `extra:${c.source ?? c.label}` : c.key, c])))
const col = (id: string): BoardColumn => layoutById.value.get(id)!
const cellClass = (c: BoardColumn, row: 'top' | 'bottom', value: string): string => {
  if (c.key === 'customer' && row === 'top' && value) return 'bg-amber-200 text-black font-bold tracking-wide'
  if (c.key === 'profit') return 'text-green-700 font-semibold'
  if (c.key === 'rate' || c.key === 'soldRate') return 'font-semibold'
  return ''
}
const pillLabel = (l: BoardLoad): string => (l.pill.state === 'attention' ? 'Attention' : '—')
const rowClass = (l: BoardLoad, selected: boolean): string =>
  (l.status === 'archived' ? 'opacity-60 ' : '') + (selected ? 'bg-brand-wash ring-1 ring-inset ring-brand ' : 'bg-orange-100 dark:bg-orange-900/40 ') + 'text-black dark:text-ink hover:brightness-95'
const cellPad = computed(() => (t.density.value === 'tight' ? 'px-2 py-0.5' : 'px-2 py-1'))

// Shift-click selects the range between the last clicked load and this one, in the visible order.
let anchor: string | null = null
function onCheck(id: string, ev: MouseEvent | Event) {
  const visible = rows.value.map((r) => r.id)
  const shift = (ev as MouseEvent).shiftKey === true
  if (shift && anchor && visible.includes(anchor)) {
    const [a, b] = [visible.indexOf(anchor), visible.indexOf(id)].sort((x, y) => x - y)
    const next = { ...t.rowSelection.value }
    for (const vid of visible.slice(a, b + 1)) next[vid] = true
    t.rowSelection.value = next
  } else {
    t.rowSelection.value = { ...t.rowSelection.value, [id]: !t.rowSelection.value[id] }
  }
  anchor = id
}
const allChecked = computed(() => t.table.getIsAllRowsSelected())
const someChecked = computed(() => t.table.getIsSomeRowsSelected())
const toggleAll = () => t.table.toggleAllRowsSelected(!allChecked.value)

defineExpose({ hideColumn: t.hideColumn, resetColumns: t.resetColumns, setDensity: t.setDensity, density: t.density, table: t.table, clearSelection: t.clearSelection })
</script>

<template>
  <div ref="scroller" class="relative max-h-[calc(100vh-220px)] overflow-auto rounded border border-line bg-surface">
    <table class="min-w-full border-separate border-spacing-0 text-[13px] leading-tight" data-broker-grid :style="{ width: t.table.getTotalSize() + 48 + 'px' }">
      <thead class="sticky top-0 z-20 bg-surface-2">
        <tr>
          <th class="sticky left-0 z-30 w-12 border border-line bg-surface-2 px-2 text-center">
            <input type="checkbox" :checked="allChecked" :indeterminate.prop="!allChecked && someChecked" aria-label="Select all loads" @change="toggleAll" />
          </th>
          <th v-for="header in t.table.getHeaderGroups()[0].headers" :key="header.id" :style="{ width: header.getSize() + 'px' }"
              :aria-sort="header.column.getIsSorted() === 'asc' ? 'ascending' : header.column.getIsSorted() === 'desc' ? 'descending' : 'none'"
              class="relative whitespace-nowrap border border-line px-2 py-1.5 text-left text-[11px] font-bold uppercase tracking-wide text-ink-2"
              :class="header.column.id === 'bol' ? 'sticky left-12 z-30 bg-surface-2' : ''">
            <button type="button" class="flex w-full items-center gap-1 text-left" :title="'Sort by ' + col(header.column.id).label + ' (shift-click to add)'" @click="header.column.getToggleSortingHandler()?.($event)">
              <span>{{ col(header.column.id).label }}</span>
              <span v-if="header.column.getIsSorted()" class="text-ink-3">{{ header.column.getIsSorted() === 'asc' ? '▲' : '▼' }}<sub v-if="t.sorting.value.length > 1">{{ header.column.getSortIndex() + 1 }}</sub></span>
            </button>
            <span class="absolute right-0 top-0 h-full w-1 cursor-col-resize select-none hover:bg-brand" @mousedown="header.getResizeHandler()($event)" @touchstart="header.getResizeHandler()($event)" aria-hidden="true"></span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="padTop > 0" aria-hidden="true"><td :colspan="t.table.getVisibleLeafColumns().length + 1" :style="{ height: padTop + 'px' }" class="border-0 p-0"></td></tr>
        <template v-for="item in items" :key="rows[item.index].id">
          <tr :data-load="rows[item.index].id" data-row="top" :class="rowClass(rows[item.index].original, rows[item.index].getIsSelected())" :data-selected="rows[item.index].getIsSelected() || undefined">
            <td :rowspan="rows[item.index].original.bottom ? 2 : 1" class="sticky left-0 z-10 border border-line bg-surface px-2 text-center align-middle">
              <input type="checkbox" :checked="rows[item.index].getIsSelected()" :aria-label="'Select load ' + (rows[item.index].original.bottom?.loadNo || rows[item.index].original.top.bol || '')" @click="onCheck(rows[item.index].id, $event)" />
            </td>
            <td v-for="cell in rows[item.index].getVisibleCells()" :key="cell.id" :data-col="cell.column.id" :style="{ width: cell.column.getSize() + 'px' }"
                class="whitespace-nowrap border border-line align-middle" :class="[cellPad, cellClass(col(cell.column.id), 'top', cellOf(rows[item.index].original.top, col(cell.column.id))), cell.column.id === 'bol' ? 'sticky left-12 z-10' : '']">
              <template v-if="cell.column.id === 'agent'">
                <span data-pill :title="rows[item.index].original.pill.text ?? undefined" class="inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold" :class="rows[item.index].original.pill.state === 'attention' ? 'border border-red-500 text-red-600' : 'text-ink-3'">{{ pillLabel(rows[item.index].original) }}</span>
              </template>
              <template v-else-if="isUrl(cellOf(rows[item.index].original.top, col(cell.column.id)))">
                <a :href="cellOf(rows[item.index].original.top, col(cell.column.id))" target="_blank" rel="noopener" class="text-blue-700 underline">{{ cellOf(rows[item.index].original.top, col(cell.column.id)).replace(/^https?:\/\//, '').slice(0, 42) }}…</a>
              </template>
              <template v-else>{{ cellOf(rows[item.index].original.top, col(cell.column.id)) }}</template>
            </td>
          </tr>
          <tr v-if="rows[item.index].original.bottom" :data-load="rows[item.index].id" data-row="bottom" :class="rowClass(rows[item.index].original, rows[item.index].getIsSelected())" :data-selected="rows[item.index].getIsSelected() || undefined">
            <td v-for="cell in rows[item.index].getVisibleCells()" :key="cell.id" :data-col="cell.column.id" :style="{ width: cell.column.getSize() + 'px' }"
                class="whitespace-nowrap border border-line align-middle" :class="[cellPad, cellClass(col(cell.column.id), 'bottom', cellOf(rows[item.index].original.bottom, col(cell.column.id))), cell.column.id === 'bol' ? 'sticky left-12 z-10' : '']">
              <template v-if="cell.column.id !== 'agent'">{{ cellOf(rows[item.index].original.bottom, col(cell.column.id)) }}</template>
            </td>
          </tr>
        </template>
        <tr v-if="padBottom > 0" aria-hidden="true"><td :colspan="t.table.getVisibleLeafColumns().length + 1" :style="{ height: padBottom + 'px' }" class="border-0 p-0"></td></tr>
      </tbody>
    </table>
    <p v-if="rows.length === 0" class="p-6 text-center text-sm text-ink-2">No loads match.</p>
  </div>
</template>
```
Notes for the implementer: the spacer row between pairs from slice 1 is gone (the virtualizer's row height covers it; keep a `border-b-4 border-surface` on the bottom row of a pair if the visual gap is missed — judge on the live check); `bg-brand-wash` exists in the Tailwind config (`brand.wash`); `getToggleSortingHandler()` handles shift for multi-sort; `getSortIndex()` is 0-based.

- [ ] **Step 5: Run to verify it passes** — the three new specs green; the slice 1 specs (`BrokerBoardView.spec.ts`, `brokerBoard.spec.ts`, `BrokerImportDialog.spec.ts`) still green — update the view spec's selectors only where the DOM contract changed (there is now a checkbox `<th>` first; `tbody tr[data-row]` still marks load rows; the spacer row is gone). `npx vue-tsc -b` clean for these files.

- [ ] **Step 6: Break it** — in `onCheck`, drop the shift branch → no spec fails (there is no shift spec): add one: click load `a`, then click load `c` with `{ shiftKey: true }` → three selected. Then remove the branch → it fails. Restore.

- [ ] **Step 7: Commit** — skipped.

---

### Task 5: Bulk bar, archive/unarchive/delete/export actions, show-archived toggle

**Files:**
- Modify: `fleet-portal/src/lib/api.ts` (types), `fleet-portal/src/lib/download.ts` (`triggerBlobDownload`), `fleet-portal/src/stores/brokerBoard.ts` (actions), `fleet-portal/src/views/BrokerBoardView.vue`
- Create: `fleet-portal/src/components/broker/BulkBar.vue`, `fleet-portal/src/components/broker/ConfirmDelete.vue`
- Test: `fleet-portal/src/stores/brokerBoard.spec.ts` (extend), `fleet-portal/src/components/broker/BulkBar.spec.ts`, `fleet-portal/src/views/BrokerBoardView.spec.ts` (extend)

**Interfaces:**
- Store gains: `showArchived: boolean`, `selectedIds: string[]`, `busy: boolean`, `notice: string | null`, `load()` (uses `showArchived`), `archive(ids, archived)`, `remove(ids)`, `exportSelected(ids)` — each posts, then reloads and clears the selection; a 409/404 message lands in `error` verbatim (the server names the LOAD#s).
- `BulkBar.vue` props `{ count, busy }`, emits `archive`, `unarchive`, `delete`, `export`, `clear`; renders only when `count > 0`.
- `ConfirmDelete.vue` props `{ labels: string[] }` (the LOAD#/BOL# of each selected load), emits `confirm`/`cancel`; the confirm button says "Delete N loads" and lists the labels.
- `triggerBlobDownload(filename: string, blob: Blob): void` in `download.ts`.

- [ ] **Step 1: Write the failing tests**

Extend `fleet-portal/src/stores/brokerBoard.spec.ts` with:
```ts
  it('archives, deletes and exports a selection through the org endpoints, then reloads and clears', async () => {
    mockedPost.mockResolvedValueOnce({ data: { updated: 2 } })
    mockedGet.mockResolvedValueOnce({ data: board })
    const s = useBrokerBoardStore()
    s.selectedIds = ['l1', 'l2']
    await s.archive(['l1', 'l2'], true)
    expect(mockedPost).toHaveBeenLastCalledWith('/dispatcher/broker-board/loads/archive', { ids: ['l1', 'l2'], archived: true })
    expect(s.selectedIds).toEqual([])
    expect(s.notice).toMatch(/2 loads archived/)
    mockedPost.mockResolvedValueOnce({ data: { deleted: 1 } })
    mockedGet.mockResolvedValueOnce({ data: board })
    await s.remove(['l1'])
    expect(mockedPost).toHaveBeenLastCalledWith('/dispatcher/broker-board/loads/delete', { ids: ['l1'] })
    mockedPost.mockResolvedValueOnce({ data: new Blob(['x']) })
    await s.exportSelected(['l1'])
    expect(mockedPost.mock.calls.at(-1)?.[0]).toBe('/dispatcher/broker-board/export')
    expect(mockedPost.mock.calls.at(-1)?.[2]).toMatchObject({ responseType: 'blob' })
  })

  it('keeps the server\'s refusal verbatim so the dispatcher sees which loads blocked it', async () => {
    mockedPost.mockRejectedValueOnce({ response: { status: 409, data: { error: "These loads can't be deleted while assigned or in progress: 145205" } } })
    const s = useBrokerBoardStore()
    await s.remove(['l1'])
    expect(s.error).toMatch(/145205/)
  })

  it('asks for archived loads when the toggle is on', async () => {
    mockedGet.mockResolvedValueOnce({ data: board })
    const s = useBrokerBoardStore()
    s.showArchived = true
    await s.load()
    expect(mockedGet).toHaveBeenLastCalledWith('/dispatcher/broker-board?archived=1')
  })
```
(`vi.mock('../lib/download', () => ({ triggerDownload: vi.fn(), triggerBlobDownload: vi.fn() }))` at the top of the spec.)

`fleet-portal/src/components/broker/BulkBar.spec.ts`:
```ts
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import BulkBar from './BulkBar.vue'

describe('BulkBar', () => {
  it('is absent with nothing selected and shows the count and actions otherwise', () => {
    expect(mount(BulkBar, { props: { count: 0, busy: false } }).find('[data-bulk]').exists()).toBe(false)
    const w = mount(BulkBar, { props: { count: 3, busy: false } })
    expect(w.text()).toContain('3 loads selected')
    for (const name of ['archive', 'unarchive', 'delete', 'export', 'clear']) {
      w.find(`button[data-action="${name}"]`).trigger('click')
      expect(w.emitted(name)).toBeTruthy()
    }
  })
  it('disables the actions while busy', () => {
    const w = mount(BulkBar, { props: { count: 1, busy: true } })
    expect(w.find('button[data-action="delete"]').attributes('disabled')).toBeDefined()
  })
})
```

Extend `fleet-portal/src/views/BrokerBoardView.spec.ts`:
```ts
  it('selecting loads shows the bulk bar, delete asks first and names the loads, archive toggle reloads', async () => {
    mockedGet.mockResolvedValue({ data: { layout, loads } })
    const w = mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    await w.find('tbody input[type="checkbox"]').setValue(true)
    await flushPromises()
    expect(w.find('[data-bulk]').text()).toContain('1 load selected')
    await w.find('button[data-action="delete"]').trigger('click')
    expect(w.find('[role="dialog"]').text()).toContain('145205')
    await w.find('[role="dialog"] button[data-cancel]').trigger('click')
    expect(w.find('[role="dialog"]').exists()).toBe(false)
    await w.find('input[data-show-archived]').setValue(true)
    await flushPromises()
    expect(mockedGet).toHaveBeenLastCalledWith('/dispatcher/broker-board?archived=1')
  })
```
(Add `status: 'open', boardLine: 1` to the spec's fixture loads.)

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement**

`download.ts` append:
```ts
export function triggerBlobDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.rel = 'noopener'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
```

Store additions (`brokerBoard.ts`):
```ts
    showArchived: false,
    selectedIds: [] as string[],
    busy: false,
    notice: null as string | null,
```
```ts
    async load() {
      this.loading = true; this.error = null
      try {
        const { data } = await api.get<BrokerBoard>('/dispatcher/broker-board' + (this.showArchived ? '?archived=1' : ''))
        this.layout = data.layout; this.loads = data.loads
      } catch (e) { this.error = extractApiErrorMessage(e, 'Could not load the board') }
      finally { this.loading = false }
    },
    async archive(ids: string[], archived: boolean) {
      await this.bulk(async () => {
        const { data } = await api.post<{ updated: number }>('/dispatcher/broker-board/loads/archive', { ids, archived })
        return `${data.updated} ${data.updated === 1 ? 'load' : 'loads'} ${archived ? 'archived' : 'unarchived'}`
      })
    },
    async remove(ids: string[]) {
      await this.bulk(async () => {
        const { data } = await api.post<{ deleted: number }>('/dispatcher/broker-board/loads/delete', { ids })
        return `${data.deleted} ${data.deleted === 1 ? 'load' : 'loads'} deleted`
      })
    },
    async exportSelected(ids: string[]) {
      this.busy = true; this.error = null
      try {
        const { data } = await api.post<Blob>('/dispatcher/broker-board/export', { ids }, { responseType: 'blob' })
        triggerBlobDownload(`board-${new Date().toISOString().slice(0, 10)}.xlsx`, data)
        this.notice = `${ids.length} ${ids.length === 1 ? 'load' : 'loads'} exported`
      } catch (e) { this.error = extractApiErrorMessage(e, 'Could not export') }
      finally { this.busy = false }
    },
    async bulk(run: () => Promise<string>) {
      this.busy = true; this.error = null; this.notice = null
      try { this.notice = await run(); this.selectedIds = []; await this.load() }
      catch (e) { this.error = extractApiErrorMessage(e, 'That did not work') }
      finally { this.busy = false }
    },
```
(The store's `error` must carry the server's `error` text verbatim — check `extractApiErrorMessage` does that for 409/404 bodies; if it only handles some shapes, read `e?.response?.data?.error` first.)

`BulkBar.vue`:
```vue
<script setup lang="ts">
const props = defineProps<{ count: number; busy: boolean }>()
const emit = defineEmits<{ (e: 'archive'): void; (e: 'unarchive'): void; (e: 'delete'): void; (e: 'export'): void; (e: 'clear'): void }>()
</script>
<template>
  <div v-if="props.count > 0" data-bulk class="flex flex-wrap items-center gap-2 rounded border border-line bg-surface-2 px-3 py-2 text-sm text-ink">
    <span class="font-semibold">{{ props.count }} {{ props.count === 1 ? 'load' : 'loads' }} selected</span>
    <span class="mx-1 text-ink-3">·</span>
    <button type="button" data-action="archive" class="rounded px-2 py-1 hover:bg-surface disabled:opacity-50" :disabled="props.busy" @click="emit('archive')">Archive</button>
    <button type="button" data-action="unarchive" class="rounded px-2 py-1 hover:bg-surface disabled:opacity-50" :disabled="props.busy" @click="emit('unarchive')">Unarchive</button>
    <button type="button" data-action="export" class="rounded px-2 py-1 hover:bg-surface disabled:opacity-50" :disabled="props.busy" @click="emit('export')">Export selected</button>
    <button type="button" data-action="delete" class="rounded px-2 py-1 text-red-600 hover:bg-red-50 disabled:opacity-50" :disabled="props.busy" @click="emit('delete')">Delete</button>
    <span class="grow"></span>
    <button type="button" data-action="clear" class="rounded px-2 py-1 text-ink-2 hover:bg-surface" @click="emit('clear')">Clear selection</button>
  </div>
</template>
```

`ConfirmDelete.vue`:
```vue
<script setup lang="ts">
const props = defineProps<{ labels: string[] }>()
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()
</script>
<template>
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="Delete loads">
    <div class="w-[min(520px,95vw)] rounded-lg border border-line bg-surface p-5 text-ink shadow-xl">
      <h2 class="text-lg font-semibold">Delete {{ props.labels.length }} {{ props.labels.length === 1 ? 'load' : 'loads' }}?</h2>
      <p class="mt-1 text-sm text-ink-2">This can't be undone. Loads that are assigned or in progress will refuse and nothing will be deleted.</p>
      <ul class="mt-3 max-h-48 overflow-auto rounded border border-line bg-surface-2 p-2 text-sm font-mono">
        <li v-for="l in props.labels" :key="l">{{ l }}</li>
      </ul>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" data-cancel class="rounded px-3 py-2 text-sm text-ink-2 hover:bg-surface-2" @click="emit('cancel')">Cancel</button>
        <button type="button" data-confirm class="rounded bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700" @click="emit('confirm')">Delete {{ props.labels.length }} {{ props.labels.length === 1 ? 'load' : 'loads' }}</button>
      </div>
    </div>
  </div>
</template>
```

`BrokerBoardView.vue` (rewrite the template's middle; script gains the wiring):
```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import BrokerGrid from '../components/broker/BrokerGrid.vue'
import BrokerImportDialog from '../components/broker/BrokerImportDialog.vue'
import BulkBar from '../components/broker/BulkBar.vue'
import ConfirmDelete from '../components/broker/ConfirmDelete.vue'
import { useBrokerBoardStore } from '../stores/brokerBoard'

const store = useBrokerBoardStore()
const importing = ref(false)
const confirmingDelete = ref(false)
const search = ref('')
const grid = ref<InstanceType<typeof BrokerGrid> | null>(null)
onMounted(() => store.load())

const selectedLabels = computed(() => store.loads.filter((l) => store.selectedIds.includes(l.id)).map((l) => l.bottom?.loadNo || l.top.bol || l.top.loadNo || l.id.slice(0, 8)))
async function onDelete() { confirmingDelete.value = false; await store.remove(store.selectedIds); grid.value?.clearSelection() }
async function onArchive(archived: boolean) { await store.archive(store.selectedIds, archived); grid.value?.clearSelection() }
async function onToggleArchived(ev: Event) { store.showArchived = (ev.target as HTMLInputElement).checked; await store.load() }
</script>

<template>
  <div class="space-y-3 p-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-[18px] font-bold tracking-tight text-ink">Their Board</h1>
        <p class="text-sm text-ink-2">Your sheet, as you use it. Two rows per load. The AGENT column is the night shift.</p>
      </div>
      <div class="flex items-center gap-3">
        <input v-model="search" type="search" placeholder="Search every cell…" aria-label="Search the board" class="w-64 rounded border border-line bg-surface px-3 py-2 text-sm text-ink" />
        <label class="flex items-center gap-1 text-sm text-ink-2"><input type="checkbox" data-show-archived :checked="store.showArchived" @change="onToggleArchived" /> Show archived</label>
        <button type="button" class="rounded border border-line px-2 py-2 text-sm text-ink-2 hover:bg-surface-2" title="Tight or their spacing" @click="grid?.setDensity(grid?.density === 'tight' ? 'theirs' : 'tight')">Density</button>
        <button type="button" class="rounded border border-line px-2 py-2 text-sm text-ink-2 hover:bg-surface-2" @click="grid?.resetColumns()">Reset to their layout</button>
        <button class="rounded bg-brand px-3 py-2 text-sm font-semibold text-brand-ink" @click="importing = true">Import .xlsx</button>
      </div>
    </div>

    <p v-if="store.error" class="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{{ store.error }}</p>
    <p v-if="store.notice" class="rounded border border-green-300 bg-green-50 p-2 text-sm text-green-800">{{ store.notice }}</p>
    <BulkBar :count="store.selectedIds.length" :busy="store.busy" @archive="onArchive(true)" @unarchive="onArchive(false)" @delete="confirmingDelete = true" @export="store.exportSelected(store.selectedIds)" @clear="grid?.clearSelection()" />

    <p v-if="store.loading && store.loads.length === 0" class="text-sm text-ink-2">Loading your board…</p>
    <div v-else-if="!store.error && store.loads.length === 0" class="rounded border border-dashed border-line p-8 text-center">
      <p class="text-base font-semibold text-ink">Import your board</p>
      <p class="mt-1 text-sm text-ink-2">Pick the .xlsx you dispatch from today. It shows up here exactly as it is, and the night shift can start watching it.</p>
      <button class="mt-4 rounded bg-brand px-3 py-2 text-sm font-semibold text-brand-ink" @click="importing = true">Choose file</button>
    </div>
    <BrokerGrid v-else-if="!store.error" ref="grid" :layout="store.layout" :loads="store.loads" :search="search" @update:selected-ids="store.selectedIds = $event" />

    <ConfirmDelete v-if="confirmingDelete" :labels="selectedLabels" @confirm="onDelete" @cancel="confirmingDelete = false" />
    <BrokerImportDialog v-if="importing" @close="importing = false" />
  </div>
</template>
```

- [ ] **Step 4: Run to verify it passes** — all portal specs green; `npx vue-tsc -b` clean (known T4 errors aside).

- [ ] **Step 5: Break it** — in the store's `bulk`, drop `this.selectedIds = []` → the archive spec's `selectedIds` assertion fails. Restore.

- [ ] **Step 6: Commit** — skipped.

---

### Task 6: Column tools — hide, reorder, per-column filters, status filter

**Files:**
- Create: `fleet-portal/src/components/broker/ColumnTools.vue`
- Modify: `fleet-portal/src/components/broker/BrokerGrid.vue` (filter row, drag-reorder on headers, expose visibility/order), `fleet-portal/src/views/BrokerBoardView.vue` (mount the tools, status filter)
- Test: `fleet-portal/src/components/broker/ColumnTools.spec.ts`, `fleet-portal/src/components/broker/BrokerGrid.spec.ts` (extend)

**Interfaces:**
- `ColumnTools.vue` props `{ columns: { id: string; label: string; visible: boolean }[] }`, emits `toggle (id)`, `move (id, direction: -1 | 1)`, `reset`; a popover button "Columns" listing every column with a checkbox and up/down arrows.
- Grid: a second header row of per-column text filters, shown when `showFilters` prop is true (`column.setFilterValue`, `getFilteredRowModel` already on); header drag-and-drop reorder using native HTML5 drag events (`draggable`, `dragstart`, `dragover`, `drop`) that sets `columnOrder`; exposes `columnsForTools: ComputedRef<{ id, label, visible }[]>`, `toggleColumn(id)`, `moveColumn(id, dir)`.
- View: a "Filters" toggle, the `ColumnTools` button, and a status `<select>` (all, open, assigned, in progress, delivered, archived) that sets a column filter on a hidden `status` column (add `status` as a hidden TanStack column in `buildColumns` with `enableHiding: true`, visibility false by default, `filterFn: 'equals'`).

- [ ] **Step 1: Write the failing tests**

`ColumnTools.spec.ts`:
```ts
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ColumnTools from './ColumnTools.vue'

const columns = [{ id: 'bol', label: 'BOL#', visible: true }, { id: 'rate', label: 'RATE', visible: false }]
describe('ColumnTools', () => {
  it('lists columns with their visibility and emits toggle, move and reset', async () => {
    const w = mount(ColumnTools, { props: { columns } })
    await w.find('button[data-columns]').trigger('click')
    const boxes = w.findAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect((boxes[1].element as HTMLInputElement).checked).toBe(false)
    await boxes[1].setValue(true)
    expect(w.emitted('toggle')?.[0]).toEqual(['rate'])
    await w.find('button[data-move-up="rate"]').trigger('click')
    expect(w.emitted('move')?.[0]).toEqual(['rate', -1])
    await w.find('button[data-reset]').trigger('click')
    expect(w.emitted('reset')).toBeTruthy()
  })
})
```

Extend `BrokerGrid.spec.ts`:
```ts
  it('filters one column with the filter row and reorders columns', async () => {
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000, showFilters: true } })
    await w.find('thead tr[data-filters] input[data-filter="customer"]').setValue('red')
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]')).toHaveLength(1)
    await w.vm.$.exposed!.moveColumn('rate', -1)
    await nextTick()
    expect(w.findAll('thead tr:first-child th').map((t) => t.text()).slice(1)).toEqual(['BOL#', 'RATE', 'CUSTOMER /CARRIER', 'AGENT'])
  })

  it('hides archived loads from the status filter and shows them when asked', async () => {
    const withArchived = [...loads, { ...mk('d', '4', '$1.00', null), status: 'archived' }]
    const w = mount(BrokerGrid, { props: { layout, loads: withArchived, viewportHeight: 10_000, statusFilter: 'archived' } })
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]').map((tr) => tr.find('td[data-col="bol"]').text())).toEqual(['4'])
  })
```

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement**

In `boardColumns.ts`, append to `buildColumns`' result a hidden status column:
```ts
  const status: ColumnDef<BoardLoad, string> = { id: 'status', header: 'Status', accessorFn: (l) => l.status, enableSorting: false, enableHiding: true, filterFn: 'equals', size: 0 }
  return [...defs, status]
```
and in `useBoardTable`, initialize `columnVisibility` with `{ status: false, ...(prefs?.visibility ?? {}) }`; `resetColumns` resets to `{ status: false }`. `ColumnTools` never lists `status` (filter it out in `columnsForTools`).

Grid additions (`BrokerGrid.vue`): props `showFilters?: boolean`, `statusFilter?: string`; `watch(() => props.statusFilter, (v) => t.table.getColumn('status')?.setFilterValue(v && v !== 'all' ? v : undefined), { immediate: true })`; a second `<tr data-filters v-if="props.showFilters">` in `<thead>` with `<input :data-filter="header.column.id" :value="header.column.getFilterValue() ?? ''" @input="header.column.setFilterValue(($event.target as HTMLInputElement).value || undefined)">` per visible header (skip `agent`); header `draggable="true"` with `@dragstart="dragId = header.column.id"`, `@dragover.prevent`, `@drop="dropOn(header.column.id)"` where `dropOn` computes the new order from `t.table.getAllLeafColumns().map(c => c.id)` (excluding `status`) and assigns `t.columnOrder.value`; `moveColumn(id, dir)` does the same by index; `toggleColumn(id)` flips visibility; `columnsForTools` computed from `t.table.getAllLeafColumns()` in current order, minus `status`. Expose all three plus `columnsForTools`.

`ColumnTools.vue`:
```vue
<script setup lang="ts">
import { ref } from 'vue'
const props = defineProps<{ columns: { id: string; label: string; visible: boolean }[] }>()
const emit = defineEmits<{ (e: 'toggle', id: string): void; (e: 'move', id: string, dir: -1 | 1): void; (e: 'reset'): void }>()
const open = ref(false)
</script>
<template>
  <div class="relative">
    <button type="button" data-columns class="rounded border border-line px-2 py-2 text-sm text-ink-2 hover:bg-surface-2" @click="open = !open" :aria-expanded="open">Columns</button>
    <div v-if="open" class="absolute right-0 z-40 mt-1 w-72 rounded border border-line bg-surface p-2 shadow-xl" role="menu">
      <ul class="max-h-80 overflow-auto text-sm text-ink">
        <li v-for="(c, i) in props.columns" :key="c.id" class="flex items-center gap-2 px-1 py-1">
          <input type="checkbox" :id="'col-' + c.id" :checked="c.visible" @change="emit('toggle', c.id)" />
          <label :for="'col-' + c.id" class="grow truncate">{{ c.label }}</label>
          <button type="button" :data-move-up="c.id" class="px-1 text-ink-3 hover:text-ink disabled:opacity-30" :disabled="i === 0" aria-label="Move up" @click="emit('move', c.id, -1)">▲</button>
          <button type="button" :data-move-down="c.id" class="px-1 text-ink-3 hover:text-ink disabled:opacity-30" :disabled="i === props.columns.length - 1" aria-label="Move down" @click="emit('move', c.id, 1)">▼</button>
        </li>
      </ul>
      <button type="button" data-reset class="mt-2 w-full rounded border border-line px-2 py-1 text-sm text-ink-2 hover:bg-surface-2" @click="emit('reset')">Reset to their layout</button>
    </div>
  </div>
</template>
```

View: add `showFilters` (a "Filters" toggle button), `statusFilter` (`<select data-status>` with the six options), mount `<ColumnTools :columns="grid?.columnsForTools ?? []" @toggle="grid?.toggleColumn($event)" @move="(id, d) => grid?.moveColumn(id, d)" @reset="grid?.resetColumns()" />`, and pass `:show-filters="showFilters" :status-filter="statusFilter"` to the grid. Replace the earlier "Reset to their layout" button with the one inside ColumnTools.

- [ ] **Step 4: Run to verify it passes** — all portal specs green; `vue-tsc` clean.

- [ ] **Step 5: Break it** — remove the `filterFn: 'equals'` on the status column → the status-filter spec fails (substring matching would still pass? "archived" is not a substring of "open", so it may still pass — instead change `statusFilter` watch to never set the filter → the spec fails). Restore.

- [ ] **Step 6: Commit** — skipped.

---

### Task 7: Live check

**Files:** none (a throwaway Playwright script under `fleet-portal/`, deleted after).

- [ ] **Step 1:** With the backend (`tsx watch`, already running on :3001 — verify the new routes answer) and the portal on :5173, log in as `d@fleet.com` / `pass123`, open **Their Board** (the demo org already holds the five fixture loads plus fleet loads).
- [ ] **Step 2:** Screenshot to `C:\Users\Naum\AppData\Local\Temp\claude\e--meeting-copilot-dispatch-control-tower\49306997-fe1d-457c-a465-599d1eeb54cc\scratchpad\board-2a-1.png` after: selecting two brokered loads (both rows of each highlighted, bulk bar visible with "2 loads selected"), sorting by RATE descending (arrow visible), typing "acme" in the search.
- [ ] **Step 3:** Click Delete → screenshot the confirmation naming the LOAD#s (`board-2a-2.png`) → Cancel. Archive the two → the notice reads "2 loads archived" and they vanish; tick "Show archived" → they return greyed; Unarchive them.
- [ ] **Step 4:** Export selected → a `board-YYYY-MM-DD.xlsx` downloads; open it with `readWorkbook` in a `node --import tsx -e` one-liner from `fleet-backend/` and print the header and the first two rows to the report.
- [ ] **Step 5:** Hide RATE via Columns, drag CUSTOMER after DELIVERY, reload the page → both remembered; Reset to their layout → back. Density toggle → rows tighten. Screenshot `board-2a-3.png`.
- [ ] **Step 6:** Report all screenshot paths.

---

## Self-review (done while writing)

- **Spec coverage, §4.4:** selection + bulk bar (T4, T5), sorting incl. bottom-row values and multi-sort (T4), search + per-column + status filters (T4, T6), column hide/reorder/resize/reset persisted (T4, T6), sticky header/first column, density, virtual scroll (T4), archive semantics and delete refusals (T2), export selected (T3, T5), `boardLine` order (T1). Keyboard navigation beyond checkbox/sort buttons (arrows/Space/Enter) is deferred to slice 2B with inline editing, where Enter has a meaning — noted here so it is not lost.
- **Type consistency:** `BoardLoad` gains `status`/`boardLine` in T1 (backend) and T4 (portal types); `renderBoardRows` (T3) takes the route's row shape; store actions (T5) post to T2/T3 routes with the bodies those routes validate; `columnId` (T4) is the id the filter row and ColumnTools use (T6).
- **No placeholders:** every step carries its code; the three "confirm the helper" notes (`Assignment` required fields, `DispatchConflict` relation, `extractApiErrorMessage` shape) tell the implementer to adapt a call, never a test.
