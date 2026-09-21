/** Default ceiling on a client-supplied id list. A paste can touch a lot of
 *  rows; an unbounded `IN (...)` is a query a client gets to size. */
export const MAX_IDS = 200;

/**
 * Parse a comma-separated `ids` query parameter.
 *
 * Returns `undefined` when the parameter is absent — meaning "no filter",
 * which is a different answer from `[]` ("filter to nothing"). Callers must
 * keep those apart: collapsing them is how an id filter silently becomes a
 * full board read.
 */
export function parseIdList(raw: unknown, max: number = MAX_IDS): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw);
  if (text.length === 0) return [];
  const ids = [...new Set(text.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];
  return ids.slice(0, max);
}
