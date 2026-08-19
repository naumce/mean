import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { upload } from "../lib/upload.js";

// Mounted at "/api" in app.ts — the client's two paths don't share a common
// prefix (`/mobile/trips/:id/...` vs `/signs-proof/:stopId/...`), so both
// full sub-paths live in this one router rather than splitting the mount.
export const signsProofRouter = Router();
signsProofRouter.use(requireAuth);

signsProofRouter.get("/mobile/trips/:id/signs-proof-requirements", async (req, res) => {
  const trip = await prisma.trip.findFirst({ where: { id: req.params.id, driverId: req.auth!.driverId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const stopId = typeof req.query.stopId === "string" ? req.query.stopId : undefined;
  if (!stopId) return res.status(400).json({ error: "stopId is required" });
  const stop = await prisma.stop.findFirst({ where: { id: stopId, tripId: trip.id } });
  if (!stop) return res.status(404).json({ error: "Stop not found" });
  const requirements = await prisma.signsProofRequirement.findMany({ where: { stopId: stop.id } });
  res.json(requirements);
});

const signsProofUploadSchema = z.object({
  requirementId: z.string().optional(),
  proofType: z.string().min(1),
  hasLocation: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === "true"),
});

// upload.single runs before validateBody: multer is what parses the
// multipart text fields into req.body in the first place.
signsProofRouter.post(
  "/signs-proof/:stopId/upload",
  upload.single("file"),
  validateBody(signsProofUploadSchema),
  async (req, res) => {
    const stopId = req.params.stopId as string;
    // ownership by construction via the relation: the stop must belong to a
    // trip owned by the calling driver.
    const stop = await prisma.stop.findFirst({ where: { id: stopId, trip: { driverId: req.auth!.driverId } } });
    if (!stop) return res.status(404).json({ error: "Stop not found" });
    if (!req.file) return res.status(400).json({ error: "file is required" });
    const { requirementId, proofType, hasLocation } = req.body as z.infer<typeof signsProofUploadSchema>;
    const fileUrl = `/uploads/${req.file.filename}`;
    const created = await prisma.signsProof.create({
      data: { stopId: stop.id, requirementId: requirementId ?? null, proofType, fileUrl, hasLocation },
    });
    res.json(created);
  },
);
