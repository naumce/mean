# One Honest Record — A5 Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the class of defect where a request hangs instead of failing, and clear every item the four previous slices parked by ruling.

**Architecture:** Slices A1–A4 shipped the writer, the locks, the carrier lanes and the realtime unification. Each closed its own findings but parked a short list — small gaps that were real but not worth reopening a finished review. This plan is the sweep. Its one piece of new design is an async route wrapper plus a terminal error responder, which retires a bug class rather than its five current instances. Everything else is a few lines and a test.

**Tech Stack:** Express 4, Prisma 5 (Postgres in docker `fleet-postgres` on :5434), zod, vitest + supertest; Vue 3, Pinia, vitest + @vue/test-utils.

**Spec:** `docs/superpowers/specs/2026-09-09-one-honest-record-design.md` — §12 Honesty rules binds most of this; §7.4 binds Task 5.

**Parked items this plan closes:** `.superpowers/sdd/a5-seed.md`, and the rulings named there — A3's R20 and R21, A4's R9, R12, R17 and R18.

**What this plan does NOT build:** spec §10's marks. They already exist, as `record.update` and `record.appt` on the broker-board row, rendered as a corner dot with a `title` tooltip. An earlier note in the seed claimed otherwise; it was wrong, and the correction is recorded in `a5-seed.md`.

## Global Constraints

- **No git commits, no `git add`** — the user's standing rule, reaffirmed at the start of this plan. The working tree is the deliverable.
- **A handler must never leave a request without a response.** Express 4 does not await an `async` handler, so a rejected promise produces no reply at all and the client spins forever. `errorHandler.ts` cannot catch these; its own header says so.
- **Nothing displays or emits a value the record does not hold** (spec §12). A number we cannot stand behind is not made safe by going unrendered.
- **Every version bump carries a trace row** explaining who moved it and why (spec §7.4).
- Every new query is org-scoped; every body validated with zod; the actor is the session's dispatcher (`actorOf(req)`).
- Checks: backend `npx vitest run` and `npx tsc --noEmit`; portal `npx vitest run` and `npx vue-tsc --noEmit -p tsconfig.app.json` (only the five pre-existing errors in `RoutePlanCard.spec.ts` ×4 and `FleetMap.vue` ×1 are permitted).

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `fleet-backend/src/lib/asyncRoute.ts` | Wraps an async handler so a rejection reaches Express instead of vanishing. The one place this knowledge lives. |
| `fleet-backend/tests/no-silent-hang.test.ts` | Proves no router can register a bare async handler, and that a rejection answers 500 rather than hanging. |

**Modified**

| File | Change |
|---|---|
| `fleet-backend/src/routes/dispatcherLoads.ts`, `dispatcherLoadTruth.ts` | The five unguarded handlers go through the wrapper. |
| `fleet-backend/src/middleware/errorHandler.ts` | Becomes the terminal responder for what the wrapper forwards. |
| `fleet-backend/src/routes/dispatcherRisk.ts` or `src/lib/lateRisk.ts` | Stop shipping a fabricated arrival for brokered rows (R20). |
| `fleet-backend/src/routes/dispatcherBrokerBoard.ts` | Unarchive writes its own trace row (A4-R17). |
| `fleet-backend/src/routes/dispatcherAuth.ts`, `fleet-portal/src/stores/auth.ts` | A session endpoint so an existing login recovers its identity (A4-R12). |
| `fleet-portal/src/components/broker/BrokerGrid.vue` | `commitEdit`'s dirty-check compares against the text captured at edit-open (A4-R9). |

---

### Task 1: No handler can hang, by construction

**Files:**
- Create: `fleet-backend/src/lib/asyncRoute.ts`
- Create: `fleet-backend/tests/no-silent-hang.test.ts`
- Modify: `fleet-backend/src/routes/dispatcherLoads.ts`, `fleet-backend/src/routes/dispatcherLoadTruth.ts`, `fleet-backend/src/middleware/errorHandler.ts`

**Interfaces:**
- Consumes: the existing `errorHandler` mounted last in `src/app.ts`.
- Produces: `asyncRoute(fn)` returning an Express `RequestHandler`. Later tasks and all future routes use it.

**Why a wrapper and not five more try blocks.** Five handlers lack a catch today. Adding five catches fixes five instances and leaves the class open — the next route written is the next hang. The wrapper makes the safe thing the default, and the guard test makes the unsafe thing fail CI.

- [ ] **Step 1: Write the failing guard test**

