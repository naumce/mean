# Night Shift on the Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dispatcher flips a switch on a load, picks a policy, and the night-shift agent watches that truck from inside the product — visible as a pill on both boards, supervised from a drawer, configured from a setup screen on the Control Tower.

**Architecture:** The agent (`night-shift/`) already works on real phones but takes one JSON file on the command line and hard-codes its thresholds. This plan makes its thresholds a **policy** row, makes the load's **explicit switch** the trigger, and swaps two of its ports for platform adapters: loads come from the `Load` table and status goes back to it. The backend gains a small API for policies, the switch, the timeline and the supervision actions; the worker polls the switched-on loads and applies supervision commands; the portal gains the setup screen, the switch and pill on both boards, and the drawer.

**Tech Stack:** Express 4, Prisma 5 (Postgres in docker `fleet-postgres` :5434), zod, vitest + supertest; `night-shift/` TypeScript with its own vitest; Vue 3, Pinia, vitest + @vue/test-utils.

**Spec:** `docs/superpowers/specs/2026-09-07-broker-board-night-shift-design.md` — §6 (the agent in the board), §7 (adapters), §8 (the Cockpit side), and **§17 (decided 2026-09-11: the explicit switch, policies, supervision)**. Where §7.1's auto-start conflicts with §17.1, §17 wins.

## Global Constraints

- **No git commits, no `git add`** — the user's standing rule. The working tree is the deliverable.
- **Never read, print or log `night-shift/.env` or `fleet-backend/.env`.** Both hold live credentials. Edit `.env.example` files only, and describe changes rather than showing them.
- **The agent never starts on its own.** Only `Load.agentEnabled = true`, set by a human through the switch, makes it watch a load (§17.1).
- **Shadow is the default for a new policy.** In shadow the agent writes `would say:` lines and sends nothing to anyone (§6.5). Going live is a policy field and a traced change.
- **Rules decide, the model speaks.** No threshold moves into an LLM. Policies parameterise the existing deterministic rules; they do not replace them.
- **Every Load write goes through the writer** (`applyLoadChange` / `applyStatusChange` in `fleet-backend/src/lib/loadWriter.ts`), carries a `LoadChange` row, and emits `load_changed` through `emitLoadChanged` in `src/lib/loadEvents.ts`. The switch is a Load write.
- **Every route handler is wrapped in `asyncRoute`**; `tests/no-silent-hang.test.ts` fails otherwise.
- **A human's UPDATE text is never modified by the agent** (§6.2).
- Every new query is org-scoped; every body validated with zod; the actor is the session's dispatcher (`actorOf(req)`).
- Checks: backend `npx vitest run` + `npx tsc --noEmit`; night-shift `npm test` + `npm run typecheck`; portal `npx vitest run` + `npx vue-tsc --noEmit -p tsconfig.app.json` (only the five pre-existing errors in `RoutePlanCard.spec.ts` ×4 and `FleetMap.vue` ×1 are permitted).

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `fleet-backend/prisma/migrations/<ts>_night_shift_policies/migration.sql` | `AgentPolicy`, the switch and pill on `Load`, `AgentTrip.loadId`, `AgentCommand`. |
| `fleet-backend/src/lib/agentPolicies.ts` | The policy shape, its zod schema, the Standard defaults, and `policyFor(load)`. |
| `fleet-backend/src/routes/dispatcherNightShift.ts` | Policies CRUD, the switch, the timeline, the supervision actions. |
| `fleet-backend/tests/night-shift-routes.test.ts` | Proves the API. |
| `night-shift/src/core/policy.ts` | `Policy` type, `STANDARD` defaults, `thresholdsOf(policy)` — replaces the constants at the call sites. |
| `night-shift/src/live/platformLoads.ts` | `PlatformLoads`: polls switched-on loads, builds briefs (§7.1 as amended by §17.1). |
| `night-shift/src/live/platformSheet.ts` | `PlatformSheet`: pill + `AgentUpdate` writes (§7.4). |
| `night-shift/src/live/commands.ts` | Reads `AgentCommand` rows and applies them to the registry. |
| `fleet-portal/src/stores/nightShift.ts` | Policies, per-load agent state, the timeline, the actions. |
| `fleet-portal/src/views/NightShiftView.vue` | The setup screen on the Control Tower. |
| `fleet-portal/src/components/agent/AgentPill.vue`, `AgentSwitch.vue`, `AgentDrawer.vue` | The pill, the switch with policy picker, the drawer. Used by both boards. |

