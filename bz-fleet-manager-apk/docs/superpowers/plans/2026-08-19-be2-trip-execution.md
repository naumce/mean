# BE-2 — Trip Execution Implementation Plan

> Extends the existing `fleet-backend/` (auth + trip-start foundation). Follow its established patterns exactly: `requireAuth`, Zod `validateBody`, ownership-by-construction (every query keyed on the token's `driverId`), Prisma + SQLite, Vitest + Supertest with `resetDb()`, per-unit commits scoped to `fleet-backend/` paths. TDD: failing test first.

**Goal:** Implement the driver-facing trip-execution flow — pre-trip checklist completion, stop arrive/complete with sequential unlocking, proof photo/document uploads, signs-proof capture, and the can-proceed gate — plus trip completion.

**Spec:** `decompiled/API-CONTRACT.md` (Trips + Stops + Signs-proof sections) — match routes/verbs/shapes.

## Global Constraints
- All routes under `/api`, Bearer auth, driver-scoped. A driver may only touch trips where `trip.driverId === req.auth.driverId`; a mismatch returns **404** (never leak existence). Enforce by construction (match `id` AND `driverId` together).
- State transitions are guarded by pure functions in `src/domain/` (unit-tested separately), mirroring the foundation's `tripState.ts`.
- Uploads: `multer` disk storage → `fleet-backend/uploads/`, served static at `/uploads`; persist the URL `"/uploads/<filename>"`. Add `uploads/` to `.gitignore`.
- Every endpoint validated with Zod where it has a body; wrong state → **409**, bad input → **400**, not-owner/not-found → **404**.

## Data model additions (`prisma/schema.prisma`) + migration
```prisma
model Stop {
  // existing: id, tripId, sequence, address, status
  arrivedAt   DateTime?
  departedAt  DateTime?
  completedAt DateTime?
  uploads     Upload[]
  signsProofs SignsProof[]
  requirements SignsProofRequirement[]
}
model ChecklistItem {
  id        String  @id @default(uuid())
  trip      Trip    @relation(fields: [tripId], references: [id])
  tripId    String
  label     String
  required  Boolean @default(true)
  completed Boolean @default(false)
  @@index([tripId])
}
model Upload {
  id        String   @id @default(uuid())
  stop      Stop     @relation(fields: [stopId], references: [id])
  stopId    String
  kind      String   // "photo" | "document"
  url       String
  mimeType  String?
  createdAt DateTime @default(now())
  @@index([stopId])
}
model SignsProofRequirement {
  id             String  @id @default(uuid())
  stop           Stop    @relation(fields: [stopId], references: [id])
  stopId         String
  proofType      String  // e.g. "signature" | "photo" | "barcode"
  validationType String?
  required       Boolean @default(true)
  @@index([stopId])
}
model SignsProof {
  id            String   @id @default(uuid())
  stop          Stop     @relation(fields: [stopId], references: [id])
  stopId        String
  requirementId String?
  proofType     String
  fileUrl       String
  hasLocation   Boolean  @default(false)
  status        String   @default("pending") // pending | approved | rejected
  createdAt     DateTime @default(now())
  @@index([stopId])
}
```
Add the back-relations (`ChecklistItem[]`, etc.) to `Trip`/`Stop`. Create migration `be2_trip_execution`.

## Domain guards (`src/domain/stopState.ts`, unit-tested)
```ts
// A stop may be arrived only if the trip is running and every earlier-sequence stop is completed.
export function canArriveStop(trip, stop, earlierStops) { ... in_progress + stop.status==='pending' + all earlierStops completed }
// A stop may be completed only if it is arrived and all its REQUIRED signs-proof requirements have a proof.
export function canCompleteStop(stop, requiredCount, providedCount) { arrived + providedCount>=requiredCount }
// A trip may be completed only if in_progress and all stops completed.
export function canCompleteTrip(trip, stops) { in_progress + stops.length>0 + all completed }
```
Each returns `{ ok: true } | { ok: false, reason }`. Write unit tests for allow + each block reason first.

## Endpoints (`src/routes/trips.ts`, extend; new `src/routes/signsProof.ts`; mount in `app.ts`)
| Method | Path | Body / query | Behavior |
|---|---|---|---|
| GET | `/api/trips/:id/checklist` | — | items for the driver's trip |
| POST | `/api/trips/:id/checklist/complete` | `{loadId?, populate?}` | mark all items complete → set `trip.preTripCheckCompleted=true` |
| POST | `/api/trips/:id/stops/:stopId/arrive` | — | guarded `canArriveStop` → status `arrived`, `arrivedAt` |
| POST | `/api/trips/:id/stops/:stopId/complete` | — | guarded `canCompleteStop` → status `completed`, `completedAt` |
| POST | `/api/trips/:id/stops/:stopId/photos` | multipart `file` | → `Upload{kind:"photo"}`, returns `{url}` |
| POST | `/api/trips/:id/stops/:stopId/documents` | multipart `file` | → `Upload{kind:"document"}`, returns `{url}` |
| GET | `/api/mobile/trips/:id/signs-proof-requirements` | `?stopId=` | requirements for the stop |
| POST | `/api/signs-proof/:stopId/upload` | multipart `file` + `{requirementId?, proofType, hasLocation?}` | → `SignsProof`, returns record |
| GET | `/api/trips/:id/can-proceed` | `?currentStopSequence=&validationType=` | `{canProceed, reason}` — false if the current stop has unmet required proofs |
| POST | `/api/trips/:id/complete` | — | guarded `canCompleteTrip` → status `completed`, `completedAt` |

Every handler first loads the trip with `findFirst({ where:{ id, driverId: req.auth.driverId }})` → 404 if null; stop handlers additionally verify `stop.tripId === id`.

## Acceptance tests (Supertest, driver-scoped)
- checklist: complete flips `preTripCheckCompleted`; GET returns items.
- arrive/complete happy path; **sequential-unlock**: arriving stop #2 before #1 completes → 409.
- complete-stop with an unmet **required** signs-proof → 409; with proof present → 200.
- photo/document upload returns a `/uploads/...` url and persists an `Upload` row.
- signs-proof upload persists a `SignsProof` and appears in requirements-satisfaction.
- can-proceed returns false+reason when required proof missing, true when satisfied.
- complete-trip: 409 while a stop is open; 200 when all completed.
- **cross-driver isolation**: every route returns 404 when the trip belongs to another driver (at least arrive, upload, complete).

## Done when
`npm test` green (foundation's 20 + new), `tsc --noEmit` clean, migration applied, commits scoped to `fleet-backend/`.
