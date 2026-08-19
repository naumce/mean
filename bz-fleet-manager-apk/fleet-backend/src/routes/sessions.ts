import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { canStartSession, canToggleBreak, canEndSession } from "../domain/sessionState.js";

export const sessionsRouter = Router();
sessionsRouter.use(requireAuth);

function openSession(driverId: string) {
  return prisma.driverSession.findFirst({ where: { driverId, status: { in: ["active", "on_break"] } } });
}

sessionsRouter.get("/", async (req, res) => {
  const session = await openSession(req.auth!.driverId);
  res.json(session ?? null);
});

sessionsRouter.post("/start", async (req, res) => {
  const existing = await openSession(req.auth!.driverId);
  const guard = canStartSession(existing);
  if (!guard.ok) return res.status(409).json({ error: guard.reason });
  const created = await prisma.driverSession.create({ data: { driverId: req.auth!.driverId } });
  res.json(created);
});

sessionsRouter.post("/break", async (req, res) => {
  const session = await openSession(req.auth!.driverId);
  if (!session) return res.status(404).json({ error: "No active session" });
  const guard = canToggleBreak(session);
  if (!guard.ok) return res.status(409).json({ error: guard.reason });
  const updated = session.status === "active"
    ? await prisma.driverSession.update({
        where: { id: session.id }, data: { status: "on_break", breakStartedAt: new Date() } })
    : await prisma.driverSession.update({
        where: { id: session.id },
        data: {
          status: "active",
          breakStartedAt: null,
          totalBreakMs: session.totalBreakMs + (Date.now() - session.breakStartedAt!.getTime()),
        },
      });
  res.json(updated);
});

sessionsRouter.post("/end", async (req, res) => {
  const session = await openSession(req.auth!.driverId);
  if (!session) return res.status(404).json({ error: "No active session" });
  const guard = canEndSession(session);
  if (!guard.ok) return res.status(409).json({ error: guard.reason });
  // finalize any in-progress break before closing the session out
  const totalBreakMs = session.status === "on_break"
    ? session.totalBreakMs + (Date.now() - session.breakStartedAt!.getTime())
    : session.totalBreakMs;
  const updated = await prisma.driverSession.update({
    where: { id: session.id },
    data: { status: "ended", endedAt: new Date(), breakStartedAt: null, totalBreakMs },
  });
  res.json(updated);
});
