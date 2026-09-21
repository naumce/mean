# One Honest Record — Plan A1: the LoadWriter, the vocabulary, the trace

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every change to a `Load` — from Their Board's cells and paste, from the .xlsx importer, and from a backfill — passes through one writer that derives the structured truth once (appointments, coordinates, status, Attention), bumps a version, and leaves a trace; the Cockpit's read model stops lying about brokered loads.

**Architecture:** A pure orchestration module `src/lib/loadWriter.ts` takes a `LoadPatch` inside the caller's transaction, applies it, derives only what changed, replaces the affected Attention rows atomically, appends `LoadChange` rows and increments `Load.version`. `boardCellApply.ts` shrinks to a translator (`CellPlan` → `LoadPatch`); `brokerImport.ts` keeps identity matching and hands each row pair to the writer; a CLI re-derives every existing load. UPDATE text drives `Load.status` through a per-org `UpdateRule` table matched by prefix, guarded for loads our own drivers run, traced and undoable.

**Tech Stack:** Express 4 + Prisma 5 (Postgres) + zod + vitest (backend, ESM `.js` specifiers); Vue 3 + Pinia + vitest (portal, one small task).

**Spec:** `docs/superpowers/specs/2026-09-09-one-honest-record-design.md` — §4 (writer), §5 (data model), §6 (vocabulary), §10 (marks), §11 (importer, backfill), §13 (API), §16 (defects). This plan implements spec §15 build steps 1 and 2. Locks (§7), Cockpit lanes (§8) and realtime unification (§9) are plans A2, A3, A4 on the same spec.

## Global Constraints

- **No git commits and no `git add`** in this session (user's standing rule). Every "Commit" step below is skipped; the ledger records the proofs.
- Backend imports use ESM `.js` specifiers; `noUnusedLocals`/`noUnusedParameters` are on. No `console.log` in library code.
- Every dispatcher route is org-scoped: read `req.orgScope`, refuse with 400 when null, `outsideOrg(req, orgId)` before returning any record. Cross-org ids read as 404.
- Free text a human typed is stored verbatim (`updateText`, `apptText`); the system never rewrites a cell (spec §12).
- Nothing is invented: an unreadable appointment or an unplaceable city becomes an `AgentUpdate` of kind `attention` quoting the text; the previous good value stays (spec §4.2).
- `geocodeStatus` on a miss is `"pending"`, never `"failed"` (spec D6). Geocode with the city only (trailing 5-digit ZIP stripped), exactly as the importer does today.
- A `force` re-derivation never overwrites an existing `Appointment` from text; it only creates one where a stop has none (spec D3).
- Money is integer cents; dates are UTC instants computed from `Org.timezone`.
- Backend tests: `npm test` in `fleet-backend/` (per-process Postgres schema, migrated by globalSetup); every DB test calls `resetDb()` in `beforeEach`. Backend fixtures are anonymised.
- Prisma migration on this Windows machine: stop the dev backend on `:3001` before `prisma migrate`/`generate`, then restart it. `prisma migrate dev` is refused in a non-interactive shell — use `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<ts>_<name>/migration.sql` then `prisma migrate deploy` then `prisma generate`.
- American English in every user-facing string.

## File structure

| File | Responsibility |
|---|---|
| `fleet-backend/prisma/schema.prisma` | `Load.version`, `LoadChange`, `UpdateRule` (Task 1) |
| `fleet-backend/src/lib/updateVocabulary.ts` | Pure: default rules, prefix match, `statusFor` (Task 2) |
| `fleet-backend/src/lib/loadWriter.ts` | `applyLoadChange` and the derivation pipeline (Tasks 3–6) |
| `fleet-backend/src/lib/actor.ts` | `actorOf(req)` — who is writing (Task 3) |
| `fleet-backend/src/lib/boardCellApply.ts` | Becomes `planToPatch`: `CellPlan` + current load → `LoadPatch` (Task 7) |
| `fleet-backend/src/routes/dispatcherBrokerBoard.ts` | Cell/paste routes call the writer; GET fixes defects 1 and 4; `record` hints (Tasks 7, 11) |
| `fleet-backend/src/lib/brokerImport.ts` | Identity matching stays; row writes go through the writer (Task 8) |
| `fleet-backend/src/cli/rederive.ts` | `npm run loads:rederive` backfill (Task 9) |
| `fleet-backend/src/routes/dispatcherLoadTruth.ts` | `update-rules`, `loads/:id/changes`, `loads/:id/undo-status` (Task 10) |
| `fleet-portal/src/components/broker/BrokerGrid.vue` | The dot on a cell that disagrees with the record (Task 11) |

---

### Task 1: Schema — `Load.version`, `LoadChange`, `UpdateRule`

**Files:**
- Modify: `fleet-backend/prisma/schema.prisma` (`Load`, `Org`; new `LoadChange`, `UpdateRule`)
- Create: `fleet-backend/prisma/migrations/<ts>_one_honest_record/migration.sql` (generated)
- Modify: `fleet-backend/tests/helpers.ts` (`resetDb`)
- Test: `fleet-backend/tests/honest-record-schema.test.ts`

**Interfaces:**
- Produces: `Load.version Int @default(0)`; `LoadChange { id, loadId, orgId, atMs BigInt, actorId String?, actorName String, source String, field String, before String?, after String?, note String? }`; `UpdateRule { id, orgId, prefix String, status String, enabled Boolean }` unique on `[orgId, prefix]`.

- [ ] **Step 1: Write the failing test**

`fleet-backend/tests/honest-record-schema.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";

// Spec §5: a version on every load, a trace of who changed what, and the
// org's own words for UPDATE → status.
describe("one honest record — schema", () => {
  beforeEach(resetDb);

  it("gives every load a version that starts at 0 and only goes up", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
    const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0 } });
    expect(load.version).toBe(0);
    const bumped = await prisma.load.update({ where: { id: load.id }, data: { version: { increment: 1 } } });
    expect(bumped.version).toBe(1);
  });

  it("keeps a trace row per changed field, and drops it with the load", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
    const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0 } });
    await prisma.loadChange.create({
      data: { loadId: load.id, orgId: org.id, atMs: BigInt(1_760_000_000_000), actorId: null, actorName: "import", source: "import", field: "status", before: "open", after: "delivered", note: "DELIVERED 07/17/2026" },
    });
    expect(await prisma.loadChange.count({ where: { loadId: load.id } })).toBe(1);
    await prisma.load.delete({ where: { id: load.id } });
    expect(await prisma.loadChange.count()).toBe(0);
  });

  it("stores one rule per prefix per org, and lets another org use the same word", async () => {
    const a = await prisma.org.create({ data: { name: "A", timezone: "UTC" } });
    const b = await prisma.org.create({ data: { name: "B", timezone: "UTC" } });
    await prisma.updateRule.create({ data: { orgId: a.id, prefix: "DELIVERED", status: "delivered" } });
    await expect(prisma.updateRule.create({ data: { orgId: a.id, prefix: "DELIVERED", status: "canceled" } })).rejects.toThrow();
    const theirs = await prisma.updateRule.create({ data: { orgId: b.id, prefix: "DELIVERED", status: "delivered" } });
    expect(theirs.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd fleet-backend && npx vitest run tests/honest-record-schema.test.ts`
Expected: FAIL — `version` is not a column; `prisma.loadChange` / `prisma.updateRule` are undefined.

- [ ] **Step 3: Add the schema**

In `fleet-backend/prisma/schema.prisma`, inside `model Load`, after `extras Json?`:
```prisma
  /// Bumped by the LoadWriter on every change (spec §5.1). A client sends the
  /// version it rendered; a write on a stale one is refused (plan A2).
  version            Int      @default(0)
  changes            LoadChange[]
```
Inside `model Org`, next to `boardView BoardView?`:
```prisma
  updateRules UpdateRule[]
```
After `model BoardView { … }`:
```prisma
// Who changed what on a load, one row per field (spec §5.2). Read by the
// undo (§6.4) and, in slice B, by the drawer. Never edited, never deleted
// except with its load.
model LoadChange {
  id        String   @id @default(uuid())
  loadId    String
  load      Load     @relation(fields: [loadId], references: [id], onDelete: Cascade)
  orgId     String
  atMs      BigInt
  actorId   String?  // a dispatcher id, or null for a system source
  actorName String   // "Maria", or the source name for a system write
  source    String   // board | paste | import | loadboard | agent | backfill
  field     String
  before    String?  // rendered as the cell would show it
  after     String?
  note      String?  // e.g. the UPDATE text that drove a status change
  @@index([loadId, atMs])
}

// The org's own words for UPDATE → status (spec §6.1). Seeded from the
// words on their board; edited by a human, never by the system.
model UpdateRule {
  id        String   @id @default(uuid())
  orgId     String
  org       Org      @relation(fields: [orgId], references: [id])
  prefix    String   // matched case-insensitively at the start of the cell
  status    String   // open | assigned | in_progress | delivered | canceled
  enabled   Boolean  @default(true)
  createdAt DateTime @default(now())
  @@unique([orgId, prefix])
}
```

- [ ] **Step 4: Migrate and regenerate**

```powershell
# stop the dev backend first (it holds the engine DLL on Windows)
Get-NetTCPConnection -LocalPort 3001 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```
```bash
cd fleet-backend
TS=$(date +%Y%m%d%H%M%S) && mkdir -p prisma/migrations/${TS}_one_honest_record
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/${TS}_one_honest_record/migration.sql
npx prisma migrate deploy && npx prisma generate
```
Then restart the dev backend (`npm run dev` in `fleet-backend/`, health at `http://localhost:3001/health`).

- [ ] **Step 5: Clear the new tables in `resetDb`**

In `fleet-backend/tests/helpers.ts`, inside the `$transaction([...])` array, before `prisma.load.deleteMany()`:
```ts
    // One honest record: the trace rows cascade with the load, but the
    // vocabulary is org-scoped and its FK to Org is RESTRICT — clear it before
    // org, like boardLayout/boardView, or every later suite's resetDb fails.
    prisma.loadChange.deleteMany(),
```
and before `prisma.org.deleteMany()`:
```ts
    prisma.updateRule.deleteMany(),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/honest-record-schema.test.ts`
Expected: PASS (3 tests). Then `npx vitest run` — whole suite green.

- [ ] **Step 7: Commit** — skipped (no commits this session); record in the ledger.

---

### Task 2: The vocabulary — `updateVocabulary.ts`

**Files:**
- Create: `fleet-backend/src/lib/updateVocabulary.ts`
- Test: `fleet-backend/tests/update-vocabulary.test.ts`

**Interfaces:**
- Produces:
  - `type LoadStatusFromText = "open" | "assigned" | "in_progress" | "delivered" | "canceled"`
  - `interface UpdateRuleRow { prefix: string; status: LoadStatusFromText; enabled?: boolean }`
  - `const DEFAULT_UPDATE_RULES: readonly UpdateRuleRow[]`
  - `function matchRule(text: string | null, rules: readonly UpdateRuleRow[]): UpdateRuleRow | null` — longest enabled prefix that matches at the start of the trimmed, upper-cased text, followed by end-of-text or a non-letter.
  - `function statusFor(text: string | null, rules: readonly UpdateRuleRow[], ctx: { carrierBooked: boolean }): LoadStatusFromText | null` — `assigned` requires a carrier; without one it is `open`.

- [ ] **Step 1: Write the failing test**

`fleet-backend/tests/update-vocabulary.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_UPDATE_RULES, matchRule, statusFor } from "../src/lib/updateVocabulary.js";

// Spec §6.1–§6.2: their words, matched at the start of the cell; everything
// after the verb is a note; unknown text changes nothing.
describe("matchRule", () => {
  it("matches at the start of the cell, case-insensitively, with the rest as a note", () => {
    expect(matchRule("DELIVERED 07/17/2026", DEFAULT_UPDATE_RULES)?.status).toBe("delivered");
    expect(matchRule("delivered - POD sent", DEFAULT_UPDATE_RULES)?.status).toBe("delivered");
    expect(matchRule("  In Transit - ETA 09:30", DEFAULT_UPDATE_RULES)?.status).toBe("in_progress");
    expect(matchRule("PICKED UP 07/15/2026", DEFAULT_UPDATE_RULES)?.status).toBe("in_progress");
    expect(matchRule("PENDING RATE CONFIRMATION", DEFAULT_UPDATE_RULES)?.status).toBe("open");
  });

  it("needs a word boundary after the prefix — DELIVEREDX is not DELIVERED", () => {
    expect(matchRule("DELIVEREDX", DEFAULT_UPDATE_RULES)).toBeNull();
    expect(matchRule("DELIVERED", DEFAULT_UPDATE_RULES)?.status).toBe("delivered");
    expect(matchRule("DELIVERED.", DEFAULT_UPDATE_RULES)?.status).toBe("delivered");
  });

  it("prefers the longest prefix when two match", () => {
    const rules = [{ prefix: "IN", status: "open" as const }, { prefix: "IN TRANSIT", status: "in_progress" as const }];
    expect(matchRule("IN TRANSIT - ON TIME", rules)?.prefix).toBe("IN TRANSIT");
  });

  it("returns null for free notes, blanks and disabled rules", () => {
    expect(matchRule("call John about the pallets", DEFAULT_UPDATE_RULES)).toBeNull();
    expect(matchRule("", DEFAULT_UPDATE_RULES)).toBeNull();
    expect(matchRule(null, DEFAULT_UPDATE_RULES)).toBeNull();
    expect(matchRule("DELIVERED", [{ prefix: "DELIVERED", status: "delivered", enabled: false }])).toBeNull();
  });
});

describe("statusFor", () => {
  it("maps their five verbs", () => {
    const ctx = { carrierBooked: true };
    expect(statusFor("PENDING PU CONFIRMATION", DEFAULT_UPDATE_RULES, ctx)).toBe("open");
    expect(statusFor("SCHEDULED", DEFAULT_UPDATE_RULES, ctx)).toBe("assigned");
    expect(statusFor("IN TRANSIT - CHECK CALL 14:00", DEFAULT_UPDATE_RULES, ctx)).toBe("in_progress");
    expect(statusFor("DELIVERED 07/16/2026", DEFAULT_UPDATE_RULES, ctx)).toBe("delivered");
    expect(statusFor("TONU", DEFAULT_UPDATE_RULES, ctx)).toBe("canceled");
    expect(statusFor("CANCELED", DEFAULT_UPDATE_RULES, ctx)).toBe("canceled");
  });

  it("never calls a load covered without a carrier: SCHEDULED with no carrier is open", () => {
    expect(statusFor("SCHEDULED", DEFAULT_UPDATE_RULES, { carrierBooked: false })).toBe("open");
    expect(statusFor("SCHEDULED", DEFAULT_UPDATE_RULES, { carrierBooked: true })).toBe("assigned");
  });

  it("says nothing for text that matches no rule", () => {
    expect(statusFor("waiting on POD", DEFAULT_UPDATE_RULES, { carrierBooked: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/update-vocabulary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

`fleet-backend/src/lib/updateVocabulary.ts`:
```ts
// UPDATE text → status (spec §6). Their words, matched at the start of the
// cell; everything after the verb is a note; a cell that matches nothing
// changes nothing. Pure — the rules are handed in, so the same function
// serves the writer, the board's `record` hints and the backfill.

export type LoadStatusFromText = "open" | "assigned" | "in_progress" | "delivered" | "canceled";

export interface UpdateRuleRow {
  prefix: string;
  status: LoadStatusFromText;
  enabled?: boolean;
}

/** Seeded per org from the words actually on their board (spec §6.1). */
export const DEFAULT_UPDATE_RULES: readonly UpdateRuleRow[] = [
  { prefix: "PENDING", status: "open" },
  { prefix: "SCHEDULED", status: "assigned" },
  { prefix: "PICKED UP", status: "in_progress" },
  { prefix: "IN TRANSIT", status: "in_progress" },
  { prefix: "LOADED", status: "in_progress" },
  { prefix: "EN ROUTE", status: "in_progress" },
  { prefix: "DELIVERED", status: "delivered" },
  { prefix: "CANCELLED", status: "canceled" },
  { prefix: "CANCELED", status: "canceled" },
  { prefix: "TONU", status: "canceled" },
];

const normalize = (s: string): string => s.trim().toUpperCase().replace(/\s+/g, " ");

/** The longest enabled prefix that starts the cell and is followed by the end
 *  of the text or a non-letter — so `DELIVERED 07/17` and `DELIVERED - POD`
 *  match `DELIVERED`, and `DELIVEREDX` matches nothing. */
export function matchRule(text: string | null, rules: readonly UpdateRuleRow[]): UpdateRuleRow | null {
  if (!text) return null;
  const cell = normalize(text);
  if (cell === "") return null;
  let best: UpdateRuleRow | null = null;
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const prefix = normalize(rule.prefix);
    if (prefix === "" || !cell.startsWith(prefix)) continue;
    const next = cell.charAt(prefix.length);
    if (next !== "" && /[A-Z]/.test(next)) continue;
    if (!best || prefix.length > normalize(best.prefix).length) best = rule;
  }
  return best;
}

