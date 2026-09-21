import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../lib/password.js";
import { signDispatcherAccess, signDispatcherRefresh } from "../lib/tokens.js";
import { validateBody } from "../middleware/validate.js";
import { loginLimiter, signupLimiter } from "../middleware/rateLimit.js";
import { respondToWriteConflict } from "../lib/writeConflict.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import { STANDARD_POLICY } from "../lib/agentPolicies.js";
import { planOf } from "../lib/plans.js";

// Mounted at "/api/auth" — sibling of authRouter's "/driver/login", giving
// "/api/auth/dispatcher/login". Refresh/logout are NOT duplicated here: the
// shared "/api/auth/refresh" and "/api/auth/logout" routes already branch on
// the token payload's role.
export const dispatcherAuthRouter = Router();
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

// Self-serve onboarding: one call creates the Org and its first (org-scoped)
// dispatcher, then auto-logs-in so the portal can land straight on the board.
const signupSchema = z.object({
  orgName: z.string().trim().min(2).max(120),
  name: z.string().trim().min(1).max(120),
  email: z.string().email(),
  // Max 72: bcrypt silently ignores bytes past 72, so longer would lie to the user.
  password: z.string().min(8).max(72),
  timezone: z.string().trim().min(1).max(64).optional(),
  // Night Shift (spec §4a): which product this signup is for. Defaults to
  // "tower" so every existing signup — and every existing test — keeps
  // getting the full Control Tower plan it always got.
  product: z.enum(["nightshift", "tower"]).optional(),
});

/** Signup's "what vanished?" answer (lib/writeConflict.ts). The org and its
 *  first dispatcher are created together or not at all, so a failure here can
 *  never leave a half-made tenant behind. */
const SIGNUP_ROLLED_BACK =
  "Your organization could not be created — nothing was saved. Try signing up again.";

dispatcherAuthRouter.post("/dispatcher/signup", signupLimiter(), validateBody(signupSchema), asyncRoute(async (req, res) => {
  const { orgName, name, email, password, timezone, product } = req.body as z.infer<typeof signupSchema>;
  if (await prisma.dispatcher.findUnique({ where: { email } }))
    return res.status(409).json({ error: "An account with this email already exists" });
  const passwordHash = await hashPassword(password);
  try {
    const { org, dispatcher } = await prisma.$transaction(async (tx) => {
      const org = await tx.org.create({ data: { name: orgName, ...(timezone ? { timezone } : {}) } });
      const dispatcher = await tx.dispatcher.create({ data: { email, passwordHash, name, orgId: org.id } });
      // Night Shift (spec §17.2): every org gets a Standard agent policy the
      // moment it exists, so a load can be switched on without a dispatcher
      // ever visiting a policy screen first.
      await tx.agentPolicy.upsert({
        where: { orgId_name: { orgId: org.id, name: STANDARD_POLICY.name } },
        create: { ...STANDARD_POLICY, orgId: org.id, dispatcherEmail: email },
        update: {},
      });
      // Night Shift sheet slices (spec §4a/§7.1/§5.2): the link secret signs
      // sheet callback links that must work without a dispatcher session.
      // The Plan row itself already exists — the `org_default_plan` DB
      // trigger (migration 20260920103547_night_shift_sheet) created it with
      // tier 'tower' the instant the Org insert above committed. Signup only
      // needs to overwrite that default when the product asked for the
      // other tier.
      await tx.org.update({ where: { id: org.id }, data: { linkSecret: randomBytes(32).toString("hex") } });
      if (product === "nightshift") await tx.plan.update({ where: { orgId: org.id }, data: { tier: "sheet" } });
      return { org, dispatcher };
    });
    const { passwordHash: _ph, ...safe } = dispatcher;
    const refresh = signDispatcherRefresh(dispatcher.id);
    const { tier } = await planOf(org.id);
    // Explicit field list, same reasoning as login/`/me` below — the raw Org
    // row now carries `linkSecret`, which must never reach a client response.
    return res.status(201).json({
      org: { id: org.id, name: org.name, timezone: org.timezone },
      dispatcher: safe, token: signDispatcherAccess(dispatcher.id), refreshToken: refresh.token,
      plan: { tier },
    });
  } catch (err) {
    // The pre-check races with concurrent signups; the unique index is the
    // authority. Checked BEFORE the shared mapper, which would answer the same
    // P2002 with its generic "a concurrent commit touched this driver or load"
    // — true, but useless to someone typing an email into a signup form.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
      return res.status(409).json({ error: "An account with this email already exists" });
    // Everything else the transaction can raise — a Postgres deadlock or
    // serialization failure against a concurrent write — used to reach
    // `throw err` out of an un-awaited async Express handler, so the signup
    // button spun with NO response and no account. Nothing can VANISH on this
    // path (the transaction only creates), so the message says what actually
    // happened: nothing was saved, and a retry is safe precisely because of
    // that.
    if (respondToWriteConflict(res, err, SIGNUP_ROLLED_BACK)) return;
    throw err;
  }
}));