**Modified**

| File | Change |
|---|---|
| `fleet-backend/prisma/schema.prisma` | The models above. |
| `fleet-backend/src/app.ts` | Mount the new router behind the dispatcher gate. |
| `fleet-backend/src/routes/dispatcherBrokerBoard.ts`, `dispatcherLoadboard.ts` | Project `agentEnabled`, `agentPolicyId`, `agentPill`, `agentLine` on both boards. |
| `night-shift/src/core/constants.ts`, `rules.ts`, `ladder.ts`, `agent.ts` | Read thresholds from the trip's policy instead of module constants. |
| `night-shift/src/live/worker.ts`, `registry.ts` | Platform mode: poll loads, apply commands; keep file mode behind a flag. |
| `fleet-portal/src/router/index.ts`, `layouts/AppShell.vue` | The Night Shift route and nav item. |
| `fleet-portal/src/components/broker/BrokerGrid.vue` | AGENT column renders pill + switch; click opens the drawer. |
| `fleet-portal/src/components/cockpit/LegBrick.vue`, the inspect panel | Pill on the brick; switch + drawer button in the panel. |

---

### Task 1: The data — policies, the switch, and a trip that knows its load

**Files:**
- Modify: `fleet-backend/prisma/schema.prisma`
- Create: the migration; `fleet-backend/src/lib/agentPolicies.ts`
- Test: `fleet-backend/tests/agent-policies.test.ts` (create)

**Interfaces:**
- Produces: the `AgentPolicy` model; `Load.agentEnabled: Boolean @default(false)`, `Load.agentPolicyId: String?`, `Load.agentPill: String @default("off")`; `AgentTrip.loadId: String?` with a relation; `AgentCommand` model. `STANDARD_POLICY`, `agentPolicySchema`, `policyFor(load, policies)` from `agentPolicies.ts`. Tasks 3, 4 and 5 consume all of these.

- [ ] **Step 1: Add the models**

```prisma
// Night Shift (spec §17.2): how the agent behaves, configured once.
model AgentPolicy {
  id        String   @id @default(uuid())
  orgId     String
  org       Org      @relation(fields: [orgId], references: [id])
  name      String
  // Thresholds — minutes unless stated. Defaults are the 2026-09-07 live run's.
  stopMin        Int  @default(15)
  delayMin       Int  @default(30)
  darkMin        Int  @default(20)
  darkAtStopMin  Int  @default(60)
  offRouteMi     Float @default(3.1)
  offRouteMin    Int  @default(10)
  // Ladder
  rungGapMin     Int  @default(5)
  maxCalls       Int  @default(2)
  // Contacts
  dispatcherEmail String
  dispatcherPhone String?
  customerEmailOn Boolean @default(false)
  // Permissions
  shadow         Boolean @default(true)
  bossCallOn     Boolean @default(true)
  quietFrom      String?   // "22:00" local, or null
  quietTo        String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  loads     Load[]

  @@unique([orgId, name])
}

// The switch, the chosen policy, and the pill the boards show (spec §6.1/§17).
// On Load:
//   agentEnabled  Boolean @default(false)
//   agentPolicyId String?
//   agentPolicy   AgentPolicy? @relation(fields: [agentPolicyId], references: [id])
//   agentPill     String  @default("off")   // off|watching|asked|calling|escalated|delivered|attention|shadow|held

// A supervision action from the drawer, consumed by the worker (spec §17.3).
model AgentCommand {
  id        String   @id @default(uuid())
  loadId    String
  load      Load     @relation(fields: [loadId], references: [id], onDelete: Cascade)
  kind      String   // stop|call|reply|correct|takeover|handback|send_customer_email
  payload   Json?
  actorName String
  createdAt DateTime @default(now())
  appliedAt DateTime?

  @@index([loadId, appliedAt])
}
```

