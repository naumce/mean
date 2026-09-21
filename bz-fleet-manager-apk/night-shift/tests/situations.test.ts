import { describe, expect, it } from "vitest";
import { CLASSIFY_FLOOR } from "../src/core/constants.js";
import { SITUATIONS, matchByKeywords, situationFor } from "../src/core/situations.js";

describe("situation library", () => {
  it("covers the spec's table with the spec's levels", () => {
    const levels = Object.fromEntries(SITUATIONS.map((s) => [s.key, s.level]));
    expect(levels).toMatchObject({ all_good: 0, rest: 0, fuel: 0, traffic: 1, inspection: 2, customer: 2, breakdown: 3, accident: 3 });
  });

  it("every response is a full sentence in American English with no template holes", () => {
    for (const s of SITUATIONS) {
      expect(s.response).toMatch(/[.?!]$/);
      expect(s.response).not.toMatch(/\{|\}/);
    }
  });

  it("looks a situation up by key, and admits an unknown key", () => {
    expect(situationFor("breakdown")?.level).toBe(3);
    expect(situationFor("teleport")).toBeNull();
  });
});

describe("matchByKeywords", () => {
  it("classifies the replay's reply as rest, not as all_good", () => {
    // "rolling" is an all_good phrase; "bathroom" is the information.
    const r = matchByKeywords("had to use the bathroom, rolling now");
    expect(r.key).toBe("rest");
    expect(r.confidence).toBeGreaterThanOrEqual(CLASSIFY_FLOOR);
  });

  it("breaks a TIE toward the more serious situation", () => {
    // One traffic phrase, one breakdown phrase — an actual tie on hits. (A
    // reply containing both "check engine" and "engine" is not a tie:
    // breakdown wins on count alone and the tie-break is never consulted.)
    expect(matchByKeywords("stuck in traffic with a flat").key).toBe("breakdown");
    // On count, the more-mentioned situation wins regardless of level.
    expect(matchByKeywords("traffic jam, construction, road closed, and a flat").key).toBe("traffic");
  });

  it("matches whole words only", () => {
    // "shit" must not match the accident phrase "hit".
    expect(matchByKeywords("oh shit forgot my wallet").key).toBeNull();
  });

  it("never builds a level-3 claim out of a common word", () => {
    // A bare "hit" made "hit traffic on 35" an ACCIDENT — level 3, dispatcher
    // woken, "are you OK?" sent to a driver who is merely in a jam. A word
    // that common cannot carry a claim that serious.
    expect(matchByKeywords("hit traffic on 35").key).toBe("traffic");
    expect(matchByKeywords("i hit some traffic").key).toBe("traffic");
    expect(matchByKeywords("rolled over the curb, no damage").key).toBeNull();
    // The phrasings that DO mean an accident still land.
    expect(matchByKeywords("hit a car at the light").key).toBe("accident");
  });

  it("treats 'all good' as a fallback, never as a vote", () => {
    // Three affirmatives must not outvote one "police pulled me over".
    expect(matchByKeywords("ok fine yes but police pulled me over").key).toBe("inspection");
    // With nothing else matched it is still the answer.
    expect(matchByKeywords("all good, rolling").key).toBe("all_good");
  });

  it("reads a phone's curly apostrophe as an apostrophe", () => {
    // Every iPhone types U+2019. Stripping it turned "won't start" into
    // "won t start" and the breakdown went unrecognized.
    expect(matchByKeywords("won’t start").key).toBe("breakdown");
    expect(matchByKeywords("won't start").key).toBe("breakdown");
  });

  it("returns UNKNOWN below the floor rather than forcing a bucket", () => {
    const r = matchByKeywords("asdf qwer zxcv");
    expect(r.key).toBeNull();
    expect(r.confidence).toBeLessThan(CLASSIFY_FLOOR);
    expect(matchByKeywords("").key).toBeNull();
  });

  it("is case- and punctuation-insensitive", () => {
    expect(matchByKeywords("PULLED OVER!! DOT inspection.").key).toBe("inspection");
  });
});