dispatcherAuthRouter.post("/dispatcher/login", loginLimiter(), validateBody(loginSchema), asyncRoute(async (req, res) => {
  const { email, password } = req.body as z.infer<typeof loginSchema>;
  const dispatcher = await prisma.dispatcher.findUnique({ where: { email } });
  // Constant-work compare (DUMMY_HASH) so timing doesn't reveal which emails exist.
  if (!(await verifyPassword(password, dispatcher?.passwordHash ?? DUMMY_HASH)) || !dispatcher)
    return res.status(401).json({ error: "Invalid email or password" });
  const { passwordHash, ...safe } = dispatcher;
  const refresh = signDispatcherRefresh(dispatcher.id);
  // The org travels with the login so the portal can render org-local time
  // (cockpit) without a second round-trip. Legacy/unscoped dispatchers: null.
  const org = dispatcher.orgId
    ? await prisma.org.findUnique({ where: { id: dispatcher.orgId }, select: { id: true, name: true, timezone: true } })
    : null;
  // Legacy/unscoped dispatchers (orgId null) have no plan to read — same
  // null-org case as `org` above. Every ORG, by contrast, is guaranteed a
  // Plan by the `org_default_plan` DB trigger, so `planOf` here is safe to
  // let throw rather than silently reporting `plan: null` for a real org.
  const plan = dispatcher.orgId ? { tier: (await planOf(dispatcher.orgId)).tier } : null;
  res.json({ dispatcher: safe, token: signDispatcherAccess(dispatcher.id), refreshToken: refresh.token, org, plan });
}));

// A4-R12: "who am I". A session that already has a valid token but no
// dispatcher identity (a reload from before identity persistence shipped, or
// one whose localStorage disagrees with the server) needs a way to recover
// it without logging in again. Deliberately a SEPARATE router
// (dispatcherMeRouter, below) rather than one more path on
// dispatcherAuthRouter: that router is mounted at the public "/api/auth"
// prefix (login/signup must be reachable pre-token), while this route must
// sit behind the same requireAuth + requireDispatcher + attachOrgScope gate
// every other /api/dispatcher route gets — see app.ts's "ONE structural
// gate" comment. Mounting dispatcherAuthRouter a second time under
// "/api/dispatcher" would have worked too, but it would also re-expose
// /dispatcher/login and /dispatcher/signup as dead, confusing paths behind
// that gate. A dedicated router with just this one route avoids that.
export const dispatcherMeRouter = Router();

dispatcherMeRouter.get("/auth/me", asyncRoute(async (req, res) => {
  // requireDispatcher (ahead of this route on the /api/dispatcher gate)
  // guarantees req.auth.role === "dispatcher", so dispatcherId is set.
  const dispatcherId = req.auth!.dispatcherId!;
  // Explicit field list — never the whole row. This route's entire job is
  // handing a dispatcher row to the browser; a bare `findUnique` without
  // `select` would serve passwordHash straight to the client.
  const dispatcher = await prisma.dispatcher.findUnique({
    where: { id: dispatcherId },
    select: { id: true, email: true, name: true, orgId: true },
  });
  // attachOrgScope (also ahead of this route) already looked this dispatcher
  // up once and would have 403'd if the row were gone — this guards only the
  // theoretical race of a delete landing between that check and this query.
  if (!dispatcher) return res.status(401).json({ error: "Dispatcher not found" });
  // orgId stays ON the response — it's the tenant id, and `org` right next
  // to it already carries the whole org object, so echoing it too leaks
  // nothing new. It used to be stripped here; that made this the one auth
  // path whose dispatcher shape silently disagreed with login/signup's (both
  // return the full row minus passwordHash, orgId included), which cost a
  // portal-side cast to paper over. One shape from every path now — the only
  // deliberate omission left is `createdAt`, which nothing reads.
  const org = dispatcher.orgId
    ? await prisma.org.findUnique({ where: { id: dispatcher.orgId }, select: { id: true, name: true, timezone: true } })
    : null;
  const plan = dispatcher.orgId ? { tier: (await planOf(dispatcher.orgId)).tier } : null;
  res.json({ dispatcher, org, plan });
}));