Add the three `Load` fields where the comment says, and `loadId String?` plus `load Load? @relation(...)` on `AgentTrip` so a trip's events can be found from a load. Add `agentCommands AgentCommand[]` and `agentTrips AgentTrip[]` to `Load`, and `agentPolicies AgentPolicy[]` to `Org`.

- [ ] **Step 2: Write the migration and apply it to the dev database**

Run: `cd fleet-backend && npx prisma migrate dev --name night_shift_policies`
The dev backend on :3001 holds the Prisma engine DLL on Windows — **stop it first**, run the migration, then restart it with `NODE_OPTIONS=--max-http-header-size=65536 npx tsx watch src/server.ts &`. Say in the report that you did.

- [ ] **Step 3: Write the policy library**

```ts
// fleet-backend/src/lib/agentPolicies.ts
import { z } from "zod";

/** Spec §17.2. The Standard policy carries the thresholds the agent used on
 *  its first live run (2026-09-07). Every other policy starts from these. */
export const STANDARD_POLICY = {
  name: "Standard",
  stopMin: 15, delayMin: 30, darkMin: 20, darkAtStopMin: 60,
  offRouteMi: 3.1, offRouteMin: 10,
  rungGapMin: 5, maxCalls: 2,
  customerEmailOn: false, shadow: true, bossCallOn: true,
  quietFrom: null as string | null, quietTo: null as string | null,
} as const;

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const agentPolicySchema = z.object({
  name: z.string().min(1).max(40),
  stopMin: z.number().int().min(1).max(240),
  delayMin: z.number().int().min(1).max(600),
  darkMin: z.number().int().min(1).max(600),
  darkAtStopMin: z.number().int().min(1).max(600),
  offRouteMi: z.number().min(0.1).max(50),
  offRouteMin: z.number().int().min(1).max(120),
  rungGapMin: z.number().int().min(1).max(60),
  maxCalls: z.number().int().min(0).max(5),
  dispatcherEmail: z.string().email(),
  dispatcherPhone: z.string().regex(/^\+\d{8,15}$/).nullable(),
  customerEmailOn: z.boolean(),
  shadow: z.boolean(),
  bossCallOn: z.boolean(),
  quietFrom: hhmm.nullable(),
  quietTo: hhmm.nullable(),
});
export type AgentPolicyInput = z.infer<typeof agentPolicySchema>;

/** The policy a load runs under: its own, else the org's Standard. A load
 *  that is switched on without a policy is a bug upstream, not a fallback
 *  here — this throws so the caller notices. */
export function policyFor<P extends { id: string; name: string }>(
  load: { agentPolicyId: string | null },
  policies: readonly P[],
): P {
  const own = load.agentPolicyId ? policies.find((p) => p.id === load.agentPolicyId) : undefined;
  const std = policies.find((p) => p.name === STANDARD_POLICY.name);
  const chosen = own ?? std;
  if (!chosen) throw new Error("org has no Standard agent policy — seed it");
  return chosen;
}
```

- [ ] **Step 4: Seed Standard for every org**

Add to the org-creation path (find where an `Org` is created on signup and in `seed-control-tower.mjs`) a `prisma.agentPolicy.upsert` on `[orgId, "Standard"]` with `STANDARD_POLICY` and the org's dispatcher email. Also add a one-off script or a line in the seed that back-fills Standard for every existing org, and run it against the dev database.

- [ ] **Step 5: Tests**

```ts
// fleet-backend/tests/agent-policies.test.ts
it("every org gets a Standard policy with the live-run thresholds", ...)  // signup an org → policy exists, stopMin 15, shadow true
it("policyFor prefers the load's own policy and falls back to Standard", ...)
it("policyFor throws when an org has no Standard — never silently guesses", ...)
it("the schema refuses a phone that is not E.164 and a quiet time that is not HH:MM", ...)
```

- [ ] **Step 6: Run the suite**

Run: `cd fleet-backend && npx vitest run` then `npx tsc --noEmit`
Expected: green, clean. Note `tests/active-statuses.test.ts` may flag a new status-word array; if it does, add an exact-literal exemption with a reason, as its existing entries do.

- [ ] **Step 7: Commit** — skipped (Global Constraints).

---

### Task 2: The agent reads its thresholds from a policy

