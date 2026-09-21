# Broker Board — Slice 1: schema, `.xlsx` import, their board read-only

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A broker's `.xlsx` board imports into the platform and appears in the portal as their own board — same columns, same two-row loads, same colors — read-only, with an agent pill that is grey or "Attention".

**Architecture:** The board is a view over the existing `Load`/`LoadStop`/`Appointment`/`Carrier` tables plus a few new columns. Three pure libraries do the work (appointment text → windows, header row → layout, workbook → row pairs); one import module writes the database; one router exposes preview/confirm/read; one Vue view renders the layout it is given. Nothing here talks to the agent yet — slice 3 does — but every row it creates is a load the agent can start on.

**Tech Stack:** Express 4 + Prisma 5 + zod + multer (backend, ESM `.js` specifiers); SheetJS (`xlsx` 0.18.5) for the workbook; Vue 3 + Pinia + Tailwind tokens + vitest + @vue/test-utils (portal).

**Spec:** `docs/superpowers/specs/2026-09-07-broker-board-night-shift-design.md` — §4 (layout, behaviour), §5 (data model, parsing), §9.1 (import), §11 (API). This plan implements §13 slice 1.

## Global Constraints

- **No git commits and no `git add`** in this session (user rule). Every "Commit" step is skipped.
- Backend imports use ESM `.js` specifiers; `noUnusedLocals`/`noUnusedParameters` are on in both packages.
- Every dispatcher route is org-scoped: read `req.orgScope`, refuse with 400 when it is null, and use `outsideOrg(req, orgId)` before returning any record (pattern: `routes/dispatcherImport.ts`, `middleware/orgScope.ts`).
- Free text typed by a human is stored verbatim (`updateText`, `apptText`); parsing never rewrites a cell. A cell that cannot be parsed becomes an `AgentUpdate` of kind `attention`, never an import error and never a guess (spec §5.3).
- Money is integer cents. Dates and windows are UTC instants computed from the org's timezone (`Org.timezone`).
- Appointment `type` stays `pickup | delivery` (the platform's existing literal); a window's FCFS-ness is `Appointment.kind` (`appointment | fcfs`) — this refines spec §5.2, which said `type` would gain `FCFS`.
- Test fixtures are anonymized: no real BOL numbers, MC numbers, phone numbers, or company names from the customer's screenshots. Cities, ZIPs, rates, and appointment text keep their real shapes.
- Backend tests run against the test database (`fleet-backend/.env.test`, `npm test` in `fleet-backend/`) and call `resetDb()` from `tests/helpers.ts` in `beforeEach`. Portal specs mock `../lib/api`.
- Prisma migration: `npx prisma migrate dev --name broker_board` from `fleet-backend/`. On this Windows machine the dev backend holds the engine DLL: stop the process listening on `:3001` before `prisma generate`/`migrate`, then restart it (`npm run dev` in `fleet-backend/`, health at `http://[::1]:3001/health`).
- American English in every user-facing string.

---

### Task 1: Schema for a brokered load

**Files:**
- Modify: `fleet-backend/prisma/schema.prisma` (`Load`, `Carrier`, `Org`, `Appointment`; new `AgentUpdate`, `BoardLayout`)
- Create: migration `fleet-backend/prisma/migrations/<ts>_broker_board/migration.sql` (generated)
- Modify: `fleet-backend/tests/helpers.ts` (`resetDb`)
- Test: `fleet-backend/tests/broker-board-schema.test.ts`

**Interfaces:**
- Produces: `Load.{bolNumber, customerName, soldRateCents, trackingUrl, shipDate, updateText, apptText, carrierId, carrierPhone, carrierContactName, driverCell}`; `Carrier.loads`; `Appointment.kind`; `AgentUpdate { id, loadId, atMs: BigInt, kind, text, createdAt }`; `BoardLayout { id, orgId (unique), columns: Json, rowsPerLoad, createdAt, updatedAt }`.

- [ ] **Step 1: Write the failing test**

`fleet-backend/tests/broker-board-schema.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";

// The board is a view over Load; these columns are what a brokered row needs
// that a fleet's load did not. AgentUpdate is the agent's line under UPDATE;
// BoardLayout is what makes the board "theirs".
describe("broker board schema", () => {
  beforeEach(resetDb);

  it("stores a brokered load, its carrier side, an agent line, and the org's layout", async () => {
    const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Chicago" } });
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC", mcNumber: "1000001" } });
    const load = await prisma.load.create({
      data: {
        orgId: org.id, externalId: "145205", orderRef: "2026-34566-00", requiredEquip: "DryVan", revenueCents: 400000,
        bolNumber: "0500001", customerName: "ACME FOODS", soldRateCents: 360000, trackingUrl: "https://example.com/share/abc",
        shipDate: new Date("2026-07-13T00:00:00Z"), updateText: "DELIVERED 07/15/2026", apptText: "PU: 07/13 - 13:00\nDEL: 07/15 - 11:00",
        carrierId: carrier.id, carrierPhone: "(555) 010-0104", carrierContactName: "Contact A",
        stops: { create: [
          { sequence: 1, type: "pickup", address: "Henderson, NV 89074", appointment: { create: { windowStart: new Date("2026-07-13T20:00:00Z"), windowEnd: new Date("2026-07-13T20:00:00Z"), type: "pickup", kind: "appointment" } } },
          { sequence: 2, type: "delivery", address: "Dallas, TX 75236", appointment: { create: { windowStart: new Date("2026-07-15T13:00:00Z"), windowEnd: new Date("2026-07-15T20:00:00Z"), type: "delivery", kind: "fcfs" } } },
        ] },
      },
      include: { stops: { include: { appointment: true } }, carrier: true },
    });
    expect(load.carrier?.mcNumber).toBe("1000001");
    expect(load.stops[1].appointment?.kind).toBe("fcfs");
    expect(load.driverCell).toBeNull();

    const line = await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(1_760_000_000_000), kind: "attention", text: "can't read DEL appointment" } });
    expect(Number(line.atMs)).toBe(1_760_000_000_000);

    const layout = await prisma.boardLayout.create({ data: { orgId: org.id, columns: [{ key: "bol", label: "BOL#" }] } });
    expect(layout.rowsPerLoad).toBe(2);
    await expect(prisma.boardLayout.create({ data: { orgId: org.id, columns: [] } })).rejects.toThrow();
  });

  it("deletes a load's agent lines with the load", async () => {
    const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Chicago" } });
    const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0 } });
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(1), kind: "status", text: "x" } });
    await prisma.load.delete({ where: { id: load.id } });
    expect(await prisma.agentUpdate.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fleet-backend && npx vitest run tests/broker-board-schema.test.ts`
Expected: FAIL — `bolNumber` is not a known field / `prisma.agentUpdate` is undefined.

- [ ] **Step 3: Schema**

In `fleet-backend/prisma/schema.prisma`, inside `model Load { … }`, after `brokerName String?` add:
```prisma
  // Broker Board (spec 2026-09-07-broker-board §5.2): the columns a brokered
  // row carries that a fleet's own load did not. Free text is verbatim; the
  // parsed appointment lives on the stops.
  bolNumber          String?
  customerName       String?
  soldRateCents      Int?
  trackingUrl        String?   // the customer's Samsara/Motive/Linxup share link — human-only, never fetched
  shipDate           DateTime?
  updateText         String?   // the dispatcher's UPDATE cell, verbatim; the agent never writes here
  apptText           String?   // APPT SCHEDULE cell(s), verbatim
  carrierId          String?
  carrier            Carrier?  @relation(fields: [carrierId], references: [id])
  carrierPhone       String?   // as typed, extension and all
  carrierContactName String?
  driverCell         String?   // E.164 when the broker adds a driver phone; else the agent talks to the carrier contact
  agentUpdates       AgentUpdate[]
```
Inside `model Carrier { … }` add `  loads Load[]`. Inside `model Org { … }` add `  boardLayout BoardLayout?`.
Inside `model Appointment { … }` add:
```prisma
  kind        String    @default("appointment") // appointment | fcfs — a window with a start is fcfs when the sheet said so
```
Append at the end of the file:
```prisma
// The agent's line under UPDATE (spec §6.2). One row per line; the newest is
// what the board shows. Kinds: status | eta | delivered | attention | would_say.
model AgentUpdate {
  id        String   @id @default(uuid())
  loadId    String
  load      Load     @relation(fields: [loadId], references: [id], onDelete: Cascade)
  atMs      BigInt
  kind      String
  text      String
  createdAt DateTime @default(now())

  @@index([loadId, atMs])
}

// What makes the board "theirs": the column order and labels of one org's
// sheet, proposed at import and confirmed once (spec §5.4).
model BoardLayout {
  id          String   @id @default(uuid())
  orgId       String   @unique
  org         Org      @relation(fields: [orgId], references: [id])
  columns     Json     // ordered [{ key: BoardColumnKey, label: string }]
  rowsPerLoad Int      @default(2)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

- [ ] **Step 4: Migrate**

Stop the dev backend (`netstat -ano | grep ":3001" | grep LISTENING` → `taskkill //F //PID <pid>`), then:
```
cd fleet-backend && npx prisma migrate dev --name broker_board
```
Expected: a new `…_broker_board` migration applied, client regenerated. Restart the backend afterwards.

- [ ] **Step 5: `resetDb`**

In `fleet-backend/tests/helpers.ts`, in the `$transaction` array, add before `prisma.appointment.deleteMany()`:
```ts
    prisma.agentUpdate.deleteMany(),
```
and before `prisma.org.deleteMany()` (after `prisma.fuelPrice.deleteMany()`):
```ts
    // Broker Board layout: org-scoped, one per org — clear before org.
    prisma.boardLayout.deleteMany(),
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd fleet-backend && npx vitest run tests/broker-board-schema.test.ts && npm test`
Expected: the new test passes; the whole backend suite still green.

- [ ] **Step 7: Commit** — skipped (no-commits rule).

---

### Task 2: Appointment text → windows

**Files:**
- Create: `fleet-backend/src/lib/apptText.ts`
- Test: `fleet-backend/tests/appt-text.test.ts`

**Interfaces:**
- Produces:
  - `interface ApptWindow { startMs: number; endMs: number; kind: "appointment" | "fcfs" }`
  - `parseApptLine(line: string, ctx: { year: number; tz: string }): { role: "PU" | "DEL" | null; window: ApptWindow | null; note: string | null }`
  - `parseApptText(lines: readonly string[], ctx): { pu: ApptWindow | null; del: ApptWindow | null; notes: string[] }` — lines without a `PU:`/`DEL:` prefix take the role by position (first = PU, second = DEL).
  - `zonedToUtcMs(y, m, d, h, mi, tz): number`.

- [ ] **Step 1: Write the failing test**

`fleet-backend/tests/appt-text.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseApptLine, parseApptText, zonedToUtcMs } from "../src/lib/apptText.js";

// Every form seen on the customer's board, and the refusals. The year comes
// from SHIP DATE; the zone is the org's. A cell the parser cannot read is a
// note, never a guess (spec §5.3).
const ctx = { year: 2026, tz: "America/Los_Angeles" };
const la = (m: number, d: number, h: number, mi = 0) => zonedToUtcMs(2026, m, d, h, mi, ctx.tz);

describe("zonedToUtcMs", () => {
  it("turns a wall-clock time in a zone into the instant", () => {
    expect(zonedToUtcMs(2026, 7, 13, 13, 0, "America/Los_Angeles")).toBe(Date.parse("2026-07-13T13:00:00-07:00"));
    expect(zonedToUtcMs(2026, 1, 13, 13, 0, "America/Los_Angeles")).toBe(Date.parse("2026-01-13T13:00:00-08:00"));
    expect(zonedToUtcMs(2026, 7, 13, 13, 0, "Europe/Skopje")).toBe(Date.parse("2026-07-13T13:00:00+02:00"));
  });
});

describe("parseApptLine", () => {
  it("reads a fixed appointment, 24-hour", () => {
    expect(parseApptLine("PU: 07/13 - 13:00", ctx)).toEqual({ role: "PU", window: { startMs: la(7, 13, 13), endMs: la(7, 13, 13), kind: "appointment" }, note: null });
    expect(parseApptLine("DEL: 07/15 - 11:00", ctx)).toEqual({ role: "DEL", window: { startMs: la(7, 15, 11), endMs: la(7, 15, 11), kind: "appointment" }, note: null });
  });

  it("reads am/pm and a one-digit month", () => {
    expect(parseApptLine("PU: 07/14 - 11:00am", ctx).window).toEqual({ startMs: la(7, 14, 11), endMs: la(7, 14, 11), kind: "appointment" });
    expect(parseApptLine("DEL: 7/17 - 10:00am", ctx).window).toEqual({ startMs: la(7, 17, 10), endMs: la(7, 17, 10), kind: "appointment" });
    expect(parseApptLine("DEL: 07/17 - 12:00pm", ctx).window).toEqual({ startMs: la(7, 17, 12), endMs: la(7, 17, 12), kind: "appointment" });
    expect(parseApptLine("PU: 07/14 - 12:00am", ctx).window?.startMs).toBe(la(7, 14, 0));
  });

  it("reads first-come-first-served windows in every spelling on the board", () => {
    expect(parseApptLine("PU: 07/14 - 07-15 FCFS", ctx).window).toEqual({ startMs: la(7, 14, 7), endMs: la(7, 14, 15), kind: "fcfs" });
    expect(parseApptLine("DEL: 07/17 - 08 - 14 FCFS", ctx).window).toEqual({ startMs: la(7, 17, 8), endMs: la(7, 17, 14), kind: "fcfs" });
    expect(parseApptLine("DEL: 07/16 - 08-15:00 fcfs", ctx).window).toEqual({ startMs: la(7, 16, 8), endMs: la(7, 16, 15), kind: "fcfs" });
    expect(parseApptLine("PU: 07/14 - 7am-3pm", ctx).window).toEqual({ startMs: la(7, 14, 7), endMs: la(7, 14, 15), kind: "fcfs" });
  });

  it("keeps a trailing word as a note and still reads the time", () => {
    const r = parseApptLine("PU: 07/14 - 13:00 working", ctx);
    expect(r.window?.startMs).toBe(la(7, 14, 13));
    expect(r.note).toBe('ignored "working"');
  });

  it("takes an explicit year when the cell has one", () => {
    expect(parseApptLine("DEL: 07/15/2027 - 11:00", ctx).window?.startMs).toBe(zonedToUtcMs(2027, 7, 15, 11, 0, ctx.tz));
  });

  it("refuses what it cannot read, and says why", () => {
    expect(parseApptLine("asap", ctx)).toEqual({ role: null, window: null, note: 'no date in "asap"' });
    expect(parseApptLine("DEL: 07/17", ctx)).toEqual({ role: "DEL", window: null, note: 'no time in "DEL: 07/17"' });
    expect(parseApptLine("PU: 07/14 - 25:00", ctx).window).toBeNull();
    expect(parseApptLine("PU: 07/14 - 15-07 FCFS", ctx).note).toMatch(/ends before it starts/);
    expect(parseApptLine("PU: 13/40 - 10:00", ctx).window).toBeNull();
    expect(parseApptLine("", ctx)).toEqual({ role: null, window: null, note: "empty" });
  });
});

describe("parseApptText", () => {
  it("assigns roles by prefix, or by position when the prefix is missing", () => {
    const a = parseApptText(["PU: 07/13 - 13:00", "DEL: 07/15 - 11:00"], ctx);
    expect(a.pu?.startMs).toBe(la(7, 13, 13));
    expect(a.del?.endMs).toBe(la(7, 15, 11));
    expect(a.notes).toEqual([]);
    const b = parseApptText(["07/13 - 13:00", "07/15 - 08-15 FCFS"], ctx);
    expect(b.pu?.startMs).toBe(la(7, 13, 13));
    expect(b.del?.kind).toBe("fcfs");
  });

  it("reports a missing or unreadable side without inventing it", () => {
    const a = parseApptText(["PU: 07/13 - 13:00", "DEL: tbd"], ctx);
    expect(a.pu).not.toBeNull();
    expect(a.del).toBeNull();
    expect(a.notes).toEqual(['DEL: no date in "DEL: tbd"']);
    const b = parseApptText(["PU: 07/13 - 13:00"], ctx);
    expect(b.del).toBeNull();
    expect(b.notes).toEqual(["DEL: missing"]);
  });

  it("refuses a delivery that ends before the pickup starts", () => {
    const a = parseApptText(["PU: 07/15 - 13:00", "DEL: 07/13 - 11:00"], ctx);
    expect(a.del).toBeNull();
    expect(a.notes).toEqual(["DEL: before pickup"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fleet-backend && npx vitest run tests/appt-text.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`fleet-backend/src/lib/apptText.ts`:
```ts
// APPT SCHEDULE cells are free text typed by a dispatcher: "PU: 07/14 -
// 12:00pm", "07-15 FCFS", "08-15:00 fcfs". This reads the forms seen on real
// boards into UTC windows in the org's zone, and refuses — with a reason —
// anything it cannot read. Nothing here rewrites the cell (spec §5.3).

export interface ApptWindow {
  startMs: number;
  endMs: number;
  kind: "appointment" | "fcfs";
}

export interface ApptCtx {
  /** The year the cells belong to — SHIP DATE's year. */
  year: number;
  /** IANA zone the times are written in — the org's. */
  tz: string;
}

export interface ApptLineResult {
  role: "PU" | "DEL" | null;
  window: ApptWindow | null;
  note: string | null;
}

/** Offset of `tz` from UTC at the instant `atMs`, in ms. */
function tzOffsetMs(atMs: number, tz: string): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(atMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(atMs / 1000) * 1000;
}

/** A wall-clock time in `tz` → the UTC instant. Two passes so a DST edge lands right. */
export function zonedToUtcMs(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

const ROLE_RE = /^\s*(PU|DEL)\s*:\s*/i;
const DATE_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*/;
// "13:00", "11:00am", "7am", "07"
const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`;
const RANGE_RE = new RegExp(String.raw`^${TIME}\s*-\s*${TIME}\s*(fcfs)?\s*`, "i");
const SINGLE_RE = new RegExp(String.raw`^${TIME}\s*(fcfs)?\s*`, "i");

function toHour(h: string, ampm: string | undefined): number | null {
  let hour = Number(h);
  if (!Number.isInteger(hour) || hour < 0 || hour > 24) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm.toLowerCase() === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  }
  return hour > 23 ? null : hour;
}

function toMinute(mi: string | undefined): number | null {
  if (mi === undefined) return 0;
  const n = Number(mi);
  return Number.isInteger(n) && n >= 0 && n < 60 ? n : null;
}

function fullYear(y: string | undefined, fallback: number): number {
  if (y === undefined) return fallback;
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

export function parseApptLine(raw: string, ctx: ApptCtx): ApptLineResult {
  const trimmed = raw.trim();
  if (!trimmed) return { role: null, window: null, note: "empty" };
  const roleMatch = trimmed.match(ROLE_RE);
  const role = roleMatch ? (roleMatch[1].toUpperCase() as "PU" | "DEL") : null;
  let rest = roleMatch ? trimmed.slice(roleMatch[0].length) : trimmed;

  const date = rest.match(DATE_RE);
  if (!date) return { role, window: null, note: `no date in "${trimmed}"` };
  const month = Number(date[1]), day = Number(date[2]), year = fullYear(date[3], ctx.year);
  if (month < 1 || month > 12 || day < 1 || day > 31) return { role, window: null, note: `bad date in "${trimmed}"` };
  rest = rest.slice(date[0].length).replace(/^-\s*/, "");
  if (!rest) return { role, window: null, note: `no time in "${trimmed}"` };

  let startH: number | null, startM: number | null, endH: number | null, endM: number | null, kind: ApptWindow["kind"], consumed: string;
  const range = rest.match(RANGE_RE);
  if (range) {
    // A range with one am/pm at the end applies it to both sides ("7-3pm" is rare; "7am-3pm" is common).
    const ampmStart = range[3] ?? undefined, ampmEnd = range[6] ?? undefined;
    startH = toHour(range[1], ampmStart ?? (ampmEnd && Number(range[1]) <= 12 && Number(range[1]) > Number(range[4]) ? "am" : undefined));
    startM = toMinute(range[2]);
    endH = toHour(range[4], ampmEnd);
    endM = toMinute(range[5]);
    kind = "fcfs";
    consumed = range[0];
  } else {
    const single = rest.match(SINGLE_RE);
    if (!single) return { role, window: null, note: `no time in "${trimmed}"` };
    startH = endH = toHour(single[1], single[3] ?? undefined);
    startM = endM = toMinute(single[2]);
    kind = single[4] ? "fcfs" : "appointment";
    consumed = single[0];
  }
  if (startH === null || startM === null || endH === null || endM === null) return { role, window: null, note: `bad time in "${trimmed}"` };

  const startMs = zonedToUtcMs(year, month, day, startH, startM, ctx.tz);
  const endMs = zonedToUtcMs(year, month, day, endH, endM, ctx.tz);
  if (endMs < startMs) return { role, window: null, note: `window ends before it starts in "${trimmed}"` };
  const leftover = rest.slice(consumed.length).trim();
  return { role, window: { startMs, endMs, kind }, note: leftover ? `ignored "${leftover}"` : null };
}

export function parseApptText(lines: readonly string[], ctx: ApptCtx): { pu: ApptWindow | null; del: ApptWindow | null; notes: string[] } {
  const parsed = lines.map((l) => parseApptLine(l, ctx));
  const byRole = (role: "PU" | "DEL", position: number): ApptLineResult | undefined =>
    parsed.find((p) => p.role === role) ?? parsed.filter((p) => p.role === null)[position];
  const pu = byRole("PU", 0);
  const del = byRole("DEL", 1);
  const notes: string[] = [];
  const noteFor = (label: "PU" | "DEL", r: ApptLineResult | undefined): void => {
    if (!r) { notes.push(`${label}: missing`); return; }
    if (!r.window && r.note) notes.push(`${label}: ${r.note}`);
    else if (r.note) notes.push(`${label}: ${r.note}`);
  };
  noteFor("PU", pu);
  noteFor("DEL", del);
  let delWindow = del?.window ?? null;
  if (pu?.window && delWindow && delWindow.endMs < pu.window.startMs) { delWindow = null; notes.push("DEL: before pickup"); }
  return { pu: pu?.window ?? null, del: delWindow, notes };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd fleet-backend && npx vitest run tests/appt-text.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Break it**

Change `if (endMs < startMs)` to `if (endMs <= startMs)` → the fixed-appointment tests fail (start equals end). Restore. Change `kind = "fcfs"` in the range branch to `"appointment"` → the FCFS tests fail. Restore.

- [ ] **Step 6: Commit** — skipped.

---

### Task 3: Header row → the org's layout

**Files:**
- Create: `fleet-backend/src/lib/boardLayout.ts`
- Test: `fleet-backend/tests/board-layout.test.ts`

**Interfaces:**
- Produces:
  - `type BoardColumnKey = "bol" | "customer" | "phone" | "contact" | "pickupCity" | "puZip" | "delZip" | "deliveryCity" | "rate" | "soldRate" | "profit" | "mc" | "loadNo" | "shipDate" | "update" | "appt" | "agent" | "driverCell" | "extra"`
  - `interface BoardColumn { key: BoardColumnKey; label: string; source?: string }` — `source` is the sheet's header for `extra` columns.
  - `DEFAULT_BROKER_LAYOUT: BoardColumn[]` (the customer's 16 columns + `agent`).
  - `normalizeHeader(s): string`; `proposeLayout(headerRow: string[]): { columns: BoardColumn[]; unmatched: string[]; missing: BoardColumnKey[] }`.
  - `layoutFor(orgId): Promise<BoardColumn[]>` — the org's `BoardLayout.columns`, else the default; `saveLayout(orgId, columns)`.

- [ ] **Step 1: Write the failing test**

`fleet-backend/tests/board-layout.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { DEFAULT_BROKER_LAYOUT, layoutFor, normalizeHeader, proposeLayout, saveLayout } from "../src/lib/boardLayout.js";
import { resetDb } from "./helpers.js";

// The customer's header row, exactly as typed, stars and all.
const THEIR_HEADER = ["BOL#", "CUSTOMER /CARRIER", "TELEPHONE#", "CONTACT NAME", "PICK UP", "PU ZIP", "DEL ZIP", "DELIVERY", "RATE", "SOLD RATE", "PROFIT", "M.C. #", "LOAD#", "SHIP DATE", "****UPDATE****", "APPT SCHEDULE"];

describe("normalizeHeader", () => {
  it("strips decoration so 'their' spelling matches ours", () => {
    expect(normalizeHeader("****UPDATE****")).toBe("update");
    expect(normalizeHeader("M.C. #")).toBe("mc");
    expect(normalizeHeader("CUSTOMER /CARRIER")).toBe("customer carrier");
    expect(normalizeHeader("  BOL# ")).toBe("bol");
  });
});

describe("proposeLayout", () => {
  it("maps every one of the customer's columns, in their order, and appends the agent pill", () => {
    const { columns, unmatched, missing } = proposeLayout(THEIR_HEADER);
    expect(columns.map((c) => c.key)).toEqual(["bol", "customer", "phone", "contact", "pickupCity", "puZip", "delZip", "deliveryCity", "rate", "soldRate", "profit", "mc", "loadNo", "shipDate", "update", "appt", "agent"]);
    expect(columns.map((c) => c.label).slice(0, 16)).toEqual(THEIR_HEADER);
    expect(unmatched).toEqual([]);
    expect(missing).toEqual([]);
  });

  it("keeps a column it does not know as extra text, and names what a board is missing", () => {
    const { columns, unmatched, missing } = proposeLayout(["BOL#", "CUSTOMER", "NOTES", "PICK UP", "DELIVERY", "RATE"]);
    expect(columns.find((c) => c.key === "extra")).toEqual({ key: "extra", label: "NOTES", source: "NOTES" });
    expect(unmatched).toEqual(["NOTES"]);
    expect(missing).toContain("loadNo");
    expect(missing).toContain("appt");
  });

  it("recognizes common alternative spellings", () => {
    const { columns } = proposeLayout(["BOL", "Customer/Carrier", "Phone", "Contact", "Origin", "Origin Zip", "Dest Zip", "Destination", "Rate", "Carrier Rate", "Margin", "MC#", "Load #", "Ship Date", "Update", "Appointments"]);
    expect(columns.map((c) => c.key)).toEqual(["bol", "customer", "phone", "contact", "pickupCity", "puZip", "delZip", "deliveryCity", "rate", "soldRate", "profit", "mc", "loadNo", "shipDate", "update", "appt", "agent"]);
  });
});

describe("layoutFor / saveLayout", () => {
  beforeEach(resetDb);
  it("falls back to the default layout and returns what was saved afterwards", async () => {
    const org = await prisma.org.create({ data: { name: "B", timezone: "America/Chicago" } });
    expect(await layoutFor(org.id)).toEqual(DEFAULT_BROKER_LAYOUT);
    const theirs = proposeLayout(THEIR_HEADER).columns;
    await saveLayout(org.id, theirs);
    expect(await layoutFor(org.id)).toEqual(theirs);
    await saveLayout(org.id, theirs.slice(0, 3));
    expect((await layoutFor(org.id)).length).toBe(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fleet-backend && npx vitest run tests/board-layout.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement**

`fleet-backend/src/lib/boardLayout.ts`:
```ts
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

// The board is "theirs" because the layout is data: the column order and the
// labels of one org's sheet (spec §5.4). Import proposes it from the header
// row; the dispatcher confirms once; every board read carries it.

export type BoardColumnKey =
  | "bol" | "customer" | "phone" | "contact" | "pickupCity" | "puZip" | "delZip" | "deliveryCity"
  | "rate" | "soldRate" | "profit" | "mc" | "loadNo" | "shipDate" | "update" | "appt"
  | "agent" | "driverCell" | "extra";

export interface BoardColumn {
  key: BoardColumnKey;
  label: string;
  /** For `extra`: the sheet's own header, so export can put it back. */
  source?: string;
}

/** The customer's board, verbatim, plus the agent pill (spec §4.1). */
export const DEFAULT_BROKER_LAYOUT: BoardColumn[] = [
  { key: "bol", label: "BOL#" }, { key: "customer", label: "CUSTOMER /CARRIER" }, { key: "phone", label: "TELEPHONE#" },
  { key: "contact", label: "CONTACT NAME" }, { key: "pickupCity", label: "PICK UP" }, { key: "puZip", label: "PU ZIP" },
  { key: "delZip", label: "DEL ZIP" }, { key: "deliveryCity", label: "DELIVERY" }, { key: "rate", label: "RATE" },
  { key: "soldRate", label: "SOLD RATE" }, { key: "profit", label: "PROFIT" }, { key: "mc", label: "M.C. #" },
  { key: "loadNo", label: "LOAD#" }, { key: "shipDate", label: "SHIP DATE" }, { key: "update", label: "****UPDATE****" },
  { key: "appt", label: "APPT SCHEDULE" }, { key: "agent", label: "AGENT" },
];

/** Normalized header → key. Order inside a list does not matter; a header
 *  matches when its normalized form equals an alias exactly. */
const ALIASES: Record<Exclude<BoardColumnKey, "agent" | "driverCell" | "extra">, string[]> = {
  bol: ["bol", "bol number", "bol no"],
  customer: ["customer carrier", "customer", "customer name", "shipper", "customer / carrier"],
  phone: ["telephone", "phone", "tel", "phone number", "telephone number"],
  contact: ["contact name", "contact", "carrier contact"],
  pickupCity: ["pick up", "pickup", "origin", "pu", "pu city", "pickup city", "from"],
  puZip: ["pu zip", "pickup zip", "origin zip", "from zip"],
  delZip: ["del zip", "delivery zip", "dest zip", "destination zip", "to zip"],
  deliveryCity: ["delivery", "destination", "dest", "del", "del city", "delivery city", "to"],
  rate: ["rate", "customer rate", "bill rate", "revenue"],
  soldRate: ["sold rate", "carrier rate", "sold", "cost", "carrier pay"],
  profit: ["profit", "margin", "gross"],
  mc: ["mc", "m c", "mc number", "mc no", "carrier mc"],
  loadNo: ["load", "load no", "load number", "load id", "ref", "reference"],
  shipDate: ["ship date", "pickup date", "pu date", "date", "ship"],
  update: ["update", "updates", "status", "notes status"],
  appt: ["appt schedule", "appt", "appointment", "appointments", "appt time", "schedule"],
};

export function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[#*().:'"_-]+/g, " ").replace(/\//g, " ").replace(/\s+/g, " ").trim();
}

const REQUIRED: BoardColumnKey[] = ["bol", "customer", "pickupCity", "deliveryCity", "rate", "loadNo", "appt"];

export function proposeLayout(headerRow: string[]): { columns: BoardColumn[]; unmatched: string[]; missing: BoardColumnKey[] } {
  const taken = new Set<BoardColumnKey>();
  const columns: BoardColumn[] = [];
  const unmatched: string[] = [];
  for (const raw of headerRow) {
    const label = raw.trim();
    if (!label) continue;
    const norm = normalizeHeader(label);
    const hit = (Object.keys(ALIASES) as Array<keyof typeof ALIASES>).find((k) => !taken.has(k) && ALIASES[k].includes(norm));
    if (hit) { taken.add(hit); columns.push({ key: hit, label }); }
    else { unmatched.push(label); columns.push({ key: "extra", label, source: label }); }
  }
  columns.push({ key: "agent", label: "AGENT" });
  const missing = REQUIRED.filter((k) => !taken.has(k));
  return { columns, unmatched, missing };
}

export async function layoutFor(orgId: string): Promise<BoardColumn[]> {
  const row = await prisma.boardLayout.findUnique({ where: { orgId } });
  return row ? (row.columns as unknown as BoardColumn[]) : DEFAULT_BROKER_LAYOUT;
}

export async function saveLayout(orgId: string, columns: BoardColumn[]): Promise<void> {
  const json = columns as unknown as Prisma.InputJsonValue;
  await prisma.boardLayout.upsert({ where: { orgId }, create: { orgId, columns: json }, update: { columns: json } });
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/board-layout.test.ts` → PASS.

- [ ] **Step 5: Break it** — remove `"update"` from `ALIASES.update` → the first proposeLayout test fails on `****UPDATE****`. Restore.

- [ ] **Step 6: Commit** — skipped.

---

### Task 4: Workbook → row pairs

**Files:**
- Create: `fleet-backend/src/lib/brokerSheet.ts`
- Test: `fleet-backend/tests/broker-sheet.test.ts`, `fleet-backend/tests/fixtures/brokerBoard.ts`
- Modify: `fleet-backend/package.json` (dependency `xlsx`)

**Interfaces:**
- Consumes: `BoardColumn`, `normalizeHeader`, `proposeLayout` (Task 3).
- Produces:
  - `readWorkbook(buf: Buffer): { header: string[]; headerLine: number; rows: Array<{ line: number; cells: string[] }> }` — first sheet, header row detected, dates rendered `YYYY-MM-DD`, numbers rendered as typed, everything else trimmed text.
  - `type CellsByKey = Partial<Record<BoardColumnKey, string>>`
  - `interface RawLoadPair { line: number; top: CellsByKey; bottom: CellsByKey | null; extras: Record<string, string> }`
  - `pairRows(rows, columns): { pairs: RawLoadPair[]; notes: string[] }`
  - `parseMoney(s: string): number | null` (cents), `looksLikeUrl(s): boolean`, `parseSheetDate(s: string): Date | null`.
  - The fixture `BROKER_ROWS: string[][]` (header + anonymized rows) and `brokerWorkbook(rows = BROKER_ROWS): Buffer`.

- [ ] **Step 1: Install SheetJS**

Run: `cd fleet-backend && npm i xlsx@0.18.5` (the last version published to npm; no other source).

- [ ] **Step 2: Write the fixture and the failing test**

`fleet-backend/tests/fixtures/brokerBoard.ts` — the customer's layout with invented identities; cities, ZIPs, rates and appointment text keep their real shapes:
```ts
import * as XLSX from "xlsx";

export const THEIR_HEADER = ["BOL#", "CUSTOMER /CARRIER", "TELEPHONE#", "CONTACT NAME", "PICK UP", "PU ZIP", "DEL ZIP", "DELIVERY", "RATE", "SOLD RATE", "PROFIT", "M.C. #", "LOAD#", "SHIP DATE", "****UPDATE****", "APPT SCHEDULE"];

// Two rows per load, a blank row between loads — exactly their file.
export const BROKER_ROWS: string[][] = [
  ["Dispatch board", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],     // a title row above the header, as sheets often have
  THEIR_HEADER,
  ["0500001", "ACME FOODS", "https://cloud.example.com/o/6006533/fleet/viewer/PGQx", "", "Henderson, NV", "89074", "75236", "Dallas, TX", "$4,000.00", "$3,600.00", "$400.00", "MC", "2026-34566-00", "7/13/2026", "DELIVERED 07/15/2026", "PU: 07/13 - 13:00"],
  ["", "BLUE ROAD LLC", "(555) 010-0104", "Contact A", "", "", "", "", "", "", "", "1000001", "145205", "", "", "DEL: 07/15 - 11:00"],
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
  ["0500002", "ACME FOODS", "https://share.example.com/en-US/#/share/v/a8aa", "", "Henderson, NV", "89074", "61104", "Rockford, IL", "$4,900.00", "$4,500.00", "$400.00", "MC", "2026-35082-00", "7/14/2026", "DELIVERED 07/17/2026", "PU: 07/14 - 11:00am"],
  ["", "FAST LANE INC", "(555) 010-1010", "Contact B", "", "", "", "", "", "", "", "1000002", "145219", "", "", "DEL: 7/17 - 10:00am"],
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
  ["0500003", "ACME FOODS", "https://share.example.com/en-US/#/share/v/ab3f", "", "Rockford, IL", "61109", "92154", "San Diego, CA", "$4,600.00", "$4,350.00", "$250.00", "MC", "RBMT61145", "7/14/2026", "DELIVERED 07/16/2026", "PU: 07/14 - 07-15 FCFS"],
  ["", "GLOBE FREIGHT", "(555) 010-8528", "Contact C", "", "", "", "", "", "", "", "1000003", "145197", "", "", "DEL: 07/17 - 08 - 14 FCFS"],
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
  ["0500004", "ACME FOODS", "https://track.example.com/followme?uuid=788d", "", "Neenah, WI", "54956", "14220", "Buffalo, NY", "$2,890.00", "$2,600.00", "$290.00", "MC", "931599400", "7/14/2026", "DELIVERED 07/16/2026", "PU: 07/14 - 13:00 working"],
  ["", "NORTHSTAR HAULING", "(555) 010-2858", "Contact D", "", "", "", "", "", "", "", "1000004", "145963", "", "", "DEL: 07/16 - 08-15:00 fcfs"],
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
  // An unassigned load: top row only, no carrier yet, appointment not decided.
  ["0500005", "ACME FOODS", "", "", "Henderson, NV", "89074", "80216", "Denver, CO", "$3,100.00", "", "", "MC", "2026-35100-00", "7/15/2026", "", "PU: 07/15 - tbd"],
];

export function brokerWorkbook(rows: string[][] = BROKER_ROWS): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Board");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
```

`fleet-backend/tests/broker-sheet.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { proposeLayout } from "../src/lib/boardLayout.js";
import { looksLikeUrl, pairRows, parseMoney, parseSheetDate, readWorkbook } from "../src/lib/brokerSheet.js";
import { BROKER_ROWS, THEIR_HEADER, brokerWorkbook } from "./fixtures/brokerBoard.js";

describe("readWorkbook", () => {
  it("finds the header row under a title row and renders every cell as text", () => {
    const wb = readWorkbook(brokerWorkbook());
    expect(wb.header).toEqual(THEIR_HEADER);
    expect(wb.headerLine).toBe(2);
    expect(wb.rows[0].line).toBe(3);
    expect(wb.rows[0].cells[0]).toBe("0500001");
    expect(wb.rows[0].cells[8]).toBe("$4,000.00");
  });

  it("renders a real Excel date cell as YYYY-MM-DD", () => {
    const rows = BROKER_ROWS.map((r) => [...r]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.sheet_add_aoa(ws, [[new Date(Date.UTC(2026, 6, 13))]], { origin: "N3" });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Board");
    const out = readWorkbook(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
    expect(out.rows[0].cells[13]).toBe("2026-07-13");
  });

  it("refuses a workbook with no recognizable header", () => {
    expect(() => readWorkbook(brokerWorkbook([["a", "b"], ["1", "2"]]))).toThrow(/header row/);
  });
});

describe("pairRows", () => {
  const { columns } = proposeLayout(THEIR_HEADER);
  it("pairs a customer row with the carrier row under it, skipping blanks", () => {
    const { pairs, notes } = pairRows(readWorkbook(brokerWorkbook()).rows, columns);
    expect(pairs).toHaveLength(5);
    expect(pairs[0].line).toBe(3);
    expect(pairs[0].top.bol).toBe("0500001");
    expect(pairs[0].top.phone).toMatch(/^https:/);
    expect(pairs[0].top.loadNo).toBe("2026-34566-00");
    expect(pairs[0].top.appt).toBe("PU: 07/13 - 13:00");
    expect(pairs[0].bottom?.customer).toBe("BLUE ROAD LLC");
    expect(pairs[0].bottom?.phone).toBe("(555) 010-0104");
    expect(pairs[0].bottom?.contact).toBe("Contact A");
    expect(pairs[0].bottom?.mc).toBe("1000001");
    expect(pairs[0].bottom?.loadNo).toBe("145205");
    expect(pairs[0].bottom?.appt).toBe("DEL: 07/15 - 11:00");
    expect(notes).toEqual([]);
  });

  it("keeps a top row with no carrier as an unassigned load", () => {
    const { pairs } = pairRows(readWorkbook(brokerWorkbook()).rows, columns);
    expect(pairs[4].bottom).toBeNull();
    expect(pairs[4].top.loadNo).toBe("2026-35100-00");
  });

  it("notes a carrier row that has no customer row above it", () => {
    const rows = [THEIR_HEADER, ["", "LONELY CARRIER", "(555) 1", "X", "", "", "", "", "", "", "", "1", "9", "", "", ""]];
    const { pairs, notes } = pairRows(readWorkbook(brokerWorkbook(rows)).rows, columns);
    expect(pairs).toEqual([]);
    expect(notes).toEqual(["line 2: carrier row with no load above it"]);
  });

  it("keeps unknown columns as extras keyed by their header", () => {
    const header = [...THEIR_HEADER, "NOTES"];
    const rows = [header, [...BROKER_ROWS[2], "call before delivery"], [...BROKER_ROWS[3], ""]];
    const { pairs } = pairRows(readWorkbook(brokerWorkbook(rows)).rows, proposeLayout(header).columns);
    expect(pairs[0].extras).toEqual({ NOTES: "call before delivery" });
  });
});

describe("cell parsers", () => {
  it("reads money as cents", () => {
    expect(parseMoney("$4,000.00")).toBe(400000);
    expect(parseMoney("4000")).toBe(400000);
    expect(parseMoney("$3,600.5")).toBe(360050);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("tbd")).toBeNull();
  });
  it("tells a share link from a phone number", () => {
    expect(looksLikeUrl("https://cloud.example.com/o/1/fleet/viewer/x")).toBe(true);
    expect(looksLikeUrl("share.example.com/en-US/#/share/v/a8aa")).toBe(true);
    expect(looksLikeUrl("(555) 010-0104")).toBe(false);
  });
  it("reads a sheet date in either form", () => {
    expect(parseSheetDate("7/13/2026")?.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(parseSheetDate("2026-07-13")?.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(parseSheetDate("")).toBeNull();
    expect(parseSheetDate("soon")).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails** — `npx vitest run tests/broker-sheet.test.ts` → FAIL, module not found.

- [ ] **Step 4: Implement**

`fleet-backend/src/lib/brokerSheet.ts`:
```ts
import * as XLSX from "xlsx";
import { normalizeHeader, type BoardColumn, type BoardColumnKey } from "./boardLayout.js";

// A broker's board as it comes off the disk: one sheet, a header row
// somewhere near the top, two rows per load with blank rows between. This
// turns it into row pairs keyed by our column keys and leaves every cell as
// the text the dispatcher typed. Parsing of money, dates and appointments is
// separate and never rewrites a cell.

export interface SheetRow { line: number; cells: string[] }
export type CellsByKey = Partial<Record<BoardColumnKey, string>>;
export interface RawLoadPair {
  /** 1-based line of the customer row in the sheet. */
  line: number;
  top: CellsByKey;
  bottom: CellsByKey | null;
  /** Columns we do not know, keyed by the sheet's own header. */
  extras: Record<string, string>;
}

const HEADER_HINTS = ["bol", "customer", "pick up", "pickup", "delivery", "rate", "load"];

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

export function readWorkbook(buf: Buffer): { header: string[]; headerLine: number; rows: SheetRow[] } {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const first = wb.SheetNames[0];
  if (!first) throw new Error("the workbook has no sheets");
  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[first], { header: 1, raw: true, defval: "" });
  const lines = grid.map((r) => (r as unknown[]).map(cellText));
  const headerIdx = lines.findIndex((r) => {
    const norms = r.map(normalizeHeader);
    return HEADER_HINTS.filter((h) => norms.some((n) => n === h || n.startsWith(h + " ") || n.includes(" " + h))).length >= 3;
  });
  if (headerIdx < 0) throw new Error("no header row found — expected BOL#, CUSTOMER, PICK UP, DELIVERY, RATE, LOAD# in one row near the top");
  const header = lines[headerIdx].map((h) => h.trim());
  const width = header.length;
  const rows: SheetRow[] = lines.slice(headerIdx + 1).map((cells, i) => ({
    line: headerIdx + 2 + i,
    cells: Array.from({ length: width }, (_, c) => cells[c] ?? ""),
  }));
  return { header, headerLine: headerIdx + 1, rows };
}

const isBlank = (r: SheetRow): boolean => r.cells.every((c) => c === "");

function byKey(cells: string[], columns: BoardColumn[]): { known: CellsByKey; extras: Record<string, string> } {
  const known: CellsByKey = {};
  const extras: Record<string, string> = {};
  columns.forEach((col, i) => {
    const v = cells[i] ?? "";
    if (col.key === "agent") return;
    if (col.key === "extra") { if (v) extras[col.source ?? col.label] = v; return; }
    known[col.key] = v;
  });
  return { known, extras };
}

export function pairRows(rows: SheetRow[], columns: BoardColumn[]): { pairs: RawLoadPair[]; notes: string[] } {
  const pairs: RawLoadPair[] = [];
  const notes: string[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (isBlank(row)) { i += 1; continue; }
    const { known, extras } = byKey(row.cells, columns);
    const isTop = Boolean(known.bol) || Boolean(known.pickupCity) || Boolean(known.rate);
    if (!isTop) { notes.push(`line ${row.line}: carrier row with no load above it`); i += 1; continue; }
    let bottom: CellsByKey | null = null;
    const next = rows[i + 1];
    if (next && !isBlank(next)) {
      const nb = byKey(next.cells, columns);
      const nextIsTop = Boolean(nb.known.bol) || Boolean(nb.known.pickupCity) || Boolean(nb.known.rate);
      if (!nextIsTop) { bottom = nb.known; Object.assign(extras, nb.extras); i += 1; }
    }
    pairs.push({ line: row.line, top: known, bottom, extras });
    i += 1;
  }
  return { pairs, notes };
}

export function parseMoney(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, "");
  if (!cleaned || !/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export function looksLikeUrl(s: string): boolean {
  return /^(https?:\/\/|[a-z0-9.-]+\.[a-z]{2,}\/)/i.test(s.trim());
}

export function parseSheetDate(s: string): Date | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return new Date(Date.UTC(y, Number(m[1]) - 1, Number(m[2]))); }
  return null;
}
```

- [ ] **Step 5: Run to verify it passes** — `npx vitest run tests/broker-sheet.test.ts` → PASS.

- [ ] **Step 6: Break it** — in `pairRows`, drop the `!nextIsTop` check (always take the next row as the bottom) → "keeps a top row with no carrier" passes wrongly? No: the unassigned load is last, so instead change the fixture's expectation. Real proof: make `isTop` require `known.bol` only → the "carrier row with no load above it" test still passes but a top row typed without a BOL would be lost; the first pairing test's `pairs.length` is unchanged. Use this instead: change `isBlank` to check only `cells[0]` → the blank-row skipping still works but a carrier row (blank BOL) is now "blank" and `pairs[0].bottom` becomes null → the first pairing test fails. Restore.

- [ ] **Step 7: Commit** — skipped.

---

### Task 5: Import — preview and confirm

**Files:**
- Create: `fleet-backend/src/lib/brokerImport.ts`
- Test: `fleet-backend/tests/broker-import.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4; `geocodeAddress` from `lib/geocode.ts`; `prisma`.
- Produces:
  - `interface PreviewLoad { line: number; loadNo: string | null; orderRef: string | null; bol: string | null; customer: string | null; carrier: string | null; mc: string | null; carrierPhone: string | null; contact: string | null; pickup: string; puZip: string | null; delivery: string; delZip: string | null; rateCents: number | null; soldRateCents: number | null; profitCents: number | null; shipDate: string | null; update: string | null; trackingUrl: string | null; appt: { pu: ApptWindow | null; del: ApptWindow | null }; notes: string[] }`
  - `buildPreview(orgId, buf): Promise<{ layout: BoardColumn[]; unmatched: string[]; missing: BoardColumnKey[]; loads: PreviewLoad[]; notes: string[] }>` — pure given the sheet + the org's timezone; no writes.
  - `confirmImport(orgId, buf): Promise<{ batchId: string; created: number; updated: number; attention: number; notes: string[] }>` — writes loads, stops, appointments, carriers, agent lines, the layout, and an `ImportBatch`.

- [ ] **Step 1: Write the failing test**

`fleet-backend/tests/broker-import.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { buildPreview, confirmImport } from "../src/lib/brokerImport.js";
import { BROKER_ROWS, brokerWorkbook } from "./fixtures/brokerBoard.js";
import { resetDb } from "./helpers.js";

async function org() { return prisma.org.create({ data: { name: "Test Broker", timezone: "America/Los_Angeles" } }); }

describe("buildPreview", () => {
  beforeEach(resetDb);

  it("shows every load as the dispatcher will see it, with parsed money, dates and windows", async () => {
    const o = await org();
    const p = await buildPreview(o.id, brokerWorkbook());
    expect(p.layout.map((c) => c.key)).toContain("appt");
    expect(p.loads).toHaveLength(5);
    const first = p.loads[0];
    expect(first).toMatchObject({ loadNo: "145205", orderRef: "2026-34566-00", bol: "0500001", customer: "ACME FOODS", carrier: "BLUE ROAD LLC", mc: "1000001", contact: "Contact A", pickup: "Henderson, NV", puZip: "89074", delivery: "Dallas, TX", delZip: "75236", rateCents: 400000, soldRateCents: 360000, profitCents: 40000, shipDate: "2026-07-13", update: "DELIVERED 07/15/2026" });
    expect(first.trackingUrl).toMatch(/^https:/);
    expect(first.appt.pu?.startMs).toBe(Date.parse("2026-07-13T13:00:00-07:00"));
    expect(first.appt.del?.endMs).toBe(Date.parse("2026-07-15T11:00:00-07:00"));
    expect(first.notes).toEqual([]);
  });

  it("reads FCFS windows and keeps a trailing word as a note", async () => {
    const o = await org();
    const p = await buildPreview(o.id, brokerWorkbook());
    expect(p.loads[2].appt.pu).toMatchObject({ kind: "fcfs" });
    expect(p.loads[2].appt.del?.startMs).toBe(Date.parse("2026-07-17T08:00:00-07:00"));
    expect(p.loads[3].notes).toContain('PU: ignored "working"');
  });

  it("flags what it cannot read instead of guessing: an unassigned load with no delivery time", async () => {
    const o = await org();
    const p = await buildPreview(o.id, brokerWorkbook());
    const last = p.loads[4];
    expect(last.carrier).toBeNull();
    expect(last.appt.pu).toBeNull();
    expect(last.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^PU: no time/), "DEL: missing"]));
  });

  it("notes a profit cell that disagrees with rate minus sold rate", async () => {
    const o = await org();
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[2][10] = "$999.00";
    const p = await buildPreview(o.id, brokerWorkbook(rows));
    expect(p.loads[0].notes).toContain("PROFIT $999.00 does not equal RATE - SOLD RATE ($400.00)");
    expect(p.loads[0].profitCents).toBe(40000);
  });
});

describe("confirmImport", () => {
  beforeEach(resetDb);

  it("creates loads, stops, appointments and carriers, saves the layout, and audits the batch", async () => {
    const o = await org();
    const r = await confirmImport(o.id, brokerWorkbook());
    expect(r).toMatchObject({ created: 5, updated: 0 });
    const loads = await prisma.load.findMany({ where: { orgId: o.id }, include: { stops: { include: { appointment: true }, orderBy: { sequence: "asc" } }, carrier: true, agentUpdates: true }, orderBy: { externalId: "asc" } });
    expect(loads).toHaveLength(5);
    const l = loads.find((x) => x.externalId === "145205")!;
    expect(l.bolNumber).toBe("0500001");
    expect(l.customerName).toBe("ACME FOODS");
    expect(l.revenueCents).toBe(400000);
    expect(l.soldRateCents).toBe(360000);
    expect(l.carrier?.mcNumber).toBe("1000001");
    expect(l.carrierPhone).toBe("(555) 010-0104");
    expect(l.carrierContactName).toBe("Contact A");
    expect(l.updateText).toBe("DELIVERED 07/15/2026");
    expect(l.apptText).toBe("PU: 07/13 - 13:00\nDEL: 07/15 - 11:00");
    expect(l.shipDate?.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(l.requiredEquip).toBe("DryVan");
    expect(l.stops[0]).toMatchObject({ type: "pickup", address: "Henderson, NV 89074", geocodeStatus: "ok" });
    expect(l.stops[0].lat).not.toBeNull();
    expect(l.stops[0].appointment?.windowStart?.toISOString()).toBe("2026-07-13T20:00:00.000Z");
    expect(l.stops[1].appointment?.windowEnd.toISOString()).toBe("2026-07-15T18:00:00.000Z");
    expect(l.stops[1].appointment?.kind).toBe("appointment");
    expect(l.agentUpdates).toEqual([]);

    const unassigned = loads.find((x) => x.orderRef === "2026-35100-00")!;
    expect(unassigned.externalId).toBeNull();
    expect(unassigned.carrierId).toBeNull();
    expect(unassigned.agentUpdates.map((u) => u.kind)).toEqual(["attention"]);
    expect(unassigned.agentUpdates[0].text).toMatch(/can't read PU appointment/);
    expect(r.attention).toBe(1);

    expect(await prisma.carrier.count({ where: { orgId: o.id } })).toBe(4);
    const layout = await prisma.boardLayout.findUnique({ where: { orgId: o.id } });
    expect(layout).not.toBeNull();
    const batch = await prisma.importBatch.findUnique({ where: { id: r.batchId } });
    expect(batch).toMatchObject({ orgId: o.id, source: "xlsx", entity: "broker_loads", rows: 5 });
  });

  it("re-importing the same file updates by LOAD# instead of duplicating, and matches by BOL# when LOAD# is blank", async () => {
    const o = await org();
    await confirmImport(o.id, brokerWorkbook());
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[2][14] = "ARRIVED, unloading";           // the dispatcher edited UPDATE on load 145205
    rows[15][9] = "$2,800.00";                     // the unassigned load (no LOAD#) got a sold rate; still no carrier row
    const r = await confirmImport(o.id, brokerWorkbook(rows));
    expect(r).toMatchObject({ created: 0, updated: 5 });
    expect(await prisma.load.count({ where: { orgId: o.id } })).toBe(5);
    expect((await prisma.load.findFirst({ where: { orgId: o.id, externalId: "145205" } }))?.updateText).toBe("ARRIVED, unloading");
    expect((await prisma.load.findFirst({ where: { orgId: o.id, bolNumber: "0500005" } }))?.soldRateCents).toBe(280000);
    expect(await prisma.loadStop.count()).toBe(10);
    expect(await prisma.carrier.count({ where: { orgId: o.id } })).toBe(4);
  });

  it("a city the gazetteer does not know becomes an attention line, not an error", async () => {
    const o = await org();
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[2][4] = "Nowhereville, ZZ";
    const r = await confirmImport(o.id, brokerWorkbook(rows));
    expect(r.created).toBe(5);
    const l = await prisma.load.findFirst({ where: { orgId: o.id, externalId: "145205" }, include: { stops: true, agentUpdates: true } });
    expect(l?.stops[0].geocodeStatus).toBe("failed");
    expect(l?.agentUpdates.some((u) => /can't place pickup/.test(u.text))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — FAIL, module not found.

- [ ] **Step 3: Implement**

`fleet-backend/src/lib/brokerImport.ts`:
```ts
import { prisma } from "../db.js";
import { parseApptText, type ApptWindow } from "./apptText.js";
import { layoutFor, proposeLayout, saveLayout, type BoardColumn, type BoardColumnKey } from "./boardLayout.js";
import { looksLikeUrl, pairRows, parseMoney, parseSheetDate, readWorkbook, type RawLoadPair } from "./brokerSheet.js";
import { geocodeAddress } from "./geocode.js";

// The customer's board becomes loads. Preview shows exactly what confirm will
// write; confirm writes it. Every cell the parser could not read becomes an
// attention line on the load (spec §5.3, §9.1) — the load still imports, the
// pill says what is wrong, and nothing is guessed.

/** The sheet has no equipment column; a broker's dry van is the default and
 *  the preview says so. */
const DEFAULT_EQUIPMENT = "DryVan";

export interface PreviewLoad {
  line: number;
  loadNo: string | null; orderRef: string | null; bol: string | null;
  customer: string | null; carrier: string | null; mc: string | null; carrierPhone: string | null; contact: string | null;
  pickup: string; puZip: string | null; delivery: string; delZip: string | null;
  rateCents: number | null; soldRateCents: number | null; profitCents: number | null;
  shipDate: string | null; update: string | null; trackingUrl: string | null;
  appt: { pu: ApptWindow | null; del: ApptWindow | null };
  notes: string[];
}

const nz = (s: string | undefined): string | null => (s && s.trim() ? s.trim() : null);
const cents = (n: number): string => "$" + (n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function toPreview(pair: RawLoadPair, tz: string): PreviewLoad {
  const { top, bottom } = pair;
  const notes: string[] = [];
  const shipDate = top.shipDate ? parseSheetDate(top.shipDate) : null;
  if (top.shipDate && !shipDate) notes.push(`can't read SHIP DATE "${top.shipDate}"`);
  const year = shipDate ? shipDate.getUTCFullYear() : new Date().getUTCFullYear();
  const apptLines = [top.appt ?? "", bottom?.appt ?? ""].filter((l) => l.trim() !== "");
  const appt = parseApptText(apptLines, { year, tz });
  notes.push(...appt.notes);
  const rateCents = top.rate ? parseMoney(top.rate) : null;
  if (top.rate && rateCents === null) notes.push(`can't read RATE "${top.rate}"`);
  const soldRateCents = top.soldRate ? parseMoney(top.soldRate) : null;
  if (top.soldRate && soldRateCents === null) notes.push(`can't read SOLD RATE "${top.soldRate}"`);
  const profitCents = rateCents !== null && soldRateCents !== null ? rateCents - soldRateCents : null;
  if (top.profit && profitCents !== null) {
    const typed = parseMoney(top.profit);
    if (typed !== null && typed !== profitCents) notes.push(`PROFIT ${top.profit} does not equal RATE - SOLD RATE (${cents(profitCents)})`);
  }
  const topPhone = nz(top.phone);
  const trackingUrl = topPhone && looksLikeUrl(topPhone) ? topPhone : null;
  const carrierPhone = nz(bottom?.phone) ?? (topPhone && !trackingUrl ? topPhone : null);
  return {
    line: pair.line,
    loadNo: nz(bottom?.loadNo), orderRef: nz(top.loadNo), bol: nz(top.bol),
    customer: nz(top.customer), carrier: nz(bottom?.customer), mc: nz(bottom?.mc), carrierPhone, contact: nz(bottom?.contact) ?? nz(top.contact),
    pickup: (top.pickupCity ?? "").trim(), puZip: nz(top.puZip), delivery: (top.deliveryCity ?? "").trim(), delZip: nz(top.delZip),
    rateCents, soldRateCents, profitCents,
    shipDate: shipDate ? shipDate.toISOString().slice(0, 10) : null, update: nz(top.update) ?? nz(bottom?.update), trackingUrl,
    appt: { pu: appt.pu, del: appt.del }, notes,
  };
}

async function readAndPair(orgId: string, buf: Buffer) {
  const orgRow = await prisma.org.findUnique({ where: { id: orgId }, select: { timezone: true } });
  if (!orgRow) throw new Error("org not found");
  const wb = readWorkbook(buf);
  const proposal = proposeLayout(wb.header);
  const saved = await prisma.boardLayout.findUnique({ where: { orgId } });
  const layout: BoardColumn[] = saved ? (saved.columns as unknown as BoardColumn[]) : proposal.columns;
  // Pair with the proposal (it matches THIS file's header order); the saved
  // layout is what the board renders.
  const { pairs, notes } = pairRows(wb.rows, proposal.columns);
  return { tz: orgRow.timezone, layout, proposal, pairs, notes };
}

export async function buildPreview(orgId: string, buf: Buffer): Promise<{ layout: BoardColumn[]; unmatched: string[]; missing: BoardColumnKey[]; loads: PreviewLoad[]; notes: string[] }> {
  const { tz, proposal, pairs, notes } = await readAndPair(orgId, buf);
  return { layout: proposal.columns, unmatched: proposal.unmatched, missing: proposal.missing, loads: pairs.map((p) => toPreview(p, tz)), notes };
}

async function carrierFor(orgId: string, name: string | null, mc: string | null): Promise<string | null> {
  if (!name && !mc) return null;
  const existing = mc
    ? await prisma.carrier.findFirst({ where: { orgId, mcNumber: mc } })
    : await prisma.carrier.findFirst({ where: { orgId, name: name! } });
  if (existing) {
    if (name && existing.name !== name && mc) await prisma.carrier.update({ where: { id: existing.id }, data: { name } });
    return existing.id;
  }
  const created = await prisma.carrier.create({ data: { orgId, name: name ?? `MC ${mc}`, mcNumber: mc } });
  return created.id;
}

async function stopData(type: "pickup" | "delivery", sequence: number, city: string, zip: string | null, window: ApptWindow | null, notes: string[]) {
  const address = zip ? `${city} ${zip}` : city;
  const hit = city ? await geocodeAddress(city) : null;
  if (!hit) notes.push(type === "pickup" ? `can't place pickup "${address}" on the map` : `can't place delivery "${address}" on the map`);
  return {
    sequence, type, address,
    lat: hit?.lat ?? null, lng: hit?.lng ?? null, geocodeStatus: hit ? "ok" : "failed",
    ...(window ? { appointment: { create: { windowStart: new Date(window.startMs), windowEnd: new Date(window.endMs), type, kind: window.kind } } } : {}),
  };
}

export async function confirmImport(orgId: string, buf: Buffer): Promise<{ batchId: string; created: number; updated: number; attention: number; notes: string[] }> {
  const { tz, proposal, pairs, notes } = await readAndPair(orgId, buf);
  await saveLayout(orgId, (await prisma.boardLayout.findUnique({ where: { orgId } })) ? await layoutFor(orgId) : proposal.columns);
  let created = 0, updated = 0, attention = 0;
  const nowMs = Date.now();
  for (const pair of pairs) {
    const p = toPreview(pair, tz);
    const loadNotes = [...p.notes];
    if (!p.appt.pu) loadNotes.push(`can't read PU appointment: "${pair.top.appt ?? ""}"`);
    if (!p.appt.del && pair.bottom) loadNotes.push(`can't read DEL appointment: "${pair.bottom.appt ?? ""}"`);
    const carrierId = await carrierFor(orgId, p.carrier, p.mc);
    const stops = [
      await stopData("pickup", 1, p.pickup, p.puZip, p.appt.pu, loadNotes),
      await stopData("delivery", 2, p.delivery, p.delZip, p.appt.del, loadNotes),
    ];
    const fields = {
      externalId: p.loadNo, orderRef: p.orderRef, bolNumber: p.bol, customerName: p.customer, brokerName: p.customer,
      revenueCents: p.rateCents ?? 0, soldRateCents: p.soldRateCents, trackingUrl: p.trackingUrl,
      shipDate: p.shipDate ? new Date(p.shipDate + "T00:00:00Z") : null, updateText: p.update,
      apptText: [pair.top.appt ?? "", pair.bottom?.appt ?? ""].filter((l) => l.trim() !== "").join("\n") || null,
      carrierId, carrierPhone: p.carrierPhone, carrierContactName: p.contact,
    };
    const existing = (p.loadNo ? await prisma.load.findFirst({ where: { orgId, externalId: p.loadNo } }) : null)
      ?? (p.bol ? await prisma.load.findFirst({ where: { orgId, bolNumber: p.bol } }) : null);
    let loadId: string;
    if (existing) {
      await prisma.$transaction(async (tx) => {
        const stopIds = (await tx.loadStop.findMany({ where: { loadId: existing.id }, select: { id: true } })).map((s) => s.id);
        await tx.appointment.deleteMany({ where: { stopId: { in: stopIds } } });
        await tx.loadStop.deleteMany({ where: { loadId: existing.id } });
        await tx.agentUpdate.deleteMany({ where: { loadId: existing.id, kind: "attention" } });
        await tx.load.update({ where: { id: existing.id }, data: { ...fields, stops: { create: stops } } });
      });
      loadId = existing.id; updated += 1;
    } else {
      const row = await prisma.load.create({ data: { orgId, status: "open", legType: "linehaul", requiredEquip: DEFAULT_EQUIPMENT, fscCents: 0, ...fields, stops: { create: stops } } });
      loadId = row.id; created += 1;
    }
    const attentionNotes = loadNotes.filter((n) => /^can't/.test(n) || /^(PU|DEL): /.test(n) && !/ignored/.test(n));
    if (attentionNotes.length) {
      attention += 1;
      await prisma.agentUpdate.createMany({ data: attentionNotes.map((text, i) => ({ loadId, atMs: BigInt(nowMs + i), kind: "attention", text })) });
    }
  }
  const batch = await prisma.importBatch.create({ data: { orgId, source: "xlsx", entity: "broker_loads", rows: pairs.length, errors: notes.length ? JSON.stringify(notes) : null } });
  return { batchId: batch.id, created, updated, attention, notes };
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/broker-import.test.ts` → PASS. If `geocodeAddress("Henderson, NV")` misses in the gazetteer, add the city to `usCities.ts` with its real coordinates (36.04, -114.98) — the gazetteer is ours to extend; note it in the report.

- [ ] **Step 5: Break it** — in `confirmImport`, remove the `?? (p.bol ? … : null)` fallback → the re-import test fails (6 loads, not 5). Restore. Remove the `attention` push for unreadable PU → the unassigned-load assertion fails. Restore.

- [ ] **Step 6: Commit** — skipped.

---

### Task 6: The routes

**Files:**
- Create: `fleet-backend/src/routes/dispatcherBrokerBoard.ts`
- Modify: `fleet-backend/src/app.ts` (mount)
- Test: `fleet-backend/tests/dispatcher-broker-board.test.ts`

**Interfaces:**
- Produces (all under `/api/dispatcher`, dispatcher auth + org scope):
  - `POST /broker-board/import` — multipart field `file` (`.xlsx`, ≤ 5 MB) → `{ preview: buildPreview result }`.
  - `POST /broker-board/import/confirm` — multipart `file` → `confirmImport` result; emits `board_update` to the org.
  - `GET /broker-board` → `{ layout: BoardColumn[]; loads: BoardLoad[] }` where `BoardLoad = { id, line: number, top: CellsByKey, bottom: CellsByKey | null, pill: { state: "none" | "attention"; text: string | null }, agentLine: { text; atMs } | null }`, ordered by `shipDate` then `externalId`, `line` numbered 1…n.

- [ ] **Step 1: Write the failing test**

`fleet-backend/tests/dispatcher-broker-board.test.ts`:
```ts
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { brokerWorkbook } from "./fixtures/brokerBoard.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

async function orgDispatcher() {
  const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Los_Angeles" } });
  await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
  const { token } = await loginDispatcher("b@x.com", "pw");
  return { org, auth: { Authorization: `Bearer ${token}` } };
}

describe("broker board routes", () => {
  beforeEach(resetDb);

  it("previews a workbook without writing anything", async () => {
    const { org, auth } = await orgDispatcher();
    const res = await request(app).post("/api/dispatcher/broker-board/import").set(auth).attach("file", brokerWorkbook(), "board.xlsx");
    expect(res.status).toBe(200);
    expect(res.body.preview.loads).toHaveLength(5);
    expect(res.body.preview.layout[0]).toEqual({ key: "bol", label: "BOL#" });
    expect(await prisma.load.count({ where: { orgId: org.id } })).toBe(0);
  });

  it("confirms, then serves the board in the org's layout with pills", async () => {
    const { auth } = await orgDispatcher();
    const c = await request(app).post("/api/dispatcher/broker-board/import/confirm").set(auth).attach("file", brokerWorkbook(), "board.xlsx");
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ created: 5, updated: 0, attention: 1 });
    const b = await request(app).get("/api/dispatcher/broker-board").set(auth);
    expect(b.status).toBe(200);
    expect(b.body.layout.map((x: { key: string }) => x.key)).toContain("agent");
    expect(b.body.loads).toHaveLength(5);
    const first = b.body.loads[0];
    expect(first.top).toMatchObject({ bol: "0500001", customer: "ACME FOODS", pickupCity: "Henderson, NV", rate: "$4,000.00", profit: "$400.00", loadNo: "2026-34566-00", shipDate: "7/13/2026", update: "DELIVERED 07/15/2026", appt: "PU: 07/13 - 13:00" });
    expect(first.top.phone).toMatch(/^https:/);
    expect(first.bottom).toMatchObject({ customer: "BLUE ROAD LLC", phone: "(555) 010-0104", contact: "Contact A", mc: "1000001", loadNo: "145205", appt: "DEL: 07/15 - 11:00" });
    expect(first.pill).toEqual({ state: "none", text: null });
    const unassigned = b.body.loads.find((l: { top: { loadNo: string } }) => l.top.loadNo === "2026-35100-00");
    expect(unassigned.bottom).toBeNull();
    expect(unassigned.pill.state).toBe("attention");
    expect(unassigned.pill.text).toMatch(/can't read PU appointment/);
  });

  it("refuses a file that is not a workbook, and a dispatcher without an org", async () => {
    const { auth } = await orgDispatcher();
    const bad = await request(app).post("/api/dispatcher/broker-board/import").set(auth).attach("file", Buffer.from("not a workbook"), "board.xlsx");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/header row|workbook/);
    await prisma.dispatcher.create({ data: { email: "noorg@x.com", passwordHash: await hashPassword("pw"), name: "N" } });
    const { token } = await loginDispatcher("noorg@x.com", "pw");
    const res = await request(app).get("/api/dispatcher/broker-board").set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(400);
  });

  it("does not leak another org's board", async () => {
    const { auth } = await orgDispatcher();
    await request(app).post("/api/dispatcher/broker-board/import/confirm").set(auth).attach("file", brokerWorkbook(), "board.xlsx");
    const other = await prisma.org.create({ data: { name: "Other", timezone: "America/Chicago" } });
    await prisma.dispatcher.create({ data: { email: "o@x.com", passwordHash: await hashPassword("pw"), name: "O", orgId: other.id } });
    const { token } = await loginDispatcher("o@x.com", "pw");
    const res = await request(app).get("/api/dispatcher/broker-board").set({ Authorization: `Bearer ${token}` });
    expect(res.body.loads).toEqual([]);
  });
});
```
(`hashPassword` — confirm the export name in `src/lib/password.ts` and the `Dispatcher.orgId` field name from `schema.prisma` before running; adapt the helper call, not the assertions.)

- [ ] **Step 2: Run it to verify it fails** — 404s.

- [ ] **Step 3: Implement**

`fleet-backend/src/routes/dispatcherBrokerBoard.ts`:
```ts
import { Router } from "express";
import multer from "multer";
import { prisma } from "../db.js";
import { layoutFor, type BoardColumn } from "../lib/boardLayout.js";
import { buildPreview, confirmImport } from "../lib/brokerImport.js";
import type { CellsByKey } from "../lib/brokerSheet.js";
import { emitToDispatchers } from "../realtime.js";

// The Broker Board (spec §4, §11): their sheet, read from our tables. Slice 1
// is read-only plus import; cell edits arrive in slice 2, the agent in slice 3.
export const dispatcherBrokerBoardRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function fileOf(req: { file?: { buffer: Buffer; originalname: string } }): Buffer | null {
  const f = req.file;
  if (!f || !/\.xlsx$/i.test(f.originalname)) return null;
  return f.buffer;
}

dispatcherBrokerBoardRouter.post("/broker-board/import", upload.single("file"), async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Importing a board requires an org-scoped dispatcher account" });
  const buf = fileOf(req);
  if (!buf) return res.status(400).json({ error: "Attach the board as an .xlsx file in the 'file' field" });
  try {
    res.json({ preview: await buildPreview(orgId, buf) });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "could not read the workbook" });
  }
});

dispatcherBrokerBoardRouter.post("/broker-board/import/confirm", upload.single("file"), async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Importing a board requires an org-scoped dispatcher account" });
  const buf = fileOf(req);
  if (!buf) return res.status(400).json({ error: "Attach the board as an .xlsx file in the 'file' field" });
  try {
    const result = await confirmImport(orgId, buf);
    emitToDispatchers(orgId, "board_update", { brokerBoard: true, batchId: result.batchId });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "could not import the workbook" });
  }
});