```ts
// fleet-backend/tests/no-silent-hang.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const routesDir = join(repoRoot, "src", "routes");

function tsFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...tsFilesUnder(full));
    else if (entry.endsWith(".ts")) found.push(full);
  }
  return found;
}

describe("no route may hang a request", () => {
  it("registers no bare async handler", () => {
    // Express 4 does not await a handler. A rejected async handler therefore
    // sends NOTHING — not a 500, nothing — and the client spins forever.
    // Every async handler must be wrapped so its rejection reaches Express.
    const offenders: string[] = [];
    for (const file of tsFilesUnder(routesDir)) {
      const src = readFileSync(file, "utf8");
      const rel = relative(repoRoot, file).split("\\").join("/");
      // `.get("/x", async (req, res) => ...)` with no asyncRoute( before it.
      const bare = /\.(get|post|put|patch|delete)\(\s*("[^"]*"|'[^']*'|`[^`]*`)\s*,\s*async\s*\(/g;
      for (const m of src.matchAll(bare)) offenders.push(`${rel}: ${m[2]}`);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd fleet-backend && npx vitest run tests/no-silent-hang.test.ts`
Expected: FAIL, listing every bare async handler across the routes directory — far more than the five known ones, because the wrapper does not exist yet. Record the count in your report; it is the size of the class.

- [ ] **Step 3: Write the wrapper**

```ts
// fleet-backend/src/lib/asyncRoute.ts
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wrap an async route handler so a rejection reaches Express.
 *
 * Express 4 calls a handler and ignores whatever it returns. Hand it an
 * `async` function and a rejected promise goes nowhere: no response is sent,
 * no error middleware runs, and the client waits until it gives up. That is
 * not a theoretical hazard — it has shipped in this codebase more than once,
 * and the last audit found five live instances.
 *
 * Wrapping forwards the rejection to `next`, where the terminal error
 * handler answers it. Routes that already catch their own errors lose
 * nothing by being wrapped; the wrapper only sees what they re-throw.
 */
export function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}
```

- [ ] **Step 4: Make the terminal handler answer**

Read `src/middleware/errorHandler.ts` first. It is mounted last in `src/app.ts` and its header explains that it never sees async rejections today. Update that comment — the wrapper is now why it does — and make sure it answers with a JSON 500 in the shape the rest of the API uses (`{ error: "INTERNAL", message }`, matching the fallbacks A4 added), logs the error server-side with the request's method and path, and never leaks a stack trace or a database message to the client.

If it already does all of that, change only the comment and say so in your report.

- [ ] **Step 5: Wrap the five known handlers**

`src/routes/dispatcherLoads.ts`: `GET /loads`, `GET /loads/:id`.
`src/routes/dispatcherLoadTruth.ts`: `GET /update-rules`, `PUT /update-rules`, `GET /loads/:id/changes`.

Then wrap every other bare async handler the guard test named, across all routers. This is mechanical: `router.get("/x", async (req, res) => {…})` becomes `router.get("/x", asyncRoute(async (req, res) => {…}))`. Do not restructure any handler's body while doing it, and do not remove an existing try/catch — a handler that already answers its own errors keeps doing so.

- [ ] **Step 6: Run the guard test**

Run: `cd fleet-backend && npx vitest run tests/no-silent-hang.test.ts`
Expected: PASS.

- [ ] **Step 7: Prove the behaviour, not just the shape**

Add to the same file a supertest case: force one wrapped handler to reject (spy the Prisma call it makes and reject with `new Error("boom")`), and assert the response is a 500 with a JSON body — not a timeout. Then assert the body contains no stack trace and no database text.

- [ ] **Step 8: Run the suite**

Run: `cd fleet-backend && npx vitest run` then `npx tsc --noEmit`
Expected: all green, type check clean.

- [ ] **Step 9: Commit** — skipped (Global Constraints).

---

### Task 2: Stop shipping an arrival time we invented (R20)

**Files:**
- Modify: `fleet-backend/src/routes/dispatcherRisk.ts` and/or `fleet-backend/src/lib/lateRisk.ts`
- Test: `fleet-backend/tests/dispatcher-risk.test.ts`

**Interfaces:** Consumes the brokered risk-candidate path A3 added. Produces no new interface; it removes a field's value for one class of row.

**Background.** A3's final review found that brokered risk rows carried a projected arrival computed by treating the pickup-to-delivery appointment span as a transit estimate. The *wording* was fixed so no dispatcher reads a fabricated arrival. The *number* is still computed and still shipped in the JSON. Ruling R20 parked it because nothing renders it. That makes it a trap, not a fix: the next component to read `projectedArrival` will render a number nobody can stand behind, for freight we have no tracking on at all.

- [ ] **Step 1: Write the failing test**

```ts
it("ships no projected arrival for a load we do not track", async () => {
  // Spec §8.4: we have no GPS for a carrier's truck. A projection derived
  // from an appointment window is a guess wearing a number's clothes.
  const res = await agent.get("/api/dispatcher/risk").expect(200);
  const brokered = res.body.rows.filter((r: { driverId: string | null }) => r.driverId === null);
  expect(brokered.length).toBeGreaterThan(0);
  for (const row of brokered) {
    expect(row.projectedArrival ?? null).toBeNull();
    expect(row.projectedArrivalMs ?? null).toBeNull();
  }
});
```

Check the real field names in the route before writing this — the test must name what the route actually sends.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd fleet-backend && npx vitest run tests/dispatcher-risk.test.ts -t "no projected arrival"`
Expected: FAIL, with a number where `null` belongs.