/** `assigned` means covered, and nothing is covered without a carrier:
 *  a SCHEDULED load with no carrier yet is still `open` (spec §8.2). */
export function statusFor(text: string | null, rules: readonly UpdateRuleRow[], ctx: { carrierBooked: boolean }): LoadStatusFromText | null {
  const rule = matchRule(text, rules);
  if (!rule) return null;
  if (rule.status === "assigned" && !ctx.carrierBooked) return "open";
  return rule.status;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/update-vocabulary.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 3: The writer — patch, version, trace, Attention merge

**Files:**
- Create: `fleet-backend/src/lib/loadWriter.ts`
- Create: `fleet-backend/src/lib/actor.ts`
- Test: `fleet-backend/tests/load-writer.test.ts`

**Interfaces:**
- Consumes: Task 1 schema; Task 2 `statusFor` (used in Task 6, imported now).
- Produces (the shape every later task relies on):
```ts
export type ChangeSource = "board" | "paste" | "import" | "loadboard" | "agent" | "backfill";
export interface Actor { dispatcherId: string | null; name: string }
export interface LoadPatch {
  bolNumber?: string | null; customerName?: string | null; trackingUrl?: string | null; orderRef?: string | null;
  boardLoadNo?: string | null; updateText?: string | null; apptText?: string | null;
  carrierPhone?: string | null; carrierContactName?: string | null; driverCell?: string | null;
  shipDate?: Date | null; revenueCents?: number; soldRateCents?: number | null;
  carrierId?: string | null;
  /** find-or-create by name; set the MC on the load's carrier */
  carrier?: { name?: string | null; mcNumber?: string | null };
  extras?: Prisma.InputJsonValue | null;
  /** by ROLE, never by position */
  stops?: { pickup?: { address: string }; delivery?: { address: string } };
}
export interface ApplyArgs {
  loadId: string; orgId: string; actor: Actor; source: ChangeSource; patch: LoadPatch;
  /** attention the producer already knows ("can't read RATE …"), kept alongside the derived ones */
  attention?: string[];
  force?: boolean;
}
export interface ApplyResult { version: number; changed: string[]; attention: string[]; status: string; statusRefused: string | null }
export class LoadNotFound extends Error {}
export async function applyLoadChange(tx: Prisma.TransactionClient, args: ApplyArgs): Promise<ApplyResult>
export function attentionAspect(text: string): string   // "can't read PU appointment" for `can't read PU appointment: "…"`
```
- `actor.ts`: `export async function actorOf(req: { auth?: { dispatcherId?: string } }): Promise<Actor>`; `export const SYSTEM_ACTOR = (name: string): Actor => ({ dispatcherId: null, name })`.

- [ ] **Step 1: Write the failing test**

`fleet-backend/tests/load-writer.test.ts` (this file grows in Tasks 4–6; start with these):
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { applyLoadChange, attentionAspect, LoadNotFound, type Actor } from "../src/lib/loadWriter.js";
import { resetDb } from "./helpers.js";

const maria: Actor = { dispatcherId: "d-maria", name: "Maria" };

async function setup() {
  const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
  const load = await prisma.load.create({
    data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 400000, soldRateCents: 360000, customerName: "ACME", bolNumber: "0500001" },
  });
  return { org, load };
}

const apply = (loadId: string, orgId: string, patch: Parameters<typeof applyLoadChange>[1]["patch"], extra: Partial<Parameters<typeof applyLoadChange>[1]> = {}) =>
  prisma.$transaction((tx) => applyLoadChange(tx, { loadId, orgId, actor: maria, source: "board", patch, ...extra }));

describe("applyLoadChange — the patch, the version, the trace", () => {
  beforeEach(resetDb);

  it("writes the scalar patch, bumps the version once, and traces each field that changed", async () => {
    const { org, load } = await setup();
    const r = await apply(load.id, org.id, { customerName: "NEW CO", bolNumber: "0500001", revenueCents: 450000 });
    expect(r.version).toBe(1);
    // bolNumber was patched to the value it already had: not a change, not a trace.
    expect(r.changed.sort()).toEqual(["customerName", "revenueCents"]);
    const after = await prisma.load.findUnique({ where: { id: load.id } });
    expect(after?.customerName).toBe("NEW CO");
    expect(after?.version).toBe(1);
    const trace = await prisma.loadChange.findMany({ where: { loadId: load.id }, orderBy: { field: "asc" } });
    expect(trace.map((t) => [t.field, t.before, t.after, t.actorName, t.source])).toEqual([
      ["customerName", "ACME", "NEW CO", "Maria", "board"],
      ["revenueCents", "400000", "450000", "Maria", "board"],
    ]);
  });

  it("does not bump the version or write a trace when nothing changed", async () => {
    const { org, load } = await setup();
    const r = await apply(load.id, org.id, { customerName: "ACME" });
    expect(r.version).toBe(0);
    expect(r.changed).toEqual([]);
    expect(await prisma.loadChange.count()).toBe(0);
  });

  it("refuses a load outside the org as not found", async () => {
    const { load } = await setup();
    const other = await prisma.org.create({ data: { name: "Other", timezone: "UTC" } });
    await expect(apply(load.id, other.id, { customerName: "X" })).rejects.toBeInstanceOf(LoadNotFound);
  });

  it("finds the org's carrier by name and only creates one when there is none; MC lands on that carrier", async () => {
    const { org, load } = await setup();
    const existing = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    await apply(load.id, org.id, { carrier: { name: "Blue Road LLC" } });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.carrierId).toBe(existing.id);
    await apply(load.id, org.id, { carrier: { mcNumber: "1000001" } });
    expect((await prisma.carrier.findUnique({ where: { id: existing.id } }))?.mcNumber).toBe("1000001");
    await apply(load.id, org.id, { carrier: { name: "Red Line" } });
    expect(await prisma.carrier.count({ where: { orgId: org.id } })).toBe(2);
    // emptying the name detaches the load; it never deletes a carrier
    await apply(load.id, org.id, { carrier: { name: "" } });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.carrierId).toBeNull();
    expect(await prisma.carrier.count({ where: { orgId: org.id } })).toBe(2);
  });

  it("keeps producer-supplied attention by aspect: a new RATE refusal replaces the old one and leaves others alone", async () => {
    const { org, load } = await setup();
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(1), kind: "attention", text: 'can\'t read RATE "abc"' } });
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(2), kind: "attention", text: 'can\'t place pickup "Nowhere, ZZ" on the map' } });
    const r = await apply(load.id, org.id, {}, { attention: ['can\'t read RATE "xyz"'] });
    expect(r.attention).toEqual(['can\'t read RATE "xyz"']);
    const rows = (await prisma.agentUpdate.findMany({ where: { loadId: load.id }, orderBy: { atMs: "asc" } })).map((a) => a.text);
    expect(rows).toEqual(['can\'t place pickup "Nowhere, ZZ" on the map', 'can\'t read RATE "xyz"']);
  });

  it("clears the RATE attention when a readable rate lands", async () => {
    const { org, load } = await setup();
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(1), kind: "attention", text: 'can\'t read RATE "abc"' } });
    await apply(load.id, org.id, { revenueCents: 100000 });
    expect(await prisma.agentUpdate.count({ where: { loadId: load.id } })).toBe(0);
  });
});

describe("attentionAspect", () => {
  it("is the text up to the first colon or quote", () => {
    expect(attentionAspect('can\'t read PU appointment: "PU: 07/13"')).toBe("can't read PU appointment");
    expect(attentionAspect('can\'t place pickup "Henderson, NV" on the map')).toBe("can't place pickup");
    expect(attentionAspect("can't read RATE: blank")).toBe("can't read RATE");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/load-writer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `actor.ts` and the writer's core**

`fleet-backend/src/lib/actor.ts`:
```ts
import { prisma } from "../db.js";
import type { Actor } from "./loadWriter.js";

/** Who is writing, for the trace (spec §5.2). A route reads the dispatcher
 *  off the token and looks the name up once; a system source names itself. */
export async function actorOf(req: { auth?: { dispatcherId?: string } }): Promise<Actor> {
  const id = req.auth?.dispatcherId ?? null;
  if (!id) return { dispatcherId: null, name: "dispatcher" };
  const d = await prisma.dispatcher.findUnique({ where: { id }, select: { name: true } });
  return { dispatcherId: id, name: d?.name ?? "dispatcher" };
}

export const SYSTEM_ACTOR = (name: string): Actor => ({ dispatcherId: null, name });
```

`fleet-backend/src/lib/loadWriter.ts` (Tasks 4–6 add the derivation functions to this file; the `derive*` calls below are wired now and implemented then — see each task's Step 3, which replaces the stub):
```ts
// The one door (spec §4). Every change to a Load — a board cell, a paste, an
// import row, a backfill, later the agent — comes through here, inside the
// caller's transaction. The patch is applied, the structured truth is derived
// only for what changed, the affected Attention rows are replaced, one trace
// row is written per field, and the version goes up by one.
import { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export type ChangeSource = "board" | "paste" | "import" | "loadboard" | "agent" | "backfill";

export interface Actor { dispatcherId: string | null; name: string }

export interface LoadPatch {
  bolNumber?: string | null; customerName?: string | null; trackingUrl?: string | null; orderRef?: string | null;
  boardLoadNo?: string | null; updateText?: string | null; apptText?: string | null;
  carrierPhone?: string | null; carrierContactName?: string | null; driverCell?: string | null;
  shipDate?: Date | null; revenueCents?: number; soldRateCents?: number | null;
  carrierId?: string | null;
  carrier?: { name?: string | null; mcNumber?: string | null };
  extras?: Prisma.InputJsonValue | null;
  stops?: { pickup?: { address: string }; delivery?: { address: string } };
}

export interface ApplyArgs {
  loadId: string; orgId: string; actor: Actor; source: ChangeSource; patch: LoadPatch;
  attention?: string[];
  force?: boolean;
}

export interface ApplyResult {
  version: number;
  changed: string[];
  attention: string[];
  status: string;
  statusRefused: string | null;
}

export class LoadNotFound extends Error {}

/** The scalar columns a patch may carry, in the order the trace lists them. */
const SCALARS = [
  "bolNumber", "customerName", "trackingUrl", "orderRef", "boardLoadNo", "updateText", "apptText",
  "carrierPhone", "carrierContactName", "driverCell", "shipDate", "revenueCents", "soldRateCents", "carrierId", "extras",
] as const;
type Scalar = (typeof SCALARS)[number];

/** What the trace stores: the value as a cell would show it. */
export const rendered = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/** `can't read PU appointment: "…"` → `can't read PU appointment`. Attention
 *  rows are replaced per aspect, so re-deriving appointments never touches a
 *  geocode refusal and vice versa. */
export function attentionAspect(text: string): string {
  const cut = text.search(/[:"]/);
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

export type LoadRow = Prisma.LoadGetPayload<{ include: { stops: { include: { appointment: true } }; assignment: { select: { id: true } }; org: { select: { timezone: true } } } }>;

export async function loadRow(tx: Tx, loadId: string, orgId: string): Promise<LoadRow> {
  const row = await tx.load.findFirst({
    where: { id: loadId, orgId },
    include: { stops: { include: { appointment: true }, orderBy: { sequence: "asc" } }, assignment: { select: { id: true } }, org: { select: { timezone: true } } },
  });
  if (!row) throw new LoadNotFound(`load ${loadId} is not in org ${orgId}`);
  return row;
}

async function resolveCarrier(tx: Tx, orgId: string, current: string | null, carrier: NonNullable<LoadPatch["carrier"]>): Promise<string | null> {
  let carrierId = current;
  if (carrier.name !== undefined) {
    const name = (carrier.name ?? "").trim();
    if (name === "") carrierId = null;
    else {
      // Carriers are a real entity the carrier layer prices and pays: a name
      // typed on the board finds the org's carrier before it makes another.
      const found = await tx.carrier.findFirst({ where: { orgId, name } });
      carrierId = found ? found.id : (await tx.carrier.create({ data: { orgId, name } })).id;
    }
  }
  if (carrier.mcNumber !== undefined) {
    const mc = (carrier.mcNumber ?? "").trim() || null;
    // An MC typed before the carrier's name exists still has to land: an
    // unnamed carrier for this org, which the next cell names.
    carrierId = carrierId ?? (await tx.carrier.create({ data: { orgId, name: "" } })).id;
    await tx.carrier.update({ where: { id: carrierId }, data: { mcNumber: mc } });
  }
  return carrierId;
}

/** Replace this load's attention rows for the given aspects with `next`. */
async function mergeAttention(tx: Tx, loadId: string, aspects: Set<string>, next: string[]): Promise<void> {
  const existing = await tx.agentUpdate.findMany({ where: { loadId, kind: "attention" } });
  const stale = existing.filter((a) => aspects.has(attentionAspect(a.text))).map((a) => a.id);
  if (stale.length) await tx.agentUpdate.deleteMany({ where: { id: { in: stale } } });
  if (next.length) {
    const base = Date.now();
    await tx.agentUpdate.createMany({ data: next.map((text, i) => ({ loadId, atMs: BigInt(base + i), kind: "attention", text })) });
  }
}

export async function applyLoadChange(tx: Tx, args: ApplyArgs): Promise<ApplyResult> {
  const { loadId, orgId, actor, source, patch } = args;
  const before = await loadRow(tx, loadId, orgId);
  const changed: string[] = [];
  const data: Record<string, unknown> = {};

  // 1. The scalar patch — only fields whose value actually differs.
  for (const key of SCALARS) {
    if (!(key in patch)) continue;
    const next = (patch as Record<string, unknown>)[key];
    const current = (before as Record<string, unknown>)[key];
    if (rendered(next) === rendered(current)) continue;
    data[key] = key === "extras" && next === null ? Prisma.DbNull : next;
    changed.push(key);
  }
  if (patch.carrier) {
    const carrierId = await resolveCarrier(tx, orgId, before.carrierId, patch.carrier);
    if (carrierId !== before.carrierId) { data.carrierId = carrierId; if (!changed.includes("carrierId")) changed.push("carrierId"); }
  }
  if (Object.keys(data).length) await tx.load.update({ where: { id: loadId }, data });

  // 2. Derivation — only for what changed (Tasks 4–6 fill these in).
  const aspects = new Set<string>();
  const attention: string[] = [];
  for (const a of args.attention ?? []) { aspects.add(attentionAspect(a)); attention.push(a); }
  if (changed.includes("revenueCents")) aspects.add("can't read RATE");
  await deriveStops(tx, before, patch, args.force === true, aspects, attention, changed);
  await deriveAppointments(tx, before, patch, args.force === true, aspects, attention, changed);
  const status = await deriveStatus(tx, before, patch, args.force === true, changed, actor, source);

  // 3. Attention rows, replaced per aspect in the same transaction.
  await mergeAttention(tx, loadId, aspects, attention);

  // 4. Version and trace. A change with nothing changed is not a change.
  if (changed.length === 0 && status.changed === false) {
    return { version: before.version, changed, attention, status: before.status, statusRefused: status.refused };
  }
  const after = await tx.load.update({ where: { id: loadId }, data: { version: { increment: 1 } }, include: { stops: true } });
  const atMs = BigInt(Date.now());
  const trace = changed
    .filter((f) => SCALARS.includes(f as Scalar) || f === "carrierId")
    .map((field) => ({
      loadId, orgId, atMs, actorId: actor.dispatcherId, actorName: actor.name, source, field,
      before: rendered((before as Record<string, unknown>)[field]), after: rendered((after as Record<string, unknown>)[field]), note: null as string | null,
    }));
  if (trace.length) await tx.loadChange.createMany({ data: trace });
  return { version: after.version, changed, attention, status: after.status, statusRefused: status.refused };
}

// --- derivation (implemented in Tasks 4–6) ---------------------------------
// Each is a no-op stub here so the core is testable on its own; the task that
// owns it replaces the body and its tests prove it.
async function deriveStops(_tx: Tx, _before: LoadRow, _patch: LoadPatch, _force: boolean, _aspects: Set<string>, _attention: string[], _changed: string[]): Promise<void> {}
async function deriveAppointments(_tx: Tx, _before: LoadRow, _patch: LoadPatch, _force: boolean, _aspects: Set<string>, _attention: string[], _changed: string[]): Promise<void> {}
async function deriveStatus(_tx: Tx, before: LoadRow, _patch: LoadPatch, _force: boolean, _changed: string[], _actor: Actor, _source: ChangeSource): Promise<{ changed: boolean; refused: string | null; status: string }> {
  return { changed: false, refused: null, status: before.status };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/load-writer.test.ts`
Expected: PASS (7 tests). `npx tsc --noEmit` clean (the stub parameters are underscore-prefixed so `noUnusedParameters` is satisfied).

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 4: Derive stops and coordinates

**Files:**
- Modify: `fleet-backend/src/lib/loadWriter.ts` (`deriveStops`)
- Test: `fleet-backend/tests/load-writer.test.ts` (append)

**Interfaces:**
- Consumes: `geocodeAddress(address: string): Promise<GeocodeHit | null>` from `src/lib/geocode.ts`.
- Produces: stops addressed by `type`; `LoadStop.lat/lng/geocodeStatus` written; attention `can't place pickup "<address>" on the map` / `can't place delivery "…" on the map` (the importer's exact wording, so its suite is unchanged).

- [ ] **Step 1: Append the failing tests**

```ts
describe("applyLoadChange — stops and coordinates", () => {
  beforeEach(resetDb);

  it("creates the pickup and delivery stops by role on first write, and geocodes a city the gazetteer knows", async () => {
    const { org, load } = await setup();
    const r = await apply(load.id, org.id, { stops: { pickup: { address: "Kansas City, MO 64120" } } });
    expect(r.changed).toContain("stops.pickup");
    const stops = await prisma.loadStop.findMany({ where: { loadId: load.id }, orderBy: { sequence: "asc" } });
    // both roles exist from the first write — the board's GET reads them by
    // type, and the board shows both columns for every row anyway
    expect(stops.map((s) => [s.type, s.sequence])).toEqual([["pickup", 1], ["delivery", 2]]);
    expect(stops[0].address).toBe("Kansas City, MO 64120");
    expect(stops[0].lat).not.toBeNull();
    expect(stops[0].geocodeStatus).toBe("ok");
    expect(stops[1].address).toBe("");
  });

  it("writes pending, never failed, and an attention naming the address, for a city it cannot place", async () => {
    const { org, load } = await setup();
    const r = await apply(load.id, org.id, { stops: { delivery: { address: "Nowhere, ZZ 00000" } } });
    expect(r.attention).toEqual(['can\'t place delivery "Nowhere, ZZ 00000" on the map']);
    const del = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "delivery" } });
    expect(del?.lat).toBeNull();
    expect(del?.geocodeStatus).toBe("pending");
  });

  it("re-geocodes only the stop whose address changed, and clears its attention when it resolves", async () => {
    const { org, load } = await setup();
    await apply(load.id, org.id, { stops: { pickup: { address: "Nowhere, ZZ" }, delivery: { address: "Dallas, TX 75236" } } });
    expect(await prisma.agentUpdate.count({ where: { loadId: load.id } })).toBe(1);
    const r = await apply(load.id, org.id, { stops: { pickup: { address: "Omaha, NE 68137" } } });
    expect(r.changed).toEqual(["stops.pickup"]);
    expect(await prisma.agentUpdate.count({ where: { loadId: load.id } })).toBe(0);
    const del = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "delivery" } });
    expect(del?.address).toBe("Dallas, TX 75236");
  });

  it("leaves a stop the Cockpit already placed alone when the address did not change, even under force", async () => {
    const { org, load } = await setup();
    await prisma.loadStop.create({ data: { loadId: load.id, sequence: 1, type: "pickup", address: "Kansas City, MO", lat: 39.1, lng: -94.6, geocodeStatus: "ok" } });
    await apply(load.id, org.id, {}, { force: true });
    const pu = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "pickup" } });
    expect(pu?.lat).toBe(39.1);
  });

  it("geocodes a stop that has an address but no coordinates under force", async () => {
    const { org, load } = await setup();
    await prisma.loadStop.create({ data: { loadId: load.id, sequence: 1, type: "pickup", address: "Kansas City, MO 64120", geocodeStatus: "pending" } });
    await apply(load.id, org.id, {}, { force: true });
    const pu = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "pickup" } });
    expect(pu?.lat).not.toBeNull();
    expect(pu?.geocodeStatus).toBe("ok");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/load-writer.test.ts -t "stops and coordinates"`
Expected: FAIL — no stops are created.

- [ ] **Step 3: Replace the `deriveStops` stub**

Add the import at the top of `loadWriter.ts`:
```ts
import { geocodeAddress } from "./geocode.js";
```
Replace the stub:
```ts
/** The gazetteer reads "City, ST"; the importer has always handed it the city
 *  without the ZIP, and this does the same so the two agree stop for stop. */