const money = (c: number | null): string => (c === null ? "" : "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const usDate = (d: Date | null): string => (d ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}` : "");

dispatcherBrokerBoardRouter.get("/broker-board", async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  const layout: BoardColumn[] = await layoutFor(orgId);
  const loads = await prisma.load.findMany({
    where: { orgId },
    include: { carrier: true, stops: { orderBy: { sequence: "asc" } }, agentUpdates: { orderBy: { atMs: "desc" }, take: 1 } },
    orderBy: [{ shipDate: "asc" }, { externalId: "asc" }],
  });
  const rows = loads.map((l, i) => {
    const [pu, del] = [l.stops[0], l.stops[1]];
    const apptLines = (l.apptText ?? "").split("\n");
    const top: CellsByKey = {
      bol: l.bolNumber ?? "", customer: l.customerName ?? "", phone: l.trackingUrl ?? "", contact: "",
      pickupCity: pu?.address.replace(/\s\d{5}$/, "") ?? "", puZip: pu?.address.match(/(\d{5})$/)?.[1] ?? "",
      delZip: del?.address.match(/(\d{5})$/)?.[1] ?? "", deliveryCity: del?.address.replace(/\s\d{5}$/, "") ?? "",
      rate: money(l.revenueCents), soldRate: money(l.soldRateCents), profit: l.soldRateCents === null ? "" : money(l.revenueCents - l.soldRateCents),
      mc: "MC", loadNo: l.orderRef ?? "", shipDate: usDate(l.shipDate), update: l.updateText ?? "", appt: apptLines[0] ?? "",
    };
    const bottom: CellsByKey | null = l.carrierId || l.carrierPhone || l.externalId
      ? { customer: l.carrier?.name ?? "", phone: l.carrierPhone ?? "", contact: l.carrierContactName ?? "", mc: l.carrier?.mcNumber ?? "", loadNo: l.externalId ?? "", appt: apptLines[1] ?? "" }
      : null;
    const latest = l.agentUpdates[0] ?? null;
    const pill = latest?.kind === "attention" ? { state: "attention" as const, text: latest.text } : { state: "none" as const, text: null };
    return { id: l.id, line: i + 1, top, bottom, pill, agentLine: latest && latest.kind !== "attention" ? { text: latest.text, atMs: Number(latest.atMs) } : null };
  });
  res.json({ layout, loads: rows });
});
```

Mount in `fleet-backend/src/app.ts` next to the other dispatcher routers:
```ts
import { dispatcherBrokerBoardRouter } from "./routes/dispatcherBrokerBoard.js";
…
  app.use("/api/dispatcher", dispatcherBrokerBoardRouter);
