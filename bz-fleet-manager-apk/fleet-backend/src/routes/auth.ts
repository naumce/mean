import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { verifyPassword } from "../lib/password.js";
import { signAccess } from "../lib/tokens.js";
import { validateBody } from "../middleware/validate.js";

export const authRouter = Router();
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

authRouter.post("/driver/login", validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body as z.infer<typeof loginSchema>;
  const driver = await prisma.driver.findUnique({ where: { email }, include: { vehicle: true } });
  if (!driver || !(await verifyPassword(password, driver.passwordHash)))
    return res.status(401).json({ error: "Invalid email or password" });
  const { passwordHash, vehicle, ...safe } = driver;
  res.json({
    driver: safe, vehicle: vehicle ?? null,
    token: signAccess(driver.id), requiresPasswordChange: driver.requiresPasswordChange,
  });
});