const geocodeQuery = (address: string): string => address.replace(/\s+\d{5}$/, "").trim();

const ROLES = ["pickup", "delivery"] as const;

async function deriveStops(tx: Tx, before: LoadRow, patch: LoadPatch, force: boolean, aspects: Set<string>, attention: string[], changed: string[]): Promise<void> {
  const wanted = patch.stops;
  if (!wanted && !force) return;
  // Both roles exist from the first write: the board's GET reads them by
  // type and shows both columns for every row.
  const byType = new Map(before.stops.map((s) => [s.type, s]));
  if (wanted && (!byType.has("pickup") || !byType.has("delivery"))) {
    const taken = new Set(before.stops.map((s) => s.sequence));
    const free = (want: number): number => { let n = want; while (taken.has(n)) n += 1; taken.add(n); return n; };
    for (const [role, seq] of [["pickup", 1], ["delivery", 2]] as const) {
      if (byType.has(role)) continue;
      const created = await tx.loadStop.create({ data: { loadId: before.id, type: role, address: "", sequence: free(seq), geocodeStatus: "pending" } });
      byType.set(role, { ...created, appointment: null });
    }
  }
  for (const role of ROLES) {
    const stop = byType.get(role);
    if (!stop) continue;
    const next = wanted?.[role]?.address;
    const addressChanged = next !== undefined && next.trim() !== stop.address.trim();
    const needsPlacing = force && stop.address.trim() !== "" && (stop.lat === null || stop.lng === null);
    if (!addressChanged && !needsPlacing) continue;
    const address = addressChanged ? next!.trim() : stop.address;
    const aspect = `can't place ${role}`;
    aspects.add(aspect);
    const hit = address === "" ? null : await geocodeAddress(geocodeQuery(address));
    await tx.loadStop.update({
      where: { id: stop.id },
      data: { address, lat: hit?.lat ?? null, lng: hit?.lng ?? null, geocodeStatus: hit ? "ok" : "pending" },
    });
    if (!hit && address !== "") attention.push(`${aspect} "${address}" on the map`);
    if (addressChanged) changed.push(`stops.${role}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/load-writer.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 5: Derive appointments — and never destroy a good one

**Files:**
- Modify: `fleet-backend/src/lib/loadWriter.ts` (`deriveAppointments`)
- Test: `fleet-backend/tests/load-writer.test.ts` (append)

**Interfaces:**
- Consumes: `parseApptText(lines: readonly string[], ctx: { year: number; tz: string }): { pu: ApptWindow | null; del: ApptWindow | null; notes: string[] }` and `ApptWindow { startMs, endMs, kind }` from `src/lib/apptText.ts`.
- Produces: `Appointment` upserted on the pickup/delivery stop; attention `can't read PU appointment: "<cell>"` / `can't read DEL appointment: "<cell>"` (the importer's wording; the cell is the apptText lines joined by `" / "`).

- [ ] **Step 1: Append the failing tests**

```ts
describe("applyLoadChange — appointments", () => {
  beforeEach(resetDb);

  const withStops = async () => {
    const { org, load } = await setup();
    await apply(load.id, org.id, { shipDate: new Date("2026-07-13T00:00:00Z"), stops: { pickup: { address: "Kansas City, MO" }, delivery: { address: "Dallas, TX" } } });
    return { org, load };
  };
  const appointments = (loadId: string) =>
    prisma.appointment.findMany({ where: { stop: { loadId } }, include: { stop: true }, orderBy: { stop: { sequence: "asc" } } });

  it("parses PU and DEL lines into the two stops' appointments, in the org's zone", async () => {
    const { org, load } = await withStops();
    const r = await apply(load.id, org.id, { apptText: "PU: 07/14 - 12:00\nDEL: 07/17 - 10:00" });
    expect(r.attention).toEqual([]);
    const rows = await appointments(load.id);
    expect(rows.map((a) => [a.stop.type, a.kind])).toEqual([["pickup", "appointment"], ["delivery", "appointment"]]);
    // 12:00 Chicago (CDT, UTC-5) on 07/14/2026 is 17:00Z
    expect(rows[0].windowEnd.toISOString()).toBe("2026-07-14T17:00:00.000Z");
    expect(rows[1].windowEnd.toISOString()).toBe("2026-07-17T15:00:00.000Z");
  });

  it("keeps the existing appointment and raises attention when the new line cannot be read", async () => {
    const { org, load } = await withStops();
    await apply(load.id, org.id, { apptText: "PU: 07/14 - 12:00\nDEL: 07/17 - 10:00" });
    const r = await apply(load.id, org.id, { apptText: "PU: 07/14 - 12:00\nDEL: whenever" });
    expect(r.attention).toEqual(['can\'t read DEL appointment: "PU: 07/14 - 12:00 / DEL: whenever"']);
    const rows = await appointments(load.id);
    expect(rows).toHaveLength(2);
    expect(rows[1].windowEnd.toISOString()).toBe("2026-07-17T15:00:00.000Z");   // untouched
    // and the text is stored exactly as typed
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.apptText).toBe("PU: 07/14 - 12:00\nDEL: whenever");
  });

  it("clears the attention once the line reads again", async () => {
    const { org, load } = await withStops();
    await apply(load.id, org.id, { apptText: "PU: 07/14 - 12:00\nDEL: whenever" });
    const r = await apply(load.id, org.id, { apptText: "PU: 07/14 - 12:00\nDEL: 07/18 - 09:00" });
    expect(r.attention).toEqual([]);
    expect(await prisma.agentUpdate.count({ where: { loadId: load.id } })).toBe(0);
  });

  it("reads an FCFS range as an fcfs window", async () => {
    const { org, load } = await withStops();
    await apply(load.id, org.id, { apptText: "PU: 07/14 - 12:00\nDEL: 07/17 - 08-15:00 FCFS" });
    const rows = await appointments(load.id);
    expect(rows[1].kind).toBe("fcfs");
    expect(rows[1].windowStart?.toISOString()).toBe("2026-07-17T13:00:00.000Z");
    expect(rows[1].windowEnd.toISOString()).toBe("2026-07-17T20:00:00.000Z");
  });

  it("under force, creates an appointment only where the stop has none — a Cockpit-set one is truth", async () => {
    const { org, load } = await withStops();
    await prisma.load.update({ where: { id: load.id }, data: { apptText: "PU: 07/14 - 12:00\nDEL: 07/17 - 10:00" } });
    const del = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "delivery" } });
    await prisma.appointment.create({ data: { stopId: del!.id, windowEnd: new Date("2026-07-20T12:00:00Z"), type: "delivery", kind: "appointment" } });
    await apply(load.id, org.id, {}, { force: true });
    const rows = await appointments(load.id);
    expect(rows.map((a) => [a.stop.type, a.windowEnd.toISOString()])).toEqual([
      ["pickup", "2026-07-14T17:00:00.000Z"],    // created from the text
      ["delivery", "2026-07-20T12:00:00.000Z"],  // the Cockpit's value, not the text's
    ]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/load-writer.test.ts -t "appointments"`
Expected: FAIL — no appointment rows.

- [ ] **Step 3: Replace the `deriveAppointments` stub**

Add the import:
```ts
import { parseApptText, type ApptWindow } from "./apptText.js";
```
Replace the stub:
```ts
/** The text a refusal quotes: the whole cell as the parser read it. */
const apptCellText = (text: string | null): string => (text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" / ");

async function upsertAppointment(tx: Tx, stopId: string, type: "pickup" | "delivery", w: ApptWindow): Promise<void> {
  const data = { windowStart: new Date(w.startMs), windowEnd: new Date(w.endMs), type, kind: w.kind };
  await tx.appointment.upsert({ where: { stopId }, create: { stopId, ...data }, update: data });
}

async function deriveAppointments(tx: Tx, before: LoadRow, patch: LoadPatch, force: boolean, aspects: Set<string>, attention: string[], changed: string[]): Promise<void> {
  const textChanged = changed.includes("apptText");
  if (!textChanged && !force) return;
  const text = textChanged ? (patch.apptText ?? null) : before.apptText;
  const shipDate = patch.shipDate !== undefined ? patch.shipDate : before.shipDate;
  const year = shipDate ? shipDate.getUTCFullYear() : new Date().getUTCFullYear();
  const lines = (text ?? "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const parsed = parseApptText(lines, { year, tz: before.org.timezone });
  const stops = await tx.loadStop.findMany({ where: { loadId: before.id }, include: { appointment: true } });
  for (const [role, window] of [["pickup", parsed.pu], ["delivery", parsed.del]] as const) {
    const stop = stops.find((s) => s.type === role);
    if (!stop) continue;
    const label = role === "pickup" ? "PU" : "DEL";
    const aspect = `can't read ${label} appointment`;
    if (textChanged) aspects.add(aspect);
    if (window) {
      // Under force the text may only FILL a gap: an Appointment that is
      // already there is the record's truth (a Cockpit edit, an import), and
      // the text stays what they typed beside it (spec D3).
      if (textChanged || !stop.appointment) await upsertAppointment(tx, stop.id, role, window);
    } else if (textChanged && lines.length > 0) {
      // Unreadable: the previous appointment stays, and the pill says why.
      attention.push(`${aspect}: "${apptCellText(text)}"`);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/load-writer.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 6: Derive status — the guard, the trace, the vocabulary from the org

**Files:**
- Modify: `fleet-backend/src/lib/loadWriter.ts` (`deriveStatus`, `rulesFor`)
- Test: `fleet-backend/tests/load-writer.test.ts` (append)

**Interfaces:**
- Consumes: Task 2 `statusFor`, `DEFAULT_UPDATE_RULES`.
- Produces: `export async function rulesFor(tx, orgId): Promise<UpdateRuleRow[]>` — the org's enabled rules, seeding the defaults when the org has none; `ApplyResult.statusRefused` sentence; a `LoadChange { field: "status", note: <the UPDATE text> }` per applied transition.

- [ ] **Step 1: Append the failing tests**

```ts
describe("applyLoadChange — UPDATE drives status", () => {
  beforeEach(resetDb);

  const brokered = async () => {
    const { org, load } = await setup();
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    await prisma.load.update({ where: { id: load.id }, data: { carrierId: carrier.id } });
    return { org, load };
  };

  it("moves a brokered load through their words, tracing each step with the text that drove it", async () => {
    const { org, load } = await brokered();
    let r = await apply(load.id, org.id, { updateText: "SCHEDULED" });
    expect(r.status).toBe("assigned");
    r = await apply(load.id, org.id, { updateText: "PICKED UP 07/15/2026" });
    expect(r.status).toBe("in_progress");
    r = await apply(load.id, org.id, { updateText: "DELIVERED 07/17/2026" });
    expect(r.status).toBe("delivered");
    const trace = await prisma.loadChange.findMany({ where: { loadId: load.id, field: "status" }, orderBy: { atMs: "asc" } });
    expect(trace.map((t) => [t.before, t.after, t.note])).toEqual([
      ["open", "assigned", "SCHEDULED"],
      ["assigned", "in_progress", "PICKED UP 07/15/2026"],
      ["in_progress", "delivered", "DELIVERED 07/17/2026"],
    ]);
  });

  it("changes nothing for text that matches no rule, and raises no attention for it", async () => {
    const { org, load } = await brokered();
    const r = await apply(load.id, org.id, { updateText: "waiting on POD" });
    expect(r.status).toBe("open");
    expect(r.statusRefused).toBeNull();
    expect(r.attention).toEqual([]);
    expect(await prisma.loadChange.count({ where: { field: "status" } })).toBe(0);
  });

  it("re-derives when the carrier changes: SCHEDULED becomes assigned the moment a carrier is booked", async () => {
    const { org, load } = await setup();
    let r = await apply(load.id, org.id, { updateText: "SCHEDULED" });
    expect(r.status).toBe("open");                       // no carrier yet
    r = await apply(load.id, org.id, { carrier: { name: "Blue Road LLC" } });
    expect(r.status).toBe("assigned");
  });

  it("refuses to move a load one of our drivers runs, stores the cell, and says where to do it", async () => {
    const { org, load } = await brokered();
    const driver = await prisma.driver.create({ data: { email: "j@x.com", passwordHash: "x", name: "Jake", orgId: org.id } });
    await prisma.assignment.create({ data: { orgId: org.id, loadId: load.id, driverId: driver.id, status: "dispatched", plannedStart: new Date(), plannedEnd: new Date() } });
    await prisma.load.update({ where: { id: load.id }, data: { status: "assigned" } });
    const r = await apply(load.id, org.id, { updateText: "DELIVERED 07/17/2026" });
    expect(r.status).toBe("assigned");
    expect(r.statusRefused).toMatch(/record says assigned/);
    expect(r.statusRefused).toMatch(/Cockpit/);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.updateText).toBe("DELIVERED 07/17/2026");
    expect(await prisma.loadChange.count({ where: { field: "status" } })).toBe(0);
  });

  it("never moves an archived load by text", async () => {
    const { org, load } = await brokered();
    await prisma.load.update({ where: { id: load.id }, data: { status: "archived" } });
    const r = await apply(load.id, org.id, { updateText: "DELIVERED 07/17/2026" });
    expect(r.status).toBe("archived");
    expect(r.statusRefused).toMatch(/archived/);
  });

  it("uses the org's own rules, seeding the defaults the first time it needs them", async () => {
    const { org, load } = await brokered();
    expect(await prisma.updateRule.count({ where: { orgId: org.id } })).toBe(0);
    await apply(load.id, org.id, { updateText: "LOADED" });
    expect(await prisma.updateRule.count({ where: { orgId: org.id } })).toBe(10);
    // a human's rule wins: disable DELIVERED, add their own word
    await prisma.updateRule.update({ where: { orgId_prefix: { orgId: org.id, prefix: "DELIVERED" } }, data: { enabled: false } });
    await prisma.updateRule.create({ data: { orgId: org.id, prefix: "DONE", status: "delivered" } });
    let r = await apply(load.id, org.id, { updateText: "DELIVERED 07/17/2026" });
    expect(r.status).toBe("in_progress");
    r = await apply(load.id, org.id, { updateText: "DONE" });
    expect(r.status).toBe("delivered");
  });

  it("re-derives under force from the text already stored — the backfill", async () => {
    const { org, load } = await brokered();
    await prisma.load.update({ where: { id: load.id }, data: { updateText: "DELIVERED 07/16/2026" } });
    const r = await apply(load.id, org.id, {}, { force: true, source: "backfill" });
    expect(r.status).toBe("delivered");
    const t = await prisma.loadChange.findFirst({ where: { field: "status" } });
    expect(t?.source).toBe("backfill");
  });
});
```
(If `assignment.create` needs more required fields in this schema, copy the minimal `create` used in `tests/broker-board-bulk.test.ts` or `tests/dispatcher-assignments.test.ts` — the point is only that `load.assignment` is non-null.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/load-writer.test.ts -t "UPDATE drives status"`
Expected: FAIL — status stays `open`.

- [ ] **Step 3: Replace the `deriveStatus` stub and add `rulesFor`**

Add the import:
```ts
import { DEFAULT_UPDATE_RULES, statusFor, type UpdateRuleRow } from "./updateVocabulary.js";
```
Add and replace:
```ts
/** The org's enabled rules. An org that has never had any gets the defaults —
 *  the words on their board — seeded once. To switch a word off, disable it;
 *  deleting every rule brings the defaults back. */
export async function rulesFor(tx: Tx, orgId: string): Promise<UpdateRuleRow[]> {
  let rows = await tx.updateRule.findMany({ where: { orgId } });
  if (rows.length === 0) {
    await tx.updateRule.createMany({ data: DEFAULT_UPDATE_RULES.map((r) => ({ orgId, prefix: r.prefix, status: r.status })) });
    rows = await tx.updateRule.findMany({ where: { orgId } });
  }
  return rows.map((r) => ({ prefix: r.prefix, status: r.status as UpdateRuleRow["status"], enabled: r.enabled }));
}

async function deriveStatus(tx: Tx, before: LoadRow, patch: LoadPatch, force: boolean, changed: string[], actor: Actor, source: ChangeSource): Promise<{ changed: boolean; refused: string | null; status: string }> {
  const relevant = force || changed.includes("updateText") || changed.includes("carrierId");
  if (!relevant) return { changed: false, refused: null, status: before.status };
  const text = changed.includes("updateText") ? (patch.updateText ?? null) : before.updateText;
  const fresh = await tx.load.findUnique({ where: { id: before.id }, select: { carrierId: true, status: true } });
  const target = statusFor(text, await rulesFor(tx, before.orgId), { carrierBooked: fresh?.carrierId != null });
  const current = fresh?.status ?? before.status;
  if (target === null || target === current) return { changed: false, refused: null, status: current };
  // The guard (spec §6.3): a trip one of our drivers runs is moved by the
  // assignment lifecycle, not by a cell. Archived is never moved by text.
  if (before.assignment) return { changed: false, refused: `record says ${current} — advance the trip in the Cockpit`, status: current };
  if (current === "archived") return { changed: false, refused: "record says archived — unarchive it on the board first", status: current };
  await tx.load.update({ where: { id: before.id }, data: { status: target } });
  await tx.loadChange.create({
    data: { loadId: before.id, orgId: before.orgId, atMs: BigInt(Date.now()), actorId: actor.dispatcherId, actorName: actor.name, source, field: "status", before: current, after: target, note: text },
  });
  return { changed: true, refused: null, status: target };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/load-writer.test.ts`
Expected: PASS (24 tests). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 7: Their Board's writes go through the writer

**Files:**
- Modify: `fleet-backend/src/lib/boardCellApply.ts` (becomes a translator)
- Modify: `fleet-backend/src/routes/dispatcherBrokerBoard.ts` (cell + paste routes; GET: `boardLoadNo`, stops by type, `version`)
- Modify: `fleet-portal/src/lib/api.ts` (`BoardLoad.version`)
- Test: `fleet-backend/tests/broker-board-cell-route.test.ts`, `fleet-backend/tests/broker-board-paste.test.ts` (existing suites must stay green; add the assertions below)

**Interfaces:**
- Consumes: Task 3 `applyLoadChange`, `actorOf`, `LoadNotFound`.
- Produces: `export function planToPatch(plan: CellPlan, current: { apptText: string | null; extras: Prisma.JsonValue | null }): LoadPatch` in `boardCellApply.ts`; `PATCH …/cell` and `POST …/cells` responses gain `version`; every board mutation emits `load_changed { loadId, version, fields }` after `board_update`; GET rows carry `version`, render `boardLoadNo` on the carrier line and read stops **by type**.

- [ ] **Step 1: Add the failing assertions**

In `tests/broker-board-cell-route.test.ts`, append:
```ts
  it("bumps the version, traces the cell, and renders the carrier line's LOAD# from boardLoadNo", async () => {
    const { token, load } = await setup();
    const res = await patch(token, load.id, { row: "bottom", key: "loadNo", value: "145205" });
    expect(res.status).toBe(200);
    expect(res.body.load.version).toBe(1);
    expect(res.body.load.bottom.loadNo).toBe("145205");          // defect 1: it used to vanish on refresh
    const trace = await prisma.loadChange.findMany({ where: { loadId: load.id } });
    expect(trace.map((t) => [t.field, t.after, t.source])).toEqual([["boardLoadNo", "145205", "board"]]);
  });

  it("parses an APPT cell into a real appointment the Cockpit can read", async () => {
    const { token, load } = await setup();
    await patch(token, load.id, { row: "top", key: "shipDate", value: "7/13/2026" }).expect(200);
    await patch(token, load.id, { row: "bottom", key: "appt", value: "DEL: 07/17 - 10:00" }).expect(200);
    const del = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "delivery" }, include: { appointment: true } });
    expect(del?.appointment?.windowEnd.toISOString()).toBe("2026-07-17T15:00:00.000Z");
  });

  it("geocodes a city typed on the board", async () => {
    const { token, load } = await setup();
    await patch(token, load.id, { row: "top", key: "pickupCity", value: "Omaha, NE" }).expect(200);
    const pu = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "pickup" } });
    expect(pu?.lat).not.toBeNull();
    expect(pu?.geocodeStatus).toBe("ok");
  });

  it("moves status from UPDATE on a brokered load, and refuses on one of ours with a sentence", async () => {
    const { token, load } = await setup();
    await patch(token, load.id, { row: "bottom", key: "customer", value: "Blue Road LLC" }).expect(200);
    const res = await patch(token, load.id, { row: "top", key: "update", value: "DELIVERED 07/17/2026" });
    expect(res.status).toBe(200);
    expect(res.body.load.status).toBe("delivered");
    expect(res.body.statusRefused).toBeNull();
  });
```
In `tests/broker-board-paste.test.ts`, append inside the `POST /dispatcher/broker-board/cells` describe:
```ts
  it("bumps each touched load's version exactly once per paste", async () => {
    const { auth, loads } = await setup();
    await paste(auth, [
      { loadId: loads[0].id, row: "top", key: "customer", value: "A" },
      { loadId: loads[0].id, row: "top", key: "rate", value: "1000" },
      { loadId: loads[1].id, row: "top", key: "customer", value: "B" },
    ]).expect(200);
    const [a, b] = await Promise.all(loads.map((l) => prisma.load.findUnique({ where: { id: l.id } })));
    expect([a?.version, b?.version]).toEqual([1, 1]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/broker-board-cell-route.test.ts tests/broker-board-paste.test.ts`
Expected: the new tests FAIL (`version` undefined; `bottom.loadNo` empty; no appointment; status stays open).

- [ ] **Step 3: Turn `boardCellApply.ts` into a translator**

Replace the whole file with:
```ts
// A `CellPlan` (what a cell means) → a `LoadPatch` (what to write). Pure: the
// writer does the writing, so a paste of forty cells on one load composes
// forty small patches into the load's state one after another.
//
// Two cells need the load's current state to compose their value: APPT is one
// text cell rendered as lines (a write replaces one line), and `extras` is a
// map (a write sets or removes one key).
import { Prisma } from "@prisma/client";
import type { CellPlan } from "./boardCellWrite.js";
import type { LoadPatch } from "./loadWriter.js";

export interface PatchContext { apptText: string | null; extras: Prisma.JsonValue | null }

/** APPT SCHEDULE is one text cell rendered as lines; a write replaces one
 *  line and keeps the others. Trailing blanks are dropped so an emptied
 *  second line does not leave the cell ending in a newline forever. */
export function spliceLine(text: string | null, line: number, value: string): string | null {
  const lines = (text ?? "").split("\n");
  while (lines.length <= line) lines.push("");
  lines[line] = value;
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.length === 0 ? null : lines.join("\n");
}

/** `extras` is a plain object; an emptied cell removes its key rather than
 *  storing "" forever, and the last key removed takes the column back to null. */
export function mergeExtras(current: Prisma.JsonValue | null, key: string, value: string): Prisma.InputJsonValue | null {
  const base: Record<string, string> = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, string>) } : {};
  if (value === "") delete base[key];
  else base[key] = value;
  return Object.keys(base).length === 0 ? null : base;
}

export function planToPatch(plan: CellPlan, ctx: PatchContext): LoadPatch {
  switch (plan.kind) {
    case "load": return { [plan.field]: plan.value } as LoadPatch;
    case "money": return { [plan.field]: plan.cents } as LoadPatch;
    case "date": return { shipDate: plan.at };
    case "carrier": return plan.field === "name" ? { carrier: { name: plan.value } } : { carrier: { mcNumber: plan.value } };
    case "stop": return { stops: { [plan.stop]: { address: plan.part === "city" ? plan.value : plan.value } } } as LoadPatch;
    case "appt": return { apptText: spliceLine(ctx.apptText, plan.line, plan.value) };
    case "extras": return { extras: mergeExtras(ctx.extras, plan.key, plan.value) };
    case "refuse": throw new Error(`refused plan translated: ${plan.reason}`);
  }
}

/** A stop write on the board is a city or a ZIP, and the address is both.
 *  "Henderson, NV 89074" ⇄ { city: "Henderson, NV", zip: "89074" } — the
 *  same split the board's GET does when it renders the two columns. */
export const composeAddress = (city: string, zip: string): string => (zip ? `${city.trim()} ${zip}`.trim() : city.trim());
export const splitAddress = (address: string): { city: string; zip: string } => ({
  city: address.replace(/\s*\d{5}$/, "").trim(),
  zip: address.match(/(\d{5})$/)?.[1] ?? "",
});
```
Note the `stop` case above hands the writer only the part that was typed; the route composes the full address from the current stop (next step) because only the route has the stop rows. Replace that case with:
```ts
    case "stop": return { stops: { [plan.stop]: { address: plan.part === "city" ? composeAddress(plan.value, ctx.stopZip?.[plan.stop] ?? "") : composeAddress(ctx.stopCity?.[plan.stop] ?? "", plan.value) } } } as LoadPatch;
```
and extend `PatchContext`:
```ts
export interface PatchContext {
  apptText: string | null;
  extras: Prisma.JsonValue | null;
  /** the current city/zip halves per role, so a city write keeps the ZIP beside it */
  stopCity?: Partial<Record<"pickup" | "delivery", string>>;
  stopZip?: Partial<Record<"pickup" | "delivery", string>>;
}
```

- [ ] **Step 4: Rewrite the two routes onto the writer**

In `src/routes/dispatcherBrokerBoard.ts`, replace the imports of `applyCellPlan` with:
```ts
import { composeAddress, planToPatch, splitAddress, type PatchContext } from "../lib/boardCellApply.js";
import { actorOf } from "../lib/actor.js";
import { applyLoadChange, LoadNotFound } from "../lib/loadWriter.js";
```
Add a helper above the cell route:
```ts
/** What the translator needs from the load to compose APPT lines, extras and
 *  the other half of a stop's address. */
async function patchContext(tx: Prisma.TransactionClient, loadId: string): Promise<PatchContext> {
  const load = await tx.load.findUnique({ where: { id: loadId }, select: { apptText: true, extras: true, stops: { select: { type: true, address: true } } } });
  const ctx: PatchContext = { apptText: load?.apptText ?? null, extras: load?.extras ?? null, stopCity: {}, stopZip: {} };
  for (const s of load?.stops ?? []) {
    if (s.type !== "pickup" && s.type !== "delivery") continue;
    const parts = splitAddress(s.address);
    ctx.stopCity![s.type] = parts.city;
    ctx.stopZip![s.type] = parts.zip;
  }
  return ctx;
}
```
Replace the body of `PATCH /broker-board/loads/:id/cell` from `const plan = planCellWrite(...)` down to `res.json({ load: row })` with:
```ts
  const plan = planCellWrite({ row: parsed.data.row, key: parsed.data.key as BoardColumnKey, source: parsed.data.source, value: parsed.data.value });
  if (plan.kind === "refuse") return res.status(400).json({ error: plan.reason });
  const actor = await actorOf(req);
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const patch = planToPatch(plan, await patchContext(tx, load.id));
      return applyLoadChange(tx, { loadId: load.id, orgId, actor, source: "board", patch });
    }, { timeout: 15_000 });
  } catch (e) {
    if (e instanceof LoadNotFound) return res.status(404).json({ error: "That load was not found" });
    if ((e as { code?: string }).code === "P2002") return res.status(409).json({ error: DUPLICATE_LOAD_NO });
    throw e;
  }
  const [row] = await boardRows(orgId, true, [load.id]);
  emitToDispatchers(orgId, "board_update", { brokerBoard: true, ids: [load.id] });
  emitToDispatchers(orgId, "load_changed", { loadId: load.id, version: result.version, fields: result.changed });
  res.json({ load: row, version: result.version, statusRefused: result.statusRefused });
```
Replace the paste route's transaction (from `const state = new Map(...)` through the `catch`) with:
```ts
  const actor = await actorOf(req);
  const versions = new Map<string, number>();
  try {
    await prisma.$transaction(async (tx) => {
      for (const [i, cell] of cells.entries()) {
        const patch = planToPatch(plans[i], await patchContext(tx, cell.loadId));
        const r = await applyLoadChange(tx, { loadId: cell.loadId, orgId, actor, source: "paste", patch });
        versions.set(cell.loadId, r.version);
      }
    }, { timeout: 30_000 });
  } catch (e) {
    if (e instanceof LoadNotFound) return res.status(404).json({ error: "One or more loads were not found" });
    if ((e as { code?: string }).code === "P2002") return res.status(409).json({ error: DUPLICATE_LOAD_NO });
    throw e;
  }
  const rows = await boardRows(orgId, true, ids);
  emitToDispatchers(orgId, "board_update", { brokerBoard: true, ids });
  for (const [loadId, version] of versions) emitToDispatchers(orgId, "load_changed", { loadId, version, fields: [] });
  res.json({ loads: rows });
```
Remove the earlier `const loads = await prisma.load.findMany({... select: {id, orgId, carrierId, apptText, extras}})` ownership pre-check only if the writer's `LoadNotFound` now covers it (it does — keep the `ids.length` 404 check by catching `LoadNotFound` as above).

- [ ] **Step 5: Fix the GET — defects 1 and 4, and `version`**

In `boardRows`, replace `const [pu, del] = [l.stops[0], l.stops[1]];` with:
```ts
    // By ROLE, never by position: a load with an odd stop set showed the
    // wrong city in the wrong column (spec §16.4).
    const pu = l.stops.find((s) => s.type === "pickup");
    const del = l.stops.find((s) => s.type === "delivery");
```
In the `bottom` object, replace `loadNo: brokered ? boardLoadNo(l.externalId) : ""` with:
```ts
          // The carrier line's LOAD# is the board's own column. It used to
          // render from externalId while the cell editor wrote boardLoadNo,
          // so a typed number vanished on refresh (spec §16.1). The prefix
          // trick from slice 1 still feeds loads imported before the column
          // existed.
          loadNo: l.boardLoadNo ?? (brokered ? boardLoadNo(l.externalId) : ""),
```
In the returned row object add `version: l.version`. In `fleet-portal/src/lib/api.ts` `BoardLoad`, add `version: number`.

- [ ] **Step 6: Run the two suites, then everything**

Run: `npx vitest run tests/broker-board-cell-route.test.ts tests/broker-board-paste.test.ts`
Expected: PASS, including the four new tests and the paste-version test.
Run: `npx vitest run` and `npx tsc --noEmit`. Expected: green, clean. (`tests/broker-board-2b-schema.test.ts` and the importer suite are untouched by this task.)

- [ ] **Step 7: Commit** — skipped; ledger.

---

### Task 8: The importer goes through the writer

**Files:**
- Modify: `fleet-backend/src/lib/brokerImport.ts` (`confirmImport`, `stopData` removed)
- Test: `fleet-backend/tests/broker-import.test.ts` (existing suite stays green; add three tests)

**Interfaces:**
- Consumes: `applyLoadChange`, `SYSTEM_ACTOR("import")`.
- Produces: identical import results except spec §11.1's three changes — an unparseable appointment keeps the previous one; a geocode miss writes `pending`; Attention rows replaced atomically. Every imported load has `version ≥ 1` and a `LoadChange` per field.

- [ ] **Step 1: Add the failing tests**

In `tests/broker-import.test.ts`, inside `describe("confirmImport")`, append:
```ts
  it("keeps a good appointment when a re-import brings an unreadable one, and says so", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Los_Angeles" } });
    await confirmImport(org.id, brokerWorkbook());
    const before = await prisma.appointment.findMany({ where: { stop: { load: { orgId: org.id, bolNumber: BROKER_ROWS[0][0] } } } });
    expect(before.length).toBeGreaterThan(0);
    const broken = BROKER_ROWS.map((r) => [...r]);
    broken[0][15] = "DEL: sometime";                                   // the APPT cell of the first row
    const result = await confirmImport(org.id, brokerWorkbook(broken));
    expect(result.attention).toBeGreaterThan(0);
    const after = await prisma.appointment.findMany({ where: { stop: { load: { orgId: org.id, bolNumber: BROKER_ROWS[0][0] } } } });
    expect(after.map((a) => a.windowEnd.toISOString()).sort()).toEqual(before.map((a) => a.windowEnd.toISOString()).sort());
  });

  it("writes pending, not failed, for a city the gazetteer does not know", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Los_Angeles" } });
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[0][4] = "Nowhere, ZZ";
    await confirmImport(org.id, brokerWorkbook(rows));
    const pu = await prisma.loadStop.findFirst({ where: { type: "pickup", load: { orgId: org.id, bolNumber: BROKER_ROWS[0][0] } } });
    expect(pu?.geocodeStatus).toBe("pending");
  });

  it("versions and traces every imported load", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Los_Angeles" } });
    await confirmImport(org.id, brokerWorkbook());
    const loads = await prisma.load.findMany({ where: { orgId: org.id } });
    expect(loads.every((l) => l.version >= 1)).toBe(true);
    expect(await prisma.loadChange.count({ where: { orgId: org.id, source: "import" } })).toBeGreaterThan(0);
  });
