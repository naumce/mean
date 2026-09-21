# Bertschi TP — Engineering Teardown & Adoption Map

> Analysis date: 2026-08-20. Source: `E:\Bertschi\bertschi-tp-frontend` (Vue 2 dispatcher, last commits ~2022, v1.11.2).
> Purpose: understand Bertschi's transport-planning board and decide what to adopt into our fleet product
> (`fleet-backend` Node/Express/Prisma + `fleet-portal` Vue 3/Pinia/Tailwind). Authorized — user's own workplace project.

---

## 1. What it is

Bertschi TP ("Transport Planning") is the production **dispatch/planning board** for Bertschi AG — Swiss
chemical & tanker logistics (ADR dangerous goods, food-grade tankers, intermodal rail). It is a
**time-axis Gantt board**: Y-axis = fleet rows (truck/driver/trailer/subcontractor), X-axis = time (hour
boxes across days). Dispatchers **drag transport "legs" onto lanes** to plan them, live, with multiple
dispatchers editing the same board under pessimistic locking. Not a CRUD fleet list — an operational
planning surface ("Google Calendar meets ATC, for chemical tankers").

## 2. Architecture & topology

| Layer | Tech |
|---|---|
| Frontend | Vue **2.6** + `@vue/composition-api`, Ant Design Vue, **Vuex** (`vuex-module-decorators`), i18n EN/DE. ~150 components; `Board/` = 12.7k LOC |
| Drag/DnD | `vue-drag-resize` (bricks), `vuedraggable` (sidebar), HTML5 DnD (new-leg drop) |
| Real-time | **STOMP over SockJS** (`webstomp-client`), subscribes `/user/queue/updates`, viewport-scoped |
| Search | **flexsearch** in-browser index, spotted/focused overlay |
| BFF | tiny Node/Express — *only* **SAML SSO → JWT-cookie** exchange (passport-saml, Keycloak realm `bertschi`) + serves static `dist` |
| Real backend | Java microservices **`leg-service`** + **`tp-dispatcher`** (not in this repo) |
| Infra | **Postgres + Redis + ActiveMQ Artemis (JMS)** (`Docker.txt`) |
| External | **G11 / "Galaxy 11"** master TMS/order system — `window.postMessage` bridge |
| Ops | Docker → **GKE** on GCP, Bitbucket Pipelines, templated per-env k8s, registry `europe-west6` |

Flow: G11 (orders) → leg-service → Artemis/Redis → tp-dispatcher → STOMP push → board.
Dispatcher edits go back the same path with pessimistic locking.

## 3. Domain model

- **Legs** — one movement; 15+ types (collection, delivery, trucking, full-transport, drop-swap, intermodal,
  cleaning, heating, storage, third-party…). Status lifecycle: notBooked → booked → departed → loaded →
  unloaded → dropped. Multi-step bookings; **previous-leg / intermodal** chaining with irregularity flags.
- **ADR dangerous-goods metadata** — UN number, Kemler code, ADR class, tunnel restriction, packaging group.
- **Container/tank specs** — chamber volumes, tare, tank code, next ADR/CSC test dates, heating method,
  baffles, `markedForRepair`.
- **Transport checklists** — customs / special customs / documents / special equipment / temperatures, each
  pending/done, coloring the brick. (= our signs-proofs/checklist concept, matured.)
- **Fleet = composable entities** — truck + driver + trailer + subcontractor as separate objects with
  **composite IDs** (`truck#driver`, `trailer#lastLocation`, `subcontractor#board#seq`).
- **Fleet actions** — non-leg bricks: maintenance / breaks / reminders on the same timeline.
- **Occupancy blocks** — grey "busy elsewhere / off-shift" overlays (double-booking prevention).
- Crew schedules, driver↔truck affiliations, per-user **config profiles** (viewport, day window, weekend
  toggle, trailer-type filter, sidebar ordering).

## 4. Engineering crown jewels (portable, near-verbatim)

Pure-function timeline core is domain-agnostic — ports even into Vue 3/Pinia:

1. **Time↔pixel engine** — `store/brick/useBrick.ts` (`getEventXBoardCoordinate`, `deriveBrickWidth`) +
   `components/Board/Use/useBoardBrickCalculus.ts` (`getTimestampForCoordinate`). Time→X render with
   15-min snap, weekend-collapse, clamp to board width; X→time drop resolution, business-day aware.
   Board geometry = measured DOM width ÷ hours (`GET_HOURBOX_WIDTH = offsetWidth / hoursDifference`,
   hours rounded up to multiples of 3). Day window from config profile (`dayStartsAt/EndsAt`).
   **The crown jewel — hardest part, already solved.**