**Files:**
- Create: `night-shift/src/core/policy.ts`
- Modify: `night-shift/src/core/constants.ts`, `rules.ts`, `ladder.ts`, `agent.ts`, `live/registry.ts`
- Test: `night-shift/tests/core/policy.test.ts` (create); existing core tests updated where they construct an agent

**Interfaces:**
- Consumes: the constants in `core/constants.ts` (`STOP_MIN`, `DELAY_BEHIND_PLAN_MIN`, `DARK_MIN`, `DARK_AT_STOP_MIN`, `OFF_ROUTE_MI`, `OFF_ROUTE_MIN`, `MAX_CALLS`, `CALL_RETRY_MIN`).
- Produces: `Policy` type and `STANDARD` in `core/policy.ts`, mirroring Task 1's fields exactly (same names, same units); `Registry.start(brief, ids, extras)` gains `extras.policy: Policy`; every rule reads its threshold from the trip's policy. `TIME_SCALE` still multiplies the minute thresholds so the demo knob keeps working.

- [ ] **Step 1: Write the failing test**

```ts
// night-shift/tests/core/policy.test.ts
it("a stop shorter than the policy's stopMin is not an anomaly, one longer is", () => {
  // Two agents, same pings, policies with stopMin 15 and 5 — only the second asks.
});
it("maxCalls from the policy bounds the ladder — 0 calls escalates straight from SMS", () => { ... });
it("shadow policy writes a would-say line and sends nothing", () => {
  // messenger/phone/mailer fakes record zero sends; sheet records a status line prefixed "would say:".
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd night-shift && npm test -- tests/core/policy.test.ts`
Expected: FAIL — `Policy` does not exist and the rules read constants.

- [ ] **Step 3: Introduce the policy type and thread it through**

```ts
// night-shift/src/core/policy.ts
export interface Policy {
  name: string;
  stopMin: number; delayMin: number; darkMin: number; darkAtStopMin: number;
  offRouteMi: number; offRouteMin: number;
  rungGapMin: number; maxCalls: number;
  dispatcherEmail: string; dispatcherPhone: string | null; customerEmailOn: boolean;
  shadow: boolean; bossCallOn: boolean;
  quietFrom: string | null; quietTo: string | null;
}
export const STANDARD: Policy = { /* the same values as fleet-backend's STANDARD_POLICY */ };
```

In `constants.ts`, keep `TIME_SCALE`, `MIN_MS`, radii and the non-policy constants; delete the threshold constants and replace every use with `trip.policy.<field> * TIME_SCALE` (minutes) or `trip.policy.<field>` (miles, counts). `Agent` takes the policy in its constructor via `AgentDeps` or the brief's extras — pick the one that keeps `Agent.evaluate`'s signature unchanged, and say which. Shadow: when `policy.shadow`, every messenger/phone/mailer send is replaced by a `sheet.appendLog` of kind `would_say` carrying the text it would have sent; the ladder still climbs so the timeline shows what live mode would have done.

- [ ] **Step 4: Update the existing core tests**

They construct agents with the old constants implied. Give each the `STANDARD` policy explicitly. Every existing assertion must still hold — if one changes, that is a behaviour change and the report must say why.

- [ ] **Step 5: Run the package suite**

Run: `cd night-shift && npm test && npm run typecheck`
Expected: green, clean. It was 140 passed / 2 skipped.

- [ ] **Step 6: Commit** — skipped.

---

### Task 3: The API — policies, the switch, the timeline, supervision

**Files:**
- Create: `fleet-backend/src/routes/dispatcherNightShift.ts`, `fleet-backend/tests/night-shift-routes.test.ts`
- Modify: `fleet-backend/src/app.ts`, `fleet-backend/src/routes/dispatcherBrokerBoard.ts`, `fleet-backend/src/routes/dispatcherLoadboard.ts`

