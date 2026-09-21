import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ChatBus } from "../../src/live/chatBus.js";
import { driverLinkRouter } from "../../src/live/driverLink.js";
import { Registry } from "../../src/live/registry.js";
import type { Brief } from "../../src/core/types.js";

const brief: Brief = {
  loadRef: "T-01", origin: { name: "Skopje", lat: 41.99, lng: 21.43 }, destination: { name: "Tetovo", lat: 42.01, lng: 20.97 },
  equipment: "DryVan", departAtMs: 1, deadlineAtMs: 2, driverName: "Trajce", driverPhone: "+38970000000",
  customerEmail: null, minutesSinceBreakAtDepart: null,
};

async function setup() {
  const agent = { start: vi.fn(async () => {}), onAccept: vi.fn(async () => {}), onPing: vi.fn(async () => {}), onReply: vi.fn(async () => {}), tick: vi.fn(async () => {}), state: { status: "invited" } };
  const reg = new Registry(() => agent as never);
  const trip = await reg.start(brief, {}, { orgId: "org-test", sender: "+15550001111", callerId: "+15550001111" });
  const bus = new ChatBus();
  const app = express().use(express.json()).use(driverLinkRouter(reg, bus, () => 5_000));
  return { app, agent, trip, bus };
}

describe("driver link", () => {
  it("serves the page for a known token and 404s an unknown one", async () => {
    const { app, trip, bus } = await setup();
    const ok = await request(app).get(`/d/${trip.driverToken}`);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("T-01");
    expect(ok.text).toContain("Accept");
    expect(bus.openedAt(trip.tripId)).toBe(5_000);
    expect((await request(app).get("/d/nope")).status).toBe(404);
  });

  it("accept, ping and reply reach the agent with the server's clock", async () => {
    const { app, agent, trip } = await setup();
    await request(app).post(`/d/${trip.driverToken}/accept`).expect(200);
    expect(agent.onAccept).toHaveBeenCalledTimes(1);
    await request(app).post(`/d/${trip.driverToken}/ping`).send({ lat: 41.99, lng: 21.43, atMs: 1 }).expect(200);
    expect(agent.onPing).toHaveBeenCalledWith({ atMs: 5_000, lat: 41.99, lng: 21.43 });
    await request(app).post(`/d/${trip.driverToken}/reply`).send({ text: "bathroom, rolling now" }).expect(200);
    expect(agent.onReply).toHaveBeenCalledWith({ atMs: 5_000, channel: "chat", rawText: "bathroom, rolling now" });
  });

  it("refuses a malformed ping or an empty reply with a 400 that names the field", async () => {
    const { app, agent, trip } = await setup();
    const bad = await request(app).post(`/d/${trip.driverToken}/ping`).send({ lat: "x" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/lat/);
    expect(agent.onPing).not.toHaveBeenCalled();
    expect((await request(app).post(`/d/${trip.driverToken}/reply`).send({ text: "" })).status).toBe(400);
  });

  it("hands the page the agent's messages it has not yet seen", async () => {
    const { app, trip, bus } = await setup();
    const m1 = bus.push(trip.tripId, "You've been stopped 15 min near Skopje, everything OK?", 6_000);
    bus.push(trip.tripId, "Got it, thanks.", 7_000);
    const first = await request(app).get(`/d/${trip.driverToken}/messages?after=0`);
    expect(first.body.messages.map((m: { text: string }) => m.text)).toHaveLength(2);
    const later = await request(app).get(`/d/${trip.driverToken}/messages?after=${m1.id}`);
    expect(later.body.messages.map((m: { text: string }) => m.text)).toEqual(["Got it, thanks."]);
  });

  it("never lets a driver's request throw out of the server", async () => {
    const { app, agent, trip } = await setup();
    agent.onPing.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app).post(`/d/${trip.driverToken}/ping`).send({ lat: 41.99, lng: 21.43 });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/could not record/i);
  });
});
