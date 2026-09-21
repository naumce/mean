import { randomBytes } from "node:crypto";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { resetDb } from "../helpers.js";
import { orgTokenFor } from "../../src/lib/nightShiftLink.js";

// Task 10 review, fix round 1: the org token in /api/n/<orgToken>/... is a
// bearer credential with no session behind it — it must never reach the
// server's own logs, even on a genuine 500. middleware/errorHandler.ts's
// `console.error` line is exactly where a raw `req.originalUrl` would leak
// it (and did, before lib/redactUrl.ts). Forces a real 500 through the real
// router (timelineFor mocked to throw — this router's own logic has no other
// way to fail with a 500) and asserts on the captured console.error output.
vi.mock("../../src/lib/agentTimeline.js", () => ({
  timelineFor: vi.fn(async () => {
    throw new Error("boom");
  }),
}));

// A fresh app in THIS file's isolated module graph — vitest gives every test
// file its own module registry, so this mock never reaches
// tests/sheet/link.test.ts or tests/night-shift-routes.test.ts, both of
// which need the real timelineFor.
const app = createApp();

beforeEach(resetDb);

describe("a 500 through /api/n never logs the org token", () => {
  it("errorHandler's console.error carries the redacted URL, never the raw token", async () => {
    const org = await prisma.org.create({ data: { name: "LogOrg", linkSecret: randomBytes(32).toString("hex") } });
    const load = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, status: "open" },
    });
    const token = orgTokenFor(org);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).get(`/api/n/${token}/loads/${load.id}/agent`);

    expect(res.status).toBe(500);
    const logged = errorSpy.mock.calls.map((call) => call.map((arg) => String(arg)).join(" ")).join("\n");
    expect(logged).not.toContain(token);
    // Proves the redaction actually ran on this request's log line, rather
    // than the assertion above passing vacuously because nothing logged the
    // URL at all.
    expect(logged).toContain("/api/n/[redacted]");

    errorSpy.mockRestore();
  });
});