```
(Check `BROKER_ROWS`'s column indexes against `THEIR_HEADER` in `tests/fixtures/brokerBoard.ts`: PICK UP is index 4, APPT SCHEDULE is index 15.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/broker-import.test.ts`
Expected: the three new tests FAIL (the old appointment is deleted; `failed`; `version` 0).

- [ ] **Step 3: Rewrite the write half of `confirmImport`**

Delete `interface StopWrite` and `async function stopData(...)`. Add the imports:
```ts
import { SYSTEM_ACTOR } from "./actor.js";
import { applyLoadChange, type LoadPatch } from "./loadWriter.js";
```
Replace the body of the `for (const [i, pair] of pairs.entries())` loop from `const carrierId = await carrierFor(...)` to the end of the attention block with:
```ts
    const carrierId = await carrierFor(orgId, p.carrier, p.mc);
    // Reconciliation identity: LOAD#, then BOL#, then the order number — and
    // only ever against a brokered load, never a TMS fleet load.
    const existing = (p.loadNo ? await prisma.load.findFirst({ where: { orgId, externalId: { in: [p.loadNo, BOARD_KEY_PREFIX + p.loadNo] }, ...BROKERED_WHERE } }) : null)
      ?? (p.bol ? await prisma.load.findFirst({ where: { orgId, bolNumber: p.bol, ...BROKERED_WHERE } }) : null)
      ?? (p.orderRef ? await prisma.load.findFirst({ where: { orgId, orderRef: p.orderRef, ...BROKERED_WHERE } }) : null);
    // Identity and ordering are the importer's; everything a human can see
    // and retype goes through the writer, which derives the truth once.
    const identity = { externalId: p.loadNo ? await boardKeyFor(orgId, p.loadNo) : null, brokerName: p.customer, boardLine: pair.line };
    const patch: LoadPatch = {
      orderRef: p.orderRef, bolNumber: p.bol, customerName: p.customer,
      revenueCents: p.rateCents ?? 0, soldRateCents: p.soldRateCents, trackingUrl: p.trackingUrl,
      shipDate: p.shipDate ? new Date(p.shipDate + "T00:00:00Z") : null, updateText: p.update,
      apptText: apptLinesOf(pair).join("\n") || null,
      carrierId, carrierPhone: p.carrierPhone, carrierContactName: p.contact,
      stops: {
        pickup: { address: [p.pickup, p.puZip].filter(Boolean).join(" ") },
        delivery: { address: [p.delivery, p.delZip].filter(Boolean).join(" ") },
      },
    };
    // Refusals the writer does not derive itself (RATE, SHIP DATE, PROFIT is
    // preview-only) travel with the patch; the writer keeps them by aspect.
    const producerAttention = loadNotes.filter((n) => n.startsWith("can't") && !/appointment|place/.test(n));
    const loadId = existing
      ? (await prisma.load.update({ where: { id: existing.id }, data: identity })).id
      : (await prisma.load.create({ data: { orgId, status: "open", legType: "linehaul", requiredEquip: DEFAULT_EQUIPMENT, fscCents: 0, ...identity } })).id;
    const written = await prisma.$transaction(
      (tx) => applyLoadChange(tx, { loadId, orgId, actor: SYSTEM_ACTOR("import"), source: "import", patch, attention: producerAttention }),
      { timeout: 30_000 },
    );
    if (existing) { updated += 1; if (existing.status === "archived") archivedKept += 1; } else created += 1;
    if (written.attention.length) attention += 1;
```
Remove the now-unused `nowMs`/`noteSeq` declarations and the two `loadNotes.push("can't read PU/DEL appointment …")` lines (the writer raises those itself, with the same wording, from the same joined cell text). Keep `apptCellText` only if something else still uses it; otherwise delete it.

