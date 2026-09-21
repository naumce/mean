import type { RequestHandler } from "express";
import { redactUrl } from "../lib/redactUrl.js";

/**
 * Bounds an ENTIRE request — every middleware in front of the route handler,
 * and the handler itself — to a maximum time before answering on the
 * request's behalf. Mounted first, ahead of every other middleware
 * (src/app.ts), so nothing downstream can opt out of it by being unwrapped
 * or by running before a route is even reached.
 *
 * --- Why this lives here and not in asyncRoute (plan A5 task 7, fix round 1) ---
 *
 * The first version of this deadline lived inside `asyncRoute`
 * (src/lib/asyncRoute.ts) and only covered the promise returned by a
 * wrapped ROUTE HANDLER. The live proof found the gap: `src/middleware/
 * orgScope.ts`'s `attachOrgScope` — mounted on the `/api/dispatcher` gate
 * (app.ts), in front of every authenticated dispatcher route — is itself an
 * `async` function that awaits `prisma.dispatcher.findUnique(...)` BEFORE
 * any route handler runs. With the database gone it hangs there. Measured:
 * `GET /api/dispatcher/loads` with the database stopped answered nothing for
 * 120 seconds (curl gave up); the 30s deadline never fired, because the
 * request never reached a route handler — and asyncRoute's deadline lived on
 * the handler, not the request.
 *
 * A deadline that lives in the handler wrapper can only ever bound the
 * handler. Anything mounted ahead of it — today's orgScope, and whatever
 * gets added ahead of a route tomorrow — is invisible to it by construction.
 * Mounting the SAME deadline here instead, first in the whole chain, bounds
 * the request regardless of which layer hangs. It is tied to the response
 * object (`res`'s `finish`/`close` events), not to any one promise, so it
 * does not care whether the hang is in a route handler, in `attachOrgScope`,
 * or in something mounted between them next year.
 *
 * `asyncRoute` goes back to doing only what it was always right to do —
 * converting a REJECTED promise into a response. That is a genuinely
 * different hazard (a promise that settles-with-an-error vs one that never
 * settles at all) and stays solved where it already was.
 */

/** The slowest legitimate single external call anywhere in this codebase is
 *  the 12s truck-routing provider fetch (src/lib/routing.ts's
 *  PROVIDER_TIMEOUT_MS) — 30s leaves room for a couple of those plus normal
 *  Postgres round trips within one request, while staying short enough that
 *  a dispatcher watching a spinner still remembers what they clicked when it
 *  finally answers. A deployment that does heavy bulk provider work in a
 *  single request (e.g. resolving many uncached lanes in one import burst)
 *  should raise HANDLER_DEADLINE_MS for itself rather than have every other
 *  route in the product wait longer for that one case. Overridable via
 *  HANDLER_DEADLINE_MS (ms); tests/no-silent-hang.test.ts uses a short
 *  override so the suite never waits on the real default. */
const DEFAULT_HANDLER_DEADLINE_MS = 30_000;

function handlerDeadlineMs(): number {
  const raw = process.env.HANDLER_DEADLINE_MS;
  if (!raw) return DEFAULT_HANDLER_DEADLINE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HANDLER_DEADLINE_MS;
}

/** Mount FIRST in src/app.ts, ahead of cors/json/every route — see the
 *  comment above for why position is the entire point. */
export const settleDeadline: RequestHandler = (req, res, next) => {
  const deadlineMs = handlerDeadlineMs();
  const timer = setTimeout(() => {
    // Something downstream already answered and is merely still doing
    // something afterward (an un-awaited best-effort write, say) — that is
    // not a hang, and answering again would crash on "headers already sent"
    // while masking whatever it actually returned.
    if (res.headersSent) return;
    console.error(
      `[handler-timeout] ${req.method} ${redactUrl(req.originalUrl)} did not settle within ${deadlineMs}ms`,
    );
    res.status(503).json({
      error: "TIMEOUT",
      message: "The request took too long to answer — try again",
    });
  }, deadlineMs);
  // A pending deadline must never be the reason the process stays up (tests,
  // graceful shutdown, a short-lived script).
  timer.unref();
  const clear = (): void => clearTimeout(timer);
  // 'finish': the normal case — the response was fully sent. 'close': the
  // client hung up before that happened. Either way the request is over and
  // there is nothing left to bound; leaving the timer pending until its
  // deadline would just be a stray handle for a request that has already
  // ended (harmless since it's unref'd and headersSent-guarded, but pointless).
  res.once("finish", clear);
  res.once("close", clear);
  next();
};
