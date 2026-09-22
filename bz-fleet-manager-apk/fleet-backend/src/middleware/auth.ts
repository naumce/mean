import type { RequestHandler } from "express";
import { verifyAccess } from "../lib/tokens.js";
// `driverId` stays required (not `?`) so the ~12 existing driver routes that
// read `req.auth!.driverId` without any role narrowing keep type-checking
// exactly as before. For a dispatcher-authenticated request there is no real
// driverId, so we fill in a sentinel that can never match a real driver uuid
// (`""`) rather than `undefined` — Prisma silently *drops* `undefined` filter
// values, so `undefined` here would strip the ownership filter out of every
// `where: { ..., driverId: req.auth!.driverId }` query and let a dispatcher
// token walk through driver-scoped routes unfiltered. `""` fails closed instead.
const NO_DRIVER = "";

declare global {
  namespace Express {
    interface Request { auth?: { driverId: string; dispatcherId?: string; role: "driver" | "dispatcher" } }
  }
}

export const requireAuth: RequestHandler = (req, res, next) => {
  // apiKeyAuth (mounted ahead of this on /api/dispatcher, Task 5) already
  // authenticated this request against OrgApiKey and set req.orgScope
  // itself — there is no bearer token to check and none is required. See
  // apiKeyAuth.ts's own comment for the full mount-order reasoning.
  if (req.viaApiKey) return next();
  const h = req.header("authorization");
  if (!h?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing token" });
  try {
    const payload = verifyAccess(h.slice(7));
    req.auth = payload.role === "dispatcher"
      ? { driverId: NO_DRIVER, dispatcherId: payload.dispatcherId, role: "dispatcher" }
      : { driverId: payload.driverId, role: "driver" };
    next();
  } catch { return res.status(401).json({ error: "Invalid token" }); }
};

// dispatcher-only gate: layered after requireAuth on dispatcher routes.
export const requireDispatcher: RequestHandler = (req, res, next) => {
  // Same reasoning as requireAuth above: an API-key request has no
  // req.auth at all (there was no bearer token to derive it from), so the
  // role check below would 403 it. apiKeyAllowList (mounted right after
  // this gate, app.ts) is what actually restricts a key to its routes.
  if (req.viaApiKey) return next();
  if (req.auth?.role !== "dispatcher") return res.status(403).json({ error: "Forbidden" });
  next();
};