2. **Collision layout** — `deriveBoardFlexibles` + `recalculateYCoords`/`calculateYDownshift`: overlapping
   bricks in a lane pushed down 100px recursively; row height (`fleetSpans`) grows to fit.
3. **Generic brick drag state-machine** — `components/Board/Use/useBoardBrickDrag.ts`, parametrized with
   `reset/lock/unlock` callbacks; module-level singleton `selectedBrickId` (one active brick); 5px move
   threshold. Reused by both legs and actions (`useLegDrag.ts`, `useBoardActionDrag.ts`).
4. **Pessimistic lock + optimistic freeze** — edit-start → server `POST /{id}/lock`; every *other* brick
   goes `updatable:false`; `409 ENTITY_ALREADY_LOCKED` caught centrally, toasts *who* holds the lock.
   Release → `UNLOCK` → `MARK_ALL_BRICKS_UPDATABLE`. Endpoints on legs/trucks/drivers/subcontractors/actions.
5. **STOMP real-time, viewport-scoped** — `components/Board/TimeLine/useWebSocket.ts`. Connect header
   `x-time-range: from/to` so server pushes only the visible window. Messages
   `{messageType(LEG|FLEET_ACTION|TRAILER), messageContent, messageAction(UPDATE|DELETE)}` → Vuex.
   `viaSocket`/`viaDrop` flags distinguish remote echoes from local edits and short-circuit no-op echoes.
   30s keepalive ping, linear-backoff reconnect (`retryCount*1000`).
6. **Validation-details protocol** — leg update returns `{info[], warnings[], errors[]}` (localized) not bare
   HTTP codes → graded toasts.
7. **flexsearch spotting/focus** — `store/board/useSearchIndex.ts`: one index, every brick stringified in.
   Search paints all matches yellow ("spotted"); arrows cycle focus ("focused") with auto-scroll.
8. **Config-profile persistence** — per-board-selection viewport + sidebar order saved server-side,
   rehydrated on load (`INIT_USER_CONFIG_PROFILE`, key = sorted comma-joined selected board ids).

**Rewrite, don't port:** `Leg.vue` / `useLegStatus.ts` / callouts (leg+G11 saturated), composite-ID encoding,
subcontractor sub-boards, G11 `postMessage` bridge. Whole thing is Vue 2 — concepts port, components don't.

### Vuex module map (for reference)
- **auth** (~45 LOC) — `authenticated`, `IS_LOGGED_IN`, cookie-based `CHECK_AUTH`/`LOG_OUT`.
- **board** (~870 LOC) — viewport/profile + geometry getters + cross-cutting search/highlight + G11 bridge.
- **fleet** (~1230 LOC) — flat ordered fleet rows; `SET_FLEET` explodes trucks per crew-driver / subcontractors
  per board-seq / trailers per location into synthetic ids; `GET_FLEET_IDS` = id→row-index maps; occupancy;
  orphan re-insertion reconciling server order vs saved `sidebarTiles`.
- **brick** (~1450 LOC) — positioned `legs`/`boardActions`; map-to-board (filter timespan + matching fleet),
  collision layout, CRUD, lock/optimistic-freeze, selection/spotting.
- Convention worth adopting: **two-tier action-name constants** — bare local (`SET_FLEET`) + namespaced
  (`fleet/FETCH_BOARD_FLEET`) for typo-safe cross-module wiring.

## 5. Quality / security observations

- ⚠️ **Live plaintext credentials on disk** in `E:\Bertschi`: `Links.txt` + `bertschi.txt` = user's Bertschi
  SSO login; `Docker.txt` = real **G11 service-account password** + `admin`/`admin` infra passwords; Express
  session secret hardcoded `"this is hits"`. Rotate + purge if still valid. (See separate memory.)
- `$axios` binds the JWT header **once at import** — a re-login without page reload sends a stale token.
- Dev cruft shipped: giant hardcoded `TRIGGER_LEG_UPDATE` fake-leg fixture + stray `console.log`s in the store.
- Guides describe an "enhanced" mock server (`server_enhanced.ts`) that **isn't in the tree** — aspirational.
  Real `mirage` harness has realistic previews but thin inline handlers; **can't exercise STOMP** (no socket mock).
