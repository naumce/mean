import type http from "node:http";
import request from "supertest";
import WebSocket from "ws";
import { app, resetDb, createDriver, createDispatcher } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signAccess, signDispatcherAccess } from "../src/lib/tokens.js";
import { startServer, stopServer, createMessageCollector, waitForOpen, waitForClose } from "./realtime-helpers.js";
import { __resetLocks } from "../src/lib/locks.js";
import { sweepDispatcherSockets } from "../src/realtime.js";

let server: http.Server;
let port: number;
let sockets: WebSocket[] = [];

beforeEach(async () => {
  await resetDb();
  __resetLocks();
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

// Cockpit S2a Task 9: releasing a disconnected dispatcher's lane locks.
// Asserted through the lock state itself (a real POST to acquire, then a
// real GET to read it back before and after the socket closes) rather than
// by spying on releaseAllFor — a spy would only prove the function was
// invoked, not that the lane is actually free for the next dispatcher.
async function acquireLock(dispatcherToken: string, laneId: string) {
  return fetch(`http://localhost:${port}/api/dispatcher/locks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${dispatcherToken}` },
    body: JSON.stringify({ laneId }),
  });
}

async function locksSnapshot(dispatcherToken: string) {
  const res = await fetch(`http://localhost:${port}/api/dispatcher/locks`, {
    headers: { authorization: `Bearer ${dispatcherToken}` },
  });
  return (await res.json()) as { locks: { laneId: string; dispatcherId: string }[] };
}

it("releases a dispatcher's lane lock when their socket disconnects", async () => {
  const dispatcher = await createDispatcher({ email: "rt-lock-disp@fleet.com" });
  const lane = await createDriver({ email: "rt-lock-lane@fleet.com" });
  const token = signDispatcherAccess(dispatcher.id);

  const ws = connect(token);
  await waitForOpen(ws);

  const lockRes = await acquireLock(token, lane.id);
  expect(lockRes.status).toBe(200);

  const before = await locksSnapshot(token);
  expect(before.locks.some((l) => l.laneId === lane.id)).toBe(true);

  ws.close();
  await waitForClose(ws);
  // The server's own "close" handler runs after the client sees the close
  // frame; give the event loop one tick to let it call releaseAllFor.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const after = await locksSnapshot(token);
  expect(after.locks.some((l) => l.laneId === lane.id)).toBe(false);
});

it("does not release a DIFFERENT dispatcher's lane lock when an unrelated socket disconnects", async () => {
  const holder = await createDispatcher({ email: "rt-lock-holder@fleet.com" });
  const bystander = await createDispatcher({ email: "rt-lock-bystander@fleet.com" });
  const lane = await createDriver({ email: "rt-lock-lane2@fleet.com" });
  const holderToken = signDispatcherAccess(holder.id);
  const bystanderToken = signDispatcherAccess(bystander.id);

  const holderWs = connect(holderToken);
  const bystanderWs = connect(bystanderToken);
  await Promise.all([waitForOpen(holderWs), waitForOpen(bystanderWs)]);

  expect((await acquireLock(holderToken, lane.id)).status).toBe(200);

  bystanderWs.close();
  await waitForClose(bystanderWs);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const after = await locksSnapshot(holderToken);
  expect(after.locks.some((l) => l.laneId === lane.id && l.dispatcherId === holder.id)).toBe(true);
});

it("releases a dispatcher's load locks when their socket disconnects, and tells the org", async () => {
  const org = await prisma.org.create({ data: { name: "RT Broker", timezone: "UTC" } });
  const dispatcher = await prisma.dispatcher.create({ data: { email: "rt-loadlock@fleet.com", passwordHash: "x", name: "Maria", orgId: org.id } });
  const watcher = await prisma.dispatcher.create({ data: { email: "rt-loadlock-watch@fleet.com", passwordHash: "x", name: "Jake", orgId: org.id } });
  const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME" } });
  const token = signDispatcherAccess(dispatcher.id);
  const ws = connect(token);
  const watcherWs = connect(signDispatcherAccess(watcher.id));
  await Promise.all([waitForOpen(ws), waitForOpen(watcherWs)]);
  const frames: Array<{ type: string; loadId?: string }> = [];
  watcherWs.on("message", (d) => frames.push(JSON.parse(String(d))));

  expect((await request(app).post(`/api/dispatcher/loads/${load.id}/lock`).set({ Authorization: `Bearer ${token}` })).status).toBe(200);
  expect(await prisma.loadLock.count({ where: { loadId: load.id } })).toBe(1);

  ws.close();
  await waitForClose(ws);
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(await prisma.loadLock.count({ where: { loadId: load.id } })).toBe(0);
  expect(frames.some((f) => f.type === "load_lock" && f.loadId === load.id)).toBe(true);
  expect(frames.some((f) => f.type === "load_unlock" && f.loadId === load.id)).toBe(true);
  watcherWs.close();
});

// --- R7: two tabs, one dispatcher --------------------------------------
//
// The close handler used to release every lock the dispatcher held, whichever
// socket dropped. A dispatcher with the board open in two tabs closing one of
// them was still editing in the other, and their row went free under them.
async function orgWithLoad(prefix: string) {
  const org = await prisma.org.create({ data: { name: `${prefix} Broker`, timezone: "UTC" } });
  const dispatcher = await prisma.dispatcher.create({ data: { email: `${prefix}-holder@fleet.com`, passwordHash: "x", name: "Maria", orgId: org.id } });
  const watcher = await prisma.dispatcher.create({ data: { email: `${prefix}-watch@fleet.com`, passwordHash: "x", name: "Jake", orgId: org.id } });
  const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME" } });
  return { org, dispatcher, watcher, load, token: signDispatcherAccess(dispatcher.id) };
}

