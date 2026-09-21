import type { RequestHandler } from "express";

// Postgres cannot represent a NUL byte in a text value: the driver raises
// 22021 `invalid byte sequence for encoding "UTF8": 0x00` before the query
// runs. That error surfaced as a rejected Prisma promise inside an
// `async (req, res)` handler, which Express 4 never awaits — so it became an
// unhandled rejection and Node 22 killed the whole process (observed: exit
// code 1, no HTTP response at all), taking every tenant's in-memory lane lock
// with it. `GET /api/dispatcher/loads/%00` was enough; about eleven routes
// pass a parameter straight into a Prisma `where`.
//
// src/lib/processGuards.ts stops the process dying, but a surviving process
// that never answers is still a failed request. This turns the malformed
// input into what it always was — a bad request — at the edge, before any
// route or query sees it, so all eleven routes are covered by one rule
// instead of eleven validators.
//
// Scope: the request URL (where a route parameter comes from) and the parsed
// JSON body (which reaches Prisma just as directly — e.g. POST /locks's
// `laneId`). Header values cannot carry a NUL: Node's HTTP parser rejects the
// message first. Multipart uploads are not covered — this runs before multer
// has parsed them, and CSV cell contents are the importer's business.

const NUL = "\u0000";

/** Bodies are capped at 1mb, but nesting is unbounded; this stops a
 *  deliberately deep object turning validation into a stack overflow. Values
 *  below the cap are left to the route's own zod schema. */
const MAX_BODY_DEPTH = 8;

function urlHasNul(raw: string): boolean {
  if (raw.includes(NUL)) return true;
  try {
    return decodeURIComponent(raw).includes(NUL);
  } catch {
    // A malformed percent-escape is a different fault, and Express's own
    // parameter decoding already rejects it with a 400 carrying `status`,
    // which middleware/errorHandler.ts passes through.
    return false;
  }
}

function valueHasNul(value: unknown, depth: number): boolean {
  if (typeof value === "string") return value.includes(NUL);
  if (value === null || typeof value !== "object" || depth >= MAX_BODY_DEPTH) return false;
  if (Array.isArray(value)) return value.some((entry) => valueHasNul(entry, depth + 1));
  return Object.values(value as Record<string, unknown>).some((entry) => valueHasNul(entry, depth + 1));
}

/** Mount after the body parser and ahead of every route. */
export const rejectNulBytes: RequestHandler = (req, res, next) => {
  if (urlHasNul(req.originalUrl) || valueHasNul(req.body, 0)) {
    return res.status(400).json({ error: "Invalid request" });
  }
  next();
};
