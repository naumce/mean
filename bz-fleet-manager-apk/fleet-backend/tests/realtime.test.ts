import type http from "node:http";
import WebSocket from "ws";
import { resetDb, createDriver, createDispatcher } from "./helpers.js";
import { signAccess, signDispatcherAccess } from "../src/lib/tokens.js";
import { startServer, stopServer, createMessageCollector, waitForOpen, waitForClose } from "./realtime-helpers.js";

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
  const ws = new WebSocket(`ws://localhost:${port}/?token=${encodeURIComponent(token)}`);
  sockets.push(ws);
  return ws;
}

async function assignTrip(dispatcherId: string, driverId: string, identifier: string) {
  const createRes = await fetch(`http://localhost:${port}/api/dispatcher/trips`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${signDispatcherAccess(dispatcherId)}` },
    body: JSON.stringify({ identifier, stops: [{ sequence: 1, address: "A St" }] }),
  });
  const trip = (await createRes.json()) as { id: string };
  const assignRes = await fetch(`http://localhost:${port}/api/dispatcher/trips/${trip.id}/assign`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${signDispatcherAccess(dispatcherId)}` },
    body: JSON.stringify({ driverId }),
  });
  return { trip, assignRes };
}

it("accepts a connection authenticated with a valid driver access token", async () => {
  const driver = await createDriver({ email: "rt-valid@fleet.com" });
  const ws = connect(signAccess(driver.id));
  await waitForOpen(ws);
  expect(ws.readyState).toBe(WebSocket.OPEN);
});

it("closes with 4401 when no token is provided", async () => {
  const ws = connect("");
  const { code } = await waitForClose(ws);
  expect(code).toBe(4401);
});

it("closes with 4401 for an invalid/garbage token", async () => {
  const ws = connect("not-a-real-jwt");
  const { code } = await waitForClose(ws);
  expect(code).toBe(4401);
});

it("replies with pong to a ping message", async () => {
  const driver = await createDriver({ email: "rt-ping@fleet.com" });
  const ws = connect(signAccess(driver.id));
  await waitForOpen(ws);
  const messages = createMessageCollector(ws);
  ws.send(JSON.stringify({ type: "ping" }));
  const msg = await messages.next();
  expect(msg).toEqual({ type: "pong" });
});

it("delivers trip_assignment to the driver the dispatcher assigns a trip to", async () => {
  const driverA = await createDriver({ email: "rt-assign-a@fleet.com" });
  const dispatcher = await createDispatcher({ email: "rt-assign-disp@fleet.com" });
  const wsA = connect(signAccess(driverA.id));
  await waitForOpen(wsA);
  const messages = createMessageCollector(wsA);

  const { trip, assignRes } = await assignTrip(dispatcher.id, driverA.id, "TR-RT-ASSIGN-1");
  expect(assignRes.status).toBe(200);

  const msg = await messages.next();
  expect(msg).toEqual({ type: "trip_assignment", tripId: trip.id });
});

it("delivers route_pre_assignment after trip_assignment on the same assign call", async () => {
  const driverA = await createDriver({ email: "rt-preassign-a@fleet.com" });
  const dispatcher = await createDispatcher({ email: "rt-preassign-disp@fleet.com" });
  const wsA = connect(signAccess(driverA.id));
  await waitForOpen(wsA);
  const messages = createMessageCollector(wsA);

  const { trip } = await assignTrip(dispatcher.id, driverA.id, "TR-RT-ASSIGN-2");

  const first = await messages.next();
  const second = await messages.next();
  expect(first).toEqual({ type: "trip_assignment", tripId: trip.id });
  expect(second).toEqual({ type: "route_pre_assignment", tripId: trip.id });
});

it("does not deliver driver A's trip_assignment to driver B (isolation)", async () => {
  const driverA = await createDriver({ email: "rt-iso-a@fleet.com" });
  const driverB = await createDriver({ email: "rt-iso-b@fleet.com" });
  const dispatcher = await createDispatcher({ email: "rt-iso-disp@fleet.com" });
  const wsA = connect(signAccess(driverA.id));
  const wsB = connect(signAccess(driverB.id));
  await Promise.all([waitForOpen(wsA), waitForOpen(wsB)]);
  const messagesA = createMessageCollector(wsA);

  let bReceived = false;
  wsB.on("message", () => {
    bReceived = true;
  });

  await assignTrip(dispatcher.id, driverA.id, "TR-RT-ISO-1");
  await messagesA.next();

  expect(bReceived).toBe(false);
});
