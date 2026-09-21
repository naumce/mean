import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { verifyOrgToken } from "../lib/nightShiftLink.js";
import { timelineFor } from "../lib/agentTimeline.js";
import { queueCommand } from "../lib/agentCommands.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import { rateLimit } from "../middleware/rateLimit.js";

// The deep link (Task 10, spec §6.2/§17.5): a status cell's note URL, and
// escalation SMS/email, carry ${PORTAL_URL}/n/<orgToken>/<loadId> — opened on
// a phone with no dispatcher session at all. This router authenticates by
// the org token itself (lib/nightShiftLink.ts's verifyOrgToken, constant-
// time) instead of a bearer, so it is mounted at "/api/n" in app.ts,
// OUTSIDE the /api/dispatcher gate (requireAuth/requireDispatcher/
// attachOrgScope would 401/403 a request that carries no Authorization
// header at all).
//
// It exposes exactly the two things a phone needs to supervise a run — the
// timeline and the supervision commands — sharing their bodies and writes
// byte-for-byte with the dispatcher's own routes via lib/agentTimeline.ts and
// lib/agentCommands.ts (dispatcherNightShift.ts calls the same two
// functions). No switch or policy route exists under this router: the link
// supervises, it never configures.
export const nightShiftLinkRouter = Router();

const LOAD_NOT_FOUND = "Load not found";

const validationMessage = (err: z.ZodError): string =>
  err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

// A bearer credential embedded in a URL is more exposed than one in an
// Authorization header — browser history, referrer headers, an email/SMS
// client that prefetches links — so this surface gets its own light limiter,
// reusing the same `rateLimit` factory the auth routes already use
// (RATE_LIMIT_DISABLED=1 keeps the test suites from tripping it, same as
// every other limiter in this file's family).
const linkLimiter = rateLimit({ name: "night-shift-link", windowMs: 60_000, max: 60 });

nightShiftLinkRouter.get("/:orgToken/loads/:id/agent", linkLimiter, asyncRoute(async (req, res) => {
  const orgId = await verifyOrgToken(req.params.orgToken as string);
  if (!orgId) return res.status(404).json({ error: LOAD_NOT_FOUND });

  const body = await timelineFor(req.params.id as string, orgId);
  if (!body) return res.status(404).json({ error: LOAD_NOT_FOUND });
  // The link's policy is its name and whether it is shadow — never the
  // dispatcher's own email/phone (final fix wave, minor): this URL travels
  // in SMS and email, and the phone page needs nothing more. The
  // dispatcher's own route (dispatcherNightShift.ts) keeps the full policy.
  const { id, name, shadow } = body.policy;
  res.json({ ...body, policy: { id, name, shadow } });
}));

// Identical vocabulary to dispatcherNightShift.ts's own commandSchema — kept
// as its own literal here (not imported) so this router's zod contract does
// not silently drift if dispatcherNightShift.ts's ever adds a dispatcher-only
// kind; the two are asserted to match in tests/sheet/link.test.ts.
const COMMAND_KINDS = ["stop", "call", "reply", "correct", "takeover", "handback", "send_customer_email"] as const;
const commandSchema = z.object({
  kind: z.enum(COMMAND_KINDS),
  payload: z.unknown().optional(),
});

nightShiftLinkRouter.post("/:orgToken/loads/:id/agent/commands", linkLimiter, asyncRoute(async (req, res) => {
  const orgId = await verifyOrgToken(req.params.orgToken as string);
  if (!orgId) return res.status(404).json({ error: LOAD_NOT_FOUND });

  const parsed = commandSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: validationMessage(parsed.error) });

  const load = await prisma.load.findUnique({ where: { id: req.params.id as string }, select: { id: true, orgId: true } });
  if (!load || load.orgId !== orgId) return res.status(404).json({ error: LOAD_NOT_FOUND });

  // actorName: "link" — never a dispatcher's name, since no session exists
  // to name one. See lib/agentCommands.ts's queueCommand doc comment.
  const command = await queueCommand({ loadId: load.id, kind: parsed.data.kind, payload: parsed.data.payload, actorName: "link" });
  res.status(202).json({ command });
}));

// Nothing else exists under /api/n — no switch, no policy route (Global
// Constraint: the link supervises, it never configures). Without this
// catch-all, a request to an undefined path here (e.g. POST the switch)
// would fall through past this router to the broad "/api" mounts in app.ts
// (signsProofRouter et al., mounted at "/api" with their own unconditional
// requireAuth), which would answer 401 instead of the 404 an unrecognized
// route must give.
nightShiftLinkRouter.use((_req, res) => {
  res.status(404).json({ error: LOAD_NOT_FOUND });
});
