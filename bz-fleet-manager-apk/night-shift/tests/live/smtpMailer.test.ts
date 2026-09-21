import { describe, expect, it, vi } from "vitest";
import { SmtpMailer, type MailTransport } from "../../src/live/smtpMailer.js";
import { verifyAction } from "../../src/live/tokens.js";

const transport = () => ({ sendMail: vi.fn<MailTransport["sendMail"]>(async () => ({ messageId: "<m1@x>" })) });
const opts = { dispatcherEmail: "boss@x.example", publicUrl: "https://x.example", linkSecret: "secret-secret-secret", tripId: "t1", clock: () => 1_000_000 };

describe("SmtpMailer", () => {
  it("sends through the transport and returns the message id", async () => {
    const t = transport();
    const r = await new SmtpMailer(t, "agent@x.example", opts).send("ops@c.example", "Update on load T-01", "current ETA 10:36", [{ name: "a.txt", body: "x" }]);
    expect(r.messageId).toBe("<m1@x>");
    expect(t.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: "agent@x.example", to: "ops@c.example", subject: "Update on load T-01", attachments: [{ filename: "a.txt", content: "x" }] }));
  });

  it("appends a SIGNED one-click link to the dispatcher's email only", async () => {
    const t = transport();
    const m = new SmtpMailer(t, "agent@x.example", opts);
    await m.send("boss@x.example", "[T-01] escalation", "body");
    const text: string = t.sendMail.mock.calls[0][0].text;
    const url = text.match(/https:\/\/x\.example\/act\/(\S+)/);
    expect(url).not.toBeNull();
    expect(verifyAction("secret-secret-secret", url![1], 1_000_000)).toEqual({ tripId: "t1", action: "send_customer_email" });
    await m.send("ops@c.example", "customer", "body");
    expect(t.sendMail.mock.calls[1][0].text).not.toContain("/act/");
  });

  it("lets a transport failure propagate — the core records the email as not sent", async () => {
    const t = transport(); t.sendMail.mockRejectedValueOnce(new Error("535 auth"));
    await expect(new SmtpMailer(t, "agent@x.example", opts).send("boss@x.example", "s", "b")).rejects.toThrow(/535/);
  });
});
