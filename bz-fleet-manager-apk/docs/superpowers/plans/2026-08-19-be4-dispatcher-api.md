# BE-4 — Dispatcher REST API Implementation Plan

> Extends `fleet-backend/`. This is the "designed, not recovered" admin side the Vue portal drives. Same patterns (Zod, Prisma+SQLite, Vitest+Supertest, per-unit commits scoped to `fleet-backend/`, TDD). Introduces **roles**.

**Goal:** dispatcher authentication with a role claim, driver & vehicle CRUD, trip creation + assignment, route-pre-assignments, and the approval queues (trip approval + signs-proof approval) — everything the portal needs to run the fleet.

## Global Constraints
- Under `/api`, Bearer. **Two identities now:** drivers (existing) and dispatchers (new). Dispatcher routes require role `dispatcher` (fleet-wide scope); driver routes remain driver-scoped.
- Do **not** break existing driver routes/tests. Driver tokens keep `driverId`; the change is additive.

## Auth / roles (modify `src/lib/tokens.ts`, `src/middleware/auth.ts`; new `src/routes/dispatcherAuth.ts`)
- Add `role` to token payloads. Driver access token → `{ driverId, role: "driver" }`; dispatcher → `{ dispatcherId, role: "dispatcher" }`. Keep `signAccess(driverId)` working (it now embeds `role:"driver"`); add `signDispatcherAccess(dispatcherId)` and the matching refresh.
- `requireAuth` sets `req.auth = { driverId?, dispatcherId?, role }` from the verified payload (existing driver routes still read `req.auth.driverId`).
- New `requireDispatcher` middleware → 403 unless `req.auth.role === "dispatcher"`.
- New `Dispatcher` model `{ id, email @unique, passwordHash, name, createdAt }`; `POST /api/auth/dispatcher/login` → `{ dispatcher, token, refreshToken }` (bcrypt, same shape family as driver login, `passwordHash` stripped). Refresh/logout reuse the existing rotation/revocation, keyed on the dispatcher subject.

## Schema changes + migration `be4_dispatcher`
- `Trip.driverId` → **optional** (`String?`) so a trip can exist before assignment; add `Trip.status` value `"awaiting_approval"` usage (no enum change needed, it's a String). Add `approvedAt DateTime?`, `approvedBy String?`.
- New `RoutePreAssignment { id, driverId, tripId, status @default("pending"), declineReason?, createdAt, respondedAt? }` (the driver-side respond endpoint from BE-foundation contract can be wired here if not already).
- Add `Dispatcher` (above). Keep all existing models/relations intact.

## Endpoints (`src/routes/dispatcher.ts`, mounted `/api/dispatcher`; auth route separate)
All require `requireAuth` + `requireDispatcher` unless noted.
**Drivers & vehicles**
| GET `/dispatcher/drivers` list · POST create `{email,name,phone?,password}` · GET `/:id` · PUT `/:id` · GET `/dispatcher/drivers/:id/locations` (that driver's location history) |
| GET `/dispatcher/vehicles` · POST create `{plate,model?}` · PUT `/:id` · POST `/dispatcher/vehicles/:id/assign` `{driverId}` |
**Trips & assignment**
| POST `/dispatcher/trips` `{identifier, stops:[{sequence,address}], checklistItems?:[{label,required}]}` → creates trip (status `pending`, no driver) + stops + checklist |
| GET `/dispatcher/trips` (filter `?status=&driverId=`) · GET `/dispatcher/trips/:id` (full: stops, checklist, proofs) |
| POST `/dispatcher/trips/:id/assign` `{driverId}` → sets driverId, status `assigned`; creates a `RoutePreAssignment` |
**Approvals**
| GET `/dispatcher/approvals/trips` → trips with status `awaiting_approval` |
| POST `/dispatcher/trips/:id/approve` → status `assigned`/`approved`, `approvedAt/By` |
| POST `/dispatcher/trips/:id/reject` `{reason?}` → status `rejected` |
| GET `/dispatcher/approvals/signs-proof` → `SignsProof` where status `pending` |
| POST `/dispatcher/signs-proof/:id/approve` → status `approved` |
| POST `/dispatcher/signs-proof/:id/reject` `{reason?}` → status `rejected` |
**Fleet reads**
| GET `/dispatcher/locations` (latest per driver) · GET `/dispatcher/overview` (counts by trip status) |

## Acceptance tests
- dispatcher login issues a role-`dispatcher` token; a driver token hitting any `/dispatcher/*` route → **403**; no token → 401.
- driver CRUD: create → appears in list → update persists; created driver can log in via `/auth/driver/login`.
- vehicle create + assign to driver reflects in the driver's `/driver/vehicle`.
- trip create (with stops + checklist) → GET `/dispatcher/trips/:id` returns nested; assign sets driver + creates route-pre-assignment; the assigned driver now sees it via `/driver/trips/active`.
- signs-proof approve flips a driver-uploaded proof's status to `approved` (the value the driver app reads).
- trip approve/reject transitions status.
- **existing driver suite still fully green** (regression guard) — the role change must not break driver routes.

## Done when
`npm test` green (109 + new, incl. the full existing suite), `tsc --noEmit` clean, migration applied, commits scoped to `fleet-backend/`.
