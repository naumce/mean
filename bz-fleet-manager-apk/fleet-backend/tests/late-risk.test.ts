import { computeLateRisk, type RiskCandidate } from "../src/lib/lateRisk.js";

// Pure-core tests with a fixed clock — no DB, no Date.now.

const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const MIN = 60_000;

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };

function candidate(overrides: Partial<RiskCandidate>): RiskCandidate {
  return {
    assignmentId: "a1", loadId: "l1", ref: "REF-1", driverId: "d1", driverName: "Jake",
    status: "assigned",
    plannedStartMs: NOW - 60 * MIN,
    plannedEndMs: NOW + 120 * MIN, // 3h planned duration
    deadlineMs: NOW + 240 * MIN,
    driverPos: null,
    finalDrop: null,
    ...overrides,
  };
}

it("stays quiet while the plan holds: future start, ample slack, or no deadline", () => {
  const notStartedYet = candidate({ plannedStartMs: NOW + 30 * MIN });
  // Started 1h late but projected arrival (NOW+3h) still leaves 1h of slack.
  const ampleSlack = candidate({ deadlineMs: NOW + 240 * MIN });
  const noDeadline = candidate({ deadlineMs: null });
  expect(computeLateRisk(NOW, [notStartedYet, ampleSlack, noDeadline])).toEqual([]);
});

it("warns on an eroded late start and blocks on a projected miss", () => {
  // Projected arrival NOW+3h; window closes NOW+3h30m -> 30 min slack = warn.
  const tight = candidate({ deadlineMs: NOW + 210 * MIN });
  const [warn] = computeLateRisk(NOW, [tight]);
  expect(warn.kind).toBe("late_start");
  expect(warn.severity).toBe("warn");
  expect(warn.slackMin).toBe(30);
  expect(warn.detail).toContain("Not started 1h 0m after the planned start");

  // Window closed NOW+2h; projected NOW+3h -> misses by an hour = block.
  const miss = candidate({ deadlineMs: NOW + 120 * MIN });
  const [block] = computeLateRisk(NOW, [miss]);
  expect(block.severity).toBe("block");
  expect(block.slackMin).toBe(-60);
  expect(block.detail).toContain("miss the delivery window by 1h 0m");
});

it("blocks a rolling driver whose optimistic direct run cannot make the window", () => {
  // KC -> Omaha is ~200 road-miles (~4h at planning speed); window closes in 1h.
  const rolling = candidate({
    status: "in_progress", driverPos: KC, finalDrop: OMAHA, deadlineMs: NOW + 60 * MIN,
  });
  const [row] = computeLateRisk(NOW, [rolling]);
  expect(row.kind).toBe("behind_schedule");
  expect(row.severity).toBe("block");
  expect(row.detail).toContain("even a direct run misses");
  expect(row.slackMin).toBeLessThan(-120);
});

it("leaves a rolling driver alone when even the lower-bound ETA is comfortable", () => {
  const nearDone = candidate({
    status: "in_progress",
    driverPos: { lat: 41.25, lng: -95.93 }, // ~a mile out
    finalDrop: OMAHA,
    deadlineMs: NOW + 180 * MIN,
  });
  expect(computeLateRisk(NOW, [nearDone])).toEqual([]);
});

it("skips rolling drivers with no position — no basis, never a guess", () => {
  const blind = candidate({ status: "in_progress", driverPos: null, finalDrop: OMAHA, deadlineMs: NOW + 10 * MIN });
  expect(computeLateRisk(NOW, [blind])).toEqual([]);
});

it("sorts certain misses before tight-but-possible ones", () => {
  const warnRow = candidate({ assignmentId: "w", deadlineMs: NOW + 210 * MIN });
  const blockRow = candidate({ assignmentId: "b", deadlineMs: NOW + 60 * MIN });
  const rows = computeLateRisk(NOW, [warnRow, blockRow]);
  expect(rows.map((r) => r.assignmentId)).toEqual(["b", "w"]);
});
