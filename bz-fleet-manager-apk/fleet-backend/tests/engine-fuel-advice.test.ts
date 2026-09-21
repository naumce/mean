import { describe, expect, it } from "vitest";
import {
  fuelAdvice,
  MIN_SAVING_CENTS,
  type PricedStop,
} from "../src/domain/dispatch/fuelAdvice.js";
import { fuelBurn, type FuelBurn } from "../src/domain/dispatch/fuel.js";

// A clean, round burn (650 loaded mi / 6.5 mpg) so gallon-based expectations
// don't require carrying repeating decimals through the test math.
const CLEAN_BURN: FuelBurn = fuelBurn({ deadheadMi: 0, loadedMi: 650 }, 6.5);
// A burn with a genuinely fractional totalGal, to exercise the "round once,
// at the end" rule for real instead of coincidentally landing on a whole cent.
const FRACTIONAL_BURN: FuelBurn = fuelBurn({ deadheadMi: 100, loadedMi: 600 }, 6.5);

function stop(overrides: Partial<PricedStop> & Pick<PricedStop, "sequence" | "centsPerGal">): PricedStop {
  return {
    label: `stop-${overrides.sequence}`,
    state: "XX",
    // Effectively unlimited by default, so the plan's totalGal clamp is the
    // only thing sizing `gallons` for tests that aren't specifically about
    // gallonsFromHere. Override this explicitly to exercise the leg limit
    // or the clamp itself.
    gallonsFromHere: Number.POSITIVE_INFINITY,
    ...overrides,
  };
}

describe("fuelAdvice", () => {
  it("names the cheaper (first) stop, and rounds gallonsFromHere x (dear - cheap) once at the end", () => {
    expect(FRACTIONAL_BURN.totalGal).not.toEqual(Math.round(FRACTIONAL_BURN.totalGal));

    // The cheap stop is the very first stop on the route, so nothing has
    // been burned yet — the fuel still ahead of it is the whole plan's burn.
    const cheap = stop({
      sequence: 1,
      label: "Kansas City, MO",
      state: "MO",
      centsPerGal: 350,
      gallonsFromHere: FRACTIONAL_BURN.totalGal,
    });
    const dear = stop({ sequence: 2, label: "St. Louis, MO", state: "MO", centsPerGal: 400 });

    const advice = fuelAdvice(FRACTIONAL_BURN, [cheap, dear]);

    const expectedSaving = Math.round(cheap.gallonsFromHere * (400 - 350));
    expect(advice).toEqual({
      atSequence: 1,
      atLabel: "Kansas City, MO",
      state: "MO",
      gallons: cheap.gallonsFromHere,
      centsPerGal: 350,
      vsLabel: "St. Louis, MO",
      vsCentsPerGal: 400,
      savingCents: expectedSaving,
    });
  });

  it("returns null when the cheaper stop is LAST — you can't buy fuel at the delivery to power the drive that got you there", () => {
    const dear = stop({ sequence: 1, label: "first", centsPerGal: 410 });
    const cheap = stop({ sequence: 2, label: "last-delivery", centsPerGal: 350 });

    expect(fuelAdvice(CLEAN_BURN, [dear, cheap])).toBeNull();
  });

  it("returns null with fewer than two priced stops", () => {
    expect(fuelAdvice(CLEAN_BURN, [])).toBeNull();
    expect(fuelAdvice(CLEAN_BURN, [stop({ sequence: 1, centsPerGal: 350 })])).toBeNull();
  });

  it("returns null when burn.mpgUsed is null — no burn, no advice", () => {
    const unknownBurn = fuelBurn({ deadheadMi: 100, loadedMi: 600 }, 0);
    expect(unknownBurn.mpgUsed).toBeNull();

    const stops = [
      stop({ sequence: 1, centsPerGal: 350 }),
      stop({ sequence: 2, centsPerGal: 400 }),
    ];
    expect(fuelAdvice(unknownBurn, stops)).toBeNull();
  });

  it("suppresses a saving under MIN_SAVING_CENTS, but not one that meets it exactly", () => {
    expect(MIN_SAVING_CENTS).toBe(500);

    const under = [
      stop({ sequence: 1, centsPerGal: 350 }),
      stop({ sequence: 2, centsPerGal: 354 }), // 100 gal x 4c = 400c, under the floor
    ];
    expect(fuelAdvice(CLEAN_BURN, under)).toBeNull();

    const atFloor = [
      stop({ sequence: 1, centsPerGal: 350 }),
      stop({ sequence: 2, centsPerGal: 355 }), // 100 gal x 5c = 500c, exactly the floor
    ];
    const advice = fuelAdvice(CLEAN_BURN, atFloor);
    expect(advice).not.toBeNull();
    expect(advice?.savingCents).toBe(500);
  });

  it("returns null when every priced stop has an identical price", () => {
    const stops = [
      stop({ sequence: 1, centsPerGal: 380 }),
      stop({ sequence: 2, centsPerGal: 380 }),
      stop({ sequence: 3, centsPerGal: 380 }),
    ];
    expect(fuelAdvice(CLEAN_BURN, stops)).toBeNull();
  });

  it("sizes the saving to gallonsFromHere, strictly less than the whole-burn figure when the buy stop isn't the first one", () => {
    // Regression test for the defect the coordinator flagged: gallons burned
    // BEFORE the buy stop were already purchased somewhere else, so sizing
    // the saving to the whole plan's burn (CLEAN_BURN.totalGal = 100)
    // overstates it. Here only 40 of the 100 total gallons are still ahead
    // of the cheap stop.
    const cheap = stop({ sequence: 1, centsPerGal: 350, gallonsFromHere: 40 });
    const dear = stop({ sequence: 2, centsPerGal: 500 });

    const advice = fuelAdvice(CLEAN_BURN, [cheap, dear]);
    expect(advice).not.toBeNull();

    const wholeBurnFigure = Math.round(CLEAN_BURN.totalGal * (500 - 350));
    expect(advice!.gallons).toBe(40);
    expect(advice!.savingCents).toBe(Math.round(40 * (500 - 350)));
    expect(advice!.savingCents).toBeLessThan(wholeBurnFigure);
  });

  it("clamps gallons to burn.totalGal when gallonsFromHere overstates what's left to burn", () => {
    const cheap = stop({ sequence: 1, centsPerGal: 350, gallonsFromHere: 500 });
    const dear = stop({ sequence: 2, centsPerGal: 500 });

    const advice = fuelAdvice(CLEAN_BURN, [cheap, dear]);
    expect(advice).not.toBeNull();
    expect(advice!.gallons).toBe(CLEAN_BURN.totalGal);
    expect(advice!.gallons).toBeLessThan(cheap.gallonsFromHere);
    expect(advice!.savingCents).toBe(Math.round(CLEAN_BURN.totalGal * (500 - 350)));
  });
});