```
(`multer` is already a dependency; `req.orgScope` is typed by `middleware/orgScope.ts`.)

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/dispatcher-broker-board.test.ts && npm test` → PASS, whole backend green. `npm run typecheck` (or `npx tsc --noEmit`) clean.

- [ ] **Step 5: Break it** — remove `where: { orgId }` from the GET → the "does not leak" test fails. Restore.

- [ ] **Step 6: Commit** — skipped.

---

### Task 7: The portal — their board, read-only, with import

**Files:**
- Modify: `fleet-portal/src/lib/api.ts` (three functions + types)
- Create: `fleet-portal/src/stores/brokerBoard.ts`
- Create: `fleet-portal/src/views/BrokerBoardView.vue`, `fleet-portal/src/components/broker/BrokerGrid.vue`, `fleet-portal/src/components/broker/BrokerImportDialog.vue`
- Modify: `fleet-portal/src/router/index.ts` (route `board/broker`), `fleet-portal/src/layouts/AppShell.vue` (nav item)
- Test: `fleet-portal/src/stores/brokerBoard.spec.ts`, `fleet-portal/src/views/BrokerBoardView.spec.ts`

**Interfaces:**
- Consumes: Task 6's JSON.
- Produces: route `/board/broker` named `broker-board`; nav item **Their Board** first in `primaryNav`; store `useBrokerBoardStore` with `layout`, `loads`, `loading`, `error`, `load()`, `preview(file)`, `confirm(file)`.

