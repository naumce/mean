import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";

// Slice 2B needs three things the board could not store: the LOAD# a
// dispatcher typed (kept apart from the TMS identity in `externalId`), the
// cells their sheet has and our schema does not, and the board's own visual
// state — the fills and the unmerged lines that came off their file.
describe("broker board 2B schema", () => {
  beforeEach(resetDb);

  it("keeps the board's LOAD# apart from the TMS identity", async () => {
    const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Chicago" } });
    // The collision slice 1 papered over with a `board:` prefix: a TMS load
    // and a brokered row can carry the same number and mean different loads.
    const tms = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, externalId: "145205" } });
    const brokered = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME FOODS", boardLoadNo: "145205" },
    });
    expect(tms.boardLoadNo).toBeNull();
    expect(brokered.externalId).toBeNull();
    expect(brokered.boardLoadNo).toBe("145205");

    // One board row per number, per org — typing a number another row already
    // has is a mistake the dispatcher should hear about, not a silent merge.
    await expect(
      prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, boardLoadNo: "145205" } }),
    ).rejects.toThrow();
    // ...but another org's board is free to use it.
    const other = await prisma.org.create({ data: { name: "Other Broker", timezone: "America/Chicago" } });
    const elsewhere = await prisma.load.create({ data: { orgId: other.id, requiredEquip: "DryVan", revenueCents: 0, boardLoadNo: "145205" } });
    expect(elsewhere.boardLoadNo).toBe("145205");
  });

  it("stores the cells their sheet has and our columns do not", async () => {
    const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Chicago" } });
    const load = await prisma.load.create({
      data: {
        orgId: org.id, requiredEquip: "DryVan", revenueCents: 0,
        // Keyed by the sheet's own header text for an unmapped column, and by
        // `<key>:2` for a line-2 value whose column has no carrier-side field.
        extras: { "TRAILER TYPE": "REEFER", "shipDate:2": "07/16/2026" },
      },
    });
    expect((load.extras as Record<string, string>)["TRAILER TYPE"]).toBe("REEFER");
    const blank = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0 } });
    expect(blank.extras).toBeNull();
  });

  it("stores one board view per org: the fills and the unmerged lines", async () => {
    const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Chicago" } });
    const view = await prisma.boardView.create({
      data: {
        orgId: org.id,
        fills: { row: { "load-1": "#fff3b0" }, col: { rate: "#cfe3ff" }, cell: { "load-1|customer": "#ffe95c" } },
        merges: { "load-1": ["customer", "phone"] },
      },
    });
    expect((view.merges as Record<string, string[]>)["load-1"]).toEqual(["customer", "phone"]);
    // One view per org, and it goes when the org goes.
    await expect(prisma.boardView.create({ data: { orgId: org.id, fills: {}, merges: {} } })).rejects.toThrow();
    const fresh = await prisma.boardView.create({ data: { orgId: (await prisma.org.create({ data: { name: "B", timezone: "UTC" } })).id } });
    expect(fresh.fills).toEqual({});
    expect(fresh.merges).toEqual({});
  });
});
