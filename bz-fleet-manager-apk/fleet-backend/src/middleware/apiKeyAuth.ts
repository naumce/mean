import type { RequestHandler } from "express";
import { verifyKey } from "../lib/apiKeys.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Night Shift's machine auth path (Task 5, controller ruling): a request
// carrying `x-api-key` and NO bearer authorization is authenticated against
// `OrgApiKey` instead of a dispatcher session, and gets the same
// `req.orgScope` a session would — MCP (night-shift-mcp/) is the first
// caller, but nothing here is MCP-specific.
//
// Mounted BEFORE the session gate (`requireAuth, requireDispatcher,
// attachOrgScope` — app.ts). requireAuth/requireDispatcher/attachOrgScope
// each check `req.viaApiKey` first and let a flagged request straight
// through (see their own comments) rather than demanding a bearer token or
// re-deriving org scope this middleware already set. `apiKeyAllowList`,
// mounted right AFTER that gate, is what actually restricts which routes a
// key may reach — this file only answers "who is this", never "are they
// allowed here".

declare global {
  namespace Express {
    interface Request {
      /** True once apiKeyAuth has authenticated an x-api-key request. The
       *  session gate (auth.ts/orgScope.ts) reads this to skip the bearer
       *  path entirely rather than 401ing a request that was never going to
       *  carry one. */
      viaApiKey?: boolean;
      /** The verified key's own name, for actorOf() (lib/actor.ts) to build
       *  the "api:<name>" actor label a Night Shift trace line records. */
      apiKeyName?: string;
    }
  }
}

export const apiKeyAuth: RequestHandler = asyncRoute(async function apiKeyAuth(req, res, next) {
  const key = req.header("x-api-key");
  const bearer = req.header("authorization");
  // A bearer header present at all means a dispatcher session is being
  // attempted — leave that path to requireAuth untouched rather than let an
  // x-api-key header (a proxy or a stray client default) silently override
  // it or, worse, silently coexist with it.
  if (!key || bearer) return next();

  const verified = await verifyKey(key);
  // Role is always "nightshift" today (lib/apiKeys.ts only issues that
  // role), but checked explicitly rather than assumed — a future ingest-role
  // row landing in this same table must not accidentally grant Night Shift
  // routes.
  if (!verified || verified.role !== "nightshift") {
    return res.status(401).json({ error: "Invalid API key" });
  }
  req.orgScope = verified.orgId;
  req.viaApiKey = true;
  req.apiKeyName = verified.name;
  next();
});

/** Method + path (relative to the "/api/dispatcher" mount — Express trims
 *  the mount prefix off `req.path` for a use()-mounted function the same way
 *  it does for a nested Router) that an `x-api-key` request may reach. Every
 *  route an MCP tool calls, and nothing else — the key can never touch the
 *  sheet OAuth routes, and PUT .../policies/:id additionally refuses (below,
 *  in the route itself) a body that changes `shadow`, matching the "no tool
 *  can go live" rule (spec §10/§13). */
const ALLOWED: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: "GET", pattern: /^\/night-shift\/policies$/ },
  { method: "PUT", pattern: /^\/night-shift\/policies\/[^/]+$/ },
  // Fix round 1: the MCP set_policy tool now PATCHes a partial body instead
  // of GET-merge-PUT (dispatcherNightShift.ts's PATCH route does the merge
  // server-side, against a fresh read, so nothing can land between the
  // MCP's read and its write).
  { method: "PATCH", pattern: /^\/night-shift\/policies\/[^/]+$/ },
  { method: "GET", pattern: /^\/night-shift\/loads$/ },
  { method: "GET", pattern: /^\/night-shift\/usage$/ },
  { method: "GET", pattern: /^\/loads\/lookup$/ },
  { method: "GET", pattern: /^\/loads\/[^/]+\/agent$/ },
  { method: "POST", pattern: /^\/loads\/[^/]+\/agent$/ },
  { method: "POST", pattern: /^\/loads\/[^/]+\/agent\/commands$/ },
];

/** Mounted immediately after the session gate (app.ts): a request that
 *  authenticated via apiKeyAuth above but is not on the allow-list gets a
 *  401, same status a missing/invalid key gets — a key is either good for a
 *  route or it does not exist as far as that route is concerned. A
 *  dispatcher's own bearer session is untouched (req.viaApiKey is never set
 *  for it), so every existing route keeps working exactly as before. */
export const apiKeyAllowList: RequestHandler = (req, res, next) => {
  if (!req.viaApiKey) return next();
  const allowed = ALLOWED.some((r) => r.method === req.method && r.pattern.test(req.path));
  if (!allowed) return res.status(401).json({ error: "This route does not accept an API key" });
  next();
};
