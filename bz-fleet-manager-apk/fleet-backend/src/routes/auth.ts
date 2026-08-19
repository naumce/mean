import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { verifyPassword } from "../lib/password.js";
import { signAccess, signRefresh, verifyRefresh } from "../lib/tokens.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

authRouter.post("/driver/login", validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body as z.infer<typeof loginSchema>;
  const driver = await prisma.driver.findUnique({ where: { email }, include: { vehicle: true } });
  if (!driver || !(await verifyPassword(password, driver.passwordHash)))
    return res.status(401).json({ error: "Invalid email or password" });
  const { passwordHash, vehicle, ...safe } = driver;
  const refresh = signRefresh(driver.id);
  res.json({
    driver: safe, vehicle: vehicle ?? null, token: signAccess(driver.id),
    refreshToken: refresh.token, requiresPasswordChange: driver.requiresPasswordChange,
  });
});

authRouter.post("/refresh", validateBody(z.object({ refreshToken: z.string() })), async (req, res) => {
  try {
    const { driverId, jti } = verifyRefresh(req.body.refreshToken);
    if (await prisma.revokedToken.findUnique({ where: { jti } }))
      return res.status(401).json({ error: "Token revoked" });
    await prisma.revokedToken.create({ data: { jti, expiresAt: new Date(Date.now() + 30 * 864e5) } });
    const next = signRefresh(driverId);
    res.json({ token: signAccess(driverId), refreshToken: next.token });
  } catch { res.status(401).json({ error: "Invalid refresh token" }); }
});

authRouter.post("/logout", requireAuth, validateBody(z.object({ refreshToken: z.string() })), async (req, res) => {
  try {
    const { jti } = verifyRefresh(req.body.refreshToken);
    await prisma.revokedToken.upsert({
      where: { jti }, create: { jti, expiresAt: new Date(Date.now() + 30 * 864e5) }, update: {} });
  } catch { /* already invalid — nothing to revoke */ }
  res.status(204).end();
});
