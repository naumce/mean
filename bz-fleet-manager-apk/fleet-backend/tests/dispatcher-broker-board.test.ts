import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { BROKER_ROWS, brokerWorkbook } from "./fixtures/brokerBoard.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

async function orgDispatcher() {
  const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Los_Angeles" } });
  await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
  const { token } = await loginDispatcher("b@x.com", "pw");
  return { org, auth: { Authorization: `Bearer ${token}` } };
}

describe("broker board routes", () => {
  beforeEach(resetDb);

  it("previews a workbook without writing anything", async () => {
    const { org, auth } = await orgDispatcher();
    const res = await request(app).post("/api/dispatcher/broker-board/import").set(auth).attach("file", brokerWorkbook(), "board.xlsx");
    expect(res.status).toBe(200);
    expect(res.body.preview.loads).toHaveLength(5);
    expect(res.body.preview.layout[0]).toEqual({ key: "bol", label: "BOL#" });
    expect(await prisma.load.count({ where: { orgId: org.id } })).toBe(0);
  });

  it("confirms, then serves the board in the org's layout with pills", async () => {
    const { auth } = await orgDispatcher();
    const c = await request(app).post("/api/dispatcher/broker-board/import/confirm").set(auth).attach("file", brokerWorkbook(), "board.xlsx");
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ created: 5, updated: 0, attention: 1 });
    const b = await request(app).get("/api/dispatcher/broker-board").set(auth);
    expect(b.status).toBe(200);
    expect(b.body.layout.map((x: { key: string }) => x.key)).toContain("agent");
    expect(b.body.loads).toHaveLength(5);
    const first = b.body.loads[0];
    expect(first.top).toMatchObject({ bol: "0500001", customer: "ACME FOODS", pickupCity: "Henderson, NV", rate: "$4,000.00", profit: "$400.00", loadNo: "2026-34566-00", shipDate: "7/13/2026", update: "DELIVERED 07/15/2026", appt: "PU: 07/13 - 13:00" });
    expect(first.top.phone).toMatch(/^https:/);
    expect(first.bottom).toMatchObject({ customer: "BLUE ROAD LLC", phone: "(555) 010-0104", contact: "Contact A", mc: "1000001", loadNo: "145205", appt: "DEL: 07/15 - 11:00" });
    expect(first.pill).toEqual({ state: "none", text: null });
    const unassigned = b.body.loads.find((l: { top: { loadNo: string } }) => l.top.loadNo === "2026-35100-00");
    expect(unassigned.bottom).toBeNull();
    expect(unassigned.top.mc).toBe("MC");   // brokered, no carrier yet — the sheet still prints MC here
    expect(first.top.mc).toBe("MC");
    expect(unassigned.pill.state).toBe("attention");
    expect(unassigned.pill.text).toMatch(/can't read PU appointment/);
  });

  it("refuses an oversized upload with 400, not a crash", async () => {
    const { auth } = await orgDispatcher();
    const big = Buffer.alloc(6 * 1024 * 1024);
    const res = await request(app).post("/api/dispatcher/broker-board/import").set(auth).attach("file", big, "big.xlsx");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/5 MB/);
  });

  it("refuses a file that is not a workbook, and a dispatcher without an org", async () => {
    const { auth } = await orgDispatcher();
    const bad = await request(app).post("/api/dispatcher/broker-board/import").set(auth).attach("file", Buffer.from("not a workbook"), "board.xlsx");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/header row|workbook/);
    await prisma.dispatcher.create({ data: { email: "noorg@x.com", passwordHash: await hashPassword("pw"), name: "N" } });
    const { token } = await loginDispatcher("noorg@x.com", "pw");
    const res = await request(app).get("/api/dispatcher/broker-board").set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(400);
  });

  it("does not leak another org's board", async () => {
    const { auth } = await orgDispatcher();
    await request(app).post("/api/dispatcher/broker-board/import/confirm").set(auth).attach("file", brokerWorkbook(), "board.xlsx");
    const other = await prisma.org.create({ data: { name: "Other", timezone: "America/Chicago" } });
    await prisma.dispatcher.create({ data: { email: "o@x.com", passwordHash: await hashPassword("pw"), name: "O", orgId: other.id } });
    await prisma.load.create({ data: { orgId: other.id, externalId: "B-1", bolNumber: "B-1", customerName: "OTHER CO", requiredEquip: "DryVan", revenueCents: 0 } });
    const { token } = await loginDispatcher("o@x.com", "pw");
    const res = await request(app).get("/api/dispatcher/broker-board").set({ Authorization: `Bearer ${token}` });
    expect(res.body.loads).toHaveLength(1);
    expect(res.body.loads[0].top.bol).toBe("B-1");
  });
});

