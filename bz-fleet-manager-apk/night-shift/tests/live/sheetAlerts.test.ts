import { describe, expect, it } from "vitest";
import { translateSheetError } from "../../src/live/sheetAlerts.js";
import type { MailerPort } from "../../src/ports/index.js";

// Pure translation table — no DB needed.
describe("translateSheetError", () => {
  it("names a revoked/invalid_grant token in plain words", () => {
    expect(translateSheetError("invalid_grant: token expired or revoked")).toBe(
      "Google access was removed — open Night Shift → Connect and sign in again",
    );
  });
  it("names a 429 in plain words", () => {
    expect(translateSheetError("429 Too Many Requests")).toBe("Google is rate-limiting us; we retry every 5 minutes");
  });
  it("names RESOURCE_EXHAUSTED in plain words too", () => {
    expect(translateSheetError("RESOURCE_EXHAUSTED: quota")).toBe("Google is rate-limiting us; we retry every 5 minutes");
  });
  it("names the missing agent columns in plain words", () => {
    expect(translateSheetError("Night Shift columns not found — click Install on the Connect page")).toBe(
      "the two Night Shift columns are missing — click Install on the Connect page",
    );
  });
  it("passes an unrecognized error through as-is rather than hiding it", () => {
    expect(translateSheetError("some other API hiccup")).toBe("some other API hiccup");
  });
});

// The full pass against the real database named by DATABASE_URL — the same
// convention every other live test with DB access uses
// (tests/live/prismaEvents.test.ts, tests/live/platformLoads.test.ts).
// Skipped, with a printed reason, when it is not set.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
if (!url) console.warn("sheetAlerts.test: DATABASE_URL not set — skipped");
const mod = url ? await import("../../src/live/sheetAlerts.js") : null;
const db = url ? await import("../../../fleet-backend/src/db.js") : null;

class FakeMailer implements MailerPort {
  sent: { to: string; subject: string; body: string }[] = [];
  async send(to: string, subject: string, body: string): ReturnType<MailerPort["send"]> {
    this.sent.push({ to, subject, body });
    return { messageId: "fake-" + this.sent.length };
  }
}

run("alertSheetFailures (real database)", () => {
  const alertSheetFailures = mod?.alertSheetFailures as NonNullable<typeof mod>["alertSheetFailures"];
  const prisma = db?.prisma as NonNullable<typeof db>["prisma"];
  const suffix = "alert_" + Date.now();
  const portalUrl = "https://portal.example.com";

  async function seedOrg(dispatcherEmail: string): Promise<string> {
    const org = await prisma.org.create({ data: { name: "SheetAlerts Test " + suffix + "_" + Math.random().toString(36).slice(2) } });
    await prisma.agentPolicy.create({ data: { orgId: org.id, name: "Standard", dispatcherEmail } });
    return org.id;
  }

  async function seedBinding(orgId: string, over: Partial<{ status: string; lastError: string | null; alertedError: string | null; spreadsheetTitle: string | null; tabTitle: string }> = {}) {
    return prisma.sheetBinding.create({
      data: {
        orgId, provider: "google", spreadsheetId: "s_" + suffix + "_" + Math.random().toString(36).slice(2),
        tabId: "t1", tabTitle: over.tabTitle ?? "Sheet1", columns: {}, refreshToken: "sealed-x",
        status: over.status ?? "connected",
        lastError: over.lastError ?? null,
        alertedError: over.alertedError ?? null,
        spreadsheetTitle: over.spreadsheetTitle ?? "Loads",
      },
    });
  }

  async function cleanup(orgIds: string[]): Promise<void> {
    for (const orgId of orgIds) {
      await prisma.sheetBinding.deleteMany({ where: { orgId } });
      await prisma.agentPolicy.deleteMany({ where: { orgId } });
      await prisma.plan.deleteMany({ where: { orgId } });
      await prisma.org.delete({ where: { id: orgId } });
    }
  }

  it("sends one email for a binding in error, and marks it alerted", async () => {
    const orgId = await seedOrg("ops1@example.com");
    try {
      const binding = await seedBinding(orgId, { status: "error", lastError: "invalid_grant: revoked", spreadsheetTitle: "Loads", tabTitle: "Sheet1" });
      const mailer = new FakeMailer();

      await alertSheetFailures({ mailer, portalUrl });

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0].to).toBe("ops1@example.com");
      expect(mailer.sent[0].subject).toBe("Night Shift: your sheet stopped syncing");
      expect(mailer.sent[0].body).toContain("Loads — Sheet1");
      expect(mailer.sent[0].body).toContain("Google access was removed");
      expect(mailer.sent[0].body).toContain("https://portal.example.com/night-shift?tab=connect");

      const fresh = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
      expect(fresh.alertedError).toBe("invalid_grant: revoked");
    } finally {
      await cleanup([orgId]);
    }
  });

  it("the same error again sends nothing more", async () => {
    const orgId = await seedOrg("ops2@example.com");
    try {
      await seedBinding(orgId, { status: "error", lastError: "429 rate limited" });
      const mailer = new FakeMailer();

      await alertSheetFailures({ mailer, portalUrl });
      expect(mailer.sent).toHaveLength(1);

      // A second poll tick, nothing about the binding changed.
      await alertSheetFailures({ mailer, portalUrl });
      expect(mailer.sent).toHaveLength(1);
    } finally {
      await cleanup([orgId]);
    }
  });

  it("a new, different error sends a second email", async () => {
    const orgId = await seedOrg("ops3@example.com");
    try {
      const binding = await seedBinding(orgId, { status: "error", lastError: "429 rate limited" });
      const mailer = new FakeMailer();
      await alertSheetFailures({ mailer, portalUrl });
      expect(mailer.sent).toHaveLength(1);

      await prisma.sheetBinding.update({ where: { id: binding.id }, data: { lastError: "invalid_grant: revoked" } });
      await alertSheetFailures({ mailer, portalUrl });
      expect(mailer.sent).toHaveLength(2);
      expect(mailer.sent[1].body).toContain("Google access was removed");
    } finally {
      await cleanup([orgId]);
    }
  });

  it("a binding that recovers has alertedError cleared, with no email", async () => {
    const orgId = await seedOrg("ops4@example.com");
    try {
      const binding = await seedBinding(orgId, { status: "error", lastError: "429 rate limited" });
      const mailer = new FakeMailer();
      await alertSheetFailures({ mailer, portalUrl });
      expect(mailer.sent).toHaveLength(1);

      await prisma.sheetBinding.update({ where: { id: binding.id }, data: { status: "connected", lastError: null } });
      await alertSheetFailures({ mailer, portalUrl });

      expect(mailer.sent).toHaveLength(1); // no new email
      const fresh = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
      expect(fresh.alertedError).toBeNull();
    } finally {
      await cleanup([orgId]);
    }
  });

  it("a binding that has always been connected is never touched", async () => {
    const orgId = await seedOrg("ops5@example.com");
    try {
      const binding = await seedBinding(orgId, { status: "connected" });
      const mailer = new FakeMailer();

      await alertSheetFailures({ mailer, portalUrl });

      expect(mailer.sent).toHaveLength(0);
      const fresh = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
      expect(fresh.alertedError).toBeNull();
    } finally {
      await cleanup([orgId]);
    }
  });
});
