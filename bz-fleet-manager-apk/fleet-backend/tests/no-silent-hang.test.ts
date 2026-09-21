import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { asyncRoute } from "../src/lib/asyncRoute.js";
import { settleDeadline } from "../src/middleware/settleDeadline.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

// Plan A5 task 7, fix round 1.
//
// This file carries two independent guarantees against the same class of bug
// — "an async function on the request path that never settles gets no
// response" — checked two different ways because one check alone missed a
// live instance:
//
//   1. STATIC: every `async (req...)` function under src/routes AND
//      src/middleware is wrapped in asyncRoute(), so a REJECTION always
//      reaches the error handler instead of vanishing (Task 1's guard,
//      extended here to also scan src/middleware — see "fix round 1" below).
//   2. RUNTIME: settleDeadline, mounted first in the whole chain (app.ts),
//      answers 503 for a request that never settles at all, whichever layer
//      — middleware or handler — is the one that hung.
//
// --- Fix round 1: what the original guard missed ---------------------------
//
// The first version of this file's static guard walked only src/routes.
// `src/middleware/orgScope.ts`'s `attachOrgScope` — an `async (req, res,
// next)` function mounted on the `/api/dispatcher` gate (app.ts), ahead of
// every authenticated dispatcher route — was structurally invisible to it:
// middleware was never in scope. The live proof found the actual
// consequence, not a theoretical one: with the database stopped, a real
// authenticated GET hung for 120s with no response, because attachOrgScope
// awaits `prisma.dispatcher.findUnique(...)` before any route handler runs,
// and (at the time) the settle deadline lived inside asyncRoute, which only
// wraps handlers — a request that never reaches one never reaches it either.
// Both fixes are here: attachOrgScope is now wrapped (so its rejection also
// reaches the error handler), and the static guard below now scans
// src/middleware too, so the SAME shape of bug anywhere else in that
// directory fails this test instead of waiting for a live outage to find it.

// ---------------------------------------------------------------------------
// 1. STATIC GUARD: every async(req...) under src/routes + src/middleware is
//    wrapped in asyncRoute().
// ---------------------------------------------------------------------------

interface Offender {
  file: string;
  line: number;
  snippet: string;
}

/** Strips `//` and `/* *\/` comments while leaving string and template
 *  literal contents untouched (so a route path or a doc-comment quoted in a
 *  string never gets mangled) and preserving newlines everywhere, so line
 *  numbers reported below still match the real file. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : "";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      out += src[i] ?? "";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Matches an async arrow function whose first parameter is spelled `req` or
// `_req` — the only two spellings used for a request-carrying first param
// anywhere in src/routes or src/middleware. Deliberately does NOT match
// `async function name(req` (a named helper, e.g. dispatcherLoadTruth.ts's
// `ownLoad`) — those are never registered as handlers directly, so wrapping
// is the caller's job, not theirs; and does not match other first-param
// names used for unrelated async arrows (`tx`, `c`, `bp`, ...).
const HANDLER_RE = /async\s*\(\s*_?req\b/g;
const WRAP_PREFIX = "asyncRoute(";

function findOffenders(file: string, source: string): Offender[] {
  const stripped = stripComments(source);
  const offenders: Offender[] = [];
  HANDLER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HANDLER_RE.exec(stripped))) {
    const idx = m.index;
    const before = stripped.slice(0, idx).trimEnd();
    if (before.endsWith(WRAP_PREFIX)) continue; // wrapped — not an offender
    const line = stripped.slice(0, idx).split("\n").length;
    const snippet = stripped.slice(idx, idx + 60).replace(/\s+/g, " ").trim();
    offenders.push({ file, line, snippet });
  }
  return offenders;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      out.push(...listTsFiles(full));
      continue;
    }
    if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Resolved from this file's own location, not process.cwd() — vitest's cwd
// is the package root today, but this must not depend on that staying true.
const ROOTS = ["../src/routes", "../src/middleware"].map((rel) =>
  fileURLToPath(new URL(rel, import.meta.url)),
);

function scanForOffenders(): Offender[] {
  return ROOTS.flatMap((root) =>
    listTsFiles(root).flatMap((file) => findOffenders(file, readFileSync(file, "utf8"))),
  );
}

describe("every async(req...) handler/middleware is wrapped in asyncRoute()", () => {
  it("flags an unwrapped fixture and clears the same fixture once wrapped", () => {
    const bad = 'someRouter.post("/fixture", someMiddleware(), async (req, res) => { await x(); });';
    const good = 'someRouter.post("/fixture", someMiddleware(), asyncRoute(async (req, res) => { await x(); }));';
    // Also proves prose describing a handler in a comment is not mistaken
    // for one (dispatcherAssignments.ts's priceOrRefuse doc comment was a
    // real false positive before comment-stripping existed).
    const commentOnly = '// these are async (req, res) handlers, see below\nsomeRouter.post("/x", asyncRoute(async (req, res) => {}));';

    expect(findOffenders("fixture.ts", bad)).toHaveLength(1);
    expect(findOffenders("fixture.ts", good)).toHaveLength(0);
    expect(findOffenders("fixture.ts", commentOnly)).toHaveLength(0);
  });

  it("has zero unwrapped async(req...) functions in src/routes or src/middleware", () => {
    const offenders = scanForOffenders();
    if (offenders.length > 0) {
      const report = offenders.map((o) => `  ${o.file}:${o.line} — ${o.snippet}`).join("\n");
      throw new Error(`${offenders.length} unwrapped async(req...) function(s) found:\n${report}`);
    }
    expect(offenders).toHaveLength(0);
  });

  // attachOrgScope is a named function expression — `asyncRoute(async
  // function attachOrgScope(req, res, next) {...})` — not the anonymous
  // arrow HANDLER_RE looks for, because asyncRoute (src/lib/asyncRoute.ts)
  // now carries a wrapped function's .name onto its returned wrapper so
  // Express's router stack still shows "attachOrgScope" for
  // tests/dispatcher-mount-order.test.ts to find. HANDLER_RE deliberately
  // never matches `async function name(req...` at all (src/routes has
  // legitimate non-handler helpers with that exact shape — ownLoad,
  // scopedTrip, resolveLaneOrNotFound, findOwnTenderOr404 — and flagging all
  // of them would be pure noise), which makes the broad guard above
  // structurally blind to attachOrgScope whether it is wrapped or not. It is
  // the one named-function-expression in this codebase that IS a directly
  // registered handler, so if a future edit ever strips the asyncRoute(...)
  // call around it while keeping the name, the broad guard would stay
  // silent and the middleware would silently regain the exact hang plan A5
  // task 7 fixed. This narrow, name-pinned check exists because nothing else
  // in this suite closes that gap.
  it("attachOrgScope specifically stays wrapped in asyncRoute (the one named-function handler HANDLER_RE cannot see)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/middleware/orgScope.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(/asyncRoute\(\s*async function attachOrgScope\s*\(/);
  });

  // dispatcherSheet.ts's `sheetOauthCallback` (task 7) is the second
  // named-function-expression handler in this codebase, for the same reason
  // attachOrgScope is one: it is mounted directly by app.ts as
  // `app.get("/api/dispatcher/sheet/oauth/callback", sheetOauthCallback)`,
  // ABOVE the "/api/dispatcher" gate, so Google's redirect (no bearer token)
  // can reach it — and asyncRoute's fn.name pass-through means naming it
  // matters here too, not just for attachOrgScope's own router-stack lookup.
  // Same blind spot, same fix: pin it by name so a future edit that strips
  // the asyncRoute(...) wrapper while keeping the name fails this test
  // instead of silently reintroducing an unwrapped handler outside the
  // dispatcher gate.
  it("sheetOauthCallback specifically stays wrapped in asyncRoute (the other named-function handler HANDLER_RE cannot see)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/routes/dispatcherSheet.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(/asyncRoute\(\s*async function sheetOauthCallback\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// 2. RUNTIME: settleDeadline answers instead of hanging, wherever the hang is.
// ---------------------------------------------------------------------------
//
// A short test-only HANDLER_DEADLINE_MS keeps this fast and deterministic
// rather than waiting on the real 30s default or actually stopping the
// database — see .env.example / .env.test for the connect_timeout layer this
// suite does NOT exercise (that requires a live Postgres to stop, which is
// the controller's manual step per the task brief).

/** settleDeadline mounted FIRST, exactly as app.ts mounts it, ahead of
 *  whatever middleware/handler combination each test wants to hang. */
