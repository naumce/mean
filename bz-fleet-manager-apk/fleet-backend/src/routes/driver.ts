import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

export const driverRouter = Router();
driverRouter.use(requireAuth);

driverRouter.get("/profile", async (req, res) => {
  const d = await prisma.driver.findUnique({ where: { id: req.auth!.driverId } });
  if (!d) return res.status(404).json({ error: "Not found" });
  const { passwordHash, ...safe } = d;
  res.json(safe);
});

driverRouter.put("/status", validateBody(z.object({ status: z.string().min(1) })), async (req, res) => {
  const d = await prisma.driver.update({
    where: { id: req.auth!.driverId }, data: { status: req.body.status } });
  res.json({ status: d.status });
});
