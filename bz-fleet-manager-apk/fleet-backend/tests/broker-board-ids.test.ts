import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { MAX_IDS, parseIdList } from "../src/lib/idList.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

// Plan A4, Task 2: `GET /broker-board?ids=` re-reads only the rows a client
// already knows moved, instead of the whole board.
async function orgDispatcher() {
  const org = await prisma.org.create({ data: { name: "Test Broker", timezone: "America/Los_Angeles" } });
  await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: await hashPassword("pw"), name: "B", orgId: org.id } });
  const { token } = await loginDispatcher("b@x.com", "pw");
  return { org, auth: { Authorization: `Bearer ${token}` } };
}

async function makeLoad(orgId: string, customerName: string, status = "open") {
  return prisma.load.create({ data: { orgId, customerName, requiredEquip: "DryVan", revenueCents: 0, status } });
}

async function threeLoads(orgId: string) {
  const a = await makeLoad(orgId, "A CO");
  const b = await makeLoad(orgId, "B CO");
  // Archived rows never come back from the default (unfiltered-archived)
  // board read, so asking for one by id is the "it left the board" case.
  const archived = await makeLoad(orgId, "ARCHIVED CO", "archived");
  return { a, b, archived };
}

describe("GET /broker-board?ids=", () => {
  beforeEach(resetDb);

  it("returns only the rows asked for, and omits an id that left the board", async () => {
    const { org, auth } = await orgDispatcher();
    const { a, b, archived } = await threeLoads(org.id);
    const res = await request(app).get(`/api/dispatcher/broker-board?ids=${a.id},${archived.id}`).set(auth);
    expect(res.status).toBe(200);
    const ids = res.body.loads.map((l: { id: string }) => l.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id); // not asked for
    expect(ids).not.toContain(archived.id); // asked for, but not on this board — absence means remove
    expect(res.body.layout).toBeTruthy(); // layout still travels: a client may be re-reading after a reconnect
  });

  it("refuses to hand another org's load back even when its id is asked for by name", async () => {
    const { auth } = await orgDispatcher();
    const other = await prisma.org.create({ data: { name: "Other", timezone: "America/Chicago" } });
    const otherOrgLoad = await makeLoad(other.id, "OTHER CO");
    const res = await request(app).get(`/api/dispatcher/broker-board?ids=${otherOrgLoad.id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.loads).toEqual([]);
  });

  it("caps the id list instead of letting a client size the query", async () => {
    const { auth } = await orgDispatcher();
    const many = Array.from({ length: 500 }, (_, i) => `id-${i}`).join(",");
    const res = await request(app).get(`/api/dispatcher/broker-board?ids=${many}`).set(auth);
    expect(res.status).toBe(200); // no 500, no timeout
    expect(parseIdList(many)).toHaveLength(200);
  });

  it("truncates the query itself, not just the parser: rows past the cap never come back", async () => {
    // The test above asked for 500 ids that could not possibly match a real
    // row, so its 200 proved nothing about the ROUTE's behaviour — the same
    // 200 would come back whether or not the cap was ever applied to the
    // query. This one asks for more real rows than the cap allows and checks
    // which ones actually came back, so a route that forgot to pass the
    // parsed (truncated) id list into the query — querying the full list
    // instead — would fail it even though the direct parser test still
    // passes.
    const { org, auth } = await orgDispatcher();
    const ids = Array.from({ length: MAX_IDS + 5 }, () => randomUUID());
    await prisma.load.createMany({
      data: ids.map((id, i) => ({
        id, orgId: org.id, customerName: `CO ${i}`, requiredEquip: "DryVan", revenueCents: 0, status: "open",
      })),
    });

    const res = await request(app).get(`/api/dispatcher/broker-board?ids=${ids.join(",")}`).set(auth);
    expect(res.status).toBe(200);
    const returned = res.body.loads.map((l: { id: string }) => l.id);

    // Exactly the ids parseIdList would keep (dedupe-then-slice to MAX_IDS) —
    // not more, and not just a coincidental undercount.
    expect(returned).toHaveLength(MAX_IDS);
    expect(new Set(returned)).toEqual(new Set(ids.slice(0, MAX_IDS)));
    for (const droppedId of ids.slice(MAX_IDS)) expect(returned).not.toContain(droppedId);
  });
});
