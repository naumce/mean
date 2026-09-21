import { parseCsv } from "../src/lib/csv.js";

it("parses header + rows into records", () => {
  const out = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
  expect(out).toEqual([
    { a: "1", b: "2", c: "3" },
    { a: "4", b: "5", c: "6" },
  ]);
});

it("handles quoted fields with commas and escaped quotes", () => {
  const out = parseCsv('ref,address\nL-1,"Kansas City, MO"\nL-2,"The ""Dock"" St"\n');
  expect(out[0].address).toBe("Kansas City, MO");
  expect(out[1].address).toBe('The "Dock" St');
});

it("tolerates CRLF, skips blank lines, trims cells", () => {
  const out = parseCsv("a,b\r\n 1 , 2 \r\n\r\n3,4");
  expect(out).toEqual([
    { a: "1", b: "2" },
    { a: "3", b: "4" },
  ]);
});

it("returns [] for empty input and header-only input", () => {
  expect(parseCsv("")).toEqual([]);
  expect(parseCsv("a,b\n")).toEqual([]);
});

it("missing trailing cells become empty strings", () => {
  const out = parseCsv("a,b,c\n1,2");
  expect(out[0]).toEqual({ a: "1", b: "2", c: "" });
});