- [ ] **Step 3: Null the field for untracked rows**

In the risk projection, set the projected-arrival field(s) to `null` when the row has no driver of ours. Do not delete the field from the response shape — a consumer reading `undefined` and a consumer reading `null` behave differently, and `null` is the honest answer: "we know this is unknown". Leave the deadline, the slack and the severity exactly as they are; those are computed from windows we do hold.

- [ ] **Step 4: Confirm driver rows are untouched**

Run: `cd fleet-backend && npx vitest run tests/dispatcher-risk.test.ts`
Expected: PASS, with every existing driver-row assertion still green.

- [ ] **Step 5: Commit** — skipped.

---

### Task 3: The small parked tests and the untraced transition

**Files:**
- Modify: `fleet-backend/src/routes/dispatcherBrokerBoard.ts` (unarchive)
- Test: `fleet-backend/tests/dispatcher-loads.test.ts`, `fleet-backend/tests/broker-board-bulk.test.ts`, `fleet-backend/tests/load-changed-events.test.ts`

**Interfaces:** Consumes `applyStatusChange` and the trace-row shape the archive branch already uses.

**Batched deliberately.** Three small, independent items of the same kind, each a few lines. One review surface is right for them.

- [ ] **Step 1: A4-R17 — unarchive writes its trace row**

The archive branch was fixed in A4's final wave to write one `LoadChange` row in the same transaction as its version bump. The unarchive branch's own `archived → open` transition still writes none. Give it the same treatment, matching the archive branch's shape exactly — same source, same actor, same transaction.

Test in `tests/broker-board-bulk.test.ts`: unarchiving writes exactly one `LoadChange` row naming the actor, and the version bumps by exactly one.

- [ ] **Step 2: A3-R21 — reopen's 404 gets a test**

`POST /loads/:id/reopen` maps `LoadNotFound` to a 404. That mapping is present in source and read by a reviewer, but only a generic 500 test covers the catch. Add the missing case to `tests/dispatcher-loads.test.ts`: reopening an id that does not exist answers 404 with a JSON body.

- [ ] **Step 3: A4-R18 — the sixth settle site gets a test**

`PATCH /loads/:id` was wired to `settlePendingStops` during A4's final wave, beyond the brief's named sites, and has no end-to-end test of its own wiring. Add one to `tests/load-changed-events.test.ts`: a PATCH that resolves a previously unplaceable stop emits `load_changed` naming that stop role, bumps the version, and writes one `LoadChange` row — the same assertions the other settle sites already carry.

- [ ] **Step 4: Run the suite**

Run: `cd fleet-backend && npx vitest run` then `npx tsc --noEmit`
Expected: all green, type check clean.

- [ ] **Step 5: Commit** — skipped.

---

### Task 4: A resumed session recovers its own identity (A4-R12)

**Files:**
- Modify: `fleet-backend/src/routes/dispatcherAuth.ts`, `fleet-portal/src/stores/auth.ts`
- Test: `fleet-backend/tests/dispatcher-auth.test.ts`, `fleet-portal/src/stores/auth.spec.ts`

**Interfaces:**
- Produces: `GET /api/dispatcher/auth/me` answering the signed-in dispatcher and their org. The portal's auth store fetches it at boot when a token exists but no dispatcher does.

**Background.** A4 found that the dispatcher identity was never rehydrated after a page reload, which silently disabled every lock badge — the `theirs` getter treats a null id as "nobody is signed in". The fix persisted the identity to `localStorage` on login. That works from the next login onward, but a session already signed in when it shipped never stored anything and stays without badges until it logs in again. This closes that.

