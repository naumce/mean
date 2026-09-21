import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { ACTIVE_STATUSES } from "../src/lib/activeStatuses.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "src");
// The one file allowed to hold the literal ["assigned", ..., "in_progress"]
// busy-status array — the canonical source everyone else must import.
const CANONICAL_FILE = "src/lib/activeStatuses.ts";

// Exact (file, literal-text) exceptions for arrays that share both words with
// the busy-status list but are a different concept. Keyed on the *exact*
// literal, in the *exact* file, never a blanket file exemption — a new,
// different array added to either file below still fails this test.
const ALLOWED_DUPLICATES: { file: string; literal: string; reason: string }[] = [
  {
    file: "src/routes/driver.ts",
    literal: '["assigned", "in_progress", "arrived"]',
    reason:
      'Trip.status (the driver-app "current trip" query), not Assignment.status ' +
      '— a different model with a value ("arrived") ACTIVE_STATUSES does not ' +
      "have. Same domain split as Load's OPEN_STATUSES.",
  },
  {
    file: "src/routes/dispatcherAssignments.ts",
    literal: '["assigned", "in_progress"]',
    reason:
      'LIFECYCLE transition-validity map value — which prior statuses may move ' +
      'to "completed" — a state-machine rule, not a list of busy statuses.',
  },
  {
    file: "src/routes/dispatcherLoadTruth.ts",
    literal: '["open", "assigned", "in_progress", "delivered", "canceled"]',
    reason:
      "Every Load.status an UPDATE-text rule may target — the zod enum that " +
      "validates PUT /update-rules (one honest record, spec D2). A Load " +
      "vocabulary, not Assignment busy statuses; same split as OPEN_STATUSES.",
  },
  {
    file: "src/lib/loadStatuses.ts",
    literal: '["assigned", "in_progress", "delivered"]',
    reason:
      "COVERED_LOAD_STATUSES (plan A3, spec §8.2) — Load statuses a covered " +
      "brokered load may carry, not Assignment busy statuses.",
  },
  {
    file: "src/lib/loadStatuses.ts",
    literal: '["assigned", "in_progress"]',
    reason:
      "ROLLING_LOAD_STATUSES (plan A3, spec §8.2) — Load statuses, not " +
      "Assignment busy statuses.",
  },
];

function tsFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...tsFilesUnder(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

/** Every non-nested array literal in a source file, e.g. `["assigned", "in_progress"]`. */
function arrayLiteralsIn(src: string): string[] {
  return src.match(/\[[^[\]]*\]/g) ?? [];
}

describe("ACTIVE_STATUSES", () => {
  it("counts a tendered assignment as occupying the truck", () => {
    // A tender holds capacity — the driver cannot be double-booked while the
    // offer is outstanding.
    expect(ACTIVE_STATUSES).toContain("tendered");
    expect(ACTIVE_STATUSES).toContain("assigned");
    expect(ACTIVE_STATUSES).toContain("in_progress");
  });

  it("excludes finished work so completing a leg frees the driver", () => {
    expect(ACTIVE_STATUSES).not.toContain("completed");
    expect(ACTIVE_STATUSES).not.toContain("delivered");
    expect(ACTIVE_STATUSES).not.toContain("canceled");
  });

  it("is defined exactly once in the codebase", () => {
    // Guards the defect this task exists to fix: a second hardcoded
    // ["assigned", ..., "in_progress"] array anywhere under src/ — not just
    // in the two files this task happened to already know about — must fail
    // this test, not wait for a reviewer to notice. A test that only checks
    // two hardcoded paths is green even while a third copy sits elsewhere in
    // the tree; this scans every .ts file under src/ instead.
    const offenders: string[] = [];
    for (const file of tsFilesUnder(srcDir)) {
      const relPath = relative(repoRoot, file).split("\\").join("/");
      if (relPath === CANONICAL_FILE) continue;
      const src = readFileSync(file, "utf8");
      for (const literal of arrayLiteralsIn(src)) {
        const hasAssigned = /["']assigned["']/.test(literal);
        const hasInProgress = /["']in_progress["']/.test(literal);
        if (!hasAssigned || !hasInProgress) continue;
        const allowed = ALLOWED_DUPLICATES.some((a) => a.file === relPath && a.literal === literal);
        if (!allowed) offenders.push(`${relPath}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
