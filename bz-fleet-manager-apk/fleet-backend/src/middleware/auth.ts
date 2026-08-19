import type { RequestHandler } from "express";
import { verifyAccess } from "../lib/tokens.js";
declare global { namespace Express { interface Request { auth?: { driverId: string } } } }

export const requireAuth: RequestHandler = (req, res, next) => {
  const h = req.header("authorization");
  if (!h?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing token" });
  try { req.auth = { driverId: verifyAccess(h.slice(7)).driverId }; next(); }
  catch { return res.status(401).json({ error: "Invalid token" }); }
};
