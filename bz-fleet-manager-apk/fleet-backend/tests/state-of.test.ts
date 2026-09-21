import { stateOf, STATE_MATCH_MAX_MI } from "../src/lib/stateOf.js";
import { nearestCity } from "../src/lib/usCities.js";

// T4 Task 3 — stateOf is the ONLY stop-to-state resolver. Every downstream
// number that depends on which state a stop is in (diesel price, IFTA
// gallon attribution) hangs on this file, so every case below is a case
// where a WRONG answer would be worse than no answer: null is the correct,
// expected output whenever the input isn't unambiguous — not a gap to fill
// in later. Pure unit tests, no DB.

it("reads the two-letter state code after the comma", () => {
  expect(stateOf({ address: "Kansas City, MO" })).toBe("MO");
});

it("is case-insensitive coming in, and always uppercases going out", () => {
  expect(stateOf({ address: "kansas city, mo" })).toBe("MO");
});

it("tolerates a trailing ZIP after the state code", () => {
  expect(stateOf({ address: "Kansas City, MO 64106" })).toBe("MO");
});

it("does NOT parse full state names — a name is a lookup we have not built, not a format we can verify", () => {
  // "Missouri" -> MO by pattern would license "Washington" -> WA for
  // Washington, DC, and "Kansas City" alone is ambiguous between MO and KS.
  // Two letters after a comma is verifiable; a name is a guess.
  expect(stateOf({ address: "1200 Main St, Saint Louis, Missouri" })).toBeNull();
});

it("returns null for empty, missing, and unparseable address input", () => {
  expect(stateOf({ address: "" })).toBeNull();
  expect(stateOf({ address: null })).toBeNull();
  expect(stateOf({ address: "Somewhere" })).toBeNull();
});

it("validates the two-letter code against the real 50-states-plus-DC set, not a bare regex", () => {
  // "XX" is shaped exactly like a real state code and must still be rejected.
  expect(stateOf({ address: "Springfield, XX" })).toBeNull();
});

it("falls back to the gazetteer's nearestCity when there is no address, within its radius", () => {
  const OMAHA = { lat: 41.2565, lng: -95.9345 }; // exact "omaha|ne" gazetteer coordinate, 0mi
  expect(stateOf(OMAHA)).toBe("NE");
});

it("returns null for coordinates beyond nearestCity's maxMi — no guessing past its own radius", () => {
  // Gulf of Guinea (0, 0): thousands of miles from every gazetteer city.
  expect(stateOf({ lat: 0, lng: 0 })).toBeNull();
});

it("prefers a parseable address over coordinates — the address is the asserted fact", () => {
  const OMAHA = { lat: 41.2565, lng: -95.9345 }; // would resolve to NE on its own
  expect(stateOf({ address: "Kansas City, MO", ...OMAHA })).toBe("MO");
});

// Controller addition (T4 Ruling 6). The coordinate path originally used
// nearestCity's 150-mi default, which is tuned for a cosmetic lane label. For
// a STATE — which picks a diesel price and attributes a taxable gallon — a
// 140-mi match is a coin flip: the gazetteer holds ~139 cities, so rural
// points routinely sit that far from any entry, in a different state.
describe("stateOf coordinate radius", () => {
  it("reads a state from a coordinate close to a gazetteer city", () => {
    // ~10 mi north of Springfield, MO — deep inside Missouri, far from any
    // border. My first draft of this test used a point near Kansas City and
    // asserted "MO"; it resolved "KS", correctly, because KC,KS sits 2.5 mi
    // from KC,MO and the point was marginally nearer the Kansas one. That is
    // the border ambiguity this radius cannot fix and does not claim to —
    // so the fixture belongs somewhere unambiguous.
    expect(stateOf({ lat: 37.35, lng: -93.29 })).toBe("MO");
  });

  it("refuses a coordinate whose nearest gazetteer city is in ANOTHER state", () => {
    // Marion, Illinois. The gazetteer's nearest entry is St. Louis, MO —
    // 93 mi away, comfortably inside nearestCity's 150-mi default. At that
    // default this southern-Illinois stop resolved "MO": priced against
    // Missouri diesel and, worse, attributing taxable gallons to a state the
    // truck was never in (Global Constraint 6). Southern Illinois is ordinary
    // freight country, not a remote corner, so this is a routine input.
    expect(stateOf({ lat: 37.73, lng: -88.93 })).toBeNull();
  });

  it("refuses SW Kansas, whose nearest entry is Amarillo TX at 137 mi", () => {
    expect(stateOf({ lat: 37.04, lng: -100.92 })).toBeNull();
  });

  it("never reaches further than STATE_MATCH_MAX_MI", () => {
    // Whatever the constant is set to, the Marion IL point must sit beyond it.
    const far = nearestCity(37.73, -88.93, 500);
    expect(far).not.toBeNull();
    expect(far!.miles).toBeGreaterThan(STATE_MATCH_MAX_MI);
    expect(far!.label).toContain("MO"); // the wrong answer it would have given
    expect(stateOf({ lat: 37.73, lng: -88.93 })).toBeNull();
  });
});
