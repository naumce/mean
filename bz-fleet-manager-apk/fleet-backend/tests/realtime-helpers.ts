import http from "node:http";
import WebSocket from "ws";
import { createApp } from "../src/app.js";
import { attachRealtime } from "../src/realtime.js";

// WebSocket can't go through Supertest — these helpers spin up a real
// http.Server (with the realtime layer attached, same as src/server.ts)
// bound to an ephemeral port, so tests can drive it with a real `ws` client
// and, for the HTTP side of a test, plain fetch().
export async function startServer() {
  const server = http.createServer(createApp());
  attachRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port };
}

export function stopServer(server: http.Server, sockets: WebSocket[] = []) {
  return new Promise<void>((resolve) => {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
    }
    server.close(() => resolve());
  });
}

// A dispatcher action can emit more than one event back-to-back (e.g. assign
// -> trip_assignment then route_pre_assignment); both frames can arrive in
// the same synchronous flush, so a plain `ws.once("message")` per await can
// lose the second one if its listener isn't registered yet when it lands.
// This collector buffers every message from the moment it's created and
// hands them out FIFO, so ordering assertions are race-free regardless of
// when `next()` is called.
export function createMessageCollector(ws: WebSocket) {
  const queue: Record<string, unknown>[] = [];
  const waiters: ((msg: Record<string, unknown>) => void)[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  return {
    next(timeoutMs = 2000): Promise<Record<string, unknown>> {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
  };
}

export function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

export function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}
