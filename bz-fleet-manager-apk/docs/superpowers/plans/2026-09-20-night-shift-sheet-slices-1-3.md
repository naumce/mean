# Night Shift in the Sheet — Slices 1–3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dispatcher connects their Google Sheet, maps columns once, and two columns appear; choosing a policy in the **Night Shift** cell of a row starts the agent on that load, and the **Night Shift status** cell shows what the agent is doing — in shadow, with `would say:` lines — with a link that opens the load's timeline on a phone.

**Architecture:** A sheet row becomes a `Load` row in the customer's `Org` through the traced writer (`applyLoadChange`, source `"sheet"`). The sheet layer is one folder, `fleet-backend/src/lib/sheet/` (connector interface, Google implementation, mapping, sync loop), called from the backend's routes for setup and from the night-shift worker's tick for sync. The agent core, its ports, `PlatformLoads` and `PlatformSheet` are not modified. Tenancy: `Plan.tier` hides the Control Tower nav; `OrgTelephony` lets the worker text and call from a per-org number, falling back to the env number until a number is bought (slice 6, next plan).

**Tech Stack:** Express 4, Prisma 5 (Postgres in docker `fleet-postgres` :5434), zod, vitest + supertest; `googleapis` (Sheets v4 + Drive v3 + OAuth2); `night-shift/` TypeScript with its own vitest; Vue 3, Pinia, vitest + @vue/test-utils.

**Spec:** `docs/superpowers/specs/2026-09-19-night-shift-as-a-product-design.md` — §4a (two products, one platform), §5 (connecting), §6 (the two cells and the sync loop), §7 (tenancy and telephony), §9 (hosted app), §13 (honesty rules). This plan covers build-order slices 1, 2 and 3 of §15. Slices 4–7 (two-way + conflicts, wallet, 10DLC/go-live, MCP) are the next plan.

**Deviation recorded:** the spec puts the sheet layer at `night-shift/src/sheet/`. It lives at `fleet-backend/src/lib/sheet/` because the backend's setup routes and the worker both need the connector, and the worker already imports `fleet-backend/src/db.js`. The §11 reviewer rule applies to that folder unchanged.

## Global Constraints

- **No git commits, no `git add`** — the user's standing rule. Every "Commit" step below is skipped; the working tree is the deliverable.
- **Never read, print or log `night-shift/.env` or `fleet-backend/.env`.** Edit `.env.example` files only, and describe changes rather than showing them.
- **The agent never starts on its own.** Only `Load.agentEnabled = true`, set by the switch route, makes it watch a load. The sheet's switch cell calls that route; it does not write `Load` directly.
- **Shadow is the default** for every new org's Standard policy. Nothing in this plan can flip a policy to live.
- **We never write the switch cell. We always overwrite the status cell whole** (spec §13).
- **Every Load write goes through `applyLoadChange`** (`fleet-backend/src/lib/loadWriter.ts`) with `source: "sheet"` and an `Actor` of `{ dispatcherId: null, name: "sheet" }`.
- **Every route handler is wrapped in `asyncRoute`**; `tests/no-silent-hang.test.ts` fails otherwise.
- Every new table carries `orgId`; every query is org-scoped; another org's row is a **404**, never a 403.
- A change under `fleet-backend/src/lib/sheet/` that knows about a threshold, a rung, a classification or a phone is in the wrong place (spec §11).
- A row without a load number is never mirrored (spec §5.3). Nothing invents a deadline (spec §5.4).
- **Portal isolation (decided 2026-09-20):** everything Night-Shift-only lives under `fleet-portal/src/nightshift/` (views, store, components) and imports nothing from the Cockpit; the Cockpit imports nothing from it. Shared pieces stay where they are (`components/agent/AgentDrawer.vue`, `components/broker/BrokerGrid.vue`, `stores/auth.ts`, `lib/api.ts`). This keeps a later split into a separate app a one-day move.
- Checks: backend `npx vitest run` + `npx tsc --noEmit`; night-shift `npm test` + `npm run typecheck`; portal `npx vitest run` + `npx vue-tsc --noEmit -p tsconfig.app.json` (only the five pre-existing errors in `RoutePlanCard.spec.ts` ×4 and `FleetMap.vue` ×1 are permitted).
- The dev backend on :3001 holds the Prisma engine DLL on Windows — stop it before `prisma migrate dev`, then restart with `NODE_OPTIONS=--max-http-header-size=65536 npx tsx watch src/server.ts &`, and say so in the report.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `fleet-backend/prisma/migrations/<ts>_night_shift_sheet/migration.sql` | `Plan`, `OrgTelephony`, `SheetBinding`; `Org.linkSecret`; `Load.customerEmail`, `sheetRowIndex`, `sheetStatusWrittenAt`. |
| `fleet-backend/src/lib/plans.ts` | `PlanTier`, `ensurePlan(tx, orgId, tier)`, `planOf(orgId)`. |
| `fleet-backend/src/lib/secretBox.ts` | AES-256-GCM `seal`/`open` for tokens at rest, keyed by `SECRET_BOX_KEY`. |
| `fleet-backend/src/lib/sheet/connector.ts` | `SheetConnector`, `TabRef`, `RawRow`, `CellWrite`, `AgentColumnNames`. |
| `fleet-backend/src/lib/sheet/fakeConnector.ts` | In-memory connector for tests. |
| `fleet-backend/src/lib/sheet/googleConnector.ts` | `GoogleSheetsConnector` over `googleapis`. |
| `fleet-backend/src/lib/sheet/graphConnector.ts` | `GraphExcelConnector` stub: every method throws `NotImplemented`. |
| `fleet-backend/src/lib/sheet/googleAuth.ts` | OAuth2 client, consent URL, code exchange, token refresh. |
| `fleet-backend/src/lib/sheet/mapping.ts` | `SheetColumnKey`, aliases, `proposeSheetMapping(header)`, `validateMapping`. |
| `fleet-backend/src/lib/sheet/rowToPatch.ts` | One `RawRow` + mapping → `{ loadRef, patch, extras, attention }`. |
| `fleet-backend/src/lib/sheet/statusCell.ts` | `statusCellText(pill, line)` — the exact strings of spec §6.2. |
| `fleet-backend/src/lib/sheet/sync.ts` | `syncBinding(binding, connector, deps)`: read rows → upsert loads → read switch → write status cells. |
| `fleet-backend/src/lib/sheet/connectorFor.ts` | `connectorFor(binding)` → a live connector from the stored token. |
| `fleet-backend/src/routes/dispatcherSheet.ts` | OAuth start/callback, spreadsheets/tabs/header, mapping, install, binding GET/DELETE, sync-now. |
| `fleet-backend/src/routes/nightShiftLink.ts` | `GET /api/n/:orgToken/loads/:id/agent`, `POST …/commands` — the deep link's API. |
| `fleet-backend/tests/sheet/connector.suite.ts` | The shared connector test suite (a function taking a connector factory). |
| `fleet-backend/tests/sheet/*.test.ts` | Mapping, rowToPatch, statusCell, sync, routes, link. |
| `night-shift/src/live/orgTelephony.ts` | `telephonyFor(orgId)` with a 60 s cache; falls back to env. |
| `fleet-portal/src/nightshift/stores/sheet.ts` | Binding, spreadsheets, tabs, header, proposal, save, install. |
| `fleet-portal/src/nightshift/components/ConnectSheet.vue` | The five-step Connect tab. |
| `fleet-portal/src/nightshift/views/NightShiftLinkView.vue` | `/n/:orgToken/:loadId` — the drawer full-screen. |

**Modified**

| File | Change |
|---|---|
| `fleet-backend/prisma/schema.prisma` | The models and columns above. |
| `fleet-backend/src/lib/loadWriter.ts` | `ChangeSource` gains `"sheet"`; `LoadPatch` gains `customerEmail`, `sheetRowIndex`. |
| `fleet-backend/src/routes/dispatcherAuth.ts` | Signup takes `product`, seeds `Plan` and `Org.linkSecret`; `/me` returns `plan.tier`. |
| `fleet-backend/src/app.ts` | Mount `dispatcherSheetRouter`, `nightShiftLinkRouter`. |
| `fleet-backend/.env.example` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `SECRET_BOX_KEY`, `PORTAL_URL`. |
| `night-shift/src/live/worker.ts` | Twilio adapters per trip from `telephonyFor(orgId)`; sheet sync before `syncPlatformLoads`. |
| `night-shift/src/live/registry.ts` | A trip carries `orgId`. |
| `night-shift/src/live/platformLoads.ts` | Passes `orgId` into the registry; brief's `customerEmail` from `Load.customerEmail`. |
| `night-shift/src/live/twilioWebhooks.ts` | SMS routes by `To` + `From`. |
| `night-shift/src/live/config.ts` | `TWILIO_FROM_NUMBER` optional in platform mode. |
| `fleet-portal/src/stores/auth.ts`, `layouts/AppShell.vue` | `tier` on the session; nav filtered by tier. |
| `fleet-portal/src/views/NightShiftView.vue` | Tabs: Connect, Policies. |
| `fleet-portal/src/router/index.ts` | `/n/:orgToken/:loadId` outside the auth guard. |

