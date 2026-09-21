import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { __resetLocks } from "../src/lib/locks.js";
import { createMessageCollector, startServer, stopServer, waitForOpen } from "./realtime-helpers.js";
import WebSocket from "ws";

// Cockpit S2a Task 10: the write side of the "yard hook" — PATCH
// /api/dispatcher/drivers/:id/pairing sets/clears a driver's default
// tractor/trailer. S1 added the columns and the loadboard reads them
// (dispatcherLoadboard.ts); nothing wrote them until this route.
beforeEach(async () => {
  await resetDb();
  __resetLocks();
});

async function scopedDispatcher(orgId: string, name: string) {
  const disp = await prisma.dispatcher.create({
    data: { email: `${name.toLowerCase()}@x.com`, passwordHash: "x", name, orgId },
  });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

async function seedOrg(name: string) {
  const org = await prisma.org.create({ data: { name } });
  const driver = await prisma.driver.create({
    data: { email: `${name.toLowerCase()}-drv@x.com`, passwordHash: "x", name: `${name} Driver`, orgId: org.id },
  });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "1207" } });
  const trailer = await prisma.trailer.create({ data: { orgId: org.id, unit: "DV-1", type: "DryVan" } });
  const auth = await scopedDispatcher(org.id, `${name} Disp`);
  return { org, driver, tractor, trailer, auth };
}

it("PATCH {tractorId} sets defaultTractorId and leaves defaultTrailerId untouched", async () => {
  const { driver, tractor, trailer, auth } = await seedOrg("Acme");
  await prisma.driver.update({ where: { id: driver.id }, data: { defaultTrailerId: trailer.id } });

  const res = await request(app)
    .patch(`/api/dispatcher/drivers/${driver.id}/pairing`)
    .set("authorization", auth)
    .send({ tractorId: tractor.id });

  expect(res.status).toBe(200);
  expect(res.body.driver.defaultTractorId).toBe(tractor.id);
  expect(res.body.driver.defaultTrailerId).toBe(trailer.id);
  expect(res.body.driver).not.toHaveProperty("passwordHash");

  const row = await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
  expect(row.defaultTractorId).toBe(tractor.id);
  expect(row.defaultTrailerId).toBe(trailer.id);
});

it("PATCH {tractorId: null} explicitly unhooks the tractor", async () => {
  const { driver, tractor, auth } = await seedOrg("Acme");
  await prisma.driver.update({ where: { id: driver.id }, data: { defaultTractorId: tractor.id } });

  const res = await request(app)
    .patch(`/api/dispatcher/drivers/${driver.id}/pairing`)
    .set("authorization", auth)
    .send({ tractorId: null });

  expect(res.status).toBe(200);
  expect(res.body.driver.defaultTractorId).toBeNull();

  const row = await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
  expect(row.defaultTractorId).toBeNull();
});

it("PATCH {} — an empty body with nothing to do — is a 400, not a silent no-op", async () => {
  const { driver, auth } = await seedOrg("Acme");

  const res = await request(app)
    .patch(`/api/dispatcher/drivers/${driver.id}/pairing`)
    .set("authorization", auth)
    .send({});

  expect(res.status).toBe(400);
});

it("a tractor id from another org 404s and does not leak existence or write anything", async () => {
  const acme = await seedOrg("Acme");
  const rival = await seedOrg("Rival");

  const res = await request(app)
    .patch(`/api/dispatcher/drivers/${acme.driver.id}/pairing`)
    .set("authorization", acme.auth)
    .send({ tractorId: rival.tractor.id });

  expect(res.status).toBe(404);
  expect(res.body.error).toBe("Tractor not found");
  expect(res.body).not.toHaveProperty("orgId");

  const row = await prisma.driver.findUniqueOrThrow({ where: { id: acme.driver.id } });
  expect(row.defaultTractorId).toBeNull();
});

it("a trailer id from another org 404s and does not leak existence or write anything", async () => {
  const acme = await seedOrg("Acme");
  const rival = await seedOrg("Rival");

  const res = await request(app)
    .patch(`/api/dispatcher/drivers/${acme.driver.id}/pairing`)
    .set("authorization", acme.auth)
    .send({ trailerId: rival.trailer.id });

  expect(res.status).toBe(404);
  expect(res.body.error).toBe("Trailer not found");

  const row = await prisma.driver.findUniqueOrThrow({ where: { id: acme.driver.id } });
  expect(row.defaultTrailerId).toBeNull();
});

it("a lane locked by another dispatcher 409s ENTITY_ALREADY_LOCKED and writes nothing", async () => {
  const { org, driver, tractor, auth } = await seedOrg("Acme");
  const holder = await scopedDispatcher(org.id, "Holder");

  const lockRes = await request(app).post("/api/dispatcher/locks").set("authorization", holder).send({ laneId: driver.id });
  expect(lockRes.status).toBe(200);

  const res = await request(app)
    .patch(`/api/dispatcher/drivers/${driver.id}/pairing`)
    .set("authorization", auth)
    .send({ tractorId: tractor.id });

  expect(res.status).toBe(409);
  expect(res.body.error).toBe("ENTITY_ALREADY_LOCKED");
  expect(res.body.lock.laneId).toBe(driver.id);

  const row = await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
  expect(row.defaultTractorId).toBeNull();
});

it("the lock holder is never blocked from pairing their own lane", async () => {
  const { org, driver, tractor, auth } = await seedOrg("Acme");
  await request(app).post("/api/dispatcher/locks").set("authorization", auth).send({ laneId: driver.id });

  const res = await request(app)
    .patch(`/api/dispatcher/drivers/${driver.id}/pairing`)
    .set("authorization", auth)
    .send({ tractorId: tractor.id });

  expect(res.status).toBe(200);
  expect(res.body.driver.defaultTractorId).toBe(tractor.id);
});