It also removes a subtler problem: `localStorage` is now the only source of an identity the server is authoritative for. If the two ever disagree, the client believes the wrong one.

- [ ] **Step 1: Write the failing backend test**

```ts
it("answers the signed-in dispatcher, and refuses without a token", async () => {
  const me = await agent.get("/api/dispatcher/auth/me").expect(200);
  expect(me.body.dispatcher.id).toBe(dispatcher.id);
  expect(me.body.dispatcher.email).toBe(dispatcher.email);
  expect(me.body.dispatcher).not.toHaveProperty("passwordHash");
  await request(app).get("/api/dispatcher/auth/me").expect(401);
});
```

The `passwordHash` assertion is not decoration. A route that returns a dispatcher row is one careless `select` away from serving a credential hash.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd fleet-backend && npx vitest run tests/dispatcher-auth.test.ts -t "signed-in dispatcher"`
Expected: FAIL with a 404 — the route does not exist.

- [ ] **Step 3: Add the route**

Add `GET /auth/me` to `dispatcherAuth.ts`, behind the same auth middleware the other dispatcher routes use, returning `{ dispatcher: { id, email, name }, org }` — an explicit field list, never the whole row. Mirror the shape `login` already returns so the portal can assign it without a second code path.

- [ ] **Step 4: Fetch it at boot in the portal**

In `fleet-portal/src/stores/auth.ts`, add an action that runs when a token exists but `dispatcher` is null: fetch `/dispatcher/auth/me`, assign the result, and persist it the same way login does. Call it once at app startup. On failure, leave `dispatcher` null and do not log the user out — realtime badges are an enhancement and a failed identity fetch must not cost someone their session.

- [ ] **Step 5: Test the portal side**

In `src/stores/auth.spec.ts`: with a token present and no stored dispatcher, the boot action populates and persists it. With no token, it makes no request at all. With the request failing, `dispatcher` stays null and the token survives.

- [ ] **Step 6: Run both suites**

Run: `cd fleet-backend && npx vitest run` and `npx tsc --noEmit`; then `cd ../fleet-portal && npx vitest run` and `npx vue-tsc --noEmit -p tsconfig.app.json`
Expected: backend green and clean; portal green with only the five permitted errors.

- [ ] **Step 7: Commit** — skipped.

---

### Task 5: The dirty-check reads what the dispatcher saw (A4-R9)

**Files:**
- Modify: `fleet-portal/src/components/broker/BrokerGrid.vue`
- Test: `fleet-portal/src/components/broker/BrokerGrid.edit.spec.ts`

**Interfaces:** Consumes the `editing` ref that A4 taught to capture `baseVersion` at edit-open. This adds the cell's text to the same capture.

**Background.** A4 fixed `commitEdit` to send the `baseVersion` captured when the editor opened rather than re-reading it at commit. The dirty-check beside it still compares the draft against the *live* row's text. So if a frame patches that cell while the editor is open and untouched, the commit sees a difference that the dispatcher never made and raises a conflict for an edit that was not an edit.

This fails safe — a spurious prompt, never a silent overwrite, which is why A4 parked it. It is still a prompt a dispatcher has to read and dismiss for no reason.

- [ ] **Step 1: Write the failing test**

```ts
it('does not call an untouched cell dirty just because the row moved underneath it', async () => {
  const w = mount(BrokerGrid, { props: baseProps })
  await openEditorOn(w, 'update')          // whatever the file's existing helper is
  await w.setProps({ loads: [{ ...baseProps.loads[0], version: 7, top: { ...top, update: 'CHANGED REMOTELY' } }] })
  await commitEditor(w)                    // commit without typing anything
  expect(w.emitted('edit')).toBeUndefined()   // nothing was edited, so nothing is sent
})
```

Read the spec file first and use its existing helpers and fixture names rather than these placeholders.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd fleet-portal && npx vitest run src/components/broker/BrokerGrid.edit.spec.ts -t "untouched cell"`
Expected: FAIL — an `edit` is emitted, because the draft no longer matches the live text.

- [ ] **Step 3: Capture the text at edit-open**

Store the cell's text in the `editing` ref alongside `baseVersion`, and have the dirty-check compare the draft against that captured value. The rule the code should express: an edit is a change the dispatcher made, measured from what they were shown.

- [ ] **Step 4: Confirm a real edit still commits**

