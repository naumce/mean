import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { LOAD_LOCK_TTL_MS } from "../src/lib/loadLocks.js";
import { app, loginDispatcher, resetDb } from "./helpers.js";

async function setup() {
  const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
  await prisma.dispatcher.create({ data: { email: "maria@x.com", passwordHash: await hashPassword("pw"), name: "Maria", orgId: org.id } });
  await prisma.dispatcher.create({ data: { email: "jake@x.com", passwordHash: await hashPassword("pw"), name: "Jake", orgId: org.id } });
  const maria = { Authorization: `Bearer ${(await loginDispatcher("maria@x.com", "pw")).token}` };
  const jake = { Authorization: `Bearer ${(await loginDispatcher("jake@x.com", "pw")).token}` };
  const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME" } });
  return { org, load, maria, jake };
}
const lock = (auth: Record<string, string>, id: string) => request(app).post(`/api/dispatcher/loads/${id}/lock`).set(auth);
const heartbeat = (auth: Record<string, string>, id: string) => request(app).post(`/api/dispatcher/loads/${id}/lock/heartbeat`).set(auth);
const unlock = (auth: Record<string, string>, id: string) => request(app).delete(`/api/dispatcher/loads/${id}/lock`).set(auth);

describe("load locks — the routes", () => {
  beforeEach(resetDb);

  it("acquires, heartbeats, lists, refuses the other dispatcher with the holder, and releases", async () => {
    const { load, maria, jake } = await setup();
    const a = await lock(maria, load.id);
    expect(a.status).toBe(200);
    expect(a.body.lock).toMatchObject({ loadId: load.id, by: "Maria" });
    expect(a.body.lock.expiresAt - a.body.lock.since).toBe(LOAD_LOCK_TTL_MS);
    const hb = await heartbeat(maria, load.id);
    expect(hb.status).toBe(200);
    expect(hb.body.lock.since).toBe(a.body.lock.since);
    expect(hb.body.lock.expiresAt).toBeGreaterThanOrEqual(a.body.lock.expiresAt);
    const refused = await lock(jake, load.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" }, message: "Maria is editing this load" });
    const list = await request(app).get("/api/dispatcher/load-locks").set(jake);
    expect(list.body.locks.map((l: { loadId: string }) => l.loadId)).toEqual([load.id]);
    expect((await unlock(jake, load.id)).status).toBe(409);
    expect((await unlock(maria, load.id)).status).toBe(204);
    expect((await lock(jake, load.id)).status).toBe(200);
  });

  it("treats an expired lock as free", async () => {
    const { org, load, jake } = await setup();
    await prisma.loadLock.create({ data: { loadId: load.id, orgId: org.id, dispatcherId: "gone", dispatcherName: "Gone", expiresAt: new Date(Date.now() - 1) } });
    expect((await lock(jake, load.id)).status).toBe(200);
  });

  it("never shows or locks another org's load", async () => {
    const { maria } = await setup();
    const other = await prisma.org.create({ data: { name: "Other", timezone: "UTC" } });
    const theirs = await prisma.load.create({ data: { orgId: other.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "THEIRS" } });
    expect((await lock(maria, theirs.id)).status).toBe(404);
    expect((await unlock(maria, theirs.id)).status).toBe(404);
    await prisma.loadLock.create({ data: { loadId: theirs.id, orgId: other.id, dispatcherId: "x", dispatcherName: "X", expiresAt: new Date(Date.now() + 60_000) } });
    const list = await request(app).get("/api/dispatcher/load-locks").set(maria);
    expect(list.body.locks).toEqual([]);
  });
});
