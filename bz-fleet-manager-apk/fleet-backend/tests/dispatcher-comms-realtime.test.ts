import type http from "node:http";
import WebSocket from "ws";
import { resetDb, createDriver, createDispatcher } from "./helpers.js";
import { signAccess, signDispatcherAccess } from "../src/lib/tokens.js";
import { startServer, stopServer, createMessageCollector, waitForOpen } from "./realtime-helpers.js";

let server: http.Server;
let port: number;
let sockets: WebSocket[] = [];

beforeEach(async () => {
  await resetDb();
  const started = await startServer();
  server = started.server;
  port = started.port;
  sockets = [];
});

afterEach(async () => {
  await stopServer(server, sockets);
});

function connect(token: string) {
  const ws = new WebSocket(`ws://localhost:${port}/ws?token=${encodeURIComponent(token)}`);
  sockets.push(ws);
  return ws;
}

it("delivers general_notification to the driver's socket when a dispatcher notifies them", async () => {
  const driver = await createDriver({ email: "rt-notify@fleet.com" });
  const dispatcher = await createDispatcher({ email: "rt-notify-disp@fleet.com" });
  const ws = connect(signAccess(driver.id));
  await waitForOpen(ws);
  const messages = createMessageCollector(ws);

  const notifyRes = await fetch(`http://localhost:${port}/api/dispatcher/drivers/${driver.id}/notify`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${signDispatcherAccess(dispatcher.id)}` },
    body: JSON.stringify({ type: "custom", title: "Heads up" }),
  });
  expect(notifyRes.status).toBe(200);
  const notification = (await notifyRes.json()) as { id: string };

  const msg = await messages.next();
  expect(msg).toEqual({ type: "general_notification", notificationId: notification.id });
});

it("delivers general_notification to the driver's socket when a dispatcher sends a message", async () => {
  const driver = await createDriver({ email: "rt-msg@fleet.com" });
  const dispatcher = await createDispatcher({ email: "rt-msg-disp@fleet.com" });
  const ws = connect(signAccess(driver.id));
  await waitForOpen(ws);
  const messages = createMessageCollector(ws);

  const convRes = await fetch(`http://localhost:${port}/api/dispatcher/drivers/${driver.id}/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${signDispatcherAccess(dispatcher.id)}` },
    body: JSON.stringify({}),
  });
  const conversation = (await convRes.json()) as { id: string };

  const sendRes = await fetch(`http://localhost:${port}/api/dispatcher/conversations/${conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${signDispatcherAccess(dispatcher.id)}` },
    body: JSON.stringify({ text: "hello from dispatch" }),
  });
  expect(sendRes.status).toBe(200);

  const msg = await messages.next();
  expect(msg).toEqual({ type: "general_notification", conversationId: conversation.id });
});
