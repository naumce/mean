# Backend security findings — 2026-08-31

Found while executing the Cockpit S2a plan, by review agents instructed to attack rather than verify.
**Every item marked FIXED was demonstrated exploitable against the real routes and database before it was
fixed, and each fix is pinned by a test that fails when the guard is reverted.**

None of this was caught by the existing 379-test suite, which was green throughout.

## Fixed

| # | Severity | What |
|---|---|---|
| 1 | **Critical** | `dispatcherDriversRouter` mounted without `attachOrgScope` and with no internal filtering. Any dispatcher could read every org's drivers (email, phone, GPS, push tokens), read foreign GPS history, and **write** — a foreign driver's name was changed to "PWNED". Vehicles too, including cross-org vehicle assignment. |
| 2 | **Critical** | Same class in four more routers: `trips`, `board`, `approvals`, `comms`. A trip was reassigned to another company's driver; approvals were stamped with a foreign dispatcher's id; **comms leaked a full message body on a plain list call, accepted message injection into another company's driver's thread, and created a notification ("pull over now") against that driver.** |
| 3 | **Critical** | A NUL byte in a route parameter *or* JSON body reached Prisma, raised Postgres 22021, and terminated the process — no Express error middleware and no `unhandledRejection` handler existed anywhere. ~11 routes shared the shape. Vitest masked it entirely by installing its own listener. |
| 4 | **High** | Tenant isolation depended on **mount order**. Express runs a mount's chain for every path-matching request even when the router falls through, so `req.orgScope` was set by whichever scoped mount came first. Reordering `app.ts` would have silently disabled scoping with no test failing. Also cost ~19 redundant dispatcher lookups per request. Now one structural mount; a reorder breaks a test. |
| 5 | **High** | Cross-tenant oracle: `POST /assignments` ran the lane-lock guard on the raw request body before validating the driver's tenancy, returning 409 with the holding dispatcher's **name, id, org id and timestamps** for any driver UUID. |
| 6 | Medium | `POST /drivers` created drivers with no `orgId`, so portal-created drivers fell outside org-scoped queries. |

## Open — need a decision

| Severity | What | Why not fixed |
|---|---|---|
| Medium | `Trip` and `Vehicle` have no `orgId`, so **unassigned** trips and vehicles are a pool any tenant can list, rename and claim. | Needs a migration + backfill on both models. Not a leak (nothing records an owner), but a real modelling gap. |
| Medium | Async handler rejections still return **no HTTP response** — Express 4 doesn't await handlers, so the new error middleware can't reach them. The process survives and logs. | Real fix is Express 5 or wrapping every handler. Note `package.json` already pairs `express@^4.22.2` with `@types/express@^5.0.6` — the types describe a version the runtime is not. |
| Low | Multipart bodies aren't NUL-scanned (`rejectNulBytes` runs before multer), so a NUL in an uploaded CSV cell still reaches Prisma via `dispatcherImport`. | Same shape as #3; deliberately left. |
| Low | `POST /drivers` and `POST /vehicles` return 409 for an email/plate belonging to another org — a global-unique existence oracle. | Scoping the pre-check turns it into a 500; needs thought. |

## What actually found these

Not the test suite. Reviewers told to **construct a broken variant and prove which test catches it**, and to
**attack a fix rather than confirm it**. Two of the worst findings came from a reviewer answering the question
"what was the old design buying that the new one isn't?" — and one router turned out to be already safe via a
hand-rolled check that grep could not see, which is why proof was required before every fix.