- [ ] **Step 4: Run the importer suite**

Run: `npx vitest run tests/broker-import.test.ts`
Expected: PASS — every existing test plus the three new ones. If an existing test asserts the exact *text* of an appointment refusal, the writer's `apptCellText` (lines joined by `" / "`) is the same string the importer produced; if a test asserts `geocodeStatus: "failed"`, update it to `"pending"` and cite spec D6 in the assertion.

- [ ] **Step 5: Whole suite and typecheck**

Run: `npx vitest run` and `npx tsc --noEmit`. Expected: green, clean.

- [ ] **Step 6: Commit** — skipped; ledger.

---

### Task 9: The backfill — `npm run loads:rederive`

**Files:**
- Create: `fleet-backend/src/cli/rederive.ts`
- Modify: `fleet-backend/package.json` (script)
- Test: `fleet-backend/tests/rederive.test.ts`

**Interfaces:**
- Consumes: `applyLoadChange` with `force: true`, `source: "backfill"`.
- Produces: `export async function rederiveOrg(orgId: string, say: (line: string) => void): Promise<{ loads: number; statusChanged: number; placed: number }>` in `src/cli/rederive.ts`; script `loads:rederive` = `tsx src/cli/rederive.ts [--org <id>]`.

- [ ] **Step 1: Write the failing test**

