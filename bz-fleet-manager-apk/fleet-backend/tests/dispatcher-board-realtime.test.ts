import WebSocket from "ws";
import { resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { createMessageCollector, startServer, stopServer, waitForOpen } from "./realtime-helpers.js";

// The dispatcher board channel: a commit fans load_changed out to the org's
// dispatchers (and unscoped legacy ones) but never to another org. board_update
// retired from this route (A4 Task 9) — the commit really is a change to the
// Load record (it moves to "assigned"/"tendered"), so load_changed is what
// announces it now.
beforeEach(resetDb);

const KC = { lat: 39.0997, lng: -94.5786 };
const FAR = new Date("2027-01-01T00:00:00.000Z");

async function seedCommitScenario() {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const driver = await prisma.driver.create({
    data: {
      email: "drv@x.com", passwordHash: "x", name: "Jake", orgId: org.id,
      lastLat: KC.lat, lastLng: KC.lng,
      hos: { create: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 } },
    },
  });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "T1", status: "active" } });
  const trailer = await prisma.trailer.create({ data: { orgId: org.id, unit: "R1", type: "DryVan", status: "active" } });
  const load = await prisma.load.create({
    data: {
      orgId: org.id, externalId: "L-WS", requiredEquip: "DryVan", revenueCents: 30000, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "A", lat: KC.lat, lng: KC.lng, appointment: { create: { windowEnd: FAR } } },
          { sequence: 2, type: "delivery", address: "B", lat: 41.26, lng: -95.93, appointment: { create: { windowEnd: FAR } } },
        ],
      },
    },
  });
  return { org, driver, tractor, trailer, load };
}

it("a commit pushes load_changed to same-org dispatchers, not to other orgs", async () => {
  const { org, driver, tractor, trailer, load } = await seedCommitScenario();
  const otherOrg = await prisma.org.create({ data: { name: "Other" } });

  const actor = await prisma.dispatcher.create({ data: { email: "a@x.com", passwordHash: "x", name: "A", orgId: org.id } });
  const sameOrg = await prisma.dispatcher.create({ data: { email: "s@x.com", passwordHash: "x", name: "S", orgId: org.id } });
  const foreign = await prisma.dispatcher.create({ data: { email: "f@x.com", passwordHash: "x", name: "F", orgId: otherOrg.id } });

  const { server, port } = await startServer();
  const wsSame = new WebSocket(`ws://localhost:${port}/ws?token=${signDispatcherAccess(sameOrg.id)}`);
  const wsForeign = new WebSocket(`ws://localhost:${port}/ws?token=${signDispatcherAccess(foreign.id)}`);
  await Promise.all([waitForOpen(wsSame), waitForOpen(wsForeign)]);
  const sameMsgs = createMessageCollector(wsSame);
  const foreignMsgs = createMessageCollector(wsForeign);

  try {
    const res = await fetch(`http://localhost:${port}/api/dispatcher/assignments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${signDispatcherAccess(actor.id)}` },
      body: JSON.stringify({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id }),
    });
    expect(res.status).toBe(201);

    const frame = await sameMsgs.next();
    expect(frame.type).toBe("load_changed");
    expect(frame.loadId).toBe(load.id);
    const fresh = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(frame.version).toBe(fresh.version);

    // The foreign dispatcher must stay silent.
    await expect(foreignMsgs.next(400)).rejects.toThrow(/timed out/);
  } finally {
    await stopServer(server, [wsSame, wsForeign]);
  }
});
