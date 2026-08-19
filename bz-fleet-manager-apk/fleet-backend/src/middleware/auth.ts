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
  if (req.auth?.role !== "dispatcher") return res.status(403).json({ error: "Forbidden" });
  next();
};