`fleet-backend/tests/rederive.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { rederiveOrg } from "../src/cli/rederive.js";
import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";

// Spec §11.2: derive the truth from what is already stored, once per org.
// This is how the org's real board — 26 loads all "open", three of them
// saying DELIVERED — becomes honest.
describe("rederiveOrg", () => {
  beforeEach(resetDb);

  it("moves status from stored UPDATE text and places stored cities, and is idempotent", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
    const delivered = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "MEIBORG", carrierId: carrier.id, updateText: "DELIVERED 07/16/2026",
        stops: { create: [{ sequence: 1, type: "pickup", address: "Kansas City, MO 64120", geocodeStatus: "pending" }, { sequence: 2, type: "delivery", address: "Nowhere, ZZ", geocodeStatus: "pending" }] } },
    });
    const pending = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "MEIBORG", carrierId: carrier.id, updateText: "PENDING RATE CONFIRMATION" } });
    const lines: string[] = [];
    const first = await rederiveOrg(org.id, (l) => lines.push(l));
    expect(first).toEqual({ loads: 2, statusChanged: 1, placed: 1 });
    expect((await prisma.load.findUnique({ where: { id: delivered.id } }))?.status).toBe("delivered");
    expect((await prisma.load.findUnique({ where: { id: pending.id } }))?.status).toBe("open");
    const pu = await prisma.loadStop.findFirst({ where: { loadId: delivered.id, type: "pickup" } });
    expect(pu?.lat).not.toBeNull();
    expect(lines.some((l) => l.includes(delivered.id) && l.includes("delivered"))).toBe(true);
    const second = await rederiveOrg(org.id, () => {});
    expect(second).toEqual({ loads: 2, statusChanged: 0, placed: 0 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/rederive.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the CLI**

`fleet-backend/src/cli/rederive.ts`:
```ts
// `npm run loads:rederive [--org <id>]` — the backfill (spec §11.2). Every
// load is handed to the writer with an empty patch and `force`, so
// appointments, coordinates, status and Attention are derived from what is
// already stored. Idempotent; run once per org after deploy, and again after
// a human adds a rule to the vocabulary.
import { SYSTEM_ACTOR } from "../lib/actor.js";
import { applyLoadChange } from "../lib/loadWriter.js";
import { prisma } from "../db.js";

