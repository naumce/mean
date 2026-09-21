import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { confirmImport } from "../src/lib/brokerImport.js";
import { hashPassword } from "../src/lib/password.js";
import { BROKER_ROWS, brokerWorkbook } from "./fixtures/brokerBoard.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

async function orgDispatcher() {
  const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Los_Angeles" } });
  await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
  const { token } = await loginDispatcher("b@x.com", "pw");
  return { org, auth: { Authorization: `Bearer ${token}` } };
}

describe("boardLine and archived", () => {
  beforeEach(resetDb);

  it("stores the sheet line on import and serves the board in that order, re-import included", async () => {
    const { org, auth } = await orgDispatcher();
    await confirmImport(org.id, brokerWorkbook());
    const lines = (await prisma.load.findMany({ where: { orgId: org.id }, orderBy: { boardLine: "asc" } })).map((l) => l.boardLine);
    expect(lines).toEqual([3, 6, 9, 12, 15]);
    // Move the third load to the top of the sheet and re-import: the board follows the sheet.
    const rows = BROKER_ROWS.map((r) => [...r]);
    const third = rows.splice(8, 3);      // top, bottom, blank of load 0500003
    rows.splice(2, 0, ...third);
    await confirmImport(org.id, brokerWorkbook(rows));
    const b = await request(app).get("/api/dispatcher/broker-board").set(auth);
    expect(b.body.loads.map((l: { top: { bol: string } }) => l.top.bol)).toEqual(["0500003", "0500001", "0500002", "0500004", "0500005"]);
    expect(b.body.loads[0].boardLine).toBe(3);
    // Task 8: confirmImport now derives status from the fixture's UPDATE
    // text ("DELIVERED 07/16/2026" for this row) through the writer instead
    // of hardcoding "open" — task-8-brief.md's context note.
    expect(b.body.loads[0].status).toBe("delivered");
  });

  it("puts loads with no board line after the sheet's, in creation order", async () => {
    const { org, auth } = await orgDispatcher();
    await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, externalId: "F-1" } });
    await confirmImport(org.id, brokerWorkbook());
    const b = await request(app).get("/api/dispatcher/broker-board").set(auth);
    expect(b.body.loads.at(-1).top.loadNo === "" || b.body.loads.at(-1).boardLine === null).toBe(true);
    expect(b.body.loads.slice(0, 5).map((l: { boardLine: number }) => l.boardLine)).toEqual([3, 6, 9, 12, 15]);
  });

  it("hides archived loads unless asked", async () => {
    const { org, auth } = await orgDispatcher();
    await confirmImport(org.id, brokerWorkbook());
    const l = await prisma.load.findFirst({ where: { orgId: org.id, externalId: "145205" } });
    await prisma.load.update({ where: { id: l!.id }, data: { status: "archived" } });
    const hidden = await request(app).get("/api/dispatcher/broker-board").set(auth);
    expect(hidden.body.loads).toHaveLength(4);
    const shown = await request(app).get("/api/dispatcher/broker-board?archived=1").set(auth);
    expect(shown.body.loads).toHaveLength(5);
    expect(shown.body.loads.find((x: { id: string }) => x.id === l!.id).status).toBe("archived");
  });
});
