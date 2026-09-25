// aiHarness/serialize.ts (Qwen Harness v0.1, Task 2): turning a tool's raw
// return value into the plain-JSON text a model actually reads back as a
// `tool` message, bounded in size so one oversized result (a driver's full
// location history, a load's full event trail) can never blow the model's
// context window or an AiRunStep row's payload. `TOOL_RESULT_MAX_BYTES` is
// this module's OWN default cap, used when a caller passes none; the harness
// loop (a later task) instead passes the run's configured
// `maxToolResultBytes` (aiHarness/config.ts, default 65536) — the two numbers
// are deliberately independent knobs for two different callers, not one
// value living in two places.

export const TOOL_RESULT_MAX_BYTES = 8192;

export interface SerializedToolResult {
  content: string;
  truncated: boolean;
  originalSize: number;
  returnedSize: number;
}

/**
 * `JSON.stringify`'s replacer. BigInt has no native JSON representation (and
 * throws if left to the default serializer) so it becomes a Number; `Date`
 * already serializes to its own ISO string via `toJSON` before the replacer
 * ever sees it, but the check is kept here too in case a caller's value ever
 * holds something Date-like without that method; `undefined` would normally
 * make `JSON.stringify` drop the key entirely — returning `null` instead
 * keeps the key present, so a tool result never silently loses a field the
 * caller asked about.
 */
function toolResultReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  return value;
}

/** `text`'s first `maxBytes` UTF-8 bytes, decoded back to a string. Cutting a
 *  byte buffer mid-codepoint decodes the broken tail as one U+FFFD
 *  replacement character; dropping it guarantees the prefix never ends on a
 *  split multibyte character. */
function truncateUtf8(text: string, maxBytes: number): string {
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return cut.endsWith("�") ? cut.slice(0, -1) : cut;
}

/**
 * `value` as bounded JSON text. Under `maxBytes`, `content` is just the
 * serialized value. Over it, `content` becomes a small wrapper object
 * (`{ truncated: true, originalSize, returnedSize, data }`) whose `data` is
 * only as much of the original text as fits — the model always gets valid
 * JSON back, and always knows it was cut and by how much, rather than
 * silently receiving a partial value it could mistake for a complete one.
 */
export function serializeToolResult(value: unknown, maxBytes: number = TOOL_RESULT_MAX_BYTES): SerializedToolResult {
  const json = JSON.stringify(value, toolResultReplacer) ?? "null";
  const originalSize = Buffer.byteLength(json, "utf8");
  if (originalSize <= maxBytes) {
    return { content: json, truncated: false, originalSize, returnedSize: originalSize };
  }

  const data = truncateUtf8(json, maxBytes);
  const returnedSize = Buffer.byteLength(data, "utf8");
  const content = JSON.stringify({ truncated: true, originalSize, returnedSize, data });
  return { content, truncated: true, originalSize, returnedSize };
}

/** Recursively sort every plain object's keys (arrays keep their own order —
 *  position is meaningful there, unlike an object's key order) so two
 *  argument objects that differ only in key order canonicalize to the same
 *  string. Used by the harness loop to detect the model repeating an
 *  identical tool call. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** A stable string for `args` regardless of its keys' original order — equal
 *  argument objects always canonicalize identically, so a loop can compare
 *  two calls to the same tool by string equality. */
export function canonicalArgs(args: unknown): string {
  return JSON.stringify(sortKeysDeep(args));
}
