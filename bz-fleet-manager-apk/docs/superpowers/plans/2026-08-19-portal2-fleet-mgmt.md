# Portal-2 — Fleet Management Implementation Plan

> Extends `fleet-portal/`. Follow Portal-1's established patterns (api client in `src/lib/api.ts`, Pinia stores in `src/stores/`, views in `src/views/`, router in `src/router/index.ts`, Tailwind primary `#2563eb`). TDD for store logic + a component test each; build+typecheck gate.

**Goal:** Drivers and Vehicles management screens — list, create, edit, and assign a vehicle to a driver — wired to the dispatcher CRUD API. Plus a small reusable component kit the later increments reuse.

## Backend endpoints (already built)
- `GET /dispatcher/drivers` · `POST /dispatcher/drivers` `{email,name,phone?,password}` · `GET /dispatcher/drivers/:id` · `PUT /dispatcher/drivers/:id`
- `GET /dispatcher/vehicles` · `POST /dispatcher/vehicles` `{plate,model?}` · `PUT /dispatcher/vehicles/:id` · `POST /dispatcher/vehicles/:id/assign` `{driverId}`

## Reusable component kit (`src/components/`) — build first, used across this + later increments
- `DataTable.vue` — props `columns: {key,label}[]`, `rows: any[]`; default slot per cell via `#cell-<key>` scoped slots; empty-state slot. Tailwind table, zebra rows, sticky header.
- `Modal.vue` — `v-model:open`; teleport to body; backdrop; header slot + default body slot + footer slot; ESC + backdrop-click close; focus trap basic.
- `FormField.vue` — label + slot + error text; `id` wiring for a11y.
- `AppButton.vue` — variants `primary|ghost|danger` (primary = `#2563eb`), `:loading`, disabled.

## Stores (`src/stores/`)
- `drivers.ts` — `useDriversStore`: `list()`, `create(payload)`, `update(id, payload)`, holds `items`, `loading`, `error`. Calls the api client.
- `vehicles.ts` — `useVehiclesStore`: `list()`, `create()`, `update()`, `assign(id, driverId)`.

## Views + routing
- `src/views/DriversView.vue` — `DataTable` of drivers (name, email, phone, status); "Add driver" opens a `Modal` with a create `FormField` form; row action "Edit" opens the same modal prefilled → `update`. Loads via the store on mount.
- `src/views/VehiclesView.vue` — `DataTable` of vehicles (plate, model, assigned driver); "Add vehicle" create modal; row actions "Edit" and "Assign" (assign modal with a driver `<select>` populated from the drivers store) → `assign`.
- `src/router/index.ts` — add child routes `/drivers` (name `drivers`) and `/vehicles` (name `vehicles`) under the AppShell; **activate** the previously-disabled sidebar nav links for Drivers and Vehicles.

## Tests (Vitest + jsdom + @vue/test-utils)
- `stores/drivers.spec.ts` + `stores/vehicles.spec.ts`: mock the api client; assert `list` populates `items`, `create`/`update` call the right endpoint + refresh, `assign` posts `{driverId}`. Error path sets `error`.
- `components/DataTable.spec.ts`: renders a row per item and shows the empty-state slot when `rows` is empty.
- `views/DriversView.spec.ts`: mounts with a mocked store, renders driver rows, opening "Add driver" shows the modal, submitting calls `create`.

## Done when
`npx vitest run` green (Portal-1's 10 + new), `npx vue-tsc --noEmit` 0 errors, `npm run build` succeeds, commits scoped to `fleet-portal/`.
