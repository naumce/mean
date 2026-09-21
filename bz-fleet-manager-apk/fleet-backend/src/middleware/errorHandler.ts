import type { ErrorRequestHandler } from "express";
import { redactUrl } from "../lib/redactUrl.js";

// The API had no error-handling middleware at all, so every failure fell
// through to Express's built-in one. Outside production that handler
// serialises `err.stack` into the response body — on this service that hands
// an unauthenticated caller absolute file paths, the failing SQL, and
// whatever row data the driver put in the error message. This replaces it
// with a body that says nothing more than `{ error: "INTERNAL", message }`.
//
// Register with app.use() AFTER every route: Express selects error handlers by
// arity (four parameters), and only ones mounted below the failing layer are
// reached.
//
// What it can and cannot catch: synchronous throws in a handler, anything
// passed to next(err) — which includes body-parser's malformed-JSON 400 and
// Express's undecodable-%xx 400 — and, as of plan A5, a rejected promise from
// an `async (req, res)` handler too. Express 4 never awaits a handler, so on
// its own that rejection would go nowhere; src/lib/asyncRoute.ts is what
// makes it land here — every route handler is wrapped in asyncRoute(), whose
// `.catch(next)` forwards the rejection into this chain. A handler written
// without that wrapper is back to the old failure mode (no response, ever),
// which is exactly what tests/no-silent-hang.test.ts exists to catch at the
// source rather than here. src/lib/processGuards.ts is a separate, narrower
// net: it stops an unhandled rejection from crashing the process, but the
// request that triggered it still gets no response — it is not a substitute
// for asyncRoute() and is not what makes this handler reachable.

/** Express tags its own client-side failures with a 4xx `status`/`statusCode`
 *  (body-parser's `entity.parse.failed`, `entity.too.large`, the router's
 *  `decode_param` URIError). Those are the caller's fault and keep their own
 *  code; anything unlabelled is ours and is reported as a bare 500. */
function clientStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as { status?: unknown; statusCode?: unknown };
  const raw =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : null;
  return raw !== null && raw >= 400 && raw < 500 ? raw : null;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Once the response has started there is nothing safe left to send; Express's
  // built-in handler is the only thing that can still tear the socket down.
  if (res.headersSent) return next(err);
  const status = clientStatus(err) ?? 500;
  // Server-side only, and only for our own faults — a 400 is already fully
  // described to the caller and would just be log noise.
  if (status >= 500) console.error(`[error] ${req.method} ${redactUrl(req.originalUrl)}`, err);
  // Same `{ error: "INTERNAL", message }` shape every route's own catch block
  // already answers with (plan A4) — one body shape for a 500 everywhere in
  // the API, whether a handler caught its own failure or fell through to here.
  res.status(status).json(
    status >= 500
      ? { error: "INTERNAL", message: "That did not go through — try again" }
      : { error: "Invalid request" },
  );
};