it("hooking a tractor already paired to a DIFFERENT driver 409s naming that driver, and neither row changes", async () => {
  const { org, driver: driverA, tractor, auth } = await seedOrg("Acme");
  const driverB = await prisma.driver.create({
    data: { email: "b-drv@x.com", passwordHash: "x", name: "Beatrice", orgId: org.id, defaultTractorId: tractor.id },
  });

  const res = await request(app)
    .patch(`/api/dispatcher/drivers/${driverA.id}/pairing`)
    .set("authorization", auth)
    .send({ tractorId: tractor.id });

  expect(res.status).toBe(409);
  expect(res.body.error).toContain("Beatrice");

  expect((await prisma.driver.findUniqueOrThrow({ where: { id: driverA.id } })).defaultTractorId).toBeNull();
  expect((await prisma.driver.findUniqueOrThrow({ where: { id: driverB.id } })).defaultTractorId).toBe(tractor.id);
});

it("hooking a trailer already paired to a DIFFERENT driver 409s naming that driver", async () => {
  const { org, driver: driverA, trailer, auth } = await seedOrg("Acme");
  await prisma.driver.create({
    data: { email: "c-drv@x.com", passwordHash: "x", name: "Cody", orgId: org.id, defaultTrailerId: trailer.id },
  });

  const res = await request(app)
    .patch(`/api/dispatcher/drivers/${driverA.id}/pairing`)
    .set("authorization", auth)
    .send({ trailerId: trailer.id });

  expect(res.status).toBe(409);
  expect(res.body.error).toContain("Cody");
});

it("re-pairing a driver with the unit they already hold is a no-op success, not a self-conflict", async () => {
  const { driver, tractor, auth } = await seedOrg("Acme");
  await prisma.driver.update({ where: { id: driver.id }, data: { defaultTractorId: tractor.id } });

  const res = await request(app)
    .patch(`/api/dispatcher/drivers/${driver.id}/pairing`)
    .set("authorization", auth)
    .send({ tractorId: tractor.id });

  expect(res.status).toBe(200);
  expect(res.body.driver.defaultTractorId).toBe(tractor.id);
});

it("emits board_update {loadId:null, driverId, paired:true} to same-org dispatchers", async () => {
  const { org, driver, tractor } = await seedOrg("Acme");
  const actor = await prisma.dispatcher.create({ data: { email: "actor@x.com", passwordHash: "x", name: "Actor", orgId: org.id } });
  const listener = await prisma.dispatcher.create({ data: { email: "listener@x.com", passwordHash: "x", name: "Listener", orgId: org.id } });

  const { server, port } = await startServer();
  const ws = new WebSocket(`ws://localhost:${port}/ws?token=${signDispatcherAccess(listener.id)}`);
  await waitForOpen(ws);
  const msgs = createMessageCollector(ws);

  try {
    const res = await fetch(`http://localhost:${port}/api/dispatcher/drivers/${driver.id}/pairing`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${signDispatcherAccess(actor.id)}` },
      body: JSON.stringify({ tractorId: tractor.id }),
    });
    expect(res.status).toBe(200);

    const frame = await msgs.next();
    expect(frame.type).toBe("board_update");
    expect(frame.loadId).toBeNull();
    expect(frame.driverId).toBe(driver.id);
    expect(frame.paired).toBe(true);
  } finally {
    await stopServer(server, [ws]);
  }
});

// --- Driver tenancy (S2a final review, I1) ---------------------------------
// The two tests above pin the TRACTOR and TRAILER org checks. The handler's
// FIRST guard — the one on the driver named in the URL — had none, and the
// whole suite stayed green without it. That guard is this route's tenancy
// boundary: without it org B writes org A's driver, and `{tractorId: null}`
// unhooks a truck from a driver whose org B cannot otherwise touch. It also
// reopens the F2 lane oracle, since the lock table is global by laneId and
// guardLane runs immediately after this check.
//
// Both tests assert the DATA before the status code, deliberately: a reverted
// guard must report "the write landed on another org's driver", not the
// weaker "expected 200 to be 404".

it("org B cannot pair org A's driver: the write does not land, and the id reads as 404", async () => {
  const acme = await seedOrg("Acme");
  const rival = await seedOrg("Rival");

  const res = await request(app)
    .patch(`/api/dispatcher/drivers/${acme.driver.id}/pairing`)
    .set("authorization", rival.auth)
    .send({ tractorId: rival.tractor.id });

  const row = await prisma.driver.findUniqueOrThrow({ where: { id: acme.driver.id } });
  expect(row.defaultTractorId).toBeNull();

  expect(res.status).toBe(404);
  expect(res.body.error).toBe("Driver not found");
});

it("org B cannot UNHOOK org A's driver's tractor with {tractorId: null}", async () => {
  const acme = await seedOrg("Acme");
  const rival = await seedOrg("Rival");
  await prisma.driver.update({
    where: { id: acme.driver.id },
    data: { defaultTractorId: acme.tractor.id },
  });

  const res = await request(app)
    .patch(`/api/dispatcher/drivers/${acme.driver.id}/pairing`)
    .set("authorization", rival.auth)
    .send({ tractorId: null });

  // An explicit null takes the early `data.defaultTractorId = null` branch and
  // never touches a Tractor row, so the tractor-side org check the suite
  // already had cannot see this at all — only the driver guard can.
  const row = await prisma.driver.findUniqueOrThrow({ where: { id: acme.driver.id } });
  expect(row.defaultTractorId).toBe(acme.tractor.id);

  expect(res.status).toBe(404);
});
