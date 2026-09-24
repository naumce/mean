import { resetDb } from "./helpers.js";
import { getLoad, searchLoads, getUncoveredLoads, getCurrentETA, getLoadEvents, getAgentEvents } from "../src/lib/dispatchTools/index.js";
import { seedDispatchToolsFixture, NOW_MS, DAY_MS, ETA_SHEET } from "./dispatch-tools-fixture.js";

// AI Dispatch Foundation, Task 5 — the load-centric half of the read-only
// tool boundary. See dispatch-tools-fixture.ts's own header for the shared
// scenario (org A: L1/L2 uncovered, L3 in_progress, L4 delivered+trip; org B:
// one driver/load for cross-org checks).

beforeEach(resetDb);

describe("getLoad", () => {
  it("returns ordered stops+appointments, null customer/assignment for an unlinked open load", async () => {
    const { orgA, l1 } = await seedDispatchToolsFixture();
    const load = await getLoad(orgA.id, l1.id);

    expect(load).not.toBeNull();
    expect(load!.stops.map((s) => s.sequence)).toEqual([1, 2]);
    expect(load!.stops[0]?.appointment).not.toBeNull();
    expect(load!.customer).toBeNull();
    expect(load!.assignment).toBeNull();
  });

  it("returns the linked customer and current assignment for a delivered/completed load", async () => {
    const { orgA, l4, l4Assignment, d3, customer } = await seedDispatchToolsFixture();
    const load = await getLoad(orgA.id, l4.id);

    expect(load!.customer).toEqual({ id: customer.id, name: "Acme Foods", priority: "high" });
    expect(load!.assignment).toMatchObject({
      id: l4Assignment.id,
      status: "completed",
      driverId: d3.id,
    });
  });

  it("returns null for a missing id or one belonging to another org", async () => {
    const { orgA, lB1 } = await seedDispatchToolsFixture();
    expect(await getLoad(orgA.id, lB1.id)).toBeNull();
    expect(await getLoad(orgA.id, "does-not-exist")).toBeNull();
  });
});

describe("searchLoads", () => {
  it("filters by status", async () => {
    const { orgA, l1, l2, l6 } = await seedDispatchToolsFixture();
    const rows = await searchLoads(orgA.id, { status: "open" });
    expect(rows.map((r) => r.id).sort()).toEqual([l1.id, l2.id, l6.id].sort());
  });

  it("filters by customerId", async () => {
    const { orgA, l4, customer } = await seedDispatchToolsFixture();
    const rows = await searchLoads(orgA.id, { customerId: customer.id });
    expect(rows.map((r) => r.id)).toEqual([l4.id]);
  });

  it("filters fromMs/toMs against the first stop's pickup window (windowStart ?? windowEnd)", async () => {
    const { orgA, l1 } = await seedDispatchToolsFixture();
    const rows = await searchLoads(orgA.id, { fromMs: NOW_MS - DAY_MS, toMs: NOW_MS });
    // L2/L3/L4/L5's first-stop windows are all seeded well outside this
    // range; L6 has no first-stop appointment at all (review fix round 1,
    // Important #2) and must be excluded rather than defaulted in.
    expect(rows.map((r) => r.id)).toEqual([l1.id]);
  });

  it("excludes a load whose first stop has no appointment from the fromMs/toMs filter", async () => {
    const { orgA, l6 } = await seedDispatchToolsFixture();
    const rows = await searchLoads(orgA.id, { fromMs: NOW_MS - DAY_MS, toMs: NOW_MS + 30 * DAY_MS });
    // A wide enough range to catch l6 if it were (wrongly) defaulted in.
    expect(rows.map((r) => r.id)).not.toContain(l6.id);
  });

  it("filters uncovered (open + no active assignment) both ways", async () => {
    const { orgA, l1, l2, l3, l4, l5, l6 } = await seedDispatchToolsFixture();
    const uncovered = await searchLoads(orgA.id, { uncovered: true });
    const covered = await searchLoads(orgA.id, { uncovered: false });
    // L6 is open + unassigned -> uncovered too. L5 is status "canceled" (not
    // "open") -> covered by isUncovered's definition regardless of its own
    // canceled assignment.
    expect(uncovered.map((r) => r.id).sort()).toEqual([l1.id, l2.id, l6.id].sort());
    expect(covered.map((r) => r.id).sort()).toEqual([l3.id, l4.id, l5.id].sort());
  });

  it("clamps to `limit`", async () => {
    const { orgA } = await seedDispatchToolsFixture();
    const rows = await searchLoads(orgA.id, { limit: 1 });
    expect(rows).toHaveLength(1);
  });

  it("never returns another org's loads", async () => {
    const { orgB, lB1 } = await seedDispatchToolsFixture();
    const rows = await searchLoads(orgB.id, {});
    expect(rows.map((r) => r.id)).toEqual([lB1.id]);
  });
});

describe("getUncoveredLoads", () => {
  it("includes a load whose pickup window ended 3h ago, excludes one from 2 days ago", async () => {
    const { orgA, l1 } = await seedDispatchToolsFixture();
    const rows = await getUncoveredLoads(orgA.id, NOW_MS);
    expect(rows.map((r) => r.id)).toEqual([l1.id]);
  });

  it("excludes a load with no pickup appointment at all, even though it is otherwise uncovered", async () => {
    // Review fix round 1, Important #2: l6 is open + unassigned (uncovered
    // by status+assignment) but its first stop has no appointment, so there
    // is no window to evaluate "≥ now - 24h" against — not-evaluable is not
    // a default bucket, matching onTime.ts's own philosophy for a completed
    // load with no delivery window.
    const { orgA, l6 } = await seedDispatchToolsFixture();
    const rows = await getUncoveredLoads(orgA.id, NOW_MS);
    expect(rows.map((r) => r.id)).not.toContain(l6.id);
  });

  it("never leaks another org's loads", async () => {
    const { orgA, orgB } = await seedDispatchToolsFixture();
    const rowsA = await getUncoveredLoads(orgA.id, NOW_MS);
    const rowsB = await getUncoveredLoads(orgB.id, NOW_MS);
    expect(rowsA.every((r) => r.orgId === orgA.id)).toBe(true);
    expect(rowsB.every((r) => r.orgId === orgB.id)).toBe(true);
  });
});