---

### Task 1: Schema — Plan, OrgTelephony, SheetBinding, the link secret

**Files:**
- Modify: `fleet-backend/prisma/schema.prisma`
- Create: the migration; `fleet-backend/src/lib/plans.ts`
- Modify: `fleet-backend/src/lib/loadWriter.ts:20` (`ChangeSource`), `:24-45` (`LoadPatch`), `:91` (the scalar field list)
- Modify: `fleet-backend/src/routes/dispatcherAuth.ts:23-60` (signup), `:88-96` (`/me`)
- Test: `fleet-backend/tests/plans.test.ts` (create), `fleet-backend/tests/dispatcher-auth.test.ts` (extend)

**Interfaces:**
- Produces: models `Plan { orgId unique, tier "sheet"|"tower", loadNightCents Int?, messagingMarkup Float @default(1.5), dailyCommsCapCents Int @default(2000) }`, `OrgTelephony`, `SheetBinding`; `Org.linkSecret String` (32 random bytes, hex); `Load.customerEmail String?`, `Load.sheetRowIndex Int?`, `Load.sheetStatusWrittenAt DateTime?`. `ChangeSource` includes `"sheet"`. `LoadPatch` includes `customerEmail?: string | null` and `sheetRowIndex?: number | null`. `ensurePlan(tx, orgId, tier)`, `planOf(orgId): Promise<{ tier: PlanTier }>`. Signup body accepts `product?: "nightshift" | "tower"` (default `"tower"` so every existing test still passes); `GET /api/dispatcher/me` returns `plan: { tier }`. Tasks 2–10 consume all of these.

- [ ] **Step 1: Add the models**

```prisma
/// Spec §4a / §7.1. Which product this org bought. `sheet` hides the Control
/// Tower nav; `tower` shows everything. Prices are null until set (§8).
model Plan {
  id                 String   @id @default(uuid())
  orgId              String   @unique
  org                Org      @relation(fields: [orgId], references: [id])
  tier               String   // sheet | tower
  loadNightCents     Int?
  messagingMarkup    Float    @default(1.5)
  dailyCommsCapCents Int      @default(2000)
  createdAt          DateTime @default(now())
}

/// Spec §7.2. Where this org's texts and calls come from. Absent → the
/// worker falls back to the env number (dev, and every org before slice 6).
model OrgTelephony {
  id                  String    @id @default(uuid())
  orgId               String    @unique
  org                 Org       @relation(fields: [orgId], references: [id])
  provider            String    @default("ours")   // ours | byo
  region              String    @default("US")     // US | intl
  smsSender           String?
  callerId            String?
  messagingServiceSid String?
  tenDlcCampaignSid   String?
  tenDlcStatus        String    @default("none")   // none | pending | approved | rejected
  byoAccountSid       String?   // sealed by secretBox
  byoAuthToken        String?   // sealed by secretBox
  numberPurchasedAt   DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
}

/// Spec §5.2. One connected tab. `columns` is Record<SheetColumnKey, string>
/// (our key → their header). `refreshToken` is sealed by secretBox.
model SheetBinding {
  id             String    @id @default(uuid())
  orgId          String
  org            Org       @relation(fields: [orgId], references: [id])
  provider       String    // google | graph
  spreadsheetId  String
  tabId          String
  tabTitle       String
  headerRow      Int       @default(1)
  columns        Json
  agentSwitchCol Int?
  agentStatusCol Int?
  refreshToken   String
  accountEmail   String?
  lastVersion    String?
  lastSyncAt     DateTime?
  lastError      String?
  status         String    @default("connected")  // connected | paused | error
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@unique([orgId, spreadsheetId, tabId])
  @@index([status])
}
```

On `Org` add `linkSecret String @default("")`, `plan Plan?`, `telephony OrgTelephony?`, `sheetBindings SheetBinding[]`. On `Load` add `customerEmail String?`, `sheetRowIndex Int?`, `sheetStatusWrittenAt DateTime?`.

- [ ] **Step 2: Migrate**

Run: stop the :3001 backend; `cd fleet-backend && npx prisma migrate dev --name night_shift_sheet`; restart the backend. A back-fill in the same migration: `UPDATE "Org" SET "linkSecret" = encode(gen_random_bytes(32), 'hex') WHERE "linkSecret" = '';` and `INSERT INTO "Plan" (id, "orgId", tier) SELECT gen_random_uuid()::text, id, 'tower' FROM "Org" WHERE id NOT IN (SELECT "orgId" FROM "Plan");` (`gen_random_bytes` needs `CREATE EXTENSION IF NOT EXISTS pgcrypto;` at the top of the migration).

- [ ] **Step 3: Write the failing tests**

```ts
// fleet-backend/tests/plans.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "../src/db.js";
import { ensurePlan, planOf } from "../src/lib/plans.js";
import { createOrg } from "./helpers.js";   // whatever helper the suite already uses to make an org

describe("plans", () => {
  it("ensurePlan creates once and never changes an existing tier", async () => {
    const org = await createOrg();
    await prisma.$transaction((tx) => ensurePlan(tx, org.id, "sheet"));
    await prisma.$transaction((tx) => ensurePlan(tx, org.id, "tower"));
    expect((await planOf(org.id)).tier).toBe("sheet");
  });
  it("planOf throws for an org with no plan — never guesses", async () => {
    const org = await prisma.org.create({ data: { name: "bare" } });
    await expect(planOf(org.id)).rejects.toThrow(/no plan/);
  });
});
```

In `tests/dispatcher-auth.test.ts` add:

```ts
it("signup with product=nightshift seeds a sheet plan and a link secret; default is tower", async () => {
  const a = await request(app).post("/api/dispatcher/signup").send({ orgName: "Sheet Co", name: "Ana", email: "ana@sheet.co", password: "pw-long-enough-1", product: "nightshift" });
  expect(a.status).toBe(201);
  const me = await request(app).get("/api/dispatcher/me").set("Authorization", "Bearer " + a.body.token);
  expect(me.body.plan.tier).toBe("sheet");
  const org = await prisma.org.findUnique({ where: { id: a.body.org.id } });
  expect(org?.linkSecret).toMatch(/^[0-9a-f]{64}$/);
  const b = await request(app).post("/api/dispatcher/signup").send({ orgName: "Tower Co", name: "Bo", email: "bo@tower.co", password: "pw-long-enough-1" });
  const meB = await request(app).get("/api/dispatcher/me").set("Authorization", "Bearer " + b.body.token);
  expect(meB.body.plan.tier).toBe("tower");
});
```

- [ ] **Step 4: Run them and watch them fail**

Run: `cd fleet-backend && npx vitest run tests/plans.test.ts tests/dispatcher-auth.test.ts`
Expected: FAIL — module `plans.js` missing; `plan` undefined on `/me`.

- [ ] **Step 5: Write `plans.ts`, extend the writer, the signup and `/me`**

```ts
// fleet-backend/src/lib/plans.ts
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export type PlanTier = "sheet" | "tower";
export const PLAN_TIERS: readonly PlanTier[] = ["sheet", "tower"];

/** Creates the org's plan if it has none. Never changes an existing tier:
 *  upgrading is a deliberate write elsewhere, not a side effect of signup. */
export async function ensurePlan(tx: Prisma.TransactionClient, orgId: string, tier: PlanTier): Promise<void> {
  const existing = await tx.plan.findUnique({ where: { orgId } });
  if (!existing) await tx.plan.create({ data: { orgId, tier } });
}

export async function planOf(orgId: string): Promise<{ tier: PlanTier; loadNightCents: number | null; messagingMarkup: number; dailyCommsCapCents: number }> {
  const plan = await prisma.plan.findUnique({ where: { orgId } });
  if (!plan) throw new Error(`org ${orgId} has no plan — seed it`);
  return { tier: plan.tier as PlanTier, loadNightCents: plan.loadNightCents, messagingMarkup: plan.messagingMarkup, dailyCommsCapCents: plan.dailyCommsCapCents };
}
```

