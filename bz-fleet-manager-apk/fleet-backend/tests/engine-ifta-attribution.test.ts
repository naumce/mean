import { describe, expect, it } from "vitest";
import {
  attributeGallons,
  type AttributionLeg,
  type IftaAttribution,
} from "../src/domain/dispatch/iftaAttribution.js";
import { fuelBurn, type FuelBurn } from "../src/domain/dispatch/fuel.js";

// A burn with a genuinely fractional totalGal (700 mi / 6.5 mpg), so the
// per-leg proportional split exercises real division instead of coincidentally
// landing on round numbers.
const BURN: FuelBurn = fuelBurn({ deadheadMi: 100, loadedMi: 600 }, 6.5);

function leg(overrides: Partial<AttributionLeg> & Pick<AttributionLeg, "miles">): AttributionLeg {
  return { fromState: "XX", toState: "XX", ...overrides };
}

// The invariant that makes the whole structure trustworthy: every gallon is
// either attributed to a state or reported as unattributed — never both,
// never neither, never invented. Asserted in every test below.
function assertConservation(burn: FuelBurn, result: IftaAttribution): void {
  const attributedTotal = result.byState.reduce((sum, row) => sum + row.gallons, 0);
  expect(attributedTotal + result.unattributedGal).toBeCloseTo(burn.totalGal, 6);
}

describe("attributeGallons", () => {
  it("attributes every gallon when all legs are intrastate and resolved", () => {
    const legs: AttributionLeg[] = [
      leg({ fromState: "MO", toState: "MO", miles: 300 }),
      leg({ fromState: "KS", toState: "KS", miles: 400 }),
    ];

    const result = attributeGallons(BURN, legs);
    assertConservation(BURN, result);

    expect(result.unattributedGal).toBe(0);
    expect(result.complete).toBe(true);
    expect(result.byState).toEqual([
      { state: "KS", gallons: BURN.totalGal * (400 / 700) },
      { state: "MO", gallons: BURN.totalGal * (300 / 700) },
    ]);
  });

  it("sends a cross-state leg's gallons wholly to unattributedGal, leaving other states' figures unchanged", () => {
    const legMO = leg({ fromState: "MO", toState: "MO", miles: 300 });
    const allIntrastate = attributeGallons(BURN, [
      legMO,
      leg({ fromState: "KS", toState: "KS", miles: 400 }),
    ]);

    const withCrossState = attributeGallons(BURN, [
      legMO,
      leg({ fromState: "KS", toState: "CO", miles: 400 }), // crosses a line — unattributed
    ]);
    assertConservation(BURN, withCrossState);

    // The leg that didn't touch the cross-state leg is untouched.
    expect(withCrossState.byState).toEqual([{ state: "MO", gallons: BURN.totalGal * (300 / 700) }]);
    expect(withCrossState.byState.find((r) => r.state === "MO")!.gallons).toBe(
      allIntrastate.byState.find((r) => r.state === "MO")!.gallons,
    );
    // The whole 400 mi KS->CO leg's gallons landed in unattributedGal.
    expect(withCrossState.unattributedGal).toBeCloseTo(BURN.totalGal * (400 / 700), 6);
    expect(withCrossState.complete).toBe(false);
  });

  it("treats a leg with a null endpoint the same as a cross-state leg", () => {
    const legMO = leg({ fromState: "MO", toState: "MO", miles: 300 });
    const allIntrastate = attributeGallons(BURN, [
      legMO,
      leg({ fromState: "KS", toState: "KS", miles: 400 }),
    ]);

    const withUnknownEndpoint = attributeGallons(BURN, [
      legMO,
      leg({ fromState: "KS", toState: null, miles: 400 }), // destination not resolved
    ]);
    assertConservation(BURN, withUnknownEndpoint);

    expect(withUnknownEndpoint.byState).toEqual([
      { state: "MO", gallons: BURN.totalGal * (300 / 700) },
    ]);
    expect(withUnknownEndpoint.byState.find((r) => r.state === "MO")!.gallons).toBe(
      allIntrastate.byState.find((r) => r.state === "MO")!.gallons,
    );
    expect(withUnknownEndpoint.unattributedGal).toBeCloseTo(BURN.totalGal * (400 / 700), 6);
    expect(withUnknownEndpoint.complete).toBe(false);
  });

  it("reports everything as unattributed when every leg is cross-state", () => {
    const legs: AttributionLeg[] = [
      leg({ fromState: "MO", toState: "KS", miles: 300 }),
      leg({ fromState: "KS", toState: "CO", miles: 400 }),
    ];

    const result = attributeGallons(BURN, legs);
    assertConservation(BURN, result);

    expect(result.byState).toEqual([]);
    expect(result.unattributedGal).toBeCloseTo(BURN.totalGal, 6);
    expect(result.complete).toBe(false);
  });

  it("returns all zero and incomplete when burn.mpgUsed is null — no burn, no attribution", () => {
    const unknownBurn = fuelBurn({ deadheadMi: 100, loadedMi: 600 }, 0);
    expect(unknownBurn.mpgUsed).toBeNull();

    const legs: AttributionLeg[] = [
      leg({ fromState: "MO", toState: "MO", miles: 300 }),
      leg({ fromState: "KS", toState: "KS", miles: 400 }),
    ];

    const result = attributeGallons(unknownBurn, legs);
    assertConservation(unknownBurn, result);

    expect(result).toEqual({ byState: [], unattributedGal: 0, complete: false });
  });

  it("returns all zero and incomplete when total leg miles are zero — no miles, nothing to distribute", () => {
    // A burn consistent with zero miles (totalGal is 0 too), so conservation
    // is a meaningful check here rather than comparing against a nonzero
    // burn that these zero-mile legs could never have produced.
    const zeroBurn = fuelBurn({ deadheadMi: 0, loadedMi: 0 }, 6.5);
    const legs: AttributionLeg[] = [
      leg({ fromState: "MO", toState: "MO", miles: 0 }),
      leg({ fromState: "KS", toState: "KS", miles: 0 }),
    ];

    const result = attributeGallons(zeroBurn, legs);
    assertConservation(zeroBurn, result);

    expect(result).toEqual({ byState: [], unattributedGal: 0, complete: false });
  });

  it("aggregates two separate intrastate legs in the same state into one byState row", () => {
    const legs: AttributionLeg[] = [
      leg({ fromState: "MO", toState: "MO", miles: 300 }),
      leg({ fromState: "MO", toState: "MO", miles: 400 }),
    ];

    const result = attributeGallons(BURN, legs);
    assertConservation(BURN, result);

    expect(result.byState).toHaveLength(1);
    expect(result.byState[0].state).toBe("MO");
    // Summed as two separate per-leg products, so compare with tolerance
    // rather than bit-for-bit equality against BURN.totalGal.
    expect(result.byState[0].gallons).toBeCloseTo(BURN.totalGal, 6);
    expect(result.unattributedGal).toBe(0);
    expect(result.complete).toBe(true);
  });
});