- [ ] **Step 1: Write the failing tests**

`fleet-portal/src/stores/brokerBoard.spec.ts`:
```ts
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useBrokerBoardStore } from './brokerBoard'

vi.mock('../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() }, API_BASE_URL: 'http://localhost:3001/api' }))
const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)

const board = {
  layout: [{ key: 'bol', label: 'BOL#' }, { key: 'customer', label: 'CUSTOMER /CARRIER' }, { key: 'agent', label: 'AGENT' }],
  loads: [{ id: 'l1', line: 1, top: { bol: '0500001', customer: 'ACME FOODS' }, bottom: { customer: 'BLUE ROAD LLC' }, pill: { state: 'none', text: null }, agentLine: null }],
}

describe('brokerBoard store', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('loads the layout and the row pairs', async () => {
    mockedGet.mockResolvedValueOnce({ data: board })
    const s = useBrokerBoardStore()
    await s.load()
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/broker-board')
    expect(s.layout).toHaveLength(3)
    expect(s.loads[0].bottom?.customer).toBe('BLUE ROAD LLC')
    expect(s.error).toBeNull()
  })

  it('keeps the server error message when the board cannot load', async () => {
    mockedGet.mockRejectedValueOnce({ response: { data: { error: 'The broker board requires an org-scoped dispatcher account' } } })
    const s = useBrokerBoardStore()
    await s.load()
    expect(s.error).toMatch(/org-scoped/)
  })

  it('previews and confirms a workbook as multipart, then reloads', async () => {
    mockedPost.mockResolvedValueOnce({ data: { preview: { layout: board.layout, loads: [], notes: [], unmatched: [], missing: [] } } })
    mockedPost.mockResolvedValueOnce({ data: { batchId: 'b1', created: 5, updated: 0, attention: 1, notes: [] } })
    mockedGet.mockResolvedValueOnce({ data: board })
    const s = useBrokerBoardStore()
    const file = new File([new Uint8Array([1, 2, 3])], 'board.xlsx')
    const p = await s.preview(file)
    expect(p?.layout).toHaveLength(3)
    expect(mockedPost.mock.calls[0][0]).toBe('/dispatcher/broker-board/import')
    expect(mockedPost.mock.calls[0][1]).toBeInstanceOf(FormData)
    const r = await s.confirm(file)
    expect(r?.created).toBe(5)
    expect(mockedGet).toHaveBeenCalledTimes(1)
  })
})
```

