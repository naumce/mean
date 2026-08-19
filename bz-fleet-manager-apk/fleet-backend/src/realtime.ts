import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { verifyAccess } from "./lib/tokens.js";

// Connection registry + push helper for the realtime layer. Kept decoupled
// from the HTTP routes on purpose: dispatcher handlers just call
// emitToDriver(driverId, type, payload) after they've already committed the
// change via Prisma — no business logic lives here, only delivery.
const registry = new Map<string, Set<WebSocket>>();

export function emitToDriver(driverId: string, type: string, payload: Record<string, unknown> = {}) {
  const sockets = registry.get(driverId);
  if (!sockets) return;
  const msg = JSON.stringify({ type, ...payload });
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(msg);
}

// Attaches a WebSocketServer to an existing http.Server (never to the Express
// app itself) so createApp() — and the 144 HTTP tests that exercise it via
// Supertest without a listening server — stays untouched.
export function attachRealtime(server: Server) {
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", "http://x");
    const token = url.searchParams.get("token");
    let driverId: string;
    try {
      const payload = verifyAccess(token ?? "");
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