it("keeps a dispatcher's load lock when only ONE of their two tabs closes, and releases it when the last one does", async () => {
  const { watcher, load, token } = await orgWithLoad("rt-twotab");
  const tabA = connect(token);
  const tabB = connect(token);
  const watcherWs = connect(signDispatcherAccess(watcher.id));
  await Promise.all([waitForOpen(tabA), waitForOpen(tabB), waitForOpen(watcherWs)]);
  const frames: Array<{ type: string; loadId?: string }> = [];
  watcherWs.on("message", (d) => frames.push(JSON.parse(String(d))));

  expect((await request(app).post(`/api/dispatcher/loads/${load.id}/lock`).set({ Authorization: `Bearer ${token}` })).status).toBe(200);
  expect(await prisma.loadLock.count({ where: { loadId: load.id } })).toBe(1);

  tabA.close();
  await waitForClose(tabA);
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Still editing in the other tab: the row is theirs and nobody was told
  // otherwise.
  expect(await prisma.loadLock.count({ where: { loadId: load.id } })).toBe(1);
  expect(frames.some((f) => f.type === "load_unlock")).toBe(false);

  tabB.close();
  await waitForClose(tabB);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await prisma.loadLock.count({ where: { loadId: load.id } })).toBe(0);
  expect(frames.some((f) => f.type === "load_unlock" && f.loadId === load.id)).toBe(true);
  watcherWs.close();
});

// --- F2: the ws keepalive ----------------------------------------------
//
// A slept laptop's socket stays "open" to the server for as long as the OS
// keeps the TCP connection alive — the badge on the row it holds outlives
// the human by minutes. The sweep pings; a socket that has not answered
// since the previous ping is terminated, which runs the ordinary close path.
it("terminates a dispatcher socket that stops answering pings, and frees its load lock", async () => {
  const { load, token } = await orgWithLoad("rt-keepalive");
  // A client that never answers a ping: `autoPong: false` is the library's
  // own switch for exactly this, and it is what a slept laptop looks like to
  // the server — a socket still "open", silent to every ping.
  const ws = new WebSocket(`ws://localhost:${port}/ws?token=${encodeURIComponent(token)}`, { autoPong: false });
  sockets.push(ws);
  await waitForOpen(ws);

  expect((await request(app).post(`/api/dispatcher/loads/${load.id}/lock`).set({ Authorization: `Bearer ${token}` })).status).toBe(200);
  expect(await prisma.loadLock.count({ where: { loadId: load.id } })).toBe(1);

  // First sweep: marks it unanswered and pings. Second: no pong arrived, so
  // the socket is terminated.
  sweepDispatcherSockets();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await prisma.loadLock.count({ where: { loadId: load.id } })).toBe(1);
  sweepDispatcherSockets();
  await waitForClose(ws);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await prisma.loadLock.count({ where: { loadId: load.id } })).toBe(0);
});

// F11: a cell rewritten with the value it already holds is not a change, and
// a `load_changed` for it makes every other board redraw a row that did not
// move. The paste has always applied this rule; the single-cell route did not.
it("does not announce load_changed for a cell write that changed nothing", async () => {
  const { org, watcher, load, token } = await orgWithLoad("rt-nochange");
  const watcherWs = connect(signDispatcherAccess(watcher.id));
  await waitForOpen(watcherWs);
  const frames: Array<{ type: string; loadId?: string }> = [];
  watcherWs.on("message", (d) => frames.push(JSON.parse(String(d))));
  const cell = (value: string, baseVersion: number) =>
    request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`)
      .set({ Authorization: `Bearer ${token}` }).send({ row: "top", key: "customer", value, baseVersion });

  expect((await cell("BETA CORP", 0)).status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(frames.filter((f) => f.type === "load_changed" && f.loadId === load.id)).toHaveLength(1);

  // The same value again: the record did not move, so nothing is announced.
  const same = await cell("BETA CORP", 1);
  expect(same.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(frames.filter((f) => f.type === "load_changed" && f.loadId === load.id)).toHaveLength(1);
  expect(await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).toMatchObject({ orgId: org.id, customerName: "BETA CORP" });
  watcherWs.close();
});

// Task 3 coverage gap (A6): the heartbeat is the SAME call as the acquire,
// and only a genuinely fresh hold is announced. A frame per heartbeat would
// have every other board redrawing a badge it already shows, every 20 s.
it("does not re-announce load_lock when the holder heartbeats", async () => {
  const { watcher, load, token } = await orgWithLoad("rt-heartbeat");
  const ws = connect(token);
  const watcherWs = connect(signDispatcherAccess(watcher.id));
  await Promise.all([waitForOpen(ws), waitForOpen(watcherWs)]);
  const frames: Array<{ type: string; loadId?: string }> = [];
  watcherWs.on("message", (d) => frames.push(JSON.parse(String(d))));

  expect((await request(app).post(`/api/dispatcher/loads/${load.id}/lock`).set({ Authorization: `Bearer ${token}` })).status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(frames.filter((f) => f.type === "load_lock" && f.loadId === load.id)).toHaveLength(1);

  expect((await request(app).post(`/api/dispatcher/loads/${load.id}/lock/heartbeat`).set({ Authorization: `Bearer ${token}` })).status).toBe(200);
  expect((await request(app).post(`/api/dispatcher/loads/${load.id}/lock`).set({ Authorization: `Bearer ${token}` })).status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Still exactly the one frame the first, genuinely fresh hold sent.
  expect(frames.filter((f) => f.type === "load_lock" && f.loadId === load.id)).toHaveLength(1);
  ws.close();
  watcherWs.close();
});
