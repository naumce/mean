// Task 10 review, fix round 1 — the org token IS a bearer credential (it
// authenticates every /api/n request with no session behind it, per
// lib/nightShiftLink.ts's verifyOrgToken), and it travels in the URL path:
// `/api/n/<orgToken>/loads/:id/agent`. Any logger that prints a request's raw
// URL (middleware/errorHandler.ts, middleware/settleDeadline.ts, and
// whatever gets added later) would otherwise write that credential straight
// into the server's logs — the same class of leak a query-string API key
// would be, just in the path instead. One redaction function, used
// everywhere a URL is logged, rather than trusting each call site to
// remember.

// Stops at "/" (the next path segment) or "?" (a query string) — so
// `/api/n/<token>?x=1` redacts only the token, leaving `?x=1` in place, and
// `/api/n/<token>/loads/...` redacts only the first segment.
const ORG_TOKEN_PATH = /^\/api\/n\/[^/?]+/;

/** Replaces the org-token segment of an `/api/n/<orgToken>/...` path with a
 *  fixed placeholder; every other path (including a malformed or partial
 *  `/api/n` one with no token segment at all — `^/api/n/[^/?]+` requires at
 *  least one non-"/"/"?" character after `/api/n/`) is returned unchanged.
 *  Takes the raw string a logger already has (`req.originalUrl`, `req.url`)
 *  — no URL parsing, so it works the same whether the caller passes a full
 *  path, a path+query, or a bare path. */
export function redactUrl(url: string): string {
  return url.replace(ORG_TOKEN_PATH, "/api/n/[redacted]");
}