`fleet-portal/src/views/BrokerBoardView.spec.ts`:
```ts
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import BrokerBoardView from './BrokerBoardView.vue'

vi.mock('../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() }, API_BASE_URL: 'http://localhost:3001/api' }))
const mockedGet = vi.mocked(api.get)

const layout = ['BOL#', 'CUSTOMER /CARRIER', 'TELEPHONE#', 'CONTACT NAME', 'PICK UP', 'PU ZIP', 'DEL ZIP', 'DELIVERY', 'RATE', 'SOLD RATE', 'PROFIT', 'M.C. #', 'LOAD#', 'SHIP DATE', '****UPDATE****', 'APPT SCHEDULE']
  .map((label, i) => ({ key: ['bol', 'customer', 'phone', 'contact', 'pickupCity', 'puZip', 'delZip', 'deliveryCity', 'rate', 'soldRate', 'profit', 'mc', 'loadNo', 'shipDate', 'update', 'appt'][i], label }))
  .concat([{ key: 'agent', label: 'AGENT' }])

const loads = [
  { id: 'l1', line: 1, top: { bol: '0500001', customer: 'ACME FOODS', phone: 'https://cloud.example.com/o/1', pickupCity: 'Henderson, NV', puZip: '89074', delZip: '75236', deliveryCity: 'Dallas, TX', rate: '$4,000.00', soldRate: '$3,600.00', profit: '$400.00', mc: 'MC', loadNo: '2026-34566-00', shipDate: '7/13/2026', update: 'DELIVERED 07/15/2026', appt: 'PU: 07/13 - 13:00' },
    bottom: { customer: 'BLUE ROAD LLC', phone: '(555) 010-0104', contact: 'Contact A', mc: '1000001', loadNo: '145205', appt: 'DEL: 07/15 - 11:00' }, pill: { state: 'none', text: null }, agentLine: null },
  { id: 'l2', line: 2, top: { bol: '0500005', customer: 'ACME FOODS', pickupCity: 'Henderson, NV', deliveryCity: 'Denver, CO', rate: '$3,100.00', loadNo: '2026-35100-00', appt: 'PU: 07/15 - tbd' }, bottom: null, pill: { state: 'attention', text: "can't read PU appointment: \"PU: 07/15 - tbd\"" }, agentLine: null },
]

describe('BrokerBoardView', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('renders their header, two rows per load, and the pills', async () => {
    mockedGet.mockResolvedValueOnce({ data: { layout, loads } })
    const w = mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    const headers = w.findAll('thead th').map((th) => th.text())
    expect(headers.slice(0, 16)).toEqual(layout.slice(0, 16).map((c) => c.label))
    expect(headers[16]).toBe('AGENT')
    const rows = w.findAll('tbody tr')
    expect(rows).toHaveLength(3)                       // 2 for the first load, 1 for the unassigned one
    expect(rows[0].text()).toContain('ACME FOODS')
    expect(rows[0].find('a[href^="https://"]').exists()).toBe(true)   // the tracking link opens in a new tab
    expect(rows[0].find('a').attributes('target')).toBe('_blank')
    expect(rows[1].text()).toContain('BLUE ROAD LLC')
    expect(rows[1].text()).toContain('145205')
    expect(rows[0].find('[data-pill]').text()).toBe('—')
    expect(rows[2].find('[data-pill]').text()).toBe('Attention')
    expect(rows[2].find('[data-pill]').attributes('title')).toMatch(/can't read PU appointment/)
  })

  it('says what went wrong instead of an empty grid', async () => {
    mockedGet.mockRejectedValueOnce({ response: { data: { error: 'The broker board requires an org-scoped dispatcher account' } } })
    const w = mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    expect(w.text()).toContain('org-scoped')
    expect(w.find('table').exists()).toBe(false)
  })

  it('shows the empty board with the import call to action when there are no loads', async () => {
    mockedGet.mockResolvedValueOnce({ data: { layout, loads: [] } })
    const w = mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    expect(w.text()).toContain('Import your board')
  })
})
```

