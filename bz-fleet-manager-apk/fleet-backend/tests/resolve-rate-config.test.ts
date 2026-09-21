import { describe, expect, it } from "vitest";
import { resolveRateConfig } from "../src/lib/rateConfig.js";
import { DEFAULT_RATE_CONFIG } from "../src/domain/dispatch/economics.js";

const ORG = { mpg: 6.5, dieselCentsPerGal: 400, driverPayCentsPerMi: 60, fixedCentsPerMi: 45 };
const NONE = { mpg: null, dieselCentsPerGal: null, driverPayCentsPerMi: null, fixedCentsPerMi: null };

describe("resolveRateConfig", () => {
  it("uses the org when there is no carrier", () => {
    expect(resolveRateConfig(ORG, null)).toEqual(ORG);
  });

  it("uses the carrier's values where set", () => {
    expect(resolveRateConfig(ORG, { ...NONE, driverPayCentsPerMi: 72, mpg: 5.8 })).toEqual({
      mpg: 5.8, dieselCentsPerGal: 400, driverPayCentsPerMi: 72, fixedCentsPerMi: 45,
    });
  });

  it("falls back FIELD BY FIELD, not all-or-nothing", () => {
    // The bug this test exists to catch: treating a carrier with any value set
    // as fully overriding, so its null fields price at zero.
    const r = resolveRateConfig(ORG, { ...NONE, driverPayCentsPerMi: 72 });
    expect(r.mpg).toBe(6.5);
    expect(r.dieselCentsPerGal).toBe(400);
    expect(r.fixedCentsPerMi).toBe(45);
  });

  it("never yields a zero or NaN for an unset field", () => {
    const r = resolveRateConfig(ORG, NONE);
    for (const v of Object.values(r)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it("falls back to planning defaults when there is no org either", () => {
    expect(resolveRateConfig(null, NONE)).toEqual(DEFAULT_RATE_CONFIG);
    expect(resolveRateConfig(null, null)).toEqual(DEFAULT_RATE_CONFIG);
  });

  it("treats 0 as a deliberate value on EVERY field, not as absent", () => {
    // A carrier that genuinely charges 0 for a component (e.g. an
    // owner-operator paid by percentage, so driverPayCentsPerMi: 0) must get
    // 0, not the org's nonzero fallback. `??` is correct here and `||` is
    // not. Parameterized across all four fields on purpose: a single-field
    // case only proves `??` survives on THAT field — it happened to catch a
    // `||` mutation on fixedCentsPerMi by chance, and said nothing about
    // mpg, dieselCentsPerGal, or driverPayCentsPerMi, where `||` would
    // silently substitute the org's rate for a deliberate zero.
    const fields = ["mpg", "dieselCentsPerGal", "driverPayCentsPerMi", "fixedCentsPerMi"] as const;
    for (const field of fields) {
      const r = resolveRateConfig(ORG, { ...NONE, [field]: 0 });
      expect(r[field], `${field}: 0 must survive as 0, not fall back to the org's value`).toBe(0);
      // Every OTHER field is still null on this carrier, so it must still
      // inherit the org's value — proves the zero isn't leaking all-or-nothing.
      for (const other of fields) {
        if (other === field) continue;
        expect(r[other]).toBe(ORG[other]);
      }
    }
  });
});
