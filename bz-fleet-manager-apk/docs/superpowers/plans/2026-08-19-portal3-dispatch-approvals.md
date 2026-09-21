# Portal-3 — Dispatch & Approvals Implementation Plan

> Extends `fleet-portal/`. Reuse the Portal-2 component kit (`DataTable`, `Modal`, `FormField`, `AppButton`) and the established store/view/router patterns. TDD for stores + a component test per view; build+typecheck gate. Note Modal teleports to `document.body` — component specs clear `document.body.innerHTML` in `afterEach`.

**Goal:** the core dispatcher workflow — create trips (with stops + checklist), assign to drivers, a status board of all trips, a trip-detail view, and the two approval queues (trips awaiting approval, and driver-submitted signs-proof).

## Backend endpoints (already built, dispatcher Bearer)
- `POST /dispatcher/trips` `{identifier, stops:[{sequence,address}], checklistItems?:[{label,required}]}`
- `GET /dispatcher/trips` (`?status=&driverId=`) · `GET /dispatcher/trips/:id` (nested stops/checklist/proofs) · `POST /dispatcher/trips/:id/assign` `{driverId}`
- `GET /dispatcher/approvals/trips` · `POST /dispatcher/trips/:id/approve` · `POST /dispatcher/trips/:id/reject` `{reason?}`
- `GET /dispatcher/approvals/signs-proof` · `POST /dispatcher/signs-proof/:id/approve` · `POST /dispatcher/signs-proof/:id/reject` `{reason?}`
- `GET /dispatcher/overview` (status counts, already used by Dashboard)

## Stores (`src/stores/`)
- `trips.ts` — `useTripsStore`: `list(filters?)`, `get(id)`, `create(payload)`, `assign(id, driverId)`; `items`, `current`, `loading`, `error`.
- `approvals.ts` — `useApprovalsStore`: `listTrips()`, `approveTrip(id)`, `rejectTrip(id, reason)`, `listSignsProof()`, `approveProof(id)`, `rejectProof(id, reason)`; holds `pendingTrips`, `pendingProofs`.

## Views + routing
- `src/views/TripsView.vue` — a **status board**: columns/sections for `pending / assigned / in_progress / completed`, each a `DataTable` (identifier, driver, stops count, status pill). Status filter. "Create trip" opens a `Modal` with an identifier field + a dynamic stop-list editor (add/remove rows: sequence + address) + optional checklist items; submit → `create`. Row action "Assign" opens an assign modal (driver `<select>` from the drivers store) → `assign`.
- `src/views/TripDetailView.vue` — `/trips/:id`: header (identifier, status pill, assigned driver), stops list with per-stop status + any uploads/signs-proof, checklist items. Loads via `get(id)`.
- `src/views/ApprovalsView.vue` — two tabs/sections: **Trips awaiting approval** (`DataTable` + Approve/Reject actions; reject opens a reason `Modal`) and **Signs-proof pending** (list with proof preview link/`fileUrl`, proofType, stop; Approve/Reject). Actions call the approvals store and refresh.
- `src/router/index.ts` — add `/trips` (name `trips`), `/trips/:id` (name `trip-detail`), `/approvals` (name `approvals`); activate the Trips + Approvals sidebar links.
- Use a shared `StatusPill.vue` small component (maps status → color: pending=amber, assigned=blue, in_progress=blue-600, completed=emerald, rejected/cancelled=red) — add to `src/components/`.

## Tests (Vitest + jsdom + @vue/test-utils)
- `stores/trips.spec.ts`: mock api — `create` posts the nested payload; `list` populates `items`; `assign` posts `{driverId}` and refreshes; `get` sets `current`. Error path.
- `stores/approvals.spec.ts`: `listTrips`/`listSignsProof` populate; `approveTrip`/`rejectTrip`/`approveProof`/`rejectProof` hit the right endpoints (reject sends `{reason}`) and refresh.
- `components/StatusPill.spec.ts`: renders the right label/color class per status.
- `views/ApprovalsView.spec.ts`: mounts with mocked store; renders pending trips + proofs; clicking Approve calls the store; Reject opens the reason modal and submits `{reason}`.
- `views/TripsView.spec.ts`: renders trips grouped by status; "Create trip" modal add-stop adds a row; submit calls `create` with the stops array.

## Done when
`npx vitest run` green (Portal-2's 37 + new), `npx vue-tsc --noEmit` 0 errors, `npm run build` succeeds, commits scoped to `fleet-portal/`.
