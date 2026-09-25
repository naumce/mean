import { serializeToolResult, canonicalArgs, TOOL_RESULT_MAX_BYTES } from "../src/lib/aiHarness/serialize.js";

// Qwen Harness v0.1, Task 2 — aiHarness/serialize.ts: the BigInt/Date/
// undefined replacer, the over-cap truncation wrapper (exact byte accounting,
// never a broken multibyte character at the cut), and canonicalArgs' stable
// key order.

describe("serializeToolResult", () => {
  it("converts BigInt to Number, Date to ISO string, and undefined to null", () => {
    const when = new Date("2026-01-15T12:00:00.000Z");
    const value = { big: 10n, when, missing: undefined, list: [undefined, 1n] };

    const result = serializeToolResult(value);

    expect(result.truncated).toBe(false);
    expect(result.originalSize).toBe(result.returnedSize);
    expect(JSON.parse(result.content)).toEqual({
      big: 10,
      when: "2026-01-15T12:00:00.000Z",
      missing: null,
      list: [null, 1],
    });
  });

  it("returns the plain serialized value, unwrapped, when under the byte cap", () => {
    const result = serializeToolResult({ ok: true });
    expect(result.content).toBe(JSON.stringify({ ok: true }));
    expect(result.truncated).toBe(false);
  });

  it("wraps a result over the byte cap with the exact wrapper shape and byte counts", () => {
    const big = { blob: "x".repeat(20 * 1024) }; // ~20 KB, well over the 8192 default
    const plainJson = JSON.stringify(big);
    const originalSize = Buffer.byteLength(plainJson, "utf8");

    const result = serializeToolResult(big);

    expect(result.truncated).toBe(true);
    expect(result.originalSize).toBe(originalSize);
    expect(result.returnedSize).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);

    const parsed = JSON.parse(result.content);
    expect(parsed).toMatchObject({ truncated: true, originalSize, returnedSize: result.returnedSize });
    expect(typeof parsed.data).toBe("string");
    expect(Buffer.byteLength(parsed.data, "utf8")).toBe(result.returnedSize);
    expect(Buffer.byteLength(parsed.data, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
  });

  it("respects a caller-supplied maxBytes instead of the 8192 default", () => {
    const value = { blob: "y".repeat(1000) };
    const result = serializeToolResult(value, 100);
    expect(result.truncated).toBe(true);
    expect(result.returnedSize).toBeLessThanOrEqual(100);
  });

  it("cuts a truncated multibyte character cleanly, never leaving a replacement char", () => {
    // "€" is one JS character but three UTF-8 bytes (E2 82 AC). Landing the
    // cut one byte into that sequence is exactly the case a naive
    // Buffer.slice-then-toString would corrupt.
    const value = "a".repeat(10) + "€" + "b".repeat(10);
    const json = JSON.stringify(value); // `"aaaaaaaaaa€bbbbbbbbbb"`
    const openingQuoteAndTenAs = 1 + 10; // byte offset where "€" starts
    const cutOneByteIntoEuroSign = openingQuoteAndTenAs + 1;

    const result = serializeToolResult(value, cutOneByteIntoEuroSign);
    const parsed = JSON.parse(result.content);

    expect(parsed.data).not.toContain("�");
    expect(parsed.data).toBe(json.slice(0, openingQuoteAndTenAs));
    expect(Buffer.byteLength(parsed.data, "utf8")).toBeLessThanOrEqual(cutOneByteIntoEuroSign);
  });
});

describe("canonicalArgs", () => {
  it("is independent of object key order, recursively", () => {
    const a = canonicalArgs({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalArgs({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it("still distinguishes different values", () => {
    expect(canonicalArgs({ a: 1 })).not.toBe(canonicalArgs({ a: 2 }));
  });

  it("keeps array order significant, unlike object key order", () => {
    expect(canonicalArgs({ list: [1, 2] })).not.toBe(canonicalArgs({ list: [2, 1] }));
  });
});
