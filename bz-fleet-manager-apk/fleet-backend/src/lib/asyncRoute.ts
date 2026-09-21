import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wrap an async route handler so a rejection reaches Express.
 *
 * Express 4 calls a handler and ignores whatever it returns. Hand it an
 * `async` function and a rejected promise goes nowhere: no response is sent,
 * no error middleware runs, and the client waits until it gives up. That is
 * not a theoretical hazard — it has shipped in this codebase more than once,
 * and the last audit found five live instances.
 *
 * Wrapping forwards the rejection to `next`, where the terminal error
 * handler answers it. Routes that already catch their own errors lose
 * nothing by being wrapped; the wrapper only sees what they re-throw.
 *
 * This is deliberately ALL this does. An earlier version of this file also
 * carried a settle deadline — a timer that answered 503 if a wrapped
 * handler's promise neither resolved nor rejected in time — but a deadline
 * that lives inside the handler wrapper can only ever bound the handler.
 * `src/middleware/orgScope.ts`'s `attachOrgScope`, mounted ahead of every
 * authenticated dispatcher route (app.ts), awaits the database BEFORE any
 * route handler runs; with the database gone it hung there, and this file's
 * deadline never got a chance to run because the request never reached a
 * route handler at all (plan A5 task 7, fix round 1 — found by the live
 * proof: `GET /api/dispatcher/loads` with the database stopped, 120s, no
 * response, curl gave up).
 *
 * The deadline now lives in src/middleware/settleDeadline.ts, mounted first
 * in the whole chain (src/app.ts), where it bounds every layer — middleware
 * included — instead of just the last one. `attachOrgScope` itself is now
 * wrapped the same way a route handler is (see orgScope.ts) so its OWN
 * rejection still reaches this file's `.catch(next)` rather than vanishing;
 * that is a separate concern from the deadline and belongs here, not there.
 */
export function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  const wrapper: RequestHandler = (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
  // Carry the wrapped function's name onto the wrapper. An arrow function
  // returned bare like this has no name of its own (`(req, res, next) =>
  // {}` assigned to nothing), and Express keeps its mounted layers on
  // `app._router.stack` identified BY THAT NAME —
  // tests/dispatcher-mount-order.test.ts locates the tenant gate with
  // `layer.name === "attachOrgScope"`. Erasing the name here made that
  // structural guard blind to the very thing it exists to protect (plan A5
  // task 7, fix round 1 — wrapping attachOrgScope in this function dropped
  // `countOfName(stack, "attachOrgScope")` from 1 to 0 even though the
  // product behaved identically). A wrapper that erases identity makes every
  // structural test downstream weaker, and this one just proved it.
  // `fn.name` is empty for the common case (an anonymous arrow passed
  // inline, e.g. most `asyncRoute(async (req, res) => {...})` call sites,
  // since JS does not infer a name for a function passed as a bare call
  // argument) — fall back to "wrappedHandler" rather than leave the
  // wrapper's own name blank in that case.
  Object.defineProperty(wrapper, "name", {
    value: fn.name || "wrappedHandler",
    configurable: true,
  });
  return wrapper;
}
