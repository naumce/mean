# Cockpit S2a — Interaction API complete (2026-08-31)

Spec: `docs/superpowers/specs/2026-08-28-cockpit-control-tower-design.md` (§6.2, §6.3, §6.4, §6.10, §8)
Plan: `docs/superpowers/plans/2026-08-31-cockpit-s2a-interaction-api.md` (10 tasks)
Full record — ledger, 37 rulings, 10 task reports, every review: `e:\meeting-copilot\.superpowers\sdd\2026-08-31-cockpit-s2a-interaction-api\`
**Kept, not deleted:** the standing no-commit rule means git history is not the record for this work.

## What shipped

- **Pessimistic lane locks** — `lib/locks.ts` (flat `Map<laneId, Lock>`, 90 s TTL, 30 s heartbeat, sweeper),
  `GET/POST/DELETE /locks`, and a guard on every assignment mutation. Lock visibility follows the *lane's* org.
- **`PATCH /assignments/:id/plan`** — replan as unassign+reassign in one Serializable transaction: restore the
  HOS snapshot, re-evaluate, re-snapshot, rewrite Rate/DeadheadLeg, append (never purge) conflicts. Powers
  drag-to-move, drag-between-drivers and edge resize.
- **Tenders** — offer/accept/decline, dispatcher-side and driver-side, sharing `lib/assignmentActions.ts`.
  A tender holds capacity: `tendered` is in the single shared `ACTIVE_STATUSES`, so every busy, overlap and
  yard query counts it.
- **Driver–equipment pairing** — `PATCH /drivers/:id/pairing`, the write side of the yard hook (S1 shipped the
  columns and the read; nothing wrote them).

## Gate

**81 test files / 536 tests / 0 failures** (baseline at plan start: 67 / 379). `tsc --noEmit` clean.
Live smoke 26/26.

> **How to gate this repo.** `vitest` SIGSEGVs before the reporter flushes, at any batch size. Each file prints
> its own PASS line first, so run in batches, count from those lines, and re-run whatever a crash truncated.
> A bare `npx vitest run` tells you nothing. Run **one** vitest process at a time — tests and the dev app share
> one Postgres with no isolation, and concurrent runs corrupt each other's fixtures.
> Tests wipe the demo seed: `node seed-control-tower.mjs && node seed-demo.mjs` afterwards.

## Security fixes made during this slice

Six Critical/High holes in the surrounding product, none related to the feature, all demonstrated exploitable
before being fixed. See `docs/SECURITY-BACKEND-FINDINGS.md`. The existing 379-test suite was green throughout.

## Known-open — decisions for the owner

| Severity | What | Why not done |
|---|---|---|
| Medium | `Trip` and `Vehicle` have no `orgId`, so **unassigned** trips and vehicles are a pool any tenant can list, rename and claim | Needs a migration + backfill on both models |
| Medium | Async handler rejections return **no HTTP response** (Express 4 doesn't await handlers). The process survives and logs | Needs Express 5 or wrapping every handler. `package.json` pairs `express@^4.22.2` with `@types/express@^5.0.6` |
| Low | Multipart bodies aren't NUL-scanned (`rejectNulBytes` runs before multer) | Same class as the fixed NUL crash |
| Low | `POST /drivers`/`/vehicles` 409 on an email/plate in another org — an existence oracle | Scoping the pre-check turns it into a 500 |
| Low | `PATCH /pairing`'s one-unit-one-driver check is read-then-write, not transactional | Last-write-wins under a genuine race |
| Low | The lock table is process-local — correct for one instance, wrong behind a load balancer | Isolated behind `lib/locks.ts`; a Redis swap touches one file |
| Low | `GET /suggest` doesn't check `Load.status`, so it ranks drivers for already-tendered freight | Pre-existing; equally true for `assigned` long before tenders |
| Low | `tenderedAt` is written in three places and read by nothing | Needed the day a tender-timeout feature ships |

## Consequences for S2b (the portal slice)

Recorded in that plan, but the two that would have cost real time:

1. **An overlap cannot be forced.** The in-transaction check refuses an overlapping window unconditionally on
   both commit and replan — deliberately, because an overlap is physics, not judgement. `force` remains
   meaningful for judgement-call blockers (HOS, compliance). **The verdict modal must hide Force when any
   blocker is an overlap**, or it offers a button that cannot succeed.
2. **The yard hook's contract differs from §8.** The spec says `PATCH /drivers/:id {defaultTractorId}`. It was
   built as `PATCH /drivers/:id/pairing {tractorId}` — and there is no `PATCH /drivers/:id` at all, while
   `PUT /drivers/:id` zod-strips `defaultTractorId` and returns **200 having written nothing**. A client written
   from the spec gets a 404 or a silent success. **The spec should be amended.**
3. A **left-edge** resize sending only `{availableAt}` translates the leg rather than stretching it; the client
   must send `plannedEnd` too.
4. `POST /locks` with a tractor/trailer id returns **404 "Driver not found"** — lane ids are driver ids until
   S3 adds unit lanes. Fails closed, misleading message.
