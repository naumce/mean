import request from "supertest";
import * as XLSX from "xlsx";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { confirmImport } from "../src/lib/brokerImport.js";
import { renderBoardRows } from "../src/lib/brokerExport.js";
import { hashPassword } from "../src/lib/password.js";
import { readWorkbook } from "../src/lib/brokerSheet.js";
import { BROKER_ROWS, THEIR_HEADER, brokerWorkbook } from "./fixtures/brokerBoard.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

async function setup() {
  const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Los_Angeles" } });
  await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
  const { token } = await loginDispatcher("b@x.com", "pw");
  await confirmImport(org.id, brokerWorkbook());
  return { org, auth: { Authorization: `Bearer ${token}` } };
}

describe("renderBoardRows", () => {
  it("renders the header, two rows per load, a blank row between, no agent column", () => {
    const layout = [{ key: "bol", label: "BOL#" }, { key: "customer", label: "CUSTOMER /CARRIER" }, { key: "agent", label: "AGENT" }] as const;
    const loads = [
      { id: "a", line: 1, top: { bol: "1", customer: "ACME" }, bottom: { customer: "CARRIER" }, pill: { state: "none" as const, text: null }, agentLine: null, status: "open", boardLine: 3 },
      { id: "b", line: 2, top: { bol: "2", customer: "ACME" }, bottom: null, pill: { state: "none" as const, text: null }, agentLine: null, status: "open", boardLine: 6 },
    ];
    expect(renderBoardRows([...layout], loads)).toEqual([
      ["BOL#", "CUSTOMER /CARRIER"],
      ["1", "ACME"], ["", "CARRIER"], ["", ""],
      ["2", "ACME"], ["", ""],
    ]);
  });
});

describe("POST /broker-board/export", () => {
  beforeEach(resetDb);

  it("round-trips: what was imported comes back cell for cell in their layout", async () => {
    const { auth } = await setup();
    const r = await request(app).post("/api/dispatcher/broker-board/export").set(auth).send({}).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/spreadsheetml/);
    expect(r.headers["content-disposition"]).toMatch(/board-\d{4}-\d{2}-\d{2}\.xlsx/);
    const wb = readWorkbook(r.body as Buffer);
    expect(wb.header).toEqual(THEIR_HEADER);
    const exported = wb.rows.map((x) => x.cells);
    const original = BROKER_ROWS.slice(2);            // after the title and header rows
    // Load 1: the customer row and the carrier row match the fixture cell for cell.
    expect(exported[0]).toEqual(original[0]);
    expect(exported[1]).toEqual(original[1]);
    // The unassigned load's customer row round-trips cell for cell too — including the sheet's "MC" label.
    expect(exported[exported.findIndex((row) => row[0] === "0500005")]).toEqual(BROKER_ROWS.find((row) => row[0] === "0500005"));
    // The unassigned load exports as one row followed by a blank.
    const last = exported.findIndex((row) => row[0] === "0500005");
    expect(exported[last + 1].every((c) => c === "")).toBe(true);
  });

  it("exports only the selected ids, in board order, and refuses a foreign id", async () => {
    const { org, auth } = await setup();
    const loads = await prisma.load.findMany({ where: { orgId: org.id }, orderBy: { boardLine: "asc" } });
    const r = await request(app).post("/api/dispatcher/broker-board/export").set(auth).send({ ids: [loads[3].id, loads[0].id] }).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
    const wb = readWorkbook(r.body as Buffer);
    expect(wb.rows.filter((x) => x.cells[0] !== "").map((x) => x.cells[0])).toEqual(["0500001", "0500004"]);
    const other = await prisma.org.create({ data: { name: "Other", timezone: "America/Chicago" } });
    const foreign = await prisma.load.create({ data: { orgId: other.id, requiredEquip: "DryVan", revenueCents: 0 } });
    expect((await request(app).post("/api/dispatcher/broker-board/export").set(auth).send({ ids: [foreign.id] })).status).toBe(404);
  });
});
