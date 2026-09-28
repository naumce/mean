import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DISPATCH_PROMPT_V1 } from "../src/lib/aiHarness/prompts/dispatch-v1.js";

// dispatch-v2 A/B experiment, Task 1: dispatch-v1's own text/terminal
// contract is a Global Constraint — byte-identical, untouched by the
// prompt-profile seam. These hashes were computed once against the CURRENT
// dispatch-v1.ts and pasted here; a hash mismatch means dispatch-v1's text
// changed, which this task must never do.

const SYSTEM_SHA256 = "d14f27b6f57c1c052b2d5c39fc23443b3ce5d192915bb47d93d9e06ec31172bf";
const USER_SHA256 = "9ff185aea391c28f4b8cc5cf426cc5302ce3c3b03e26ab6ca40ec335e6dc5ff9";
const NUDGE_SHA256 = "fb5561e673a182f0663d4765e07d31df6519656256b99f78cb8faa0479a4e6fa";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("DISPATCH_PROMPT_V1: byte-identical pin", () => {
  it("system text hashes to the pinned value", () => {
    expect(sha256(DISPATCH_PROMPT_V1.system)).toBe(SYSTEM_SHA256);
  });

  it("user({ loadId: 'L', loadRef: 'R' }) hashes to the pinned value", () => {
    expect(sha256(DISPATCH_PROMPT_V1.user({ loadId: "L", loadRef: "R" }))).toBe(USER_SHA256);
  });

  it("nudge hashes to the pinned value", () => {
    expect(sha256(DISPATCH_PROMPT_V1.nudge)).toBe(NUDGE_SHA256);
  });
});
