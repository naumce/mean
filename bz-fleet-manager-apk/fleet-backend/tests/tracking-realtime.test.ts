import WebSocket from "ws";
import { resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signAccess, signDispatcherAccess } from "../src/lib/tokens.js";
import { createMessageCollector, startServer, stopServer, waitForOpen } from "./realtime-helpers.js";

// The tracking bridge: a driver's location ping / status change fans
// driver_location / driver_status out to the org's dispatchers — never to
// another tenant.
beforeEach(resetDb);

async function seed() {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const otherOrg = await prisma.org.create({ data: { name: "Other" } });
  const driver = await prisma.driver.create({
    data: { email: "drv@x.com", passwordHash: "x", name: "Jake", orgId: org.id },
  });
  const sameOrg = await prisma.dispatcher.create({
    data: { email: "s@x.com", passwordHash: "x", name: "S", orgId: org.id },
  });
  const foreign = await prisma.dispatcher.create({
    data: { email: "f@x.com", passwordHash: "x", name: "F", orgId: otherOrg.id },
  });
  return { org, driver, sameOrg, foreign };
}

it("a location ping pushes driver_location to same-org dispatchers only", async () => {
  const { driver, sameOrg, foreign } = await seed();
  const { server, port } = await startServer();
  const wsSame = new WebSocket(`ws://localhost:${port}/ws?token=${signDispatcherAccess(sameOrg.id)}`);
  const wsForeign = new WebSocket(`ws://localhost:${port}/ws?token=${signDispatcherAccess(foreign.id)}`);
  await Promise.all([waitForOpen(wsSame), waitForOpen(wsForeign)]);
  const sameMsgs = createMessageCollector(wsSame);
  const foreignMsgs = createMessageCollector(wsForeign);

  try {
    const res = await fetch(`http://localhost:${port}/api/driver/location`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${signAccess(driver.id)}` },
      body: JSON.stringify({ latitude: 39.0997, longitude: -94.5786 }),
    });
    expect(res.status).toBe(201);

    const frame = await sameMsgs.next();
    expect(frame.type).toBe("driver_location");
    expect(frame.driverId).toBe(driver.id);
    expect(frame.driverName).toBe("Jake");
    expect(frame.latitude).toBeCloseTo(39.0997);
    expect(typeof frame.at).toBe("string");

    await expect(foreignMsgs.next(400)).rejects.toThrow(/timed out/);
  } finally {
    await stopServer(server, [wsSame, wsForeign]);
  }
});

it("a status change pushes driver_status to same-org dispatchers only", async () => {
  const { driver, sameOrg, foreign } = await seed();
  const { server, port } = await startServer();
  const wsSame = new WebSocket(`ws://localhost:${port}/ws?token=${signDispatcherAccess(sameOrg.id)}`);
  const wsForeign = new WebSocket(`ws://localhost:${port}/ws?token=${signDispatcherAccess(foreign.id)}`);
  await Promise.all([waitForOpen(wsSame), waitForOpen(wsForeign)]);
  const sameMsgs = createMessageCollector(wsSame);
  const foreignMsgs = createMessageCollector(wsForeign);

  try {
    const res = await fetch(`http://localhost:${port}/api/driver/status`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${signAccess(driver.id)}` },
      body: JSON.stringify({ status: "on_duty" }),
    });
    expect(res.status).toBe(200);

    const frame = await sameMsgs.next();
    expect(frame.type).toBe("driver_status");
    expect(frame.driverId).toBe(driver.id);
    expect(frame.status).toBe("on_duty");

    await expect(foreignMsgs.next(400)).rejects.toThrow(/timed out/);
  } finally {
    await stopServer(server, [wsSame, wsForeign]);
  }
});
