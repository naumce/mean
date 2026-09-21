import { centsToUsd, fractionToPct, toCsv } from "../src/lib/csvOut.js";

it("serializes plain rows with CRLF endings and a trailing newline", () => {
  expect(toCsv(["a", "b"], [["1", "2"], [3, null]])).toBe("a,b\r\n1,2\r\n3,\r\n");
});

it("quotes only fields that need it and doubles embedded quotes", () => {
  const csv = toCsv(["broker"], [['CH Robinson, Inc.'], ['The "Best" Freight'], ["plain"]]);
  expect(csv).toBe('broker\r\n"CH Robinson, Inc."\r\n"The ""Best"" Freight"\r\nplain\r\n');
});

it("converts money and fractions to spreadsheet-friendly decimals", () => {
  expect(centsToUsd(34000)).toBe("340.00");
  expect(centsToUsd(-1950)).toBe("-19.50");
  expect(fractionToPct(0.185)).toBe("18.5");
});