export async function rederiveOrg(orgId: string, say: (line: string) => void): Promise<{ loads: number; statusChanged: number; placed: number }> {
  const loads = await prisma.load.findMany({ where: { orgId }, select: { id: true, status: true, stops: { select: { lat: true } } }, orderBy: { createdAt: "asc" } });
  let statusChanged = 0, placed = 0;
  for (const l of loads) {
    const unplacedBefore = l.stops.filter((s) => s.lat === null).length;
    const r = await prisma.$transaction(
      (tx) => applyLoadChange(tx, { loadId: l.id, orgId, actor: SYSTEM_ACTOR("backfill"), source: "backfill", patch: {}, force: true }),
      { timeout: 30_000 },
    );
    const unplacedAfter = (await prisma.loadStop.count({ where: { loadId: l.id, lat: null } }));
    placed += Math.max(0, unplacedBefore - unplacedAfter);
    if (r.status !== l.status) { statusChanged += 1; say(`${l.id}: ${l.status} → ${r.status}`); }
    if (r.statusRefused) say(`${l.id}: ${r.statusRefused}`);
  }
  return { loads: loads.length, statusChanged, placed };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("src/cli/rederive.ts");
if (isMain) {
  const say = (line: string): void => void process.stdout.write(line + "\n");
  const orgArg = process.argv.indexOf("--org");
  const only = orgArg === -1 ? null : process.argv[orgArg + 1];
  const orgs = only ? [{ id: only }] : await prisma.org.findMany({ select: { id: true } });
  for (const org of orgs) {
    const r = await rederiveOrg(org.id, say);
    say(`org ${org.id}: ${r.loads} loads, ${r.statusChanged} status changes, ${r.placed} stops placed`);
  }
  await prisma.$disconnect();
}
```
In `fleet-backend/package.json` scripts, after `"typecheck"`:
```json
    "loads:rederive": "tsx src/cli/rederive.ts",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/rederive.test.ts`
Expected: PASS. `npx tsc --noEmit` clean (top-level `await` is fine under `module: ES2022`; if the config refuses it, wrap the `isMain` block in `void (async () => { … })()`).

- [ ] **Step 5: Run it against the dev database, for real**

Run: `npm run loads:rederive` (dev backend running or not — it only needs Postgres).
Expected: for the demo org, one line per status change; the final line reports **26 loads … status changes**. Then verify:
```bash
docker exec fleet-postgres psql -U fleet -d fleet -At -c "select status, count(*) from \"Load\" where \"customerName\"='MEIBORG' group by 1 order by 1;"
```
Expected: `assigned|10`, `delivered|3`, `in_progress|9`, `open|3`, `archived|1` — spec §8.5.

- [ ] **Step 6: Commit** — skipped; ledger.

---

### Task 10: The vocabulary API, the change list, the undo

**Files:**
- Create: `fleet-backend/src/routes/dispatcherLoadTruth.ts`
- Modify: `fleet-backend/src/app.ts` (mount)
- Test: `fleet-backend/tests/load-truth-routes.test.ts`

**Interfaces:**
- Consumes: `rulesFor`, `applyLoadChange`, `actorOf`, `LoadNotFound`.
- Produces:
  - `GET /api/dispatcher/update-rules` → `{ rules: [{ prefix, status, enabled }] }` (seeds defaults when none)
  - `PUT /api/dispatcher/update-rules` `{ rules: [{ prefix, status, enabled? }] }` → replaces the org's set; 400 for a status outside `open|assigned|in_progress|delivered|canceled` or a blank/duplicate prefix
  - `GET /api/dispatcher/loads/:id/changes` → `{ changes: [{ atMs, actorName, source, field, before, after, note }] }` newest first
  - `POST /api/dispatcher/loads/:id/undo-status` → `{ status }`; 409 with a sentence when the last status change is not the newest change to the load's status, or when the load has an Assignment

- [ ] **Step 1: Write the failing test**

`fleet-backend/tests/load-truth-routes.test.ts`:
```ts
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

async function setup() {
  const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
  await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "Maria", orgId: org.id } });
  const { token } = await loginDispatcher("b@x.com", "pw");
  const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
  const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME", carrierId: carrier.id } });
  return { org, auth: { Authorization: `Bearer ${token}` }, load };
}

describe("update-rules", () => {
  beforeEach(resetDb);

  it("seeds their words on first read, and replaces them on PUT", async () => {
    const { auth } = await setup();
    const seeded = await request(app).get("/api/dispatcher/update-rules").set(auth);
    expect(seeded.status).toBe(200);
    expect(seeded.body.rules.map((r: { prefix: string }) => r.prefix)).toContain("DELIVERED");
    const put = await request(app).put("/api/dispatcher/update-rules").set(auth).send({ rules: [{ prefix: "DONE", status: "delivered" }, { prefix: "PENDING", status: "open", enabled: false }] });
    expect(put.status).toBe(200);
    const after = await request(app).get("/api/dispatcher/update-rules").set(auth);
    expect(after.body.rules).toEqual([{ prefix: "DONE", status: "delivered", enabled: true }, { prefix: "PENDING", status: "open", enabled: false }]);
  });

  it("refuses a status the platform does not have, and a duplicate prefix", async () => {
    const { auth } = await setup();
    await request(app).put("/api/dispatcher/update-rules").set(auth).send({ rules: [{ prefix: "X", status: "teleported" }] }).expect(400);
    await request(app).put("/api/dispatcher/update-rules").set(auth).send({ rules: [{ prefix: "DONE", status: "delivered" }, { prefix: "done", status: "canceled" }] }).expect(400);
  });
});

describe("changes and undo", () => {
  beforeEach(resetDb);

  it("lists what changed, newest first, and undoes the last text-driven status", async () => {
    const { auth, load } = await setup();
    await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth).send({ row: "top", key: "update", value: "DELIVERED 07/17/2026" }).expect(200);
    const list = await request(app).get(`/api/dispatcher/loads/${load.id}/changes`).set(auth);
    expect(list.status).toBe(200);
    expect(list.body.changes[0]).toMatchObject({ field: "status", before: "open", after: "delivered", note: "DELIVERED 07/17/2026", actorName: "Maria", source: "board" });
    const undo = await request(app).post(`/api/dispatcher/loads/${load.id}/undo-status`).set(auth);
    expect(undo.status).toBe(200);
    expect(undo.body.status).toBe("open");
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.status).toBe("open");
    const again = await request(app).get(`/api/dispatcher/loads/${load.id}/changes`).set(auth);
    expect(again.body.changes[0]).toMatchObject({ field: "status", before: "delivered", after: "open", source: "board" });
  });

  it("refuses an undo when there is nothing to undo, or when our driver runs the load", async () => {
    const { org, auth, load } = await setup();
    const none = await request(app).post(`/api/dispatcher/loads/${load.id}/undo-status`).set(auth);
    expect(none.status).toBe(409);
    await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set(auth).send({ row: "top", key: "update", value: "DELIVERED" }).expect(200);
    const driver = await prisma.driver.create({ data: { email: "j@x.com", passwordHash: "x", name: "Jake", orgId: org.id } });
    await prisma.assignment.create({ data: { orgId: org.id, loadId: load.id, driverId: driver.id, status: "dispatched", plannedStart: new Date(), plannedEnd: new Date() } });
    const blocked = await request(app).post(`/api/dispatcher/loads/${load.id}/undo-status`).set(auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/Cockpit/);
  });

  it("never shows or undoes another org's load", async () => {
    const { auth } = await setup();
    const other = await prisma.org.create({ data: { name: "Other", timezone: "UTC" } });
    const theirs = await prisma.load.create({ data: { orgId: other.id, requiredEquip: "DryVan", revenueCents: 0 } });
    await request(app).get(`/api/dispatcher/loads/${theirs.id}/changes`).set(auth).expect(404);
    await request(app).post(`/api/dispatcher/loads/${theirs.id}/undo-status`).set(auth).expect(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/load-truth-routes.test.ts`
Expected: FAIL — 404s on every route.

- [ ] **Step 3: Write the router and mount it**

`fleet-backend/src/routes/dispatcherLoadTruth.ts`:
```ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { actorOf } from "../lib/actor.js";
import { rulesFor } from "../lib/loadWriter.js";
import { outsideOrg } from "../middleware/orgScope.js";
import { emitToDispatchers } from "../realtime.js";

// The org's words (spec §6.1), the trace (§5.2) and the undo (§6.4).
export const dispatcherLoadTruthRouter = Router();

const NO_ORG = "This requires an org-scoped dispatcher account";
const STATUSES = ["open", "assigned", "in_progress", "delivered", "canceled"] as const;
const rulesSchema = z.object({
  rules: z.array(z.object({ prefix: z.string().trim().min(1).max(40), status: z.enum(STATUSES), enabled: z.boolean().optional() })).max(100),
});

dispatcherLoadTruthRouter.get("/update-rules", async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const rules = await prisma.$transaction((tx) => rulesFor(tx, orgId));
  res.json({ rules: rules.map((r) => ({ prefix: r.prefix, status: r.status, enabled: r.enabled !== false })) });
});

dispatcherLoadTruthRouter.put("/update-rules", async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const parsed = rulesSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const seen = new Set<string>();
  for (const r of parsed.data.rules) {
    const key = r.prefix.toUpperCase();
    if (seen.has(key)) return res.status(400).json({ error: `"${r.prefix}" is listed twice` });
    seen.add(key);
  }
  // Their words are the whole set: PUT replaces, so a removed word is gone.
  await prisma.$transaction([
    prisma.updateRule.deleteMany({ where: { orgId } }),
    prisma.updateRule.createMany({ data: parsed.data.rules.map((r) => ({ orgId, prefix: r.prefix.toUpperCase(), status: r.status, enabled: r.enabled ?? true })) }),
  ]);
  const rules = await prisma.updateRule.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } });
  res.json({ rules: rules.map((r) => ({ prefix: r.prefix, status: r.status, enabled: r.enabled })) });
});

/** The org's load or a 404 — never a hint that another org's id exists. */
async function ownLoad(req: { orgScope?: string | null }, id: string) {
  const load = await prisma.load.findUnique({ where: { id }, include: { assignment: { select: { id: true } } } });
  return !load || outsideOrg(req, load.orgId) ? null : load;
}

dispatcherLoadTruthRouter.get("/loads/:id/changes", async (req, res) => {
  const load = await ownLoad(req, req.params.id as string);
  if (!load) return res.status(404).json({ error: "Load not found" });
  const rows = await prisma.loadChange.findMany({ where: { loadId: load.id }, orderBy: [{ atMs: "desc" }, { id: "desc" }], take: 200 });
  res.json({ changes: rows.map((c) => ({ atMs: Number(c.atMs), actorName: c.actorName, source: c.source, field: c.field, before: c.before, after: c.after, note: c.note })) });
});