**Interfaces:**
- Consumes: Task 1's models and `agentPolicySchema`; `applyLoadChange` for the switch; `emitLoadChanged`; `asyncRoute`.
- Produces, all under `/api/dispatcher`, all org-scoped, all wrapped:
  - `GET /night-shift/policies` → `{ policies: AgentPolicy[], loadsByPolicy: Record<policyId, number> }`
  - `POST /night-shift/policies` (body `agentPolicySchema`) → 201 `{ policy }`; name unique per org → 409.
  - `PUT /night-shift/policies/:id` → `{ policy }`; flipping `shadow` off writes an `AgentCommand`-independent audit line (a `LoadChange`-style log is wrong here — use a plain `console.info` with org and actor, and say so).
  - `DELETE /night-shift/policies/:id` → 409 if any load uses it; Standard cannot be deleted.
  - `POST /loads/:id/agent` (body `{ enabled: boolean, policyId?: string }`) → the switch. Goes through `applyLoadChange` with a patch of `agentEnabled`/`agentPolicyId`, so it is traced and versioned; sets `agentPill` to `"watching"` when enabled (the worker refines it) and `"off"` when disabled; when disabling, also writes an `AgentCommand` of kind `stop`. Emits `load_changed` with `fields: ["agentEnabled"]`. Returns `{ load: <board row>, version }`.
  - `GET /loads/:id/agent` → `{ enabled, policy, pill, line, timeline }` where `timeline` merges `AgentUpdate` rows and the `AgentEvent`s of the load's `AgentTrip`s, newest first, each `{ atMs, kind, text, evidence? }`.
  - `POST /loads/:id/agent/commands` (body `{ kind, payload? }`, kind ∈ stop|call|reply|correct|takeover|handback|send_customer_email) → writes an `AgentCommand` with the actor's name → 202.
- The two board GETs project four new fields per load: `agentEnabled`, `agentPolicyId`, `agentPill`, `agentLine` (the newest `AgentUpdate.text`, already present as `agentLine` on the broker board — keep that name; add it to the loadboard projection).

- [ ] **Step 1: Write the failing tests** — one per route above, plus: the switch writes a `LoadChange` row and emits `load_changed`; a policy from another org is invisible (404, not 403 — do not confirm existence); Standard refuses deletion; a command from the drawer lands as an `AgentCommand` with `appliedAt` null.

- [ ] **Step 2: Run them and watch them fail** (`npx vitest run tests/night-shift-routes.test.ts` → 404s).

- [ ] **Step 3: Write the router**, mount it in `app.ts` after `dispatcherLoadboardRouter`, and add the four projected fields to both board GETs. `LoadPatch` in `loadWriter.ts` needs `agentEnabled?: boolean` and `agentPolicyId?: string | null` — add them as plain scalars; they carry no derivation.

- [ ] **Step 4: Run both suites** (`npx vitest run`, `npx tsc --noEmit`). Green, clean. `no-silent-hang` and `active-statuses` guards must pass — the pill vocabulary is not a Load status list, but if the guard fires on it, exempt the exact literal with a reason.

- [ ] **Step 5: Commit** — skipped.

---

### Task 4: The worker watches the board

**Files:**
- Create: `night-shift/src/live/platformLoads.ts`, `platformSheet.ts`, `commands.ts`
- Modify: `night-shift/src/live/worker.ts`, `registry.ts`, `config.ts`, `night-shift/.env.example`, `README-live.md`
- Test: `night-shift/tests/live/platformLoads.test.ts`, `platformSheet.test.ts`, `commands.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's tables via the shared Prisma client (`fleet-backend/src/db.js`, as `prismaEvents.ts` already does); Task 2's `Policy`; `Registry.start/tickAll`; `SheetPort`.
- Produces: `MODE=platform` (default) vs `MODE=file` in `config.ts`; a worker that, every 60 s, for each org: loads `Load` rows with `agentEnabled = true` and `agentPill ∉ {delivered, off}` that have no running trip, builds a `Brief` per §7.1 (as amended: no auto-start, the switch is the only gate), starts it under `policyFor(load)`, and links `AgentTrip.loadId`; removes trips whose load was switched off or delivered; applies unapplied `AgentCommand`s in `createdAt` order and stamps `appliedAt`.

- [ ] **Step 1: Failing tests** — `platformLoads`: a switched-on load with parsed appointments and geocoded stops becomes a brief; one missing a phone becomes `agentPill = "attention"` with an `AgentUpdate` line naming what is missing and NO trip; a switched-off load is never read. `platformSheet`: `writeStatus` maps the agent's state to the pill vocabulary of §6.1 and appends an `AgentUpdate`; in shadow the line is prefixed `would say:`. `commands`: `stop` removes the trip and sets pill `off`; `takeover` sets pill `held` and mutes the ladder; `handback` resumes; `reply` posts to the driver's page as the dispatcher and stops the ladder like a driver reply; `correct` records the relabel against the trip's last classification.

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Write the three adapters and the worker loop.** Brief building (§7.1/§6.3): `loadRef = LOAD#`, origin/destination from the pickup/delivery `LoadStop` lat/lng + city, `equipment = requiredEquip`, `departAtMs = PU appointment windowEnd` (board appointments are points), `deadlineAtMs = DEL windowEnd`, `driverName/driverPhone` from the driver when the load has an `Assignment` else from `carrierContactName/carrierPhone`, `customerEmail` null unless the customer record has one, `minutesSinceBreakAtDepart` from `HosState` when the driver is ours else null. Anything unresolvable → pill `attention`, one line, no trip, retry next poll. Keep file mode working: `MODE=file` runs exactly today's path.

