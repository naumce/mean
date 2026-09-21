# Portal-4 — Messaging + Live Tracking Implementation Plan (FINAL)

> Extends `fleet-portal/`. Final increment — completes the portal. Reuse the component kit + established patterns. TDD for stores + a component test per view; build+typecheck gate. Modal specs clear `document.body.innerHTML` in `afterEach`; RouterLink in specs uses `RouterLinkStub`.

**Goal:** dispatcher messaging (conversations, thread, send) and a live driver-location tracking board (polling), activating the last two sidebar links and finishing the portal.

## Backend endpoints (already built, dispatcher Bearer)
- `GET /dispatcher/conversations` → `[{id, driverId, driverName, lastMessage, unread}]` — **NOTE `lastMessage` is the full message row (object), use `lastMessage?.text`, may be null.**
- `GET /dispatcher/conversations/:id/messages` → thread (ordered) `[{id, senderType, text, createdAt, ...}]`
- `POST /dispatcher/conversations/:id/messages` `{text}` → new dispatcher message
- `POST /dispatcher/drivers/:id/conversations` `{tripId?}` → get-or-create conversation
- `GET /dispatcher/locations` → latest location per driver `[{driverId, driverName?, latitude, longitude, speed?, createdAt}]`

> Realtime note: the WebSocket is driver-token-only (dispatcher tokens can't open a driver socket), so the portal uses **polling** for live updates here — not the WS. That's expected; a dispatcher WS channel is a future backend increment.

## Stores (`src/stores/`)
- `messages.ts` — `useMessagesStore`: `listConversations()`, `openThread(conversationId)` (loads `currentThread`), `send(conversationId, text)` (posts, then refreshes the thread); state `conversations`, `currentThread`, `currentId`, `loading`, `error`.
- `tracking.ts` — `useTrackingStore`: `listLocations()`; a `startPolling(intervalMs=8000)` that calls `listLocations` on an interval and `stopPolling()` (store the timer id; use `window.setInterval`). Keep the interval logic thin so it's testable with fake timers.

## Views + routing
- `src/views/MessagesView.vue` — two-pane: left = conversations list (driver name, `lastMessage?.text` preview, unread badge); right = the selected thread (bubbles aligned by `senderType` — dispatcher right/primary, driver left/gray) + a composer (`FormField` textarea + `AppButton` Send) calling `send`. Selecting a conversation calls `openThread`.
- `src/views/TrackingView.vue` — a live board: `DataTable` of drivers with latest coords + "updated Ns ago", refreshed by `startPolling` on mount / `stopPolling` on unmount. A small header showing active-driver count. (Optional, only if clean: a Leaflet map via the `leaflet` npm package with OSM tiles — but the polling table is the required deliverable; skip the map if it risks the build.)
- `src/router/index.ts` — add `/messages` (name `messages`) and `/tracking` (name `tracking`); activate the final two sidebar links (Messages + a new Tracking link).

## Tests (Vitest + jsdom + @vue/test-utils)
- `stores/messages.spec.ts`: mock api — `listConversations` populates; `openThread` sets `currentThread`; `send` posts `{text}` then reloads the thread; error path.
- `stores/tracking.spec.ts`: `listLocations` populates; with `vi.useFakeTimers()`, `startPolling` calls `listLocations` repeatedly and `stopPolling` halts it.
- `views/MessagesView.spec.ts`: renders conversations (incl. a null `lastMessage` without crashing); selecting one loads the thread; typing + Send calls `send`.
- `views/TrackingView.spec.ts`: renders location rows from a mocked store; unmount calls `stopPolling`.

## Done when
`npx vitest run` green (Portal-3's 78 + new), `npx vue-tsc --noEmit` 0 errors, `npm run build` succeeds, commits scoped to `fleet-portal/`. This finishes the portal.
