import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ChatBus } from "../../src/live/chatBus.js";
import { PendingCalls } from "../../src/live/pendingCalls.js";
import { Registry } from "../../src/live/registry.js";
import { createServer } from "../../src/live/server.js";

describe("createServer", () => {
  it("answers health with the number of live trips and mounts every router", async () => {
    const reg = new Registry(() => ({ start: vi.fn(async () => {}), tick: vi.fn(async () => {}), state: { status: "invited" } }) as never);
    const app = createServer({ registry: reg, bus: new ChatBus(), pending: new PendingCalls("https://x.example"), validate: () => true, publicUrl: "https://x.example", linkSecret: "secret-secret-secret", clock: () => 1 });
    const h = await request(app).get("/health");
    expect(h.body).toEqual({ ok: true, trips: 0 });
    expect((await request(app).get("/d/nope")).status).toBe(404);
    expect((await request(app).get("/act/nope")).status).toBe(403);
    expect((await request(app).post("/twilio/sms").type("form").send({})).status).toBe(404);
  });
});