- [ ] **Step 4: Run the package suite** (`npm test && npm run typecheck`). Green, clean.

- [ ] **Step 5: Document** the new config in `README-live.md` and `.env.example` (`MODE`, and that `DATABASE_URL` must point at the fleet database). Do not open `.env`.

- [ ] **Step 6: Commit** — skipped.

---

### Task 5: The Night Shift setup screen

**Files:**
- Create: `fleet-portal/src/stores/nightShift.ts`, `fleet-portal/src/views/NightShiftView.vue`, `fleet-portal/src/views/NightShiftView.spec.ts`, `fleet-portal/src/stores/nightShift.spec.ts`
- Modify: `fleet-portal/src/router/index.ts` (route `night-shift`, name `night-shift`), `fleet-portal/src/layouts/AppShell.vue` (nav item under OPERATE, label "Night Shift")

**Interfaces:**
- Consumes: Task 3's `/night-shift/policies` routes.
- Produces: `useNightShiftStore()` with `policies`, `loadsByPolicy`, `loadPolicies()`, `savePolicy(input)`, `deletePolicy(id)`; plus `agentFor(loadId)`, `setSwitch(loadId, enabled, policyId?)`, `timeline(loadId)`, `command(loadId, kind, payload?)` for Tasks 6 and 7.

- [ ] **Step 1: Failing tests** — the view lists policies with their load counts; editing Standard's `stopMin` and saving calls PUT with the whole policy; the shadow toggle shows a confirmation naming what going live means ("the agent will text and call drivers and email you"); Standard has no delete button; a second policy can be created from Standard's values.

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Build it.** One screen: a list on the left (name, shadow/live badge, loads on it), an editor on the right grouped as the spec groups them — Thresholds, Ladder, Contacts, Permissions — with plain-English labels ("Ask the driver after … minutes stopped"). Follow the portal's existing form and card patterns; do not introduce a component library. This screen is the pitch, so it must read well cold: a one-paragraph explainer at the top saying what the night shift is and that shadow means "watch only".

- [ ] **Step 4: Run the portal suites** (`npx vitest run`, `npx vue-tsc --noEmit -p tsconfig.app.json`). Green; only the five permitted errors.

- [ ] **Step 5: Commit** — skipped.

---

### Task 6: The switch and the pill on both boards

**Files:**
- Create: `fleet-portal/src/components/agent/AgentPill.vue`, `AgentSwitch.vue`, and specs
- Modify: `fleet-portal/src/components/broker/BrokerGrid.vue` (AGENT column), `fleet-portal/src/components/cockpit/LegBrick.vue` and the Cockpit inspect panel, `fleet-portal/src/stores/loadboard.ts` (`BoardLoad` gains the four fields), `fleet-portal/src/lib/api.ts` (`BoardLoad` on the broker side gains them)

**Interfaces:**
- Consumes: the four projected fields; `useNightShiftStore().setSwitch`; the `load_changed` patch-by-id path (the pill updates itself when the worker writes it, because the write bumps the version and emits).
- Produces: `<AgentPill :pill :line />` rendering §6.1's eight states plus `held`, with the tooltip sentence; `<AgentSwitch :load @change />` — a toggle that, when turning on, opens a small policy picker defaulting to Standard, and when turning off, asks "Stop watching this load?".

