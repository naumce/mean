import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { DUMMY_HASH, verifyPassword } from "../lib/password.js";
import { signAccess, signDispatcherAccess, signDispatcherRefresh, signRefresh, verifyRefresh } from "../lib/tokens.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { loginLimiter, refreshLimiter } from "../middleware/rateLimit.js";
import { asyncRoute } from "../lib/asyncRoute.js";

export const authRouter = Router();
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

authRouter.post("/driver/login", loginLimiter(), validateBody(loginSchema), asyncRoute(async (req, res) => {
  const { email, password } = req.body as z.infer<typeof loginSchema>;
  const driver = await prisma.driver.findUnique({ where: { email }, include: { vehicle: true } });
  if (!(await verifyPassword(password, driver?.passwordHash ?? DUMMY_HASH)) || !driver)
    return res.status(401).json({ error: "Invalid email or password" });
  const { passwordHash, vehicle, ...safe } = driver;
  const refresh = signRefresh(driver.id);
  res.json({
    driver: safe, vehicle: vehicle ?? null, token: signAccess(driver.id),
    refreshToken: refresh.token, requiresPasswordChange: driver.requiresPasswordChange,
  });
}));

authRouter.post("/refresh", refreshLimiter(), validateBody(z.object({ refreshToken: z.string() })), asyncRoute(async (req, res) => {
  try {
    const payload = verifyRefresh(req.body.refreshToken);
    if (await prisma.revokedToken.findUnique({ where: { jti: payload.jti } }))
      return res.status(401).json({ error: "Token revoked" });
    await prisma.revokedToken.create({ data: { jti: payload.jti, expiresAt: new Date(Date.now() + 30 * 864e5) } });
    // Opportunistic drain of expired revocation rows — every successful
    // rotation adds one, so each rotation also sweeps the dead ones.
    prisma.revokedToken.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
    if (payload.role === "dispatcher") {
      const next = signDispatcherRefresh(payload.dispatcherId);
      return res.json({ token: signDispatcherAccess(payload.dispatcherId), refreshToken: next.token });
    }
    const next = signRefresh(payload.driverId);
    res.json({ token: signAccess(payload.driverId), refreshToken: next.token });
  } catch { res.status(401).json({ error: "Invalid refresh token" }); }
}));

authRouter.post("/logout", requireAuth, validateBody(z.object({ refreshToken: z.string() })), asyncRoute(async (req, res) => {
  try {
    const payload = verifyRefresh(req.body.refreshToken);
    // ownership check: only the token's own subject (driver or dispatcher) may
    // revoke it — otherwise an authed caller could revoke someone else's
    // session by guessing/reusing a refresh token that isn't theirs.
    const isOwner = payload.role === "dispatcher"
      ? payload.dispatcherId === req.auth!.dispatcherId
      : payload.driverId === req.auth!.driverId;
    if (isOwner) {
      await prisma.revokedToken.upsert({
        where: { jti: payload.jti }, create: { jti: payload.jti, expiresAt: new Date(Date.now() + 30 * 864e5) }, update: {} });
    }
  } catch { /* invalid token — nothing to revoke */ }
  res.status(204).end();
}));