function appWithChain(...middleware: express.RequestHandler[]) {
  const app = express();
  app.use(settleDeadline);
  app.get("/x", ...middleware);
  app.use(errorHandler);
  return app;
}

describe("settleDeadline", () => {
  const originalDeadline = process.env.HANDLER_DEADLINE_MS;

  afterEach(() => {
    if (originalDeadline === undefined) delete process.env.HANDLER_DEADLINE_MS;
    else process.env.HANDLER_DEADLINE_MS = originalDeadline;
  });

  it("answers 503 instead of hanging when the ROUTE HANDLER's promise never settles", async () => {
    process.env.HANDLER_DEADLINE_MS = "50";
    const app = appWithChain(asyncRoute(() => new Promise(() => {})));

    const res = await request(app).get("/x");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "TIMEOUT",
      message: "The request took too long to answer — try again",
    });
  });

  it("answers 503 instead of hanging when MIDDLEWARE ahead of the handler never settles — the case that escaped fix round 0", async () => {
    process.env.HANDLER_DEADLINE_MS = "50";
    // The exact shape of the live bug: an async middleware (like
    // attachOrgScope) that awaits something which never resolves, mounted
    // BEFORE the route handler. The handler never runs at all.
    let handlerRan = false;
    const hangingMiddleware = asyncRoute(() => new Promise(() => {}));
    const handler: express.RequestHandler = (_req, res) => {
      handlerRan = true;
      res.json({ ok: true });
    };
    const app = appWithChain(hangingMiddleware, handler);

    const res = await request(app).get("/x");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "TIMEOUT",
      message: "The request took too long to answer — try again",
    });
    expect(handlerRan).toBe(false);
  });

  it("does not cut off a request that responds slowly but within the deadline", async () => {
    process.env.HANDLER_DEADLINE_MS = "300";
    const handler: express.RequestHandler = (_req, res) => {
      setTimeout(() => res.json({ ok: true }), 60);
    };
    const app = appWithChain(handler);

    const res = await request(app).get("/x");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("never double-answers when the handler settles after its own deadline fired", async () => {
    process.env.HANDLER_DEADLINE_MS = "30";
    let handlerRan = false;
    const handler: express.RequestHandler = (_req, res) => {
      setTimeout(() => {
        handlerRan = true;
        if (!res.headersSent) res.json({ ok: true });
      }, 120);
    };
    const app = appWithChain(handler);

    const res = await request(app).get("/x");

    expect(res.status).toBe(503);
    // Give the handler's own (later) settlement a chance to run and confirm
    // it did not throw or attempt a second response.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(handlerRan).toBe(true);
  });
});