- [ ] **Step 1: Failing tests** — pill renders each state with the right colour class and the line as its title; the switch on emits `{ enabled: true, policyId }` after the picker; a load someone else holds (the lock badge) still shows the pill but disables the switch; on the broker grid the AGENT column shows pill + switch and the UPDATE cell's agent line stays under the human's text (§6.2); on the Cockpit the brick shows the pill and the inspect panel carries the switch.

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Build them.** The switch is a Load write through the store → Task 3's route → traced. Do not let it bypass the version backstop: send `baseVersion`.

- [ ] **Step 4: Run the portal suites.** Green; five permitted errors.

- [ ] **Step 5: Commit** — skipped.

---

### Task 7: The drawer

**Files:**
- Create: `fleet-portal/src/components/agent/AgentDrawer.vue`, `AgentDrawer.spec.ts`
- Modify: `BrokerBoardView.vue`, `CockpitView.vue` (mount the drawer; pill click opens it)

**Interfaces:**
- Consumes: `useNightShiftStore().timeline`, `.command`; §6.4 and §17.3.
- Produces: one drawer used by both boards.

- [ ] **Step 1: Failing tests** — header shows LOAD#, customer, carrier + MC, policy name and a shadow/live badge; timeline newest first with message text, call outcome + transcript verbatim, escalation reason, `would say:` lines styled as such; actions present: **Call the driver now**, **I've got it** / **Hand it back** (toggle on pill `held`), **Stop the agent**, **Send the customer email** (only when a draft exists), and a reply box that posts as the dispatcher; **Correct** appears on a classified reply and offers the situation-library keys; each action posts one command and the drawer shows it as "queued" until the timeline reflects it.

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Build it.** Slides from the right, the board stays visible (§6.4). Reuse the portal's existing drawer/panel pattern if one exists (check the Cockpit's inspect panel); otherwise build a minimal one and say so.

- [ ] **Step 4: Run the portal suites.** Green; five permitted errors.

- [ ] **Step 5: Commit** — skipped.

---

### Task 8: Live acceptance — flip the switch, watch it watch

**Files:** none. The controller's, in a real browser with the worker running.

**Standing constraint:** never read `.env`. The DEMO loads on the board (DEMO-9001 brokered, DEMO-9002 on Rico) are the fixtures; the user's real rows are not.

- [ ] **Step 1: Bring it up.** Backend :3001, portal :5173, Postgres, and the worker in platform mode: `cd night-shift && npm run night:start` (no file argument). Confirm it logs that it is polling the board.

- [ ] **Step 2: The setup screen.** Open Night Shift on the Control Tower. Standard is there, shadow on, zero loads. Screenshot.

- [ ] **Step 3: The switch, shadow.** On Their Board, flip DEMO-9002 on with Standard. Pill goes Watching (shadow → blue "Shadow"). Within two polls the worker starts a trip: the timeline shows the plan and a `would say:` invite line to Rico. Nothing was sent — confirm no Twilio call was made (the worker log, not the account). Same on the Cockpit brick. Screenshot both.

- [ ] **Step 4: Supervision.** Open the drawer. "I've got it" → pill `held`, a command row appears and is applied on the next poll. "Hand it back" → Watching again. "Stop the agent" → pill off, switch off, trip removed. Screenshot the drawer with the timeline.

- [ ] **Step 5: The brokered load.** Flip DEMO-9001 on. The brief must resolve the carrier contact per §6.3 — if the row has no carrier phone, the pill must go **Attention** with a line saying exactly that, and no trip. Type a phone on the row, watch it recover on the next poll. Screenshot.

- [ ] **Step 6: Live, only if the user says so.** Flipping Standard to live sends real SMS through the user's Twilio. Do not do this without an explicit yes in the conversation.

- [ ] **Step 7: Record.** Ledger every observation, screenshots to the scratchpad, anything that did not match the plan. Leave the DEMO loads switched off at the end.

- [ ] **Step 8: Commit** — skipped.