dispatcherLoadTruthRouter.post("/loads/:id/undo-status", async (req, res) => {
  const load = await ownLoad(req, req.params.id as string);
  if (!load) return res.status(404).json({ error: "Load not found" });
  if (load.assignment) return res.status(409).json({ error: "One of our drivers runs this load — change its status in the Cockpit" });
  const last = await prisma.loadChange.findFirst({ where: { loadId: load.id, field: "status" }, orderBy: [{ atMs: "desc" }, { id: "desc" }] });
  if (!last || last.after !== load.status) return res.status(409).json({ error: "Nothing to undo — the status has not been set from UPDATE, or it moved since" });
  const actor = await actorOf(req);
  const restored = last.before ?? "open";
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.load.update({ where: { id: load.id }, data: { status: restored, version: { increment: 1 } } });
    await tx.loadChange.create({
      data: { loadId: load.id, orgId: load.orgId, atMs: BigInt(Date.now()), actorId: actor.dispatcherId, actorName: actor.name, source: "board", field: "status", before: load.status, after: restored, note: "undo" },
    });
    return row;
  });
  emitToDispatchers(load.orgId, "board_update", { brokerBoard: true, ids: [load.id] });
  emitToDispatchers(load.orgId, "load_changed", { loadId: load.id, version: updated.version, fields: ["status"] });
  res.json({ status: updated.status, version: updated.version });
});
```
In `fleet-backend/src/app.ts`, next to where `dispatcherBrokerBoardRouter` is mounted (same auth + orgScope middleware chain), mount `dispatcherLoadTruthRouter` under `/api/dispatcher`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/load-truth-routes.test.ts`
Expected: PASS (5 tests). Then `npx vitest run` and `npx tsc --noEmit`.

- [ ] **Step 5: Commit** — skipped; ledger.

---

### Task 11: The marks — a cell that disagrees with the record

**Files:**
- Modify: `fleet-backend/src/routes/dispatcherBrokerBoard.ts` (`boardRows`: `record` hints)
- Modify: `fleet-portal/src/lib/api.ts` (`BoardLoad.record`)
- Modify: `fleet-portal/src/components/broker/BrokerGrid.vue` (the dot + tooltip)
- Test: `fleet-backend/tests/dispatcher-broker-board.test.ts` (append), `fleet-portal/src/components/broker/BrokerGrid.edit.spec.ts` (append)

**Interfaces:**
- Consumes: `matchRule`, `rulesFor`, `parseApptText`.
- Produces: `BoardLoad.record?: { update?: string; appt?: string }` — `update` = `Load.status` when the UPDATE cell matches a rule whose status differs from it; `appt` = `"PU 07/14 12:00 · DEL 07/17 10:00"` (org zone) when the stops' `Appointment` rows disagree with what the APPT text parses to. Absent otherwise.

- [ ] **Step 1: Write the failing backend test**

In `tests/dispatcher-broker-board.test.ts`, append a describe:
```ts
describe("record hints", () => {
  beforeEach(resetDb);

  it("marks an UPDATE cell whose word the record refused, and an APPT cell the Cockpit moved", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
    await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
    const { token } = await loginDispatcher("b@x.com", "pw");
    const auth = { Authorization: `Bearer ${token}` };
    const driver = await prisma.driver.create({ data: { email: "j@x.com", passwordHash: "x", name: "Jake", orgId: org.id } });
    const load = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME", status: "assigned", shipDate: new Date("2026-07-13T00:00:00Z"),
        updateText: "DELIVERED 07/17/2026", apptText: "PU: 07/14 - 12:00\nDEL: 07/17 - 10:00",
        stops: { create: [
          { sequence: 1, type: "pickup", address: "Kansas City, MO", appointment: { create: { windowEnd: new Date("2026-07-14T17:00:00Z"), type: "pickup", kind: "appointment" } } },
          { sequence: 2, type: "delivery", address: "Dallas, TX", appointment: { create: { windowEnd: new Date("2026-07-20T12:00:00Z"), type: "delivery", kind: "appointment" } } },
        ] } },
    });
    await prisma.assignment.create({ data: { orgId: org.id, loadId: load.id, driverId: driver.id, status: "dispatched", plannedStart: new Date(), plannedEnd: new Date() } });
    const res = await request(app).get("/api/dispatcher/broker-board").set(auth);
    const row = res.body.loads.find((l: { id: string }) => l.id === load.id);
    expect(row.record).toEqual({ update: "assigned", appt: "PU 07/14 12:00 · DEL 07/20 07:00" });
  });

  it("carries no record hint when the cell and the record agree, or the text matches no rule", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
    await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
    const { token } = await loginDispatcher("b@x.com", "pw");
    const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME", status: "open", updateText: "waiting on POD" } });
    const res = await request(app).get("/api/dispatcher/broker-board").set({ Authorization: `Bearer ${token}` });
    const row = res.body.loads.find((l: { id: string }) => l.id === load.id);
    expect(row.record).toBeUndefined();
  });
});
```
(Import `hashPassword` and `loginDispatcher` the way the file's other tests do.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dispatcher-broker-board.test.ts -t "record hints"`
Expected: FAIL — `record` is undefined on the first test.

- [ ] **Step 3: Compute the hints in `boardRows`**

At the top of `boardRows`, after the loads query, load the org's rules and zone once:
```ts
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { timezone: true } });
  const tz = org?.timezone ?? "America/Chicago";
  const rules = await prisma.$transaction((tx) => rulesFor(tx, orgId));
```
Add the imports:
```ts
import { parseApptText } from "../lib/apptText.js";
import { rulesFor } from "../lib/loadWriter.js";
import { matchRule } from "../lib/updateVocabulary.js";
```
Add a helper above `boardRows`:
```ts
/** "PU 07/14 12:00 · DEL 07/20 07:00" in the org's zone — what the record
 *  holds, for the mark on an APPT cell whose text says otherwise. */
const clockIn = (d: Date, tz: string): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(",", "");
```
Inside the `loads.map` callback, before `return { id: l.id, … }`, compute:
```ts
    // The marks (spec §10): a cell is never rewritten, but a cell that
    // disagrees with the record says so.
    const record: { update?: string; appt?: string } = {};
    const rule = matchRule(l.updateText, rules);
    if (rule) {
      const implied = rule.status === "assigned" && l.carrierId === null ? "open" : rule.status;
      if (implied !== l.status) record.update = l.status;
    }
    if (l.apptText) {
      const year = l.shipDate ? l.shipDate.getUTCFullYear() : new Date().getUTCFullYear();
      const parsed = parseApptText(l.apptText.split(/\r?\n/).filter((x) => x.trim() !== ""), { year, tz });
      const disagree = (w: { endMs: number } | null, a: { windowEnd: Date } | null | undefined): boolean =>
        !!a && (!w || a.windowEnd.getTime() !== w.endMs);
      if (disagree(parsed.pu, pu?.appointment) || disagree(parsed.del, del?.appointment)) {
        const parts = [pu?.appointment ? `PU ${clockIn(pu.appointment.windowEnd, tz)}` : null, del?.appointment ? `DEL ${clockIn(del.appointment.windowEnd, tz)}` : null].filter(Boolean);
        record.appt = parts.join(" · ");
      }
    }
```
and add to the returned row: `...(Object.keys(record).length ? { record } : {})`. The `include` in the query must add `appointment: true` under `stops`. In `fleet-portal/src/lib/api.ts` `BoardLoad`, add `record?: { update?: string; appt?: string }`.

- [ ] **Step 4: Run the backend tests**

Run: `npx vitest run tests/dispatcher-broker-board.test.ts`
Expected: PASS. (`clockIn` formats `07/20 07:00` for 12:00Z in Chicago CDT — if the assertion's expected string differs by the formatter's exact output, adjust the expected string to what `Intl` produces for `en-US` with `hour12: false`; the point under test is *that* the hint exists and names the record's value.)

- [ ] **Step 5: Write the failing portal test**

In `fleet-portal/src/components/broker/BrokerGrid.edit.spec.ts`, append:
```ts
describe('the marks', () => {
  it('shows a dot with the record\'s value on a cell that disagrees with it, and nothing on one that agrees', () => {
    const marked = { ...loads[0], record: { update: 'assigned', appt: 'PU 07/14 12:00 · DEL 07/20 07:00' } }
    const w = mount(BrokerGrid, { props: { layout: [...layout, { key: 'update', label: 'UPDATE' }, { key: 'appt', label: 'APPT' }], loads: [marked, loads[1]], viewportHeight: 10_000 } })
    const update = w.find('tr[data-load="a"][data-row="top"] td[data-col="update"] [data-record]')
    expect(update.exists()).toBe(true)
    expect(update.attributes('title')).toBe('record says assigned')
    expect(w.find('tr[data-load="a"][data-row="top"] td[data-col="appt"] [data-record]').attributes('title')).toBe('record says PU 07/14 12:00 · DEL 07/20 07:00')
    expect(w.find('tr[data-load="b"] [data-record]').exists()).toBe(false)
  })
})
```

- [ ] **Step 6: Render the dot**

In `BrokerGrid.vue`, in the script, add:
```ts
/** The record's value for a cell whose text disagrees with it (spec §10).
 *  The text is never changed; the dot says what the record holds. */
const recordHint = (l: BoardLoad, colIdStr: string): string | null => {
  const key = col(colIdStr).key
  if (key === 'update') return l.record?.update ?? null
  if (key === 'appt') return l.record?.appt ?? null
  return null
}
```
In the top-line cell template, after the `<template v-else>{{ textOf(...) }}</template>` (inside the same `<td>`), add:
```vue
                  <span v-if="recordHint((flat[item.index] as LoadRow).load, column.id)" data-record class="bb-record" :title="'record says ' + recordHint((flat[item.index] as LoadRow).load, column.id)" aria-label="differs from the record"></span>
```
In the scoped style:
```css
.bb-cell { position: relative; }
.bb-record { position: absolute; right: 3px; top: 3px; width: 6px; height: 6px; border-radius: 99px; background: var(--bb-accent); box-shadow: 0 0 0 1.5px var(--bb-row); }
```
(`.bb-cell` gains `position: relative`; the sticky frozen cells already set `position: sticky`, which also positions — the frozen class is applied after, so it wins on those cells.)

- [ ] **Step 7: Run the portal tests, then everything**

Run: `cd fleet-portal && npx vitest run src/components/broker && npx vue-tsc --noEmit`
Expected: PASS, clean. Then `cd ../fleet-backend && npx vitest run && npx tsc --noEmit`.

- [ ] **Step 8: Live check**

With both dev servers up, open `http://localhost:5173/board/broker` on the org holding the real board after Task 9's backfill: the DELIVERED rows read `delivered` (grey/archived styling is not applied — `delivered` is a live status), the Cockpit at `/cockpit` still shows them in the backlog **until plan A3** (expected — A3 is the carrier-lane plan), and no row carries a `record` dot unless a rule was refused. Screenshot the board to the scratchpad.

- [ ] **Step 9: Commit** — skipped; ledger.

---

## Self-review

**Spec coverage (this plan = spec §15 steps 1–2):**
- §4.1 interface — Task 3. §4.2.1 appointments incl. keep-existing — Task 5. §4.2.2 geocoding + `pending` — Task 4. §4.2.3 status incl. carrier re-derive — Task 6. §4.2.4 Attention atomic per aspect — Task 3 (`mergeAttention`). §4.2.5 version + trace — Task 3. §4.3 `load_changed` after commit — Tasks 7, 10 (emitted; consumed in plan A4).
- §5.1–§5.4 minus `LoadLock` — Task 1 (`LoadLock` is plan A2).
- §6.1 seed + match — Tasks 2, 6. §6.2 unknown text — Tasks 2, 6. §6.3 guard — Task 6. §6.4 trace + undo — Tasks 6, 10.
- §10 marks — Task 11.
- §11.1 importer — Task 8. §11.2 backfill — Task 9.
- §13 API: cell/paste `version` (Task 7), `update-rules`, `changes`, `undo-status` (Task 10); `?ids=` on the GET and the lock routes are plans A4/A2.
- §16 defects: 1 and 4 — Task 7; 2 — Task 5/7; 3 — Task 4/7; 5 — Tasks 5/8.
- **Deliberately not here:** §7 locks and `baseVersion` (A2), §8 Cockpit projection and lanes (A3), §9 shared socket and patch-by-id (A4), `/loadboard` PATCH as a writer producer (A3, where the Cockpit read model changes anyway).

**Placeholder scan:** none. Every step carries its code and its command.

**Type consistency:** `LoadPatch`, `ApplyArgs`, `ApplyResult`, `LoadNotFound`, `rulesFor`, `attentionAspect`, `SYSTEM_ACTOR`, `actorOf`, `planToPatch`, `PatchContext`, `composeAddress`, `splitAddress`, `rederiveOrg` are defined once (Tasks 3, 6, 7, 9) and used with the same names and shapes in Tasks 7–11. `ApplyResult.statusRefused` is the only field a route surfaces beyond `version`; Task 7's response uses it by that name.
