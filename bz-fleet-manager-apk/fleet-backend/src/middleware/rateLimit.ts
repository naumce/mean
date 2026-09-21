import type { NextFunction, Request, Response } from "express";

// Fixed-window in-memory rate limiter for the public (unauthenticated)
// endpoints — signup, login, webhook ingest. Single-process by design: this
// deploys as one Node process; a multi-instance deployment would move the
// counters to Redis behind the same interface.
//
// RATE_LIMIT_DISABLED=1 turns every limiter into a passthrough — the test
// suites hammer login dozens of times per file and must not trip it; the
// middleware itself is unit-tested directly.

interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Distinguishes counters between routes sharing one client IP. */
  name: string;
  /** Optional extra key (e.g. the webhook API key) so abuse of one credential
   *  never throttles another tenant behind the same NAT. */
  keyFrom?: (req: Request) => string;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

const SWEEP_THRESHOLD = 10_000;

export function rateLimit(opts: RateLimitOptions) {
  const hits = new Map<string, WindowEntry>();

  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.RATE_LIMIT_DISABLED === "1") return next();
    const now = Date.now();

    // Bounded memory: sweep expired windows once the map grows large; if an
    // attacker floods unique keys faster than they expire, drop all counters
    // rather than grow without bound (losing state under attack is the safe
    // failure — the paired IP limiter still throttles the flood).
    if (hits.size > SWEEP_THRESHOLD) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      if (hits.size > SWEEP_THRESHOLD * 2) hits.clear();
    }

    // keyFrom is attacker-controlled input — cap it so keys stay small.
    const key = `${opts.name}:${req.ip}:${(opts.keyFrom?.(req) ?? "").slice(0, 64)}`;
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > opts.max) {
      res.setHeader("retry-after", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return res.status(429).json({ error: "Too many requests — please slow down" });
    }
    return next();
  };
}

const envInt = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

const MINUTE = 60_000;

/** 10 signups / 15 min / IP — org creation is rare and expensive. */
export const signupLimiter = () =>
  rateLimit({ name: "signup", windowMs: 15 * MINUTE, max: envInt("RATE_LIMIT_SIGNUP_MAX", 10) });

/** 30 login attempts / 15 min / IP — brute-force guard, generous for humans. */
export const loginLimiter = () =>
  rateLimit({ name: "login", windowMs: 15 * MINUTE, max: envInt("RATE_LIMIT_LOGIN_MAX", 30) });

/** Webhook throttling is two layers: a coarse per-IP cap first (the per-key
 *  bucket alone is bypassable by rotating garbage keys — every request would
 *  mint a fresh window), then 120/min per API key so tenants sharing a NAT
 *  never starve each other. */
export const webhookLimiters = () => [
  rateLimit({ name: "webhook-ip", windowMs: MINUTE, max: envInt("RATE_LIMIT_WEBHOOK_IP_MAX", 600) }),
  rateLimit({
    name: "webhook",
    windowMs: MINUTE,
    max: envInt("RATE_LIMIT_WEBHOOK_MAX", 120),
    keyFrom: (req) => req.header("x-api-key") ?? "",
  }),
];

/** 60 refresh calls / 15 min / IP — rotation is cheap for clients but each
 *  success writes a 30-day revocation row. */
export const refreshLimiter = () =>
  rateLimit({ name: "refresh", windowMs: 15 * MINUTE, max: envInt("RATE_LIMIT_REFRESH_MAX", 60) });