- [ ] **Step 2: Run them to verify they fail** — `cd fleet-portal && npx vitest run src/stores/brokerBoard.spec.ts src/views/BrokerBoardView.spec.ts` → FAIL, modules not found.

- [ ] **Step 3: API functions**

Append to `fleet-portal/src/lib/api.ts`:
```ts
// --- Broker Board (spec 2026-09-07 §11) -------------------------------------
export type BoardColumnKey = 'bol' | 'customer' | 'phone' | 'contact' | 'pickupCity' | 'puZip' | 'delZip' | 'deliveryCity' | 'rate' | 'soldRate' | 'profit' | 'mc' | 'loadNo' | 'shipDate' | 'update' | 'appt' | 'agent' | 'driverCell' | 'extra'
export interface BoardColumn { key: BoardColumnKey; label: string; source?: string }
export type CellsByKey = Partial<Record<BoardColumnKey, string>>
export interface BoardPill { state: 'none' | 'attention'; text: string | null }
export interface BoardLoad { id: string; line: number; top: CellsByKey; bottom: CellsByKey | null; pill: BoardPill; agentLine: { text: string; atMs: number } | null }
export interface BrokerBoard { layout: BoardColumn[]; loads: BoardLoad[] }
export interface BrokerPreview { layout: BoardColumn[]; unmatched: string[]; missing: BoardColumnKey[]; loads: Array<Record<string, unknown> & { line: number; notes: string[] }>; notes: string[] }
export interface BrokerImportResult { batchId: string; created: number; updated: number; attention: number; notes: string[] }

export async function fetchBrokerBoard(): Promise<BrokerBoard> {
  const { data } = await api.get<BrokerBoard>('/dispatcher/broker-board')
  return data
}
function workbookForm(file: File): FormData { const fd = new FormData(); fd.append('file', file, file.name); return fd }
export async function previewBrokerBoard(file: File): Promise<BrokerPreview> {
  const { data } = await api.post<{ preview: BrokerPreview }>('/dispatcher/broker-board/import', workbookForm(file), { headers: { 'Content-Type': 'multipart/form-data' } })
  return data.preview
}
export async function confirmBrokerBoard(file: File): Promise<BrokerImportResult> {
  const { data } = await api.post<BrokerImportResult>('/dispatcher/broker-board/import/confirm', workbookForm(file), { headers: { 'Content-Type': 'multipart/form-data' } })
  return data
}
```

