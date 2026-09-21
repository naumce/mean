import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";

// The board is a view over Load; these columns are what a brokered row needs
// that a fleet's load did not. AgentUpdate is the agent's line under UPDATE;
// BoardLayout is what makes the board "theirs".
describe("broker board schema", () => {
  beforeEach(resetDb);

  it("stores a brokered load, its carrier side, an agent line, and the org's layout", async () => {
    const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Chicago" } });
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC", mcNumber: "1000001" } });
    const load = await prisma.load.create({
      data: {
        orgId: org.id, externalId: "145205", orderRef: "2026-34566-00", requiredEquip: "DryVan", revenueCents: 400000,
        bolNumber: "0500001", customerName: "ACME FOODS", soldRateCents: 360000, trackingUrl: "https://example.com/share/abc",
        shipDate: new Date("2026-07-13T00:00:00Z"), updateText: "DELIVERED 07/15/2026", apptText: "PU: 07/13 - 13:00\nDEL: 07/15 - 11:00",
        carrierId: carrier.id, carrierPhone: "(555) 010-0104", carrierContactName: "Contact A",
        stops: { create: [
          { sequence: 1, type: "pickup", address: "Henderson, NV 89074", appointment: { create: { windowStart: new Date("2026-07-13T20:00:00Z"), windowEnd: new Date("2026-07-13T20:00:00Z"), type: "pickup", kind: "appointment" } } },
          { sequence: 2, type: "delivery", address: "Dallas, TX 75236", appointment: { create: { windowStart: new Date("2026-07-15T13:00:00Z"), windowEnd: new Date("2026-07-15T20:00:00Z"), type: "delivery", kind: "fcfs" } } },
        ] },
      },
      include: { stops: { include: { appointment: true } }, carrier: true },
    });
    expect(load.carrier?.mcNumber).toBe("1000001");
    expect(load.stops[1].appointment?.kind).toBe("fcfs");
    expect(load.driverCell).toBeNull();

    const line = await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(1_760_000_000_000), kind: "attention", text: "can't read DEL appointment" } });
    expect(Number(line.atMs)).toBe(1_760_000_000_000);

    const layout = await prisma.boardLayout.create({ data: { orgId: org.id, columns: [{ key: "bol", label: "BOL#" }] } });
    expect(layout.rowsPerLoad).toBe(2);
    await expect(prisma.boardLayout.create({ data: { orgId: org.id, columns: [] } })).rejects.toThrow();
  });

  it("deletes a load's agent lines with the load", async () => {
    const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Chicago" } });
    const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0 } });
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(1), kind: "status", text: "x" } });
    await prisma.load.delete({ where: { id: load.id } });
    expect(await prisma.agentUpdate.count()).toBe(0);
  });
});
