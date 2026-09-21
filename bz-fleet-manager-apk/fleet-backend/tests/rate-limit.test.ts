import express from "express";
import request from "supertest";
import { rateLimit } from "../src/middleware/rateLimit.js";

// The suite-wide RATE_LIMIT_DISABLED=1 (vitest.config.ts) keeps the limiter
// out of every other spec; here we exercise the real logic by re-enabling it
// around a minimal app that uses the middleware directly.

function limitedApp(opts: Parameters<typeof rateLimit>[0]) {
  const app = express();
  app.post("/x", rateLimit(opts), (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => {
  process.env.RATE_LIMIT_DISABLED = "0";
});
afterEach(() => {
  process.env.RATE_LIMIT_DISABLED = "1";
});

it("allows up to max requests then returns 429 with retry-after", async () => {
  const app = limitedApp({ name: "t1", windowMs: 60_000, max: 3 });
  for (let i = 0; i < 3; i++) {
    const ok = await request(app).post("/x");
    expect(ok.status).toBe(200);
  }
  const blocked = await request(app).post("/x");
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  expect(blocked.body.error).toContain("slow down");
});

it("resets the window after windowMs", async () => {
  vi.useFakeTimers();
  try {
    const app = limitedApp({ name: "t2", windowMs: 1_000, max: 1 });
    expect((await request(app).post("/x")).status).toBe(200);
    expect((await request(app).post("/x")).status).toBe(429);
    vi.advanceTimersByTime(1_001);
    expect((await request(app).post("/x")).status).toBe(200);
  } finally {
    vi.useRealTimers();
  }
});

it("separates counters by keyFrom so one credential never throttles another", async () => {
  const app = limitedApp({
    name: "t3", windowMs: 60_000, max: 1,
    keyFrom: (req) => req.header("x-api-key") ?? "",
  });
  expect((await request(app).post("/x").set("x-api-key", "whk_a")).status).toBe(200);
  expect((await request(app).post("/x").set("x-api-key", "whk_a")).status).toBe(429);
  // A different key still has a fresh window behind the same IP.
  expect((await request(app).post("/x").set("x-api-key", "whk_b")).status).toBe(200);
});

it("is a passthrough when RATE_LIMIT_DISABLED=1", async () => {
  process.env.RATE_LIMIT_DISABLED = "1";
  const app = limitedApp({ name: "t4", windowMs: 60_000, max: 1 });
  for (let i = 0; i < 5; i++) {
    expect((await request(app).post("/x")).status).toBe(200);
  }
});
