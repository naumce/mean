import { canArriveStop, canCompleteStop, canCompleteTrip } from "../src/domain/stopState.js";

describe("canArriveStop", () => {
  it("allows arrival when trip is in progress, stop is pending, and earlier stops are completed", () => {
    const trip = { status: "in_progress" };
    const stop = { status: "pending" };
    const earlier = [{ status: "completed" }, { status: "completed" }];
    expect(canArriveStop(trip, stop, earlier)).toEqual({ ok: true });
  });

  it("allows arrival with no earlier stops", () => {
    expect(canArriveStop({ status: "in_progress" }, { status: "pending" }, [])).toEqual({ ok: true });
  });

  it("blocks arrival when the trip is not in progress", () => {
    const result = canArriveStop({ status: "assigned" }, { status: "pending" }, []);
    expect(result.ok).toBe(false);
  });

  it("blocks arrival when the stop is not pending", () => {
    const result = canArriveStop({ status: "in_progress" }, { status: "arrived" }, []);
    expect(result.ok).toBe(false);
  });

  it("blocks arrival when an earlier-sequence stop is not completed (sequential unlock)", () => {
    const result = canArriveStop(
      { status: "in_progress" },
      { status: "pending" },
      [{ status: "arrived" }],
    );
    expect(result.ok).toBe(false);
  });
});

describe("canCompleteStop", () => {
  it("allows completion when arrived and all required proofs provided", () => {
    expect(canCompleteStop({ status: "arrived" }, 1, 1)).toEqual({ ok: true });
  });

  it("allows completion when no proofs are required", () => {
    expect(canCompleteStop({ status: "arrived" }, 0, 0)).toEqual({ ok: true });
  });

  it("allows completion when provided proofs exceed required", () => {
    expect(canCompleteStop({ status: "arrived" }, 1, 2)).toEqual({ ok: true });
  });

  it("blocks completion when the stop has not been arrived", () => {
    const result = canCompleteStop({ status: "pending" }, 0, 0);
    expect(result.ok).toBe(false);
  });

  it("blocks completion when required signs-proof is unmet", () => {
    const result = canCompleteStop({ status: "arrived" }, 1, 0);
    expect(result.ok).toBe(false);
  });
});

describe("canCompleteTrip", () => {
  it("allows completion when in progress and all stops are completed", () => {
    const trip = { status: "in_progress" };
    const stops = [{ status: "completed" }, { status: "completed" }];
    expect(canCompleteTrip(trip, stops)).toEqual({ ok: true });
  });

  it("blocks completion when the trip is not in progress", () => {
    const result = canCompleteTrip({ status: "assigned" }, [{ status: "completed" }]);
    expect(result.ok).toBe(false);
  });

  it("blocks completion when there are no stops", () => {
    const result = canCompleteTrip({ status: "in_progress" }, []);
    expect(result.ok).toBe(false);
  });

  it("blocks completion when a stop is still open", () => {
    const result = canCompleteTrip(
      { status: "in_progress" },
      [{ status: "completed" }, { status: "arrived" }],
    );
    expect(result.ok).toBe(false);
  });
});
