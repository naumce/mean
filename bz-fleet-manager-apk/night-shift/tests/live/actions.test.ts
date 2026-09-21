import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actionsRouter } from "../../src/live/actions.js";
import { Registry } from "../../src/live/registry.js";
import { signAction } from "../../src/live/tokens.js";
import type { Brief } from "../../src/core/types.js";

const brief: Brief = {
  loadRef: "T-01", origin: { name: "A", lat: 41.99, lng: 21.43 }, destination: { name: "B", lat: 42.0, lng: 21.5 },
  equipment: "DryVan", departAtMs: 1, deadlineAtMs: 2, driverName: "Trajce", driverPhone: "+38970000000",
  customerEmail: "ops@c.example", minutesSinceBreakAtDepart: null,
};

async function setup() {
  const agent = { start: vi.fn(async () => {}), onDispatcherReply: vi.fn(async () => {}), tick: vi.fn(async () => {}), state: { status: "tracking" } };
  const reg = new Registry(() => agent as never);
  const trip = await reg.start(brief, { tripId: "t1" }, { orgId: "org-test", sender: "+15550001111", callerId: "+15550001111" });
  const app = express().use(actionsRouter(reg, "secret-secret-secret", () => 5_000));
  return { app, agent, trip };
}

describe("GET /act/:signed", () => {
  it("performs the signed action through the agent's own command vocabulary", async () => {
    const { app, agent } = await setup();
    const signed = signAction("secret-secret-secret", "t1", "send_customer_email", 6_000);
    const res = await request(app).get("/act/" + signed);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Done/);
    expect(agent.onDispatcherReply).toHaveBeenCalledWith("send the customer email");
  });

  it("refuses an expired or tampered link with 403 and touches nothing", async () => {
    const { app, agent } = await setup();
    const expired = signAction("secret-secret-secret", "t1", "send_customer_email", 4_000);
    expect((await request(app).get("/act/" + expired)).status).toBe(403);
    const tampered = signAction("secret-secret-secret", "t1", "send_customer_email", 6_000).replace("t1", "t2");
    expect((await request(app).get("/act/" + tampered)).status).toBe(403);
    expect(agent.onDispatcherReply).not.toHaveBeenCalled();
  });

  it("404s a valid link for a trip this worker does not hold", async () => {
    const { app, agent } = await setup();
    const gone = signAction("secret-secret-secret", "t_gone", "send_customer_email", 6_000);
    expect((await request(app).get("/act/" + gone)).status).toBe(404);
    expect(agent.onDispatcherReply).not.toHaveBeenCalled();
  });
});