`loadWriter.ts`: `export type ChangeSource = "board" | "paste" | "import" | "loadboard" | "agent" | "backfill" | "system" | "sheet";` and in `LoadPatch` add `customerEmail?: string | null; sheetRowIndex?: number | null;`, and add both names to the plain-scalar list at line 91 so they are copied and traced like `customerName`.

`dispatcherAuth.ts` signup: `product: z.enum(["nightshift", "tower"]).optional()` in `signupSchema`; inside the transaction after the org is created: `await tx.org.update({ where: { id: org.id }, data: { linkSecret: randomBytes(32).toString("hex") } });` and `await ensurePlan(tx, org.id, product === "nightshift" ? "sheet" : "tower");`. In `/me` (and the login response, which returns the same org shape), include `plan: { tier }` from `planOf(dispatcher.orgId)`.

- [ ] **Step 6: Run the suite**

Run: `cd fleet-backend && npx vitest run && npx tsc --noEmit`
Expected: green, clean.

- [ ] **Step 7: Commit** — skipped (Global Constraints).

---

### Task 2: The worker texts and calls from the org's number

**Files:**
- Create: `night-shift/src/live/orgTelephony.ts`
- Modify: `night-shift/src/live/config.ts` (`TWILIO_FROM_NUMBER` optional in platform mode), `registry.ts` (trip carries `orgId`), `platformLoads.ts` (passes `orgId`; brief's `customerEmail` from `Load.customerEmail`), `worker.ts` (adapters per trip), `twilioWebhooks.ts` (SMS by `To` + `From`)
- Test: `night-shift/tests/live/orgTelephony.test.ts` (create), `night-shift/tests/live/twilioWebhooks.test.ts` (extend)

**Interfaces:**
- Consumes: `OrgTelephony` (Task 1); `Registry.start(brief, ids, extras)`; `registry.byPhone`.
- Produces: `telephonyFor(orgId, fallback: { fromNumber: string; callerId: string }): Promise<{ fromNumber: string; callerId: string }>` reading `OrgTelephony.smsSender/callerId` when present and non-null, else the fallback, cached 60 s per org; `Registry.byPhone(from: string, to: string)` — matches a trip by driver phone AND by that trip's org sender; `Trip.orgId: string`. Task 8 (sync) and Task 10 (link) rely on `Trip.orgId`.

- [ ] **Step 1: Write the failing tests**

```ts
// night-shift/tests/live/orgTelephony.test.ts
import { describe, it, expect, vi } from "vitest";
import { makeTelephonyFor } from "../../src/live/orgTelephony.js";

describe("telephonyFor", () => {
  const fallback = { fromNumber: "+15550000000", callerId: "+15550000000" };
  it("uses the org's own sender and caller id when the row has them", async () => {
    const read = vi.fn().mockResolvedValue({ smsSender: "+15551112222", callerId: "+15551112222" });
    const telephonyFor = makeTelephonyFor(read, () => 0);
    expect(await telephonyFor("org-a", fallback)).toEqual({ fromNumber: "+15551112222", callerId: "+15551112222" });
  });
  it("falls back to the env number when the org has no row or null fields", async () => {
    const read = vi.fn().mockResolvedValue(null);
    expect(await makeTelephonyFor(read, () => 0)("org-b", fallback)).toEqual(fallback);
    const read2 = vi.fn().mockResolvedValue({ smsSender: null, callerId: null });
    expect(await makeTelephonyFor(read2, () => 0)("org-b", fallback)).toEqual(fallback);
  });
  it("caches per org for 60 s", async () => {
    let now = 0;
    const read = vi.fn().mockResolvedValue({ smsSender: "+1", callerId: "+1" });
    const t = makeTelephonyFor(read, () => now);
    await t("org-a", fallback); await t("org-a", fallback);
    expect(read).toHaveBeenCalledTimes(1);
    now = 61_000; await t("org-a", fallback);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
```

In `twilioWebhooks.test.ts` add: an inbound SMS whose `To` is org A's sender and `From` is a driver on org B's trip is a 404 (no live trip), while the same `From` with org B's `To` reaches the trip.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd night-shift && npm test -- tests/live/orgTelephony.test.ts tests/live/twilioWebhooks.test.ts`
Expected: FAIL — module missing; `byPhone` takes one argument.

- [ ] **Step 3: Implement**

```ts
// night-shift/src/live/orgTelephony.ts
import { prisma } from "../../../fleet-backend/src/db.js";

export interface Telephony { fromNumber: string; callerId: string }
type Row = { smsSender: string | null; callerId: string | null } | null;
const TTL_MS = 60_000;

/** Spec §7.2. The org's own number when it has one; the env number until
 *  then (dev, and every org before slice 6 buys numbers). Cached because
 *  every tick of every trip would otherwise read the same row. */
export function makeTelephonyFor(read: (orgId: string) => Promise<Row>, nowMs: () => number) {
  let cache: Record<string, { at: number; value: Telephony }> = {};
  return async (orgId: string, fallback: Telephony): Promise<Telephony> => {
    const hit = cache[orgId];
    if (hit && nowMs() - hit.at < TTL_MS) return hit.value;
    const row = await read(orgId);
    const value: Telephony = row?.smsSender ? { fromNumber: row.smsSender, callerId: row.callerId ?? row.smsSender } : fallback;
    cache = { ...cache, [orgId]: { at: nowMs(), value } };
    return value;
  };
}

export const telephonyFor = makeTelephonyFor(
  (orgId) => prisma.orgTelephony.findUnique({ where: { orgId }, select: { smsSender: true, callerId: true } }),
  () => Date.now(),
);
```

`registry.ts`: `Trip` gains `orgId: string` and `sender: string` (the number its texts come from); `byPhone(from, to)` returns the trip whose `brief.driverPhone === from && sender === to`. File mode passes `orgId: "file"` and `sender: config.twilio.fromNumber`.

`worker.ts`: the registry factory becomes async-aware — resolve telephony *before* constructing the agent. Since `Registry`'s factory is synchronous today, resolve it in `syncPlatformLoads` when the trip is started (it already builds the brief there) and pass `{ fromNumber, callerId }` in `extras`; the factory then constructs `new TwilioMessenger(twilioClient, trip.sender, …)` and `new TwilioPhone(twilioClient, trip.callerId, …)`. Note `TwilioPhone` today is one shared instance because it owns the pending-call map the voice webhook consults; keep ONE `TwilioPhone` but make `call()` take the `from` per call: change its constructor's `from` into `defaultFrom` and add `opts.from?: string` to `CallOptions`… **no** — `CallOptions` is a port type and the core must not know numbers. Instead: `TwilioPhone` becomes a per-trip thin wrapper `TwilioPhone.forSender(callerId)` sharing one `pending` map via a `PendingCalls` object held by the worker; the voice router takes the `PendingCalls`. Keep the `PhonePort` signature unchanged.

`platformLoads.ts`: `buildBrief` sets `customerEmail: load.customerEmail ?? null` (add the column to `LoadForBrief`); when starting a trip, `await telephonyFor(load.orgId, fallback)` and pass `orgId`, `sender`, `callerId` in `extras`.

`config.ts`: `TWILIO_FROM_NUMBER` stays required (it is the fallback) — no change needed; document in `.env.example` that in platform mode it is "the number used until the org has its own".

`twilioWebhooks.ts`: `registry.byPhone(String(params.From ?? ""), String(params.To ?? ""))`.

- [ ] **Step 4: Run the package suite**

Run: `cd night-shift && npm test && npm run typecheck`
Expected: green, clean.

- [ ] **Step 5: Commit** — skipped.

---

### Task 3: The portal shows four nav items on the sheet tier

**Files:**
- Modify: `fleet-portal/src/stores/auth.ts` (session carries `tier`), `fleet-portal/src/layouts/AppShell.vue:35-51` (nav by tier), `fleet-portal/src/views/SignupView.vue` (a `product` query param → body)
- Test: `fleet-portal/src/layouts/AppShell.spec.ts` (create or extend), `fleet-portal/src/stores/auth.spec.ts` (extend)

**Interfaces:**
- Consumes: `/me` and login responses carrying `plan: { tier }` (Task 1).
- Produces: `useAuthStore().tier: "sheet" | "tower"` (default `"tower"` when absent, so nothing existing changes); `AppShell` renders `[Board, Night Shift, Usage, Settings]` when `tier === "sheet"` (Usage and Settings link to `/night-shift?tab=usage` and `?tab=settings` — placeholders that Task 9 gives the Connect tab a home next to; the tabs themselves are the next plan's) and today's nav otherwise.

- [ ] **Step 1: Failing tests**

```ts
// fleet-portal/src/layouts/AppShell.spec.ts
it("sheet tier shows Board, Night Shift, Usage, Settings and nothing else", async () => {
  const auth = useAuthStore(); auth.setSession({ token: "t", dispatcher: { id: "d1", name: "Ana", email: "ana@sheet.co", orgId: "o1" }, org: { id: "o1", name: "Sheet Co", timezone: "America/Chicago" }, plan: { tier: "sheet" } });
  const w = mount(AppShell, { global: { plugins: [router, pinia] } });
  const labels = w.findAllComponents(SidebarNavItem).map((c) => c.props("label"));
  expect(labels).toEqual(["Board", "Night Shift", "Usage", "Settings"]);
});
it("tower tier shows the full nav", async () => {
  const auth = useAuthStore(); auth.setSession({ token: "t", dispatcher: { id: "d1", name: "Bo", email: "bo@tower.co", orgId: "o2" }, org: { id: "o2", name: "Tower Co", timezone: "America/Chicago" }, plan: { tier: "tower" } });
  const w = mount(AppShell, { global: { plugins: [router, pinia] } });
  const labels = w.findAllComponents(SidebarNavItem).map((c) => c.props("label"));
  expect(labels.slice(0, 3)).toEqual(["Their Board", "Control Tower", "Night Shift"]);
  expect(labels).toContain("Fleet");
});
```

`auth.spec.ts`: `tier` defaults to `"tower"` when the session has no `plan`; persists across `persistOrg`.

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Implement.** `auth.ts`: `plan?: { tier: "sheet" | "tower" } | null` on the session type; `const tier = computed(() => session.value?.plan?.tier ?? "tower")`; persist it with the org. `AppShell.vue`: `const SHEET_NAV = [{ label: 'Board', to: '/board/broker' }, { label: 'Night Shift', to: '/night-shift' }, { label: 'Usage', to: '/night-shift?tab=usage' }, { label: 'Settings', to: '/night-shift?tab=settings' }]`; `primaryNav = computed(() => auth.tier === 'sheet' ? SHEET_NAV : TOWER_PRIMARY)`; `moreNav` is empty on the sheet tier and the "More" section is hidden when empty. `SignupView.vue`: read `route.query.product`, send `product: "nightshift"` when it equals `nightshift`. `/` redirect: when `tier === "sheet"` redirect to `broker-board` instead of `cockpit` (in the router's `''` child, via a `beforeEnter` reading the store).

- [ ] **Step 4: Run the portal suites.** `npx vitest run && npx vue-tsc --noEmit -p tsconfig.app.json` — green; five permitted errors.

- [ ] **Step 5: Commit** — skipped.

---

### Task 4: The connector interface, the fake, the Google implementation, the Graph stub

**Files:**
- Create: `fleet-backend/src/lib/sheet/connector.ts`, `fakeConnector.ts`, `googleConnector.ts`, `graphConnector.ts`, `googleAuth.ts`, `fleet-backend/src/lib/secretBox.ts`
- Create: `fleet-backend/tests/sheet/connector.suite.ts`, `fleet-backend/tests/sheet/fakeConnector.test.ts`, `googleConnector.test.ts`, `graphConnector.test.ts`, `fleet-backend/tests/secretBox.test.ts`
- Modify: `fleet-backend/package.json` (add `googleapis`), `fleet-backend/.env.example`

**Interfaces:**
- Produces:

```ts
// connector.ts
export interface TabRef { spreadsheetId: string; tabId: string; }
export interface RawRow { rowIndex: number; cells: string[]; }          // rowIndex is 1-based, the sheet's own
export interface CellWrite { rowIndex: number; col: number; value: string; note?: string }   // col is 0-based
export interface AgentColumnNames { switch: string; status: string }
export class NotImplemented extends Error {}
export interface SheetConnector {
  listSpreadsheets(): Promise<{ id: string; title: string }[]>;
  listTabs(spreadsheetId: string): Promise<{ id: string; title: string }[]>;
  readHeader(ref: TabRef, headerRow: number): Promise<string[]>;
  readRows(ref: TabRef, headerRow: number, sinceVersion?: string): Promise<{ rows: RawRow[]; version: string; changed: boolean }>;
  writeCells(ref: TabRef, writes: CellWrite[]): Promise<void>;
  ensureAgentColumns(ref: TabRef, headerRow: number, names: AgentColumnNames, policyNames: string[]): Promise<{ switch: number; status: number }>;
}
```
  `FakeConnector` (constructor takes `{ [spreadsheetId]: { title, tabs: { [tabId]: { title, grid: string[][], notes?: Record<string,string> } } } }`, exposes `grid(ref)` and `notes(ref)` for assertions, and bumps `version` on every write). `GoogleSheetsConnector(auth: OAuth2Client)`. `GraphExcelConnector` throws `NotImplemented` from every method. `googleAuth.ts`: `consentUrl(state)`, `exchangeCode(code) → { refreshToken, accountEmail }`, `clientFor(refreshToken) → OAuth2Client`. `secretBox.ts`: `seal(plain): string`, `open(sealed): string` (AES-256-GCM, `SECRET_BOX_KEY` 32 bytes hex; throws when the key is missing).
- Tasks 5–9 consume the connector; Task 7 consumes `googleAuth` and `secretBox`.

- [ ] **Step 1: Write the shared suite and the per-connector tests**

```ts
// fleet-backend/tests/sheet/connector.suite.ts
import { it, expect } from "vitest";
import type { SheetConnector, TabRef } from "../../src/lib/sheet/connector.js";

/** Every connector passes the same suite. `make` returns a connector whose
 *  spreadsheet "s1" has tab "t1" with the header on row 1 and two data rows. */
export function connectorSuite(make: () => Promise<{ c: SheetConnector; ref: TabRef }>) {
  it("reads the header row", async () => {
    const { c, ref } = await make();
    expect(await c.readHeader(ref, 1)).toEqual(["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "DEL APPT"]);
  });
  it("reads data rows with their sheet row index and reports changed=false on a second read with the same version", async () => {
    const { c, ref } = await make();
    const first = await c.readRows(ref, 1);
    expect(first.rows.map((r) => r.rowIndex)).toEqual([2, 3]);
    expect(first.rows[0].cells[0]).toBe("145219");
    const second = await c.readRows(ref, 1, first.version);
    expect(second.changed).toBe(false);
    expect(second.rows).toEqual([]);
  });
  it("writes cells and notes, and the next read sees them with a new version", async () => {
    const { c, ref } = await make();
    const v0 = (await c.readRows(ref, 1)).version;
    await c.writeCells(ref, [{ rowIndex: 2, col: 4, value: "● SHADOW — would say: hi", note: "https://x/n/t/l1" }]);
    const after = await c.readRows(ref, 1);
    expect(after.version).not.toBe(v0);
    expect(after.rows[0].cells[4]).toBe("● SHADOW — would say: hi");
  });
  it("ensureAgentColumns adds the two headers at the right edge once, and is idempotent", async () => {
    const { c, ref } = await make();
    const a = await c.ensureAgentColumns(ref, 1, { switch: "Night Shift", status: "Night Shift status" }, ["Standard"]);
    expect(a).toEqual({ switch: 5, status: 6 });
    const b = await c.ensureAgentColumns(ref, 1, { switch: "Night Shift", status: "Night Shift status" }, ["Standard", "Hazmat"]);
    expect(b).toEqual(a);
    expect(await c.readHeader(ref, 1)).toEqual(["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "DEL APPT", "Night Shift", "Night Shift status"]);
  });
}
```

`fakeConnector.test.ts` runs `connectorSuite` against `FakeConnector` plus: `grid(ref)` reflects writes; the dropdown values are recorded as `validation(ref, col)` → `["OFF", "Standard"]`.

`googleConnector.test.ts` runs `connectorSuite` against `GoogleSheetsConnector` with a **mocked `googleapis`** (`vi.mock("googleapis")`) whose `sheets.spreadsheets.values.get/batchUpdate`, `spreadsheets.get/batchUpdate` and `drive.files.get(fields: "version")`/`files.list` are backed by the same in-memory grid the fake uses — so the suite proves the request shapes, not Google. Add: `readRows` uses `drive.files.get(fileId, fields="version")` as the version and skips the values call when unchanged; `ensureAgentColumns` sends one `batchUpdate` with `appendDimension`, a `setDataValidation` (ONE_OF_LIST: `OFF` + policy names, `showCustomUi: true`) on the switch column below the header, and five `addConditionalFormatRule` rules (`TEXT_STARTS_WITH` `● WATCHING`/`● DELIVERED` green, `● ASKED`/`● CALLING` amber, `● ESCALATED`/`● ATTENTION` red, `● SHADOW`/`● HELD` blue, `● OFF` grey) on the status column; `writeCells` sends one `values.batchUpdate` for values and one `spreadsheets.batchUpdate` with `updateCells` (`fields: "note"`) for notes.

`graphConnector.test.ts`: `connectorSuite` wrapped in `it.fails`-style expectation — every method rejects with `NotImplemented`. Write it as: for each method, `await expect(c.method(...)).rejects.toBeInstanceOf(NotImplemented)`.

`secretBox.test.ts`: round-trips; two seals of the same text differ (random IV); `open` of a tampered string throws; missing key throws naming `SECRET_BOX_KEY`.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd fleet-backend && npx vitest run tests/sheet tests/secretBox.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Install and implement**

Run: `cd fleet-backend && npm i googleapis`

`secretBox.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
const key = (): Buffer => {
  const hex = process.env.SECRET_BOX_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("SECRET_BOX_KEY must be 32 bytes as 64 hex characters");
  return Buffer.from(hex, "hex");
};
export function seal(plain: string): string {
  const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}
export function open(sealed: string): string {
  const [iv, tag, body] = sealed.split(".").map((s) => Buffer.from(s, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}
```

`googleAuth.ts` (scopes exactly `https://www.googleapis.com/auth/spreadsheets`, `https://www.googleapis.com/auth/drive.file`, `openid`, `email`; `access_type: "offline"`, `prompt: "consent"`, `include_granted_scopes: true`; `state` is opaque to Google and is the org's signed nonce from Task 7):

```ts
import { google } from "googleapis";
const env = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
export const SCOPES = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive.file", "openid", "https://www.googleapis.com/auth/userinfo.email"];
export function oauthClient() { return new google.auth.OAuth2(env("GOOGLE_CLIENT_ID"), env("GOOGLE_CLIENT_SECRET"), env("GOOGLE_REDIRECT_URI")); }
export function consentUrl(state: string): string { return oauthClient().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, state, include_granted_scopes: true }); }
export async function exchangeCode(code: string): Promise<{ refreshToken: string; accountEmail: string | null }> {
  const client = oauthClient(); const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error("Google did not return a refresh token — revoke the app at myaccount.google.com/permissions and connect again");
  client.setCredentials(tokens);
  const info = await google.oauth2({ version: "v2", auth: client }).userinfo.get().catch(() => null);
  return { refreshToken: tokens.refresh_token, accountEmail: info?.data.email ?? null };
}
export function clientFor(refreshToken: string) { const c = oauthClient(); c.setCredentials({ refresh_token: refreshToken }); return c; }
```

`googleConnector.ts`: `readRows` → `drive.files.get({ fileId, fields: "version" })`; if `sinceVersion === version` return `{ rows: [], version, changed: false }`; else `sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabTitle}'!A${headerRow + 1}:ZZ`, valueRenderOption: "FORMATTED_VALUE" })` and map `values[i]` → `{ rowIndex: headerRow + 1 + i, cells }`, padding short rows to the header's width, dropping rows whose cells are all blank. `tabTitle` is resolved from `tabId` via one `spreadsheets.get({ fields: "sheets.properties" })` cached per connector instance. Column index → A1 letters with a small helper `colToA1(n)` (0 → `A`, 26 → `AA`). `listSpreadsheets` → `drive.files.list({ q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false", orderBy: "modifiedTime desc", pageSize: 50, fields: "files(id,name)" })`.

`graphConnector.ts`: six methods, each `async () => { throw new NotImplemented("Excel/Graph connector is not built yet — spec §2"); }`.

`.env.example`: add `GOOGLE_CLIENT_ID=`, `GOOGLE_CLIENT_SECRET=`, `GOOGLE_REDIRECT_URI=http://localhost:3001/api/dispatcher/sheet/oauth/callback`, `SECRET_BOX_KEY=` (with the comment `# 64 hex chars: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), `PORTAL_URL=http://localhost:5173`.

- [ ] **Step 4: Run the suite**

Run: `cd fleet-backend && npx vitest run tests/sheet tests/secretBox.test.ts && npx tsc --noEmit`
Expected: green, clean.

- [ ] **Step 5: Commit** — skipped.

---

### Task 5: Mapping and row → patch

**Files:**
- Create: `fleet-backend/src/lib/sheet/mapping.ts`, `rowToPatch.ts`
- Test: `fleet-backend/tests/sheet/mapping.test.ts`, `rowToPatch.test.ts`

**Interfaces:**
- Consumes: `parseApptText` (`lib/apptText.ts`), `parseMoney`, `parseSheetDate` (`lib/brokerSheet.ts`), `normalizeHeader` (`lib/boardLayout.ts`), `LoadPatch` (Task 1).
- Produces:

```ts
// mapping.ts
export type SheetColumnKey = "loadRef" | "driverPhone" | "driverName" | "pickup" | "delivery" | "pickupAppt" | "deliveryAppt" | "customerEmail" | "carrierName" | "carrierPhone" | "rate" | "notes";
export const REQUIRED_KEYS: readonly SheetColumnKey[] = ["loadRef", "driverPhone", "pickup", "delivery", "deliveryAppt"];
export type SheetMapping = Partial<Record<SheetColumnKey, string>>;        // our key → their header, verbatim
export function proposeSheetMapping(header: string[]): { mapping: SheetMapping; extras: string[]; missing: SheetColumnKey[] };
export function validateMapping(header: string[], mapping: SheetMapping): { ok: true } | { ok: false; errors: string[] };  // required present, every header exists, no header used twice
export function columnIndexes(header: string[], mapping: SheetMapping): Partial<Record<SheetColumnKey, number>>;
// rowToPatch.ts
export interface RowResult { loadRef: string | null; patch: LoadPatch; attention: string[] }
export function rowToPatch(row: RawRow, header: string[], mapping: SheetMapping, ctx: { tz: string; year: number }): RowResult;
```
  Task 8 (sync) consumes all four; Task 7 (routes) consumes `proposeSheetMapping` and `validateMapping`.

- [ ] **Step 1: Failing tests**

```ts
// mapping.test.ts
it("proposes by header alias, lists extras and missing", () => {
  const r = proposeSheetMapping(["Load #", "Driver Cell", "Origin", "Destination", "Del Appt", "Broker", "Rate"]);
  expect(r.mapping).toEqual({ loadRef: "Load #", driverPhone: "Driver Cell", pickup: "Origin", delivery: "Destination", deliveryAppt: "Del Appt", rate: "Rate" });
  expect(r.extras).toEqual(["Broker"]);
  expect(r.missing).toEqual([]);
});
it("reports missing required keys", () => {
  expect(proposeSheetMapping(["Load #", "Origin"]).missing).toEqual(["driverPhone", "delivery", "deliveryAppt"]);
});
it("validateMapping refuses a header used twice, an unknown header, and a missing required key", () => {
  const header = ["Load #", "Driver Cell", "Origin", "Destination", "Del Appt"];
  expect(validateMapping(header, { loadRef: "Load #", driverPhone: "Load #", pickup: "Origin", delivery: "Destination", deliveryAppt: "Del Appt" })).toEqual({ ok: false, errors: ['"Load #" is used for both loadRef and driverPhone'] });
  expect(validateMapping(header, { loadRef: "Nope", driverPhone: "Driver Cell", pickup: "Origin", delivery: "Destination", deliveryAppt: "Del Appt" }).ok).toBe(false);
  expect(validateMapping(header, { loadRef: "Load #" }).ok).toBe(false);
});
```

```ts
// rowToPatch.test.ts
const header = ["LOAD#", "DRIVER PHONE", "DRIVER", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT", "CUSTOMER EMAIL", "RATE", "BROKER"];
const mapping = { loadRef: "LOAD#", driverPhone: "DRIVER PHONE", driverName: "DRIVER", pickup: "PICK UP", delivery: "DELIVERY", pickupAppt: "PU APPT", deliveryAppt: "DEL APPT", customerEmail: "CUSTOMER EMAIL", rate: "RATE" };
const ctx = { tz: "America/Chicago", year: 2026 };
it("maps a full row to a LoadPatch and keeps unmapped columns as extras", () => {
  const r = rowToPatch({ rowIndex: 2, cells: ["145219", "+15551234567", "Milan", "Dallas, TX", "Tulsa, OK", "PU: 07/14 - 12:00pm", "DEL: 07/15 - 10:00am", "ops@acme.com", "$4,000.00", "Acme"] }, header, mapping, ctx);
  expect(r.loadRef).toBe("145219");
  expect(r.patch).toMatchObject({ boardLoadNo: "145219", driverCell: "+15551234567", carrierContactName: "Milan", customerEmail: "ops@acme.com", revenueCents: 400000, sheetRowIndex: 2,
    stops: { pickup: { address: "Dallas, TX" }, delivery: { address: "Tulsa, OK" } }, apptText: "PU: 07/14 - 12:00pm\nDEL: 07/15 - 10:00am", extras: { BROKER: "Acme" } });
  expect(r.attention).toEqual([]);
});
it("a row with no load number has loadRef null and one attention line", () => {
  const r = rowToPatch({ rowIndex: 3, cells: ["", "+15551234567", "", "Dallas, TX", "Tulsa, OK", "", "DEL: 07/15 - 10:00am", "", "", ""] }, header, mapping, ctx);
  expect(r.loadRef).toBeNull();
  expect(r.attention).toEqual(["needs a load number"]);
});
it("a phone that is not E.164 and an unreadable appointment are attention, not guesses", () => {
  const r = rowToPatch({ rowIndex: 4, cells: ["1", "555-1234", "", "Dallas, TX", "Tulsa, OK", "", "sometime tuesday", "", "", ""] }, header, mapping, ctx);
  expect(r.attention).toEqual(expect.arrayContaining([expect.stringMatching(/driver phone "555-1234"/), expect.stringMatching(/can't read DEL appointment/)]));
  expect(r.patch.driverCell).toBeUndefined();
});
it("a blank rate is not attention (rate is optional on the sheet)", () => {
  const r = rowToPatch({ rowIndex: 5, cells: ["2", "+15551234567", "", "Dallas, TX", "Tulsa, OK", "", "DEL: 07/15 - 10:00am", "", "", ""] }, header, mapping, ctx);
  expect(r.attention).toEqual([]);
  expect(r.patch.revenueCents).toBeUndefined();
});
```

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Implement.** Aliases (normalized with `normalizeHeader`): `loadRef: ["load", "load no", "load number", "load id", "ref", "reference", "pro", "pro number"]`, `driverPhone: ["driver phone", "driver cell", "driver tel", "cell", "phone", "driver number"]`, `driverName: ["driver", "driver name"]`, `pickup: ["pick up", "pickup", "origin", "pu", "pu city", "from", "shipper"]`, `delivery: ["delivery", "destination", "dest", "del", "del city", "to", "consignee"]`, `pickupAppt: ["pu appt", "pickup appt", "pu time", "pickup time", "pu appointment"]`, `deliveryAppt: ["del appt", "delivery appt", "del time", "delivery time", "appt", "appointment", "appt schedule", "delivery appointment"]`, `customerEmail: ["customer email", "email", "contact email"]`, `carrierName: ["carrier", "carrier name"]`, `carrierPhone: ["carrier phone", "carrier tel"]`, `rate: ["rate", "customer rate", "revenue", "bill rate"]`, `notes: ["notes", "update", "comments", "status"]`. First header to match a key wins; a header matches at most one key.

`rowToPatch`: E.164 check `/^\+[1-9]\d{6,14}$/` (the same regex as `night-shift/src/live/config.ts`); a bare 10-digit US number is normalised to `+1…` (say so in a note, not attention). `apptText` = the `pickupAppt` cell and the `deliveryAppt` cell joined by `\n`, each prefixed with `PU: `/`DEL: ` when the cell does not already start with one, so `parseApptText` reads them; its `notes` become attention lines. `notes` key → `updateText`. Extras = every header not in the mapping, `{ [header]: cell }`, blanks omitted. `sheetRowIndex: row.rowIndex` always.

- [ ] **Step 4: Run** `npx vitest run tests/sheet && npx tsc --noEmit`. Green.

- [ ] **Step 5: Commit** — skipped.

---

### Task 6: The status cell text

**Files:**
- Create: `fleet-backend/src/lib/sheet/statusCell.ts`
- Test: `fleet-backend/tests/sheet/statusCell.test.ts`

**Interfaces:**
- Produces: `statusCellText(pill: string, line: string | null): string`; `PILL_WORDS: Record<pill, string>`. Task 8 consumes it.

- [ ] **Step 1: Failing test** — one assertion per pill from spec §6.2, verbatim:

```ts
it.each([
  ["watching", "40 mi out, ETA 10:20", "● WATCHING — 40 mi out, ETA 10:20"],
  ["shadow", "would say: Hi Milan, this is the dispatch assistant for load 145219…", "● SHADOW — would say: Hi Milan, this is the dispatch assistant for load 145219…"],
  ["attention", `can't read DEL appointment: "08-15:00 fcfs?"`, `● ATTENTION — can't read DEL appointment: "08-15:00 fcfs?"`],
  ["delivered", "07/15/2026", "● DELIVERED 07/15/2026"],
  ["held", null, "● HELD"],
  ["off", null, "● OFF"],
])("%s", (pill, line, expected) => expect(statusCellText(pill, line)).toBe(expected));
it("an unknown pill word is rendered as ATTENTION so a vocabulary drift is visible, not silent", () => {
  expect(statusCellText("bogus", "x")).toBe("● ATTENTION — unknown state 'bogus': x");
});
```

- [ ] **Step 2: Watch it fail.** **Step 3: Implement** — `delivered` uses a space, every other pill ` — ` when a line exists. **Step 4: Run.** Green. **Step 5: Commit** — skipped.

---

### Task 7: Setup routes — OAuth, spreadsheets, tabs, header, mapping, binding

**Files:**
- Create: `fleet-backend/src/routes/dispatcherSheet.ts`, `fleet-backend/src/lib/sheet/connectorFor.ts`
- Modify: `fleet-backend/src/app.ts` (mount after `dispatcherNightShiftRouter`)
- Test: `fleet-backend/tests/sheet/routes.test.ts`

**Interfaces:**
- Consumes: `consentUrl`, `exchangeCode`, `clientFor` (Task 4); `seal`/`open`; `GoogleSheetsConnector`; `proposeSheetMapping`, `validateMapping` (Task 5); `SheetBinding` (Task 1); `saveLayout` (`lib/boardLayout.ts`).
- Produces, all under `/api/dispatcher/sheet`, dispatcher auth, org-scoped, `asyncRoute`:
  - `GET /oauth/start` → `{ url }` (state = `seal(JSON.stringify({ orgId, dispatcherId, at }))`).
  - `GET /oauth/callback?code&state` — **no auth header** (Google redirects the browser): opens `state`, refuses if `at` older than 10 min, exchanges the code, upserts a **pending** `SheetBinding` (`status: "paused"`, `spreadsheetId: ""`, `tabId: ""`) holding the sealed refresh token and `accountEmail`, then `302` to `${PORTAL_URL}/night-shift?tab=connect&step=2`.
  - `GET /spreadsheets` → `{ spreadsheets }`; `GET /tabs?spreadsheetId` → `{ tabs }`; `GET /header?spreadsheetId&tabId&headerRow=1` → `{ header, proposal: { mapping, extras, missing } }`.
  - `POST /mapping` body `{ spreadsheetId, tabId, tabTitle, headerRow, mapping }` → validates, writes the binding (`status: "connected"`), seeds `BoardLayout` via `saveLayout(orgId, layoutFromMapping(mapping, extras))` → `{ binding }`.
  - `GET /` → `{ binding | null }` (never returns the token). `DELETE /` → revokes the Google token (`client.revokeToken`, errors logged not raised), sets `status: "paused"` and blanks `refreshToken`.
  - `POST /install` and `POST /sync-now` are Task 9's.
  `connectorFor(binding): SheetConnector` → `new GoogleSheetsConnector(clientFor(open(binding.refreshToken)))` for `provider: "google"`, `new GraphExcelConnector()` otherwise. Tasks 8, 9, 10 consume `connectorFor`.

- [ ] **Step 1: Failing tests** — with `googleapis` and `googleAuth` mocked at the module level:
  - `oauth/start` returns a Google URL containing `access_type=offline` and a `state` that `open`s to the caller's org.
  - `oauth/callback` with a state from another org's seal... (the state is sealed, so tampering fails `open`) → 400; a state older than 10 min → 400; a good state creates a paused binding with a sealed token (`binding.refreshToken !== "rt-1"`, `open(...) === "rt-1"`) and redirects to the portal.
  - `header` proposes a mapping for the fixture header.
  - `mapping` with a missing required key → 400 naming it; a valid one → 200, binding `connected`, `BoardLayout` has one `extra` column per unmapped header.
  - `GET /` never includes `refreshToken`; another org's binding is invisible.
  - `DELETE /` pauses and blanks the token.
  - Every handler is wrapped (`no-silent-hang` passes).

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Implement.** The callback route is mounted on the same router but **before** the auth gate — check how `app.ts` applies `dispatcherGate`; if the gate is `app.use("/api/dispatcher", gate, router)`, mount the callback separately as `app.get("/api/dispatcher/sheet/oauth/callback", asyncRoute(...))` above it and say so in the report. `layoutFromMapping`: the `BoardColumn[]` in sheet order — mapped keys become the nearest `BoardColumnKey` (`loadRef → loadNo`, `pickup → pickupCity`, `delivery → deliveryCity`, `rate → rate`, `deliveryAppt`/`pickupAppt` → `appt` (one column), `notes → update`, `driverPhone → driverCell`, `carrierPhone → phone`, `carrierName → customer`, `driverName → contact`, `customerEmail → extra`), every unmapped header an `extra` with `source` = the header, then `agent` at the end.

- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit`. Green.

- [ ] **Step 5: Commit** — skipped.

---

### Task 8: Read-only sync — rows become loads

**Files:**
- Create: `fleet-backend/src/lib/sheet/sync.ts`
- Modify: `night-shift/src/live/worker.ts` (call `syncAllSheets` before `syncPlatformLoads`)
- Test: `fleet-backend/tests/sheet/sync.test.ts`

**Interfaces:**
- Consumes: `SheetConnector`, `FakeConnector` (Task 4); `rowToPatch`, `columnIndexes` (Task 5); `applyLoadChange` with `source: "sheet"`; `emitLoadChanged`.
- Produces:

```ts
export const SHEET_ACTOR = { dispatcherId: null, name: "sheet" } as const;
export interface SyncDeps { connector: SheetConnector; nowMs: () => number; switchRoute?: (loadId: string, enabled: boolean, policyId: string | null) => Promise<void> }
export interface SyncReport { read: number; created: number; updated: number; unchanged: number; skipped: { rowIndex: number; reason: string }[]; statusWrites: number; error: string | null }
export async function syncBinding(bindingId: string, deps: SyncDeps): Promise<SyncReport>;
export async function syncAllSheets(): Promise<SyncReport[]>;     // every binding with status "connected"; connectorFor each; never throws
```
  Task 9 extends `syncBinding` with the switch read and status writes (its `switchRoute` and `statusWrites` are placeholders here — this task leaves `switchRoute` unused and `statusWrites` 0). Task 11 runs it live.

- [ ] **Step 1: Failing tests** (against `FakeConnector` and the test DB):
  - A fixture tab with three rows: `145219` full, `145220` with a bad phone, a row with no load number. After `syncBinding`: two `Load`s exist with `boardLoadNo` 145219/145220 and `sheetRowIndex` 2/3; `145220` has an `AgentUpdate` row with `kind: "attention"` whose text contains `driver phone "555-1234"` (the writer stores attention as `AgentUpdate` rows, `loadWriter.ts:213-219`; `attentionAspect(text)` groups them, so pass `attentionOwned` with one representative line per aspect the sheet produces — phone, appointment, load number); the third row is in `skipped` with `reason: "needs a load number"` and no `Load`; every `LoadChange` has `source: "sheet"`, `actorName: "sheet"`.
  - A second `syncBinding` with an unchanged sheet reads zero rows (`read: 0`) and writes nothing (`LoadChange` count unchanged).
  - Editing the pickup cell in the fake and syncing again produces exactly one `LoadChange` (`field: "stops.pickup"` or however the writer names it — assert on the count and that `before`/`after` are the two cities).
  - Two rows with the same load number: both skipped with `reason: "duplicate load number 145219"`, neither mirrored (a pre-existing `Load` 145219 is left untouched).
  - A binding whose connector throws three syncs in a row goes to `status: "error"` with `lastError`, and `syncAllSheets` still returns (never throws); a successful sync after that resets `status` to `connected`.
  - `syncBinding` records `lastVersion`, `lastSyncAt`.

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Implement.** Per binding: `readRows(ref, headerRow, binding.lastVersion)`; when `changed === false` return early with `read: 0`. Otherwise compute `RowResult`s, detect duplicate `loadRef`s (both skipped), then for each row with a `loadRef`: find `Load` by `(orgId, boardLoadNo)`; if absent, create the bare row (`prisma.load.create` with `orgId`, `boardLoadNo`, `requiredEquip: "unknown"` — check what the broker import uses for a brokered load's default equipment and use the same constant, `EQUIPMENT_NOTE` hints there is one) then `applyLoadChange` with the full patch; if present, diff the patch against the current row (compare each patch key's value with the load's; drop equal keys; for `stops`, compare with the pickup/delivery `LoadStop.address`; for `extras`, deep-equal) and call `applyLoadChange` only when something differs, `attention` = the row's attention lines, `attentionOwned` = `SHEET_ATTENTION_ASPECTS` — a constant in `rowToPatch.ts` holding one representative line per aspect the sheet can raise (`driver phone ""`, `can't read DEL appointment ""`, `can't read PU appointment ""`, `needs a load number`), so a corrected cell clears its old line (`loadWriter.ts:51-64`). `emitLoadChanged` for each changed load. Failure counting: `SheetBinding.lastError` plus an in-memory `failures` map keyed by binding id → three consecutive → `status: "error"`; on the next success reset. Wrap everything so `syncAllSheets` logs and continues.

`worker.ts` platform poll: `await syncAllSheets();` as the first line of `poll`, imported from `../../../fleet-backend/src/lib/sheet/sync.js`.

- [ ] **Step 4: Run** `cd fleet-backend && npx vitest run && npx tsc --noEmit`; `cd night-shift && npm test && npm run typecheck`. Green.

- [ ] **Step 5: Commit** — skipped.

---

### Task 9: The two cells — install, the switch read, the status write

**Files:**
- Modify: `fleet-backend/src/lib/sheet/sync.ts`, `fleet-backend/src/routes/dispatcherSheet.ts` (`POST /install`, `POST /sync-now`), `fleet-backend/src/routes/dispatcherNightShift.ts` (policy create/rename re-runs `ensureAgentColumns` when a binding exists)
- Test: `fleet-backend/tests/sheet/cells.test.ts`, extend `routes.test.ts`

**Interfaces:**
- Consumes: `ensureAgentColumns`, `writeCells` (Task 4); `statusCellText` (Task 6); the switch route's logic (`dispatcherNightShift.ts:121-178`) — extract its body into `lib/agentSwitch.ts` as `applyAgentSwitch(args: { loadId, orgId, actor, source, enabled, policyId? }): Promise<{ version; changed }>` so the sheet calls the same code path with `source: "sheet"` and the HTTP route becomes a thin wrapper. `AgentPolicy` names for the dropdown; `Org.linkSecret` for the note's URL (the URL shape is Task 10's: `${PORTAL_URL}/n/${orgToken}/${loadId}`, with `orgToken = hmacSha256(linkSecret, orgId).hex.slice(0,32) + "." + orgId`; put `orgTokenFor(org)` in `lib/nightShiftLink.ts` in THIS task so both tasks import it).
- Produces: `POST /api/dispatcher/sheet/install` → runs `ensureAgentColumns` with `{ switch: "Night Shift", status: "Night Shift status" }` and the org's policy names, stores `agentSwitchCol`/`agentStatusCol` → `{ binding }`. `POST /sync-now` → `syncBinding` → `{ report }`. `syncBinding` now (a) reads the switch cell of every mirrored row and, when it differs from the load, calls `applyAgentSwitch` (`OFF`/blank → `enabled: false`; a policy name → `enabled: true, policyId` of that name; an unknown name → attention `unknown policy "X"` and no switch), and (b) after the load pass, for every mirrored load whose `agentPill` or newest `AgentUpdate.atMs` is newer than `sheetStatusWrittenAt`, writes `statusCellText(pill, line)` with the note = the deep link, in ONE `writeCells` batch, then sets `sheetStatusWrittenAt`.

- [ ] **Step 1: Failing tests**
  - `install` adds the two columns to the fake, records their indexes, and the dropdown values are `["OFF", "Standard"]`; running it twice changes nothing; creating a policy "Hazmat" re-installs and the dropdown gains it.
  - A row whose switch cell reads `Standard` → after sync, `Load.agentEnabled = true`, `agentPolicyId` = Standard's id, `agentPill = "watching"`, and the `LoadChange` has `source: "sheet"`. Setting it to `OFF` → `agentEnabled = false`, an `AgentCommand` of kind `stop` exists. A cell reading `Bogus` → no switch, attention line `unknown policy "Bogus"`.
  - The status write: set `agentPill = "shadow"` and an `AgentUpdate` `would say: hi Milan` on a mirrored load; sync → the fake's status cell reads `● SHADOW — would say: hi Milan`, the note is `http://localhost:5173/n/<token>/<loadId>`, `sheetStatusWrittenAt` set; a second sync writes nothing (`statusWrites: 0`); a newer `AgentUpdate` writes again.
  - A row skipped for `needs a load number` still gets its status cell written: `● ATTENTION — needs a load number` (the one exception to "mirrored loads only" — otherwise the dispatcher never learns why the row is ignored). No note on that one.
  - We never write the switch column: assert the fake's switch cells are byte-identical before and after every sync in the file.

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Implement.** Extract `applyAgentSwitch` first and re-run `night-shift-routes.test.ts` to prove the HTTP route is unchanged. Then the sync additions. The status pass selects `prisma.load.findMany({ where: { orgId, sheetRowIndex: { not: null } }, include: { agentUpdates: { orderBy: { atMs: "desc" }, take: 1 } } })` and filters in memory by `sheetStatusWrittenAt`. Line for the cell = newest `AgentUpdate.text`, or null when none. The `Load.sheetRowIndex` is refreshed on every sync from `rowToPatch`, so a row that moved (insert above) is written at its new index — the tests should include one such case: insert a row at the top of the fake between syncs and prove the status lands on the right row.

- [ ] **Step 4: Run** the backend suite + `tsc`. Green.

- [ ] **Step 5: Commit** — skipped.

---

### Task 10: The deep link — the drawer on a phone

**Files:**
- Create: `fleet-backend/src/lib/nightShiftLink.ts` (from Task 9: `orgTokenFor`, plus `verifyOrgToken(token): string | null` → orgId), `fleet-backend/src/routes/nightShiftLink.ts`, `fleet-portal/src/nightshift/views/NightShiftLinkView.vue`, `fleet-portal/src/nightshift/views/NightShiftLinkView.spec.ts`
- Modify: `fleet-backend/src/app.ts`; `fleet-portal/src/router/index.ts` (route `/n/:orgToken/:loadId`, `meta: { public: true }`, and `authGuard` lets `meta.public` through); `fleet-portal/src/lib/api.ts` (a second client that sends the org token instead of the bearer); `fleet-portal/src/components/agent/AgentDrawer.vue` (accept an injected API so it works without the dispatcher session)
- Test: `fleet-backend/tests/sheet/link.test.ts`

**Interfaces:**
- Consumes: `orgTokenFor` (Task 9); the timeline and command code in `dispatcherNightShift.ts:181-260` — extract to `lib/agentTimeline.ts` (`timelineFor(loadId)`) and `lib/agentCommands.ts` (`queueCommand(loadId, kind, payload, actorName)`) so both routers share them.
- Produces: `GET /api/n/:orgToken/loads/:id/agent` → the same shape as the dispatcher's `GET /loads/:id/agent`; `POST /api/n/:orgToken/loads/:id/agent/commands` body `{ kind, payload? }` → 202, `actorName: "link"`; both 404 when the token is bad or the load is not that org's. **No route under `/api/n` can flip the switch or a policy** — the link supervises, it does not configure. Portal: `/n/:orgToken/:loadId` renders `AgentDrawer` full-screen, no sidebar, at 390 px it fits without horizontal scroll.

- [ ] **Step 1: Failing tests**
  - Backend: a valid token returns the timeline; a token for org A with org B's load id → 404; a tampered token → 404; `commands` queues `takeover` with `actorName: "link"`; `POST /api/n/:t/loads/:id/agent` (the switch) → 404 (route does not exist).
  - Portal: the view mounts without a session, calls the link API with the token from the route, renders the pill and the buttons; pressing **I've got it** posts `{ kind: "takeover" }`; the layout has no `AppShell`.

- [ ] **Step 2: Watch them fail.** **Step 3: Implement.** `verifyOrgToken` uses `timingSafeEqual`. The portal view wraps `AgentDrawer` with `provide("nightShiftApi", linkApi(token))`; `AgentDrawer` uses `inject("nightShiftApi", defaultApi)`. **Step 4: Run** both suites. Green; five permitted errors. **Step 5: Commit** — skipped.

---

### Task 11: The Connect tab

**Files:**
- Create: `fleet-portal/src/nightshift/stores/sheet.ts`, `fleet-portal/src/nightshift/stores/sheet.spec.ts`, `fleet-portal/src/nightshift/components/ConnectSheet.vue`, `ConnectSheet.spec.ts`
- Modify: `fleet-portal/src/views/NightShiftView.vue` (tabs: **Connect**, **Policies**; `?tab=` selects; `?step=2` after the OAuth redirect lands on step 2), `fleet-portal/src/lib/api.ts` (the sheet endpoints)

**Interfaces:**
- Consumes: Task 7's and Task 9's routes.
- Produces: `useSheetStore()` with `binding`, `spreadsheets`, `tabs`, `header`, `proposal`, `load()`, `startOAuth()` (navigates to the returned URL), `pickSpreadsheet(id)`, `pickTab(id)`, `readHeader()`, `saveMapping(mapping)`, `install()`, `syncNow()`, `disconnect()`. `ConnectSheet.vue`: the five steps of spec §9.3 as one scrolling page with the current step expanded.

- [ ] **Step 1: Failing tests**
  - Store: each action calls its endpoint; `saveMapping` refuses locally when a required key is blank (mirrors the server, so the user sees the message before the round trip).
  - Component: with no binding, step 1 shows **Sign in with Google**; with a paused binding (post-OAuth), step 2 lists spreadsheets; picking one lists tabs; step 3 renders the proposal as a table with a `<select>` per required key listing the headers, extras listed as "kept as extra: Broker, Notes", missing keys highlighted; step 4 has dispatcher email (pre-filled from the session) and phone, and saving writes them into the Standard policy via the existing `savePolicy`; step 5's button calls `install()` and then shows the done sentence: "Choose a policy in the Night Shift column on any row to start. Everything runs in shadow until you go live in Settings."; a connected binding shows the summary (sheet title, tab, account email, last sync, a **Sync now** button, **Re-map**, **Disconnect** with a confirmation).

- [ ] **Step 2: Watch them fail.** **Step 3: Build it** following the portal's existing form and card patterns (`NightShiftView.vue`'s editor); no component library. **Step 4: Run** the portal suites. Green; five permitted errors. **Step 5: Commit** — skipped.

---

### Task 12: Live acceptance — a real Google Sheet, in shadow

**Files:** none. The controller's, in a real browser with the worker running. **Never read `.env`.** Nothing in this task sends an SMS or places a call: every policy is shadow.

- [ ] **Step 1: Credentials (the user's, once).** Google Cloud console → a project → OAuth consent screen (External, Testing, add the user's Google account as a test user) → Credentials → OAuth client (Web) with redirect `http://localhost:3001/api/dispatcher/sheet/oauth/callback`. The user puts client id/secret and a fresh `SECRET_BOX_KEY` into `fleet-backend/.env` themselves. Ask for it; do not do it for them; do not print it.
- [ ] **Step 2: Bring it up.** Postgres, backend :3001, portal :5173, worker in platform mode. Sign up a new org with `/signup?product=nightshift`. Confirm the nav shows Board, Night Shift, Usage, Settings. Screenshot.
- [ ] **Step 3: Connect.** A test Google Sheet with the header `LOAD# | DRIVER PHONE | DRIVER | PICK UP | DELIVERY | PU APPT | DEL APPT | CUSTOMER EMAIL | RATE | BROKER` and three rows, one of them the DEMO-9002-style load with the user's own phone as DRIVER PHONE. Walk the five steps. After install, the sheet has the two new columns and the dropdown offers `OFF` and `Standard`. Screenshot the sheet.
- [ ] **Step 4: Mirror.** Within one worker tick, the Board shows the three loads. Edit the delivery city in the sheet; within a tick the board changes. Screenshot both.
- [ ] **Step 5: The switch.** Choose `Standard` in the Night Shift cell of the first row. Within two ticks: the status cell reads `● SHADOW — would say: …` (the invite line), the board's pill is Shadow, the worker log shows a trip started and **no** Twilio call (the log, not the account). Hover the cell's note; open the link on a phone (or a 390 px viewport); press **I've got it**; the status cell reads `● HELD` on the next tick; **Hand it back**; `OFF` in the cell → `● OFF`, the trip removed. Screenshot each.
- [ ] **Step 6: The refusals.** A row with no LOAD# → `● ATTENTION — needs a load number`. A row with `DEL APPT = sometime tuesday` → `● ATTENTION — can't read DEL appointment …` and no trip when switched on. Fix the cell; watch it recover on the next tick.
- [ ] **Step 7: Record.** Ledger every observation, screenshots to the scratchpad, anything that did not match the plan. Leave every row `OFF` at the end. Disconnect the test sheet if the user asks.
- [ ] **Step 8: Commit** — skipped.
