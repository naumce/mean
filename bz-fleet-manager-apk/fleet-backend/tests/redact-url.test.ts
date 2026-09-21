import { redactUrl } from "../src/lib/redactUrl.js";

// Task 10 review, fix round 1: the org token in /api/n/<orgToken>/... is a
// bearer credential living in a URL — every logger that prints a raw request
// URL must redact it. See middleware/errorHandler.ts and
// middleware/settleDeadline.ts, the two call sites this fixes.

describe("redactUrl", () => {
  it("redacts the org-token segment of an /api/n path", () => {
    const token = "abc123def456.org-9";
    expect(redactUrl(`/api/n/${token}/loads/load-1/agent`)).toBe("/api/n/[redacted]/loads/load-1/agent");
  });

  it("redacts the commands sub-path too", () => {
    const token = "abc123def456.org-9";
    expect(redactUrl(`/api/n/${token}/loads/load-1/agent/commands`)).toBe(
      "/api/n/[redacted]/loads/load-1/agent/commands",
    );
  });

  it("redacts even when the token segment carries a query string", () => {
    // The token itself never legitimately contains a "?" (orgTokenFor's own
    // format is hex digest + "." + a cuid), but a caller could still append
    // one — redact before it, not after, so nothing past the token leaks
    // either.
    expect(redactUrl("/api/n/tok.org-1?x=1")).toBe("/api/n/[redacted]?x=1");
  });

  it("leaves every other path unchanged", () => {
    expect(redactUrl("/api/dispatcher/loads/load-1/agent")).toBe("/api/dispatcher/loads/load-1/agent");
    expect(redactUrl("/health")).toBe("/health");
    expect(redactUrl("/")).toBe("/");
  });

  it("is a no-op on a bare /api/n with no token segment", () => {
    expect(redactUrl("/api/n")).toBe("/api/n");
    expect(redactUrl("/api/n/")).toBe("/api/n/");
  });
});
