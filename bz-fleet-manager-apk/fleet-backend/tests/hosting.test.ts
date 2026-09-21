import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { mountHosting } from "../src/lib/hosting.js";

describe("single-container hosting", () => {
  let worker: http.Server; let workerUrl = ""; let dist = "";
  beforeAll(async () => {
    const w = express();
    w.get("/d/:token", (req, res) => res.type("html").send("driver " + req.params.token));
    w.post("/twilio/sms", express.urlencoded({ extended: false }), (req, res) => res.type("text/xml").send("<Response>" + req.body.From + "</Response>"));
    worker = w.listen(0);
    await new Promise<void>((r) => worker.once("listening", r));
    workerUrl = "http://127.0.0.1:" + (worker.address() as { port: number }).port;
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "portal-"));
    fs.writeFileSync(path.join(dist, "index.html"), "<html>SPA</html>");
    fs.writeFileSync(path.join(dist, "app.js"), "console.log(1)");
  });
  afterAll(() => { worker.close(); fs.rmSync(dist, { recursive: true, force: true }); });

  function appWith(env: Record<string, string>) {
    const app = express();
    app.get("/api/ping", (_req, res) => res.json({ ok: true }));
    mountHosting(app, env);
    return app;
  }

  it("serves the portal, falls back to index.html for SPA routes, never for /api", async () => {
    const app = appWith({ PORTAL_DIST: dist });
    expect((await request(app).get("/app.js")).text).toBe("console.log(1)");
    expect((await request(app).get("/n/tok/load1")).text).toBe("<html>SPA</html>");
    expect((await request(app).get("/api/ping")).body).toEqual({ ok: true });
    expect((await request(app).get("/api/nope")).status).toBe(404);
  });

  it("pipes /d and /twilio to the worker with method, path and body intact", async () => {
    const app = appWith({ WORKER_URL: workerUrl, PORTAL_DIST: dist });
    expect((await request(app).get("/d/abc")).text).toBe("driver abc");
    const sms = await request(app).post("/twilio/sms").type("form").send({ From: "+15550001111" });
    expect(sms.text).toBe("<Response>+15550001111</Response>");
    expect((await request(app).get("/dashboard")).text).toBe("<html>SPA</html>");
  });

  it("answers 502, not a hang, when the worker is down", async () => {
    const app = appWith({ WORKER_URL: "http://127.0.0.1:1" });
    const r = await request(app).get("/d/abc");
    expect(r.status).toBe(502);
  });

  it("is a no-op without the env", async () => {
    const app = appWith({});
    expect((await request(app).get("/d/abc")).status).toBe(404);
  });
});
