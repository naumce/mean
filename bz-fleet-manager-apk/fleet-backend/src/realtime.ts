import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { verifyAccess } from "./lib/tokens.js";
import { prisma } from "./db.js";
import { releaseAllFor } from "./lib/locks.js";
import { releaseAllLoadLocksFor } from "./lib/loadLocks.js";

// Connection registry + push helper for the realtime layer. Kept decoupled
// from the HTTP routes on purpose: dispatcher handlers just call
// emitToDriver(driverId, type, payload) after they've already committed the
// change via Prisma — no business logic lives here, only delivery.
const registry = new Map<string, Set<WebSocket>>();

// Dispatcher channel: sockets tagged with the dispatcher's org so board
// updates fan out to the right tenant. orgId === null marks a legacy/dev
// (unscoped) dispatcher who receives every org's events — mirroring the
// HTTP orgScope semantics.
// R7: entries carry `dispatcherId` so a close can tell "this dispatcher is
// gone" from "this dispatcher closed one of two tabs". `isAlive` is the ws
// keepalive's own bookkeeping (see `sweepDispatcherSockets`).
interface DispatcherEntry { ws: WebSocket; orgId: string | null; dispatcherId: string; isAlive: boolean }
const dispatcherRegistry = new Set<DispatcherEntry>();

export function emitToDriver(driverId: string, type: string, payload: Record<string, unknown> = {}) {
  const sockets = registry.get(driverId);
  if (!sockets) return;
  const msg = JSON.stringify({ type, ...payload });
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(msg);
}

/** Push a board event to every dispatcher of `orgId` (and unscoped ones).
 *  A null orgId (legacy driver outside any org) reaches only unscoped
 *  dispatchers — never another tenant. */
export function emitToDispatchers(orgId: string | null, type: string, payload: Record<string, unknown> = {}) {
  const msg = JSON.stringify({ type, ...payload });
  for (const entry of dispatcherRegistry) {
    if (entry.orgId !== null && entry.orgId !== orgId) continue;
    if (entry.ws.readyState === entry.ws.OPEN) entry.ws.send(msg);
  }
}

/** Best-effort lock cleanup for a dispatcher whose socket dropped (closed
 *  tab, dead connection, crashed browser): the TTL alone would free the locks
 *  eventually, but the other dispatchers on this org's board shouldn't have
 *  to wait that long to see it.
 *
 *  R7: only when this was their LAST socket. A dispatcher with the board open
 *  in two tabs closing one of them is still editing in the other; the old
 *  unconditional release freed the row they had open, and their next
 *  heartbeat then re-took a lock a colleague could already have grabbed.
 *  The entry must already be removed from the registry before this is called. */
function releaseLocksIfLastSocket(entry: DispatcherEntry): void {
  for (const other of dispatcherRegistry) if (other.dispatcherId === entry.dispatcherId) return;
  // Emitted to the SAME org the disconnecting dispatcher was registered
  // under, matching how dispatcherLocks.ts's own DELETE announces a release.
  for (const laneId of releaseAllFor(entry.dispatcherId)) {
    emitToDispatchers(entry.orgId, "lane_unlock", { laneId });
  }
  // Load locks (spec §7.1): everything this dispatcher was editing is free
  // again, and their org hears it per load.
  void releaseAllLoadLocksFor(entry.dispatcherId)
    .then((rows) => { for (const { loadId, orgId } of rows) emitToDispatchers(orgId, "load_unlock", { loadId }); })
    .catch((e: unknown) => console.error("load lock release on close failed", e));
}

/** F2: how often the server pings every dispatcher socket. A socket that has
 *  not answered since the previous ping is terminated, which fires its own
 *  `close` and releases the dispatcher's locks — so a slept laptop or a
 *  silently-dropped TCP connection frees a badge within ~2 sweeps instead of
 *  leaving it until the row's TTL. Exported for the test to drive. */
export const WS_KEEPALIVE_MS = 30_000;

/** One sweep of the keepalive. Exported (rather than only running on a timer)
 *  so a test can drive it deterministically. */
export function sweepDispatcherSockets(): void {
  for (const entry of dispatcherRegistry) {
    if (!entry.isAlive) {
      // No pong since the last ping: the socket is gone whatever its
      // readyState claims. terminate() fires 'close', which is where the
      // registry entry and the locks are cleaned up.
      entry.ws.terminate();
      continue;
    }
    entry.isAlive = false;
    try { entry.ws.ping(); } catch { /* a socket that cannot be pinged is swept next round */ }
  }
}

// Attaches a WebSocketServer to an existing http.Server (never to the Express
// app itself) so createApp() — and the 144 HTTP tests that exercise it via
// Supertest without a listening server — stays untouched.
export function attachRealtime(server: Server) {
  // Dedicated /ws path (not server root) so a reverse proxy can route the
  // upgrade cleanly next to the static portal and /api.
  const wss = new WebSocketServer({ server, path: "/ws" });
  // F2: the keepalive. `unref()` so a sweep timer never holds the process (or
  // a test's server) open; cleared with the server itself.
  const keepalive = setInterval(sweepDispatcherSockets, WS_KEEPALIVE_MS);
  keepalive.unref?.();
  wss.on("close", () => clearInterval(keepalive));
  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url ?? "", "http://x");
    const token = url.searchParams.get("token");
    let driverId: string;
    try {
      const payload = verifyAccess(token ?? "");
      if (payload.role === "dispatcher") {
        // Dispatcher socket: resolve the tenant once, then register for
        // board pushes. Delivery only — no business logic.
        const dispatcher = await prisma.dispatcher.findUnique({
          where: { id: payload.dispatcherId },
          select: { orgId: true },
        });
        if (!dispatcher) {
          ws.close(4401, "unauthorized");
          return;
        }
        const entry: DispatcherEntry = { ws, orgId: dispatcher.orgId, dispatcherId: payload.dispatcherId, isAlive: true };
        dispatcherRegistry.add(entry);
        // The keepalive's other half: a socket that answers a ping is alive
        // until the next sweep (see sweepDispatcherSockets).
        ws.on("pong", () => { entry.isAlive = true; });
        ws.on("message", (raw) => {
          try {
            if (JSON.parse(raw.toString()).type === "ping") ws.send(JSON.stringify({ type: "pong" }));
          } catch {
            // ignore malformed frames, same policy as the driver channel
          }
        });
        ws.on("close", () => {
          dispatcherRegistry.delete(entry);
          releaseLocksIfLastSocket(entry);
        });
        return;
      }
      if (payload.role !== "driver") throw new Error("not a driver token");
      driverId = payload.driverId;
    } catch {
      ws.close(4401, "unauthorized");
      return;
    }
    if (!driverId) {
      ws.close(4401, "unauthorized");
      return;
    }
    let set = registry.get(driverId);
    if (!set) {
      set = new Set();
      registry.set(driverId, set);
    }
    set.add(ws);
    ws.on("message", (raw) => {
      try {
        if (JSON.parse(raw.toString()).type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      } catch {
        // ignore malformed inbound frames; the socket layer stays decoupled
        // from business logic and has nothing else to do with them.
      }
    });
    ws.on("close", () => {
      set!.delete(ws);
      if (set!.size === 0) registry.delete(driverId);
    });
  });
  return wss;
}