- 2022 codebase: Node 16 / Vue 2 / composition-api-beta. Vue 3 + Pinia migration would touch every file.

---

## 6. Adoption map → our fleet product

Our stack is the modern version of theirs; our domain (drivers, vehicles, trips+stops+checklist, assignments,
approvals, messaging, tracking) is a strict subset of Bertschi's. Near-ideal reference.

**Tier 1 — high impact, strong fit**
- **Time-axis dispatch board** to replace/augment status-column TripsView. Our trips = their legs; drivers/
  vehicles = their fleet lanes. Lift the pure geometry core (`useBrick` math + collision + `useBoardBrickCalculus`)
  into Vue 3/Pinia. *Single biggest product upgrade available.*
- **Real WebSocket dispatch channel** (we currently poll; deferred). Viewport-scoped STOMP + `viaSocket`/`viaDrop`
  is a ready blueprint; we already run `ws` on the backend.
- **Pessimistic lock + optimistic freeze** for multi-dispatcher editing (we have none). Add
  `POST /trips/:id/lock|unlock`, `lockedBy`, and the `409` "locked by X" toast.

**Tier 2 — clear wins, moderate effort**
- **Occupancy / double-booking detection** (`useOccupancyBlock` block-merge is portable).
- **Fleet actions** (maintenance/breaks/reminders as non-trip bricks) — our model has no equivalent.
- **Validation-details protocol** on trip/assignment updates — `{info, warnings, errors}` not bare codes.
- **flexsearch board search** with spotted/focused highlight — richer than table filters.

**Tier 3 — strategic / enterprise**
- **SAML SSO / Keycloak** path (their BFF is a minimal reference impl).
- **Config profiles** — per-user saved viewport + sidebar ordering.
- **i18n (EN/DE)** — we're English-only.
- **Subcontractor entity** → maps to our **multi-tenant / partner-carrier** SaaS story.
- **Checklist model maturity** — customs/documents/temperature/equipment with pending→done coloring shows how
  far to take signs-proofs.

**Don't take:** Vue 2 components, composite-ID encoding, G11 bridge, subcontractor sub-boards, `admin`/`admin`
infra + plaintext-secret patterns.

---

## 7. Key file index (Bertschi repo)

- Board shell: `frontend/src/components/Board/Board.vue`
- Timeline/grid + drop: `frontend/src/components/Board/TimeLine/TimeLine.vue`, `.../TimeLineBoxes/TimeLineBoxes.vue`
- Geometry core: `frontend/src/store/brick/useBrick.ts`, `frontend/src/components/Board/Use/useBoardBrickCalculus.ts`
- Drag engine: `frontend/src/components/Board/Use/useBoardBrickDrag.ts`
- WebSocket: `frontend/src/components/Board/TimeLine/useWebSocket.ts`
- Occupancy: `frontend/src/store/board/useOccupancyBlock.ts`
- Search: `frontend/src/store/board/useSearchIndex.ts`, `frontend/src/components/SearchBox/SearchBox.vue`
- Axios/interceptors/locking-409: `frontend/src/config/axios.ts`
- Services (API contract): `frontend/src/services/{legService,fleetService,containerService}.ts`
- Types (domain): `frontend/src/types/{leg,fleet,board,action,configProfile,websocket}.ts`
- Stores: `frontend/src/store/{auth,board,fleet,brick}/index.ts`
- BFF/SAML: `backend/index.ts`, `backend/routes/routes.ts`, `backend/config/auth/*`
- Ops: `Docker.txt`, `k8s/truck-planning-app.yaml.tpl`, `bitbucket-pipelines.yml`, `guide/keycloak/realm-export.json`

---

## 8. Module Catalog — Round 2 (beyond the board engine)

Two follow-up surveys (2026-08-20) cataloged the *non-board* modules for adoption into our product
(Vue 3/Pinia portal + Express/Prisma backend + future Expo). Caveat for everything below: it's Vue 2 +
`@vue/composition-api` + Ant Design Vue **v1** (`a-*`, Vue-2-only) + `vue-multiselect` + Vuex string-const
dispatches — "port" always means rewrite, never copy-paste. Build these five shared deps first: **SplitScreen,
Icon, Button, Dialog, useToast**.