describe("getCurrentETA", () => {
  it("prefers the newest sheet_write remainder over the older plan (agent_itinerary)", async () => {
    const { orgA, l4 } = await seedDispatchToolsFixture();
    const eta = await getCurrentETA(orgA.id, l4.id);
    expect(eta).toMatchObject({ source: "agent_itinerary", etaMs: ETA_SHEET, precision: "live" });
    expect(typeof eta!.computedAt).toBe("number");
  });

  it("skips newer events with no resolvable etaAtMs (malformed plan, remainder-less sheet_write) and falls back to the older valid one", async () => {
    // L4's trip carries two MORE events, newer still than the valid
    // sheet_write above: a "plan" whose etaAtMs is a string, and a
    // cells-only "sheet_write" with no `remaining` at all. Both must be
    // skipped by newestEtaFromEvents/etaFromEvidence, landing back on the
    // same ETA_SHEET the previous test asserts — this test exists
    // specifically to prove the skip branch is reached at all (review fix
    // round 1, Important #2: previously the newest event was always already
    // the valid one, so this loop's "continue past a null" path never
    // actually ran).
    const { orgA, l4 } = await seedDispatchToolsFixture();
    const eta = await getCurrentETA(orgA.id, l4.id);
    expect(eta).toMatchObject({ source: "agent_itinerary", etaMs: ETA_SHEET, precision: "live" });
  });

  it("falls back to the assignment's plannedEnd when there is no agent evidence", async () => {
    const { orgA, l3, l3Assignment } = await seedDispatchToolsFixture();
    const eta = await getCurrentETA(orgA.id, l3.id);
    expect(eta).toMatchObject({ source: "plan_interpolation", etaMs: l3Assignment.plannedEnd.getTime(), precision: "planned" });
  });

  it("falls back to none when there is neither agent evidence nor an assignment", async () => {
    const { orgA, l1 } = await seedDispatchToolsFixture();
    const eta = await getCurrentETA(orgA.id, l1.id);
    expect(eta).toMatchObject({ source: "none", etaMs: null, precision: null });
  });

  it("falls back to none when the load's only assignment is canceled (its plannedEnd is not ETA evidence)", async () => {
    // Review fix round 1, ❌ #1: this exclusion was already implemented
    // (PLANNED_ETA_STATUSES omits "canceled") but was undisclosed and
    // untested. L5's only Assignment row is status "canceled".
    const { orgA, l5 } = await seedDispatchToolsFixture();
    const eta = await getCurrentETA(orgA.id, l5.id);
    expect(eta).toMatchObject({ source: "none", etaMs: null, precision: null });
  });

  it("returns null for a load belonging to another org", async () => {
    const { orgA, lB1 } = await seedDispatchToolsFixture();
    expect(await getCurrentETA(orgA.id, lB1.id)).toBeNull();
  });
});

describe("getLoadEvents", () => {
  it("merges LoadChange and AgentUpdate ascending by atMs", async () => {
    const { orgA, l3 } = await seedDispatchToolsFixture();
    const events = await getLoadEvents(orgA.id, l3.id);

    expect(events!.map((e) => e.atMs)).toEqual([500, 1000, 2000, 3000]);
    expect(events![0]).toMatchObject({ type: "agent_update", kind: "eta", text: "ETA updated" });
    expect(events![1]).toMatchObject({ type: "change", field: "status", before: "open", after: "assigned" });
    expect(events![2]).toMatchObject({ type: "agent_update", kind: "status", text: "Driver en route" });
    expect(events![3]).toMatchObject({ type: "change", before: "assigned", after: "in_progress" });
  });

  it("returns null for a load belonging to another org", async () => {
    const { orgA, lB1 } = await seedDispatchToolsFixture();
    expect(await getLoadEvents(orgA.id, lB1.id)).toBeNull();
  });
});

describe("getAgentEvents", () => {
  it("returns the load's trips newest first, each trip's events ascending", async () => {
    const { orgA, l4 } = await seedDispatchToolsFixture();
    const trips = await getAgentEvents(orgA.id, l4.id);

    expect(trips).toHaveLength(1);
    expect(trips![0]).toMatchObject({ tripId: `trip-${l4.id}`, status: "delivered" });
    // Full trail, unfiltered by kind — getAgentEvents is a raw read, unlike
    // getCurrentETA's own plan/sheet_write-only query, so it also surfaces
    // the two trailing events with no resolvable etaAtMs (added for the
    // getCurrentETA skip-logic test above).
    expect(trips![0]!.events.map((e) => e.kind)).toEqual(["plan", "reply", "sheet_write", "plan", "sheet_write"]);
    expect(trips![0]!.events.map((e) => e.atMs)).toEqual([0, 30 * 60_000, 60 * 60_000, 90 * 60_000, 120 * 60_000]);
  });

  it("returns an empty array for a load with no trips", async () => {
    const { orgA, l3 } = await seedDispatchToolsFixture();
    expect(await getAgentEvents(orgA.id, l3.id)).toEqual([]);
  });

  it("returns null for a load belonging to another org", async () => {
    const { orgA, lB1 } = await seedDispatchToolsFixture();
    expect(await getAgentEvents(orgA.id, lB1.id)).toBeNull();
  });
});
