import { describe, it, expect } from "vitest";
import { digestOf, predictedVersion } from "../../src/lib/sheet/digest.js";
import type { RawRow, CellWrite } from "../../src/lib/sheet/connector.js";

// Task 1: the shared digest both connectors' `readRows` compute, and the
// predictor the sync layer uses to know what that digest will be once its
// own writes land — before the next read ever happens.

describe("digestOf", () => {
  it("is stable for identical values", () => {
    const a = [["LOAD#", "STATUS"], ["145219", "● OFF"]];
    const b = [["LOAD#", "STATUS"], ["145219", "● OFF"]];
    expect(digestOf(a)).toBe(digestOf(b));
  });

  it("changes when a cell's text changes", () => {
    const a = [["LOAD#", "STATUS"], ["145219", "● OFF"]];
    const b = [["LOAD#", "STATUS"], ["145219", "● WATCHING"]];
    expect(digestOf(a)).not.toBe(digestOf(b));
  });

  it("is order-sensitive: the same rows in a different order digest differently", () => {
    const a = [["H1", "H2"], ["1", "2"], ["3", "4"]];
    const b = [["H1", "H2"], ["3", "4"], ["1", "2"]];
    expect(digestOf(a)).not.toBe(digestOf(b));
  });

  it("is a sha256 hex string", () => {
    expect(digestOf([["a"]])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("predictedVersion", () => {
  const header = ["LOAD#", "DRIVER PHONE", "Night Shift status"];
  const rows: RawRow[] = [
    { rowIndex: 2, cells: ["145219", "+15551234567", ""] },
    { rowIndex: 3, cells: ["145220", "+15557654321", ""] },
  ];

  it("applies the writes and equals digestOf of the mutated copy", () => {
    const writes: CellWrite[] = [{ rowIndex: 2, col: 2, value: "● WATCHING" }];
    const predicted = predictedVersion(header, rows, writes);
    const mutated = [header, ["145219", "+15551234567", "● WATCHING"], ["145220", "+15557654321", ""]];
    expect(predicted).toBe(digestOf(mutated));
  });

  it("applies more than one write, including two writes to the same row", () => {
    const writes: CellWrite[] = [
      { rowIndex: 2, col: 2, value: "● WATCHING" },
      { rowIndex: 3, col: 2, value: "● ATTENTION — needs a load number" },
      { rowIndex: 2, col: 0, value: "999999" },
    ];
    const predicted = predictedVersion(header, rows, writes);
    const mutated = [
      header,
      ["999999", "+15551234567", "● WATCHING"],
      ["145220", "+15557654321", "● ATTENTION — needs a load number"],
    ];
    expect(predicted).toBe(digestOf(mutated));
  });

  it("with no writes, equals digestOf of the rows unchanged", () => {
    expect(predictedVersion(header, rows, [])).toBe(digestOf([header, ...rows.map((r) => r.cells)]));
  });

  it("does not mutate its input rows or their cell arrays", () => {
    const before = rows.map((r) => ({ rowIndex: r.rowIndex, cells: [...r.cells] }));
    predictedVersion(header, rows, [{ rowIndex: 2, col: 2, value: "● WATCHING" }]);
    expect(rows).toEqual(before);
  });

  it("a write to a row not present in rows is skipped, not thrown", () => {
    const writes: CellWrite[] = [{ rowIndex: 99, col: 0, value: "x" }];
    expect(() => predictedVersion(header, rows, writes)).not.toThrow();
    expect(predictedVersion(header, rows, writes)).toBe(digestOf([header, ...rows.map((r) => r.cells)]));
  });
});