### Tier A — drop-in primitives (near-zero domain coupling)
- **SplitScreen** (`components/SplitScreen/SplitScreen.vue`) — slide-over master-detail panel (header/body/
  action-bar slots, Esc-close, body scroll-lock). The cleanest reusable primitive; backbone of every detail
  panel. → upgrades our detail drawer. **PORT-AS-IS-CONCEPT.**
- **SearchBox + SearchMatchOverlay** (`components/SearchBox/`) — input w/ `current/total` counter, next/prev,
  `f-f` focus, Esc clear + spotted/focused highlight overlay that scrolls into view. → our board search
  (INC-7); swap 2 dispatches. **PORT-AS-IS-CONCEPT.**
- **ContextMenu shell** (`components/Board/ContextMenu/ContextMenu.vue`) — viewport-edge-aware right-click menu
  (shell only; `TimelineContextOptions` is domain-bound → skip). → right-click brick actions. **PORT-AS-IS-CONCEPT.**
- **Services-layer pattern** (`services/*`) — typed `AxiosResponse<T>` thunks over one axios singleton +
  `baseSlug`. → standardize `api.ts`, shareable with Expo. **PORT-AS-IS.**
- **Pure-TS helpers** (`use/useArray,useObject,useNumbers,useTime (HH:mm coercion),useText (clipboard)`) →
  utils lib. **PORT-AS-IS.**
- **`types.ts`** — `IdEntity<T>`, `Location`, and the **`ErrorResponse`** contract (localized `{en,de}` msgs +
  severity). → share FE↔BE. **PORT-AS-IS.**
- **Raw SVG icon set** (`src/icons/*.svg`, 41 icons) — keep SVGs, drop `vue-svgicon` tooling.

### Tier B — port-with-rewrite (idea is gold, code is Vue2/Ant-v1/leg-domain)
- **Checklist widget** (`components/Board/Leg/LegDetail/LegDetailChecklist`) — grouped, per-item + check-all,
  status-per-category. → our signs-proofs / pre-trip checklist, parameterized. Strong fit.
- **`toastAxiosError`** (`use/useToast.ts`) — server `errorCode` → i18n key, per-detail localized messages by
  severity. → the `{info,warnings,errors}` protocol (plan INC-2); Bertschi is the mature version.
- **Controlled-form template** (`components/Board/Fleet/FleetAction/FleetForms/*`) — form emits
  `(formData,isValid)`, parent saves; cross-field date/time validation; thin picker wrappers. → trip/stop +
  fleet-action forms.
- **Linked hour-picker interval logic** (`components/Board/TimeSelector/`) + **locale-aware constrained range
  picker** (`components/Board/DateSelector/`) → board day-window controls.
- **NavSettings accordion-in-a-slideover** (`components/Nav/NavSettings/`) + config profiles → per-dispatcher
  settings / saved views (INC-7).
- **`useMouseScroll`** (`use/useMouseScroll.ts`) — auto-edge-scroll while dragging near the viewport edge → DnD
  polish for the real board.
- **Edit-mode + bulk-apply-status** (`components/Board/TransportInfoEditor/`) → bulk trip status ops.
- **`useDate`** timezone logic (drop redundant `moment`).

### Tier C — enterprise / platform
- **SAML→JWT-cookie BFF + Keycloak realm** (`backend/`, `frontend/guide/keycloak/`) — working enterprise-SSO
  reference flow; realm export reusable for local IdP. ⚠️ production-unsafe defaults (hardcoded session secret
  `"this is hits"`, JWT in a **non-httpOnly** cookie, wide-open CORS) — reuse flow, rewrite secure, consider
  OIDC over SAML.
- **i18n setup** (`i18n/`, EN/DE, browser-lang default, ant-locale bridge) — good pattern but vue-i18n **v8 →
  needs v9** for Vue 3.

### Skip (domain CRUD or dead tooling)
LegDetail / FleetDetail / SubcontractorDetail / TimelineContextOptions (Bertschi leg/fleet/G11 CRUD — mine only
the *lock-on-open* + *diff-gated-save* patterns); `useLeg`/`useFleet`/`useBrick`; Vue-2 plugins + `main.ts`
bootstrap (unconditional Mirage boot is a footgun); `vue-svgicon` compile step; `vue.config.js` (keep only the
brand tokens).
