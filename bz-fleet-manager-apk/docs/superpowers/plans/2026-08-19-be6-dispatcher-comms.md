# BE-6 — Dispatcher Comms Implementation Plan

> Small backend increment on `fleet-backend/`. Adds the dispatcher-side messaging + notify endpoints the portal's final screen needs, and closes the BE-5 gap (the `general_notification` emit had no trigger). Same patterns; TDD; `npx vitest run` (not `npm test`); commits scoped to `fleet-backend/`.

**Goal:** dispatchers can list conversations, read a thread, send messages to drivers, and push a notification to a driver — with the driver notified over the existing WebSocket.

## Context (already built)
- `requireDispatcher` middleware; `emitToDriver(driverId, type, payload)` in `src/realtime.ts`.
- Models `Conversation { id, driverId, tripId? }`, `Message { id, conversationId, senderType, text, attachmentUrl?, readAt? }`, `Notification { id, driverId, type, title?, body?, readAt? }` (BE-3).
- Driver-side reads these already; this adds the dispatcher side + notify.

## Endpoints (`src/routes/dispatcherComms.ts`, mounted under `/api/dispatcher`, `requireAuth`+`requireDispatcher`)
| GET `/dispatcher/conversations` | list all conversations w/ `{id, driverId, driverName, lastMessage, unread}` (unread = messages from driver with `readAt=null`) |
| GET `/dispatcher/conversations/:id/messages` | the thread (ordered) |
| POST `/dispatcher/conversations/:id/messages` `{text}` | create `Message{senderType:"dispatcher"}`; emit `general_notification` to the conversation's driver `{conversationId}` |
| POST `/dispatcher/drivers/:id/conversations` `{tripId?}` | get-or-create a conversation for that driver |
| POST `/dispatcher/drivers/:id/notify` `{type, title?, body?}` | create `Notification`; `emitToDriver(driverId, "general_notification", {notificationId})` — **this closes the BE-5 gap** |

Ownership note: dispatcher role is fleet-wide, so these are not driver-scoped — but validate the target driver/conversation exists (404 otherwise).

## Tests (`tests/dispatcher-comms.test.ts`)
- driver token on any of these → 403; no token → 401.
- get-or-create conversation returns the same id on a second call.
- dispatcher sends a message → `senderType:"dispatcher"`, and it appears in the **driver's** thread via the existing `GET /driver/messages?conversation=`.
- conversations list shows unread count from driver-sent unread messages.
- notify creates a Notification that the driver sees via `GET /driver/notifications`.
- **realtime**: reuse the `tests/realtime-helpers.ts` live-server pattern — connect the driver's socket, POST `/dispatcher/drivers/:id/notify`, assert a `general_notification` message arrives (and that the message-send also emits one).

## Done when
`npx vitest run` green (151 + new), `npx tsc --noEmit` clean, commits scoped to `fleet-backend/`.
