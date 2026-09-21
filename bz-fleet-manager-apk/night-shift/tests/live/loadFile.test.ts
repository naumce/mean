import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLoad } from "../../src/live/loadFile.js";

const write = (obj: unknown): string => { const p = join(mkdtempSync(join(tmpdir(), "ns-")), "load.json"); writeFileSync(p, JSON.stringify(obj)); return p; };
const driver = { name: "Trajce", phone: "+38970000000" };
const base = { loadRef: "T-01", origin: { name: "Skopje", lat: 41.99, lng: 21.43 }, destination: { name: "Tetovo", lat: 42.01, lng: 20.97 }, equipment: "DryVan" };

describe("readLoad", () => {
  it("resolves 'now' and '+45m' against the worker's clock", () => {
    const b = readLoad(write({ ...base, departAt: "now", deadlineAt: "+45m" }), driver, 1_000_000);
    expect(b.departAtMs).toBe(1_000_000);
    expect(b.deadlineAtMs).toBe(1_000_000 + 45 * 60_000);
    expect(b.driverPhone).toBe("+38970000000");
    expect(b.customerEmail).toBeNull();
    expect(b.minutesSinceBreakAtDepart).toBeNull();
  });

  it("takes ISO times and explicit hours when given", () => {
    const b = readLoad(write({ ...base, departAt: "2026-09-07T06:10:00+02:00", deadlineAt: "2026-09-07T10:15:00+02:00", customerEmail: "ops@c.example", minutesSinceBreakAtDepart: 370 }), driver, 0);
    expect(b.departAtMs).toBe(Date.parse("2026-09-07T06:10:00+02:00"));
    expect(b.customerEmail).toBe("ops@c.example");
    expect(b.minutesSinceBreakAtDepart).toBe(370);
  });

  it("refuses a load whose deadline is not after its departure, by name", () => {
    expect(() => readLoad(write({ ...base, departAt: "now", deadlineAt: "+0m" }), driver, 1)).toThrow(/deadlineAt/);
  });
});