Run: `cd fleet-portal && npx vitest run src/components/broker/BrokerGrid.edit.spec.ts`
Expected: PASS, with every existing edit, paste and conflict test still green. If any existing test depended on the live-text comparison, say which and why in your report.

- [ ] **Step 5: Commit** — skipped.

---

### Task 6: Live acceptance — the hang class is gone

**Files:** none changed. This task proves the slice on the running system and writes its evidence into the ledger.

**Standing constraint:** the user's real board rows are not test fixtures. Use probe rows you create and delete, and restore anything you touch.

- [ ] **Step 1: Bring the system up**

Confirm docker `fleet-postgres` is up and the backend on :3001 and portal on :5173 answer. If Vite serves a stale module graph after this slice's edits, `rm -rf node_modules/.vite` and restart.

- [ ] **Step 2: Prove a failing handler answers**

Pick one wrapped read route. Stop the Postgres container, call that route, and confirm it answers a JSON 500 within a second or two rather than hanging. Start the container again. Record the exact response and the elapsed time.

This is the whole point of Task 1, and it cannot be proven from a unit test that stubs the database.

- [ ] **Step 3: Prove a resumed session recovers its badges**

Log in. Reload the page. Confirm the dispatcher identity is present without a second login, then confirm a load another dispatcher holds shows its badge. Then clear only the stored dispatcher (leaving the token), reload, and confirm the boot fetch restores it — that is the case Task 4 exists for.

- [ ] **Step 4: Prove the untouched-cell case**

Open a cell editor on the broker board. From another tab or a raw request, change that same cell. Return to the first tab and commit without typing. Confirm no conflict panel appears and no write is sent.

- [ ] **Step 5: Clean up and record**

Delete every probe row, restore anything real you touched, and note what you restored with its resulting version. Append to the ledger what you observed at each step, any screenshot paths (under the session scratchpad, never the repo), and anything that did not behave as this plan predicted.

- [ ] **Step 6: Commit** — skipped.

---

### Task 7: A handler that never settles must answer too

**Added after Task 6's live acceptance found the gap.** Stopping the database and
calling a wrapped route produced no response at all — the request hung until the
client gave up. `asyncRoute` converts a *rejected* promise into a 500; a promise
that never *settles* is untouched by it, and an unreachable database is exactly
that, because Prisma waits for a connection rather than failing.

Task 1's claim was that it retired a class rather than five instances. That claim
is not true while the commonest cause of a hung request walks past it.

**Files:**
- Modify: `fleet-backend/.env.example`, `fleet-backend/.env.test`, and the dev/test database URLs
- Modify: `fleet-backend/src/lib/asyncRoute.ts` (or a sibling), `fleet-backend/src/app.ts`
- Test: `fleet-backend/tests/no-silent-hang.test.ts`

**Interfaces:** Consumes `asyncRoute` from Task 1. Produces no new public surface — a
request that cannot be served now ends in a response either way.

- [ ] **Step 1: Make the database fail instead of wait**

Add `connect_timeout` and `pool_timeout` to the Postgres connection string in
`.env.example` and `.env.test`, and say in a comment why the numbers are what they
are. A few seconds is right: long enough to survive a blip, short enough that a
dispatcher learns the truth while they still remember what they clicked.

Do not edit the developer's own `.env` — document the change in the example file
and note it in the report so the user can apply it.

This alone converts today's hang into a rejection, which `asyncRoute` already
answers.

- [ ] **Step 2: Add a settle deadline, because layer one only covers the database**

Give every wrapped handler a deadline: if it has neither responded nor rejected
within a bounded time, answer `503` with a JSON body saying the request timed out,
and log it server-side with the method and path. Put it where `asyncRoute` already
sits so no route has to remember it.

Two things to get right: the deadline must not fire after the handler has already
sent a response (check `res.headersSent`), and it must be generous enough not to
kill a legitimately slow report — pick a number, justify it in a comment, and make
it configurable by environment variable with that number as the default.

- [ ] **Step 3: Prove both layers**

In `tests/no-silent-hang.test.ts`: a handler that never settles answers 503 rather
than hanging, and a handler that responds slowly but within the deadline is not
cut off. Use fake timers or a short test-only deadline rather than making the suite
wait.

- [ ] **Step 4: Re-run the live proof**

This is the one that counts, and it is the controller's. Stop the database, call a
wrapped read route, confirm it answers within a couple of seconds rather than
hanging, then restart the database and confirm the route recovers. Record the
status code, the body and the elapsed time.

- [ ] **Step 5: Commit** — skipped (Global Constraints).