// The fix wave for the final whole-slice review: I5, I6, I7, I8.
describe("what the board is allowed to show", () => {
  beforeEach(resetDb);

  it("keeps the sheet's row order, on the first import and on the next one", async () => {
    const { auth } = await orgDispatcher();
    await request(app).post("/api/dispatcher/broker-board/import/confirm").set(auth).attach("file", brokerWorkbook(), "board.xlsx");
    const first = await request(app).get("/api/dispatcher/broker-board").set(auth);
    expect(first.body.loads.map((l: { top: { bol: string } }) => l.top.bol)).toEqual(["0500001", "0500002", "0500003", "0500004", "0500005"]);
    await request(app).post("/api/dispatcher/broker-board/import/confirm").set(auth).attach("file", brokerWorkbook(), "board.xlsx");
    const again = await request(app).get("/api/dispatcher/broker-board").set(auth);
    expect(again.body.loads.map((l: { top: { bol: string } }) => l.top.bol)).toEqual(["0500001", "0500002", "0500003", "0500004", "0500005"]);
  });

  it("leaves RATE and PROFIT blank when it could not read the rate, instead of printing $0.00", async () => {
    const { auth } = await orgDispatcher();
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[2][8] = "";
    await request(app).post("/api/dispatcher/broker-board/import/confirm").set(auth).attach("file", brokerWorkbook(rows), "board.xlsx");
    const b = await request(app).get("/api/dispatcher/broker-board").set(auth);
    const l = b.body.loads.find((x: { top: { bol: string } }) => x.top.bol === "0500001");
    expect(l.top.rate).toBe("");
    expect(l.top.profit).toBe("");
    expect(l.top.soldRate).toBe("$3,600.00");
    expect(l.pill.text).toMatch(/can't read RATE/);
  });

  it("puts every refusal in the pill, not only the newest one", async () => {
    const { auth } = await orgDispatcher();
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[2][8] = "";                 // the RATE refusal is written first…
    rows[2][4] = "Nowhereville, ZZ"; // …and the geocode refusal after it
    await request(app).post("/api/dispatcher/broker-board/import/confirm").set(auth).attach("file", brokerWorkbook(rows), "board.xlsx");
    const b = await request(app).get("/api/dispatcher/broker-board").set(auth);
    const l = b.body.loads.find((x: { top: { bol: string } }) => x.top.bol === "0500001");
    expect(l.pill.state).toBe("attention");
    expect(l.pill.text).toMatch(/can't read RATE/);
    expect(l.pill.text).toMatch(/can't place pickup/);
    expect(l.pill.text).toContain(" · ");
  });

  it("renders a TMS fleet load as one plain row: no MC, no phantom carrier row", async () => {
    const { org, auth } = await orgDispatcher();
    await prisma.load.create({ data: { orgId: org.id, externalId: "TMS-99", requiredEquip: "DryVan", revenueCents: 66000, stops: { create: [{ sequence: 1, type: "pickup", address: "Kansas City, MO 64101" }] } } });
    const b = await request(app).get("/api/dispatcher/broker-board").set(auth);
    expect(b.body.loads).toHaveLength(1);
    expect(b.body.loads[0].bottom).toBeNull();
    expect(b.body.loads[0].top.mc).toBe("");
    expect(b.body.loads[0].top.loadNo).toBe("");
    expect(b.body.loads[0].top.customer).toBe("");
  });

  it("shows the sheet's LOAD# even when a fleet load already owns that number", async () => {
    const { org, auth } = await orgDispatcher();
    await prisma.load.create({ data: { orgId: org.id, externalId: "145205", requiredEquip: "Reefer", revenueCents: 999900, status: "in_progress" } });
    await request(app).post("/api/dispatcher/broker-board/import/confirm").set(auth).attach("file", brokerWorkbook(), "board.xlsx");
    const b = await request(app).get("/api/dispatcher/broker-board").set(auth);
    const brokered = b.body.loads.find((x: { top: { bol: string } }) => x.top.bol === "0500001");
    expect(brokered.bottom.loadNo).toBe("145205");
    expect(b.body.loads).toHaveLength(6);
  });
});

describe("record hints", () => {
  beforeEach(resetDb);

  it("marks an UPDATE cell whose word the record refused, and an APPT cell the Cockpit moved", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
    await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
    const { token } = await loginDispatcher("b@x.com", "pw");
    const auth = { Authorization: `Bearer ${token}` };
    const driver = await prisma.driver.create({ data: { email: "j@x.com", passwordHash: "x", name: "Jake", orgId: org.id } });
    const load = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME", status: "assigned", shipDate: new Date("2026-07-13T00:00:00Z"),
        updateText: "DELIVERED 07/17/2026", apptText: "PU: 07/14 - 12:00\nDEL: 07/17 - 10:00",
        stops: { create: [
          { sequence: 1, type: "pickup", address: "Kansas City, MO", appointment: { create: { windowEnd: new Date("2026-07-14T17:00:00Z"), type: "pickup", kind: "appointment" } } },
          { sequence: 2, type: "delivery", address: "Dallas, TX", appointment: { create: { windowEnd: new Date("2026-07-20T12:00:00Z"), type: "delivery", kind: "appointment" } } },
        ] } },
    });
    await prisma.assignment.create({ data: { orgId: org.id, loadId: load.id, driverId: driver.id, status: "dispatched", plannedStart: new Date(), plannedEnd: new Date() } });
    const res = await request(app).get("/api/dispatcher/broker-board").set(auth);
    const row = res.body.loads.find((l: { id: string }) => l.id === load.id);
    expect(row.record).toEqual({ update: "assigned", appt: "PU 07/14 12:00 · DEL 07/20 07:00" });
  });

  // B7: a one-line APPT cell says nothing about the other stop. Treating a
  // MISSING line as a disagreement gave the same one fact two signals — the
  // `can't read PU appointment` pill AND a `record.appt` dot.
  it("does not mark a single-line APPT cell that simply says nothing about the other stop", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
    await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
    const { token } = await loginDispatcher("b@x.com", "pw");
    const load = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME", status: "open", shipDate: new Date("2026-07-13T00:00:00Z"),
        apptText: "PU: 07/14 - 12:00",
        stops: { create: [
          { sequence: 1, type: "pickup", address: "Kansas City, MO", appointment: { create: { windowEnd: new Date("2026-07-14T17:00:00Z"), type: "pickup", kind: "appointment" } } },
          { sequence: 2, type: "delivery", address: "Dallas, TX", appointment: { create: { windowEnd: new Date("2026-07-20T12:00:00Z"), type: "delivery", kind: "appointment" } } },
        ] } },
    });
    const res = await request(app).get("/api/dispatcher/broker-board").set({ Authorization: `Bearer ${token}` });
    const row = res.body.loads.find((l: { id: string }) => l.id === load.id);
    expect(row.record?.appt).toBeUndefined();
  });

  it("carries no record hint when the cell and the record agree, or the text matches no rule", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
    await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
    const { token } = await loginDispatcher("b@x.com", "pw");
    const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME", status: "open", updateText: "waiting on POD" } });
    const res = await request(app).get("/api/dispatcher/broker-board").set({ Authorization: `Bearer ${token}` });
    const row = res.body.loads.find((l: { id: string }) => l.id === load.id);
    expect(row.record).toBeUndefined();
  });
});