- [ ] **Step 4: Store**

`fleet-portal/src/stores/brokerBoard.ts`:
```ts
import { defineStore } from 'pinia'
import { confirmBrokerBoard, fetchBrokerBoard, previewBrokerBoard, type BoardColumn, type BoardLoad, type BrokerImportResult, type BrokerPreview } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'

// Their board: the org's layout and the loads as row pairs. Read-only in
// slice 1; cell edits arrive in slice 2 and go through this store.
export const useBrokerBoardStore = defineStore('brokerBoard', {
  state: () => ({
    layout: [] as BoardColumn[],
    loads: [] as BoardLoad[],
    loading: false,
    error: null as string | null,
    importing: false,
    importError: null as string | null,
  }),
  actions: {
    async load() {
      this.loading = true; this.error = null
      try {
        const b = await fetchBrokerBoard()
        this.layout = b.layout; this.loads = b.loads
      } catch (e) {
        this.error = extractApiErrorMessage(e, 'Could not load the board')
      } finally { this.loading = false }
    },
    async preview(file: File): Promise<BrokerPreview | null> {
      this.importing = true; this.importError = null
      try { return await previewBrokerBoard(file) }
      catch (e) { this.importError = extractApiErrorMessage(e, 'Could not read that workbook'); return null }
      finally { this.importing = false }
    },
    async confirm(file: File): Promise<BrokerImportResult | null> {
      this.importing = true; this.importError = null
      try {
        const r = await confirmBrokerBoard(file)
        await this.load()
        return r
      } catch (e) { this.importError = extractApiErrorMessage(e, 'Could not import that workbook'); return null }
      finally { this.importing = false }
    },
  },
})
```
(Confirm `extractApiErrorMessage(e, fallback)`'s signature in `src/lib/errors.ts`; adapt the call, not the tests.)

- [ ] **Step 5: The grid, the dialog, the view**

`fleet-portal/src/components/broker/BrokerGrid.vue`:
```vue
<script setup lang="ts">
import type { BoardColumn, BoardLoad, CellsByKey } from '../../lib/api'

// Their sheet, cell for cell. Two rows per load; the pill sits on the top
// row only; free text is shown exactly as typed. Read-only in slice 1.
const props = defineProps<{ layout: BoardColumn[]; loads: BoardLoad[] }>()

const isUrl = (v: string): boolean => /^https?:\/\//i.test(v)
const cell = (cells: CellsByKey | null, key: BoardColumn['key'], source?: string): string => {
  if (!cells) return ''
  if (key === 'extra') return (cells as Record<string, string>)[source ?? ''] ?? ''
  return cells[key] ?? ''
}
const pillLabel = (l: BoardLoad): string => (l.pill.state === 'attention' ? 'Attention' : '—')
const cellClass = (key: BoardColumn['key'], row: 'top' | 'bottom'): string => {
  if (key === 'customer' && row === 'top') return 'bg-amber-200 text-black font-bold tracking-wide'
  if (key === 'profit') return 'text-green-700 font-semibold'
  if (key === 'rate' || key === 'soldRate') return 'font-semibold'
  return ''
}
</script>

<template>
  <div class="overflow-x-auto rounded border border-line bg-surface">
    <table class="min-w-full border-collapse text-[13px] leading-tight" data-broker-grid>
      <thead>
        <tr class="bg-surface-2">
          <th v-for="c in props.layout" :key="c.key + c.label" class="whitespace-nowrap border border-line px-2 py-1.5 text-left text-[11px] font-bold uppercase tracking-wide text-ink-2">{{ c.label }}</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="l in props.loads" :key="l.id">
          <tr class="bg-orange-100 text-black dark:bg-orange-900/40 dark:text-ink" :data-load="l.id" data-row="top">
            <td v-for="c in props.layout" :key="c.key + c.label" class="whitespace-nowrap border border-line px-2 py-1 align-middle" :class="cellClass(c.key, 'top')">
              <template v-if="c.key === 'agent'">
                <span data-pill :title="l.pill.text ?? undefined" class="inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold" :class="l.pill.state === 'attention' ? 'border border-red-500 text-red-600' : 'text-ink-3'">{{ pillLabel(l) }}</span>
              </template>
              <template v-else-if="isUrl(cell(l.top, c.key, c.source))">
                <a :href="cell(l.top, c.key, c.source)" target="_blank" rel="noopener" class="text-blue-700 underline">{{ cell(l.top, c.key, c.source).replace(/^https?:\/\//, '').slice(0, 42) }}…</a>
              </template>
              <template v-else>{{ cell(l.top, c.key, c.source) }}</template>
            </td>
          </tr>
          <tr v-if="l.bottom" class="bg-orange-100 text-black dark:bg-orange-900/40 dark:text-ink" :data-load="l.id" data-row="bottom">
            <td v-for="c in props.layout" :key="c.key + c.label" class="whitespace-nowrap border border-line px-2 py-1 align-middle" :class="cellClass(c.key, 'bottom')">
              <template v-if="c.key === 'agent'"></template>
              <template v-else>{{ cell(l.bottom, c.key, c.source) }}</template>
            </td>
          </tr>
          <tr class="h-2" aria-hidden="true"><td :colspan="props.layout.length" class="border-0 p-0"></td></tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
```

`fleet-portal/src/components/broker/BrokerImportDialog.vue`:
```vue
<script setup lang="ts">
import { ref } from 'vue'
import type { BrokerImportResult, BrokerPreview } from '../../lib/api'
import { useBrokerBoardStore } from '../../stores/brokerBoard'

// Import → preview the first loads as row pairs → confirm. Nothing is
// written until Confirm; unreadable cells show as notes, not errors.
const emit = defineEmits<{ (e: 'close'): void; (e: 'imported', r: BrokerImportResult): void }>()
const store = useBrokerBoardStore()
const file = ref<File | null>(null)
const preview = ref<BrokerPreview | null>(null)
const result = ref<BrokerImportResult | null>(null)

async function pick(ev: Event) {
  const f = (ev.target as HTMLInputElement).files?.[0] ?? null
  file.value = f; preview.value = null; result.value = null
  if (f) preview.value = await store.preview(f)
}
async function confirm() {
  if (!file.value) return
  const r = await store.confirm(file.value)
  if (r) { result.value = r; emit('imported', r) }
}
</script>

<template>
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="Import your board">
    <div class="w-[min(960px,95vw)] max-h-[90vh] overflow-auto rounded-lg border border-line bg-surface p-5 text-ink shadow-xl">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-lg font-semibold">Import your board</h2>
          <p class="text-sm text-ink-2">Pick the .xlsx you use today. We read the header row, show the first loads the way they'll appear, and write nothing until you confirm.</p>
        </div>
        <button class="rounded px-2 py-1 text-ink-2 hover:bg-surface-2" @click="emit('close')" aria-label="Close">✕</button>
      </div>
      <input type="file" accept=".xlsx" class="mt-4 block" @change="pick" />
      <p v-if="store.importError" class="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700">{{ store.importError }}</p>
      <div v-if="preview" class="mt-4 space-y-3">
        <p class="text-sm"><strong>{{ preview.loads.length }}</strong> loads found. Columns: {{ preview.layout.filter((c) => c.key !== 'extra' && c.key !== 'agent').length }} recognized<span v-if="preview.unmatched.length">, kept as text: {{ preview.unmatched.join(', ') }}</span>.</p>
        <p v-if="preview.missing.length" class="text-sm text-amber-700">Missing columns: {{ preview.missing.join(', ') }}. The board still imports; the agent needs LOAD# and APPT SCHEDULE to work a load.</p>
        <table class="w-full text-xs">
          <thead><tr class="text-left text-ink-2"><th class="py-1">Line</th><th>LOAD#</th><th>Customer</th><th>Carrier</th><th>Pick up</th><th>Delivery</th><th>Rate</th><th>Notes</th></tr></thead>
          <tbody>
            <tr v-for="l in preview.loads.slice(0, 10)" :key="l.line" class="border-t border-line">
              <td class="py-1">{{ l.line }}</td><td>{{ l.loadNo ?? '—' }}</td><td>{{ l.customer }}</td><td>{{ l.carrier ?? '— (no carrier yet)' }}</td><td>{{ l.pickup }}</td><td>{{ l.delivery }}</td><td>{{ l.rateCents == null ? '' : '$' + (Number(l.rateCents) / 100).toFixed(2) }}</td>
              <td class="text-amber-700">{{ l.notes.join('; ') }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="preview.loads.length > 10" class="text-xs text-ink-3">…and {{ preview.loads.length - 10 }} more.</p>
        <div class="flex items-center gap-3">
          <button class="rounded bg-brand px-4 py-2 text-sm font-semibold text-brand-ink disabled:opacity-50" :disabled="store.importing || !file" @click="confirm">Confirm import</button>
          <span v-if="result" class="text-sm text-green-700">Imported: {{ result.created }} new, {{ result.updated }} updated<span v-if="result.attention">, {{ result.attention }} need attention</span>.</span>
        </div>
      </div>
    </div>
  </div>
</template>
```

`fleet-portal/src/views/BrokerBoardView.vue`:
```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import BrokerGrid from '../components/broker/BrokerGrid.vue'
import BrokerImportDialog from '../components/broker/BrokerImportDialog.vue'
import { useBrokerBoardStore } from '../stores/brokerBoard'

// Their board (spec §4): the sheet they use today, backed by our loads.
const store = useBrokerBoardStore()
const importing = ref(false)
onMounted(() => store.load())
</script>

<template>
  <div class="space-y-4 p-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-[18px] font-bold tracking-tight text-ink">Their Board</h1>
        <p class="text-sm text-ink-2">Your sheet, as you use it. Two rows per load. The AGENT column is the night shift.</p>
      </div>
      <button class="rounded bg-brand px-3 py-2 text-sm font-semibold text-brand-ink" @click="importing = true">Import .xlsx</button>
    </div>

    <p v-if="store.error" class="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{{ store.error }}</p>
    <p v-else-if="store.loading" class="text-sm text-ink-2">Loading your board…</p>
    <div v-else-if="store.loads.length === 0" class="rounded border border-dashed border-line p-8 text-center">
      <p class="text-base font-semibold text-ink">Import your board</p>
      <p class="mt-1 text-sm text-ink-2">Pick the .xlsx you dispatch from today. It shows up here exactly as it is, and the night shift can start watching it.</p>
      <button class="mt-4 rounded bg-brand px-3 py-2 text-sm font-semibold text-brand-ink" @click="importing = true">Choose file</button>
    </div>
    <BrokerGrid v-else :layout="store.layout" :loads="store.loads" />

    <BrokerImportDialog v-if="importing" @close="importing = false" @imported="importing = false" />
  </div>
</template>
```

Route, in `fleet-portal/src/router/index.ts`: import `BrokerBoardView` and add, before `{ path: 'board', … }`:
```ts
      { path: 'board/broker', name: 'broker-board', component: BrokerBoardView },
```
Nav, in `fleet-portal/src/layouts/AppShell.vue`, first entry of `primaryNav`:
```ts
  { label: 'Their Board', to: '/board/broker', icon: 'tower' },
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd fleet-portal && npx vitest run src/stores/brokerBoard.spec.ts src/views/BrokerBoardView.spec.ts && npm test && npx vue-tsc -b`
Expected: the two new specs pass, the portal suite green, type build clean.

- [ ] **Step 7: See it**

With the backend on `:3001` and the portal on `:5173`, log in (`d@fleet.com` / `pass123`), open **Their Board**, import `fleet-backend/tests/fixtures` rendered to a file (run `node -e` with `brokerWorkbook()` written to `C:\Users\Naum\AppData\Local\Temp\claude\…\board.xlsx`, or the customer's real file), confirm, and screenshot the grid. The first load must show the yellow customer cell, the orange rows, the profit in green, the tracking link as a link, and the unassigned load's red-outlined **Attention** pill with the tooltip.

- [ ] **Step 8: Commit** — skipped.

---

## Self-review (done while writing)

- **Spec coverage, slice 1:** §4.1 layout (Tasks 3, 7), §4.3 no extra columns (Task 3 `agent` only), §5.1–5.4 (Tasks 1–5), §6.1 pill states `none`/`attention` only (Task 6; the rest are slice 3), §9.1 import with preview/confirm/re-import matching (Tasks 5–7), §11 the three read/import endpoints (Task 6). §4.2 editing, §9.2 export, §6.2–6.6, §7, §8 are slices 2–5 by design.
- **Type consistency:** `BoardColumnKey`/`BoardColumn`/`CellsByKey` are defined once in the backend (Task 3/4) and mirrored by name in the portal's `api.ts` (Task 7); `PreviewLoad` (Task 5) is what Task 6's preview returns and Task 7's dialog renders (`loadNo`, `customer`, `carrier`, `pickup`, `delivery`, `rateCents`, `notes`, `line`); `AgentUpdate.kind` `attention` is what Task 6 turns into the pill.
- **No placeholders:** every step carries its code; the two "confirm the helper name" notes (`hashPassword`, `extractApiErrorMessage`) tell the implementer to adapt a call, never a test.
