# BE-5 — Realtime (WebSocket) Implementation Plan

> Extends `fleet-backend/`. Final backend increment. Same conventions; TDD; commits scoped to `fleet-backend/`.

**Goal:** a WebSocket server that authenticates drivers on connect and pushes the recovered event types, with emits wired into the dispatcher actions that already exist.

**Spec:** `decompiled/API-CONTRACT.md` (Realtime section) — event types: `trip_assignment`, `trip_unassignment`, `route_pre_assignment`, `route_confirmation`, `status_change`, `signs_proof_approved`, `signs_proof_rejected`, `general_notification`, `ping`/`pong`.

## Global Constraints
- Auth on connect: JWT access token via `?token=` query param; verify with the existing `verifyAccess`. Reject (close code 4401) if missing/invalid. Register the socket under its `driverId`.
- Keep it decoupled: a `src/realtime.ts` module owns the connection registry + `emitToDriver`; route handlers just call `emitToDriver(driverId, type, payload)`. No business logic in the socket layer.
- Don't break existing HTTP: the WS server attaches to the same `http.Server` in `src/server.ts`; `createApp()` stays unchanged so the existing 144 HTTP tests are untouched.

## Dependencies
`npm i ws && npm i -D @types/ws`

## `src/realtime.ts`
```ts
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { verifyAccess } from "./lib/tokens.js";

const registry = new Map<string, Set<WebSocket>>();

export function emitToDriver(driverId: string, type: string, payload: Record<string, unknown> = {}) {
  const sockets = registry.get(driverId);
  if (!sockets) return;
  const msg = JSON.stringify({ type, ...payload });
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(msg);
}

export function attachRealtime(server: Server) {
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", "http://x");
    const token = url.searchParams.get("token");
    let driverId: string;
    try { driverId = verifyAccess(token ?? "").driverId; }
    catch { ws.close(4401, "unauthorized"); return; }
    if (!driverId) { ws.close(4401, "unauthorized"); return; }
    let set = registry.get(driverId); if (!set) { set = new Set(); registry.set(driverId, set); }
    set.add(ws);
    ws.on("message", (raw) => {
      try { if (JSON.parse(raw.toString()).type === "ping") ws.send(JSON.stringify({ type: "pong" })); } catch {}
    });
    ws.on("close", () => { set!.delete(ws); if (set!.size === 0) registry.delete(driverId); });
  });
  return wss;
}
```

## Wire `src/server.ts` (only file that changes for attachment)
```ts
import http from "node:http";
import { createApp } from "./app.js";
import { attachRealtime } from "./realtime.js";
const server = http.createServer(createApp());
attachRealtime(server);
server.listen(Number(process.env.PORT ?? 3001));
```

## Emit points (add `emitToDriver(...)` calls into existing dispatcher handlers)
- assign trip (`dispatcherTrips`) → `emitToDriver(driverId, "trip_assignment", { tripId })` and, when it creates the RoutePreAssignment, `"route_pre_assignment"`.
- signs-proof approve/reject (`dispatcherApprovals`) → look up the proof's stop→trip→driverId, emit `"signs_proof_approved"` / `"signs_proof_rejected"` with `{ signsProofId }`.
- trip approve (`dispatcherApprovals`) → `"status_change"` with `{ tripId, status }`.
- notification create → `"general_notification"` with `{ notificationId }`.

## Tests (`tests/realtime.test.ts`)
Use the real `ws` client against a live server on an ephemeral port (WS can't go through Supertest):
```ts
import http from "node:http"; import WebSocket from "ws"; import { createApp } from "../src/app.js";
import { attachRealtime } from "../src/realtime.js"; import { signAccess } from "../src/lib/tokens.js";
// beforeEach: resetDb; start server = http.createServer(createApp()); attachRealtime(server); await listen(0); port = server.address().port
// afterEach: close all sockets + server
```
- **connect with a valid driver token** → socket opens; **invalid/missing token** → closes with code 4401.
- **ping → pong**: send `{type:"ping"}`, receive `{type:"pong"}`.
- **event delivery**: connect driver A's socket; via HTTP (a dispatcher agent hitting the same server) assign a trip to driver A; assert the socket receives a `trip_assignment` message for that `tripId`. Use a promise that resolves on the awaited message with a timeout.
- **isolation**: driver B's socket does NOT receive driver A's `trip_assignment`.

Add a small `tests/realtime-helpers.ts` (start/stop server, `nextMessage(ws)` promise) if it keeps the test readable.

## Done when
`npm test`/`npx vitest run` green (144 + new), `tsc --noEmit` clean, commits scoped to `fleet-backend/`. (`npm test` may segfault in this shell — use `npx vitest run`, which is stable here.)
