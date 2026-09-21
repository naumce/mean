import { Router } from "express";
import { z } from "zod";
import type { ServiceRecord } from "@prisma/client";
import { prisma } from "../db.js";
import { orgWhere, outsideOrg } from "../middleware/orgScope.js";
import { validateBody } from "../middleware/validate.js";
import { geocodeAddress } from "../lib/geocode.js";
import { respondToWriteConflict } from "../lib/writeConflict.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Fleet compliance & maintenance:
//  - GET  /fleet                 — every unit + driver with their compliance clocks
//  - GET  /fleet/services        — the org's service shops (map-ready)
//  - POST /fleet/services        — register a shop (address geocoded when possible)
//  - GET  /fleet/records         — the maintenance ledger, newest first
//  - POST /fleet/records         — log a service; refreshes the unit's clock in the same tx
// Mounted under dispatcherRouter with attachOrgScope.
export const dispatcherFleetRouter = Router();

const COMPLIANCE_SELECT = {
  id: true, unit: true, status: true, lastLat: true, lastLng: true,
  inspectionExpiresAt: true, registrationExpiresAt: true, nextServiceAt: true,
} as const;

const DIGEST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface DigestItem {
  label: string;
  kind: "inspection" | "registration" | "service" | "medical";
  at: Date;
  expired: boolean;
}

function pushClock(items: DigestItem[], label: string, kind: DigestItem["kind"], at: Date | null, now: number): void {
  if (!at) return;
  const t = at.getTime();
  if (t >= now + DIGEST_WINDOW_MS) return;
  items.push({ label, kind, at, expired: t < now });
}

dispatcherFleetRouter.get("/fleet", asyncRoute(async (req, res) => {
  const scope = orgWhere(req);
  const [tractors, trailers, drivers] = await Promise.all([
    prisma.tractor.findMany({ where: { ...scope }, orderBy: { unit: "asc" }, select: { ...COMPLIANCE_SELECT, make: true } }),
    prisma.trailer.findMany({ where: { ...scope }, orderBy: { unit: "asc" }, select: { ...COMPLIANCE_SELECT, type: true } }),
    prisma.driver.findMany({
      where: { ...scope },
      orderBy: { name: "asc" },
      select: { id: true, name: true, medicalCertExpiresAt: true },
    }),
  ]);
  res.json({ tractors, trailers, drivers });
}));

// The board's compliance digest: everything expired or inside the 30-day
// window, worst first — so the problem reaches the dispatcher's screen
// before it reaches a roadside inspection.
dispatcherFleetRouter.get("/fleet/digest", asyncRoute(async (req, res) => {
  const scope = orgWhere(req);
  const now = Date.now();
  const [tractors, trailers, drivers] = await Promise.all([
    prisma.tractor.findMany({ where: { ...scope }, select: COMPLIANCE_SELECT }),
    prisma.trailer.findMany({ where: { ...scope }, select: { ...COMPLIANCE_SELECT, type: true } }),
    prisma.driver.findMany({ where: { ...scope }, select: { name: true, medicalCertExpiresAt: true } }),
  ]);

  const items: DigestItem[] = [];
  for (const t of tractors) {
    pushClock(items, `Tractor #${t.unit}`, "inspection", t.inspectionExpiresAt, now);
    pushClock(items, `Tractor #${t.unit}`, "registration", t.registrationExpiresAt, now);
    pushClock(items, `Tractor #${t.unit}`, "service", t.nextServiceAt, now);
  }
  for (const t of trailers) {
    pushClock(items, `Trailer ${t.unit}`, "inspection", t.inspectionExpiresAt, now);
    pushClock(items, `Trailer ${t.unit}`, "registration", t.registrationExpiresAt, now);
    pushClock(items, `Trailer ${t.unit}`, "service", t.nextServiceAt, now);
  }
  for (const d of drivers) {
    pushClock(items, d.name, "medical", d.medicalCertExpiresAt, now);
  }

  items.sort((a, b) => a.at.getTime() - b.at.getTime());
  res.json({
    items,
    expiredCount: items.filter((i) => i.expired).length,
    dueSoonCount: items.filter((i) => !i.expired).length,
  });
}));

dispatcherFleetRouter.get("/fleet/services", asyncRoute(async (req, res) => {
  const shops = await prisma.serviceShop.findMany({
    where: { ...orgWhere(req) },
    orderBy: { name: "asc" },
  });
  res.json({ shops });
}));

const shopSchema = z.object({
  name: z.string().min(2),
  address: z.string().min(3),
  lat: z.number().optional(),
  lng: z.number().optional(),
  phone: z.string().optional(),
});

dispatcherFleetRouter.post("/fleet/services", validateBody(shopSchema), asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Service shops require an org-scoped dispatcher account" });
  const body = req.body as z.infer<typeof shopSchema>;
  const geo =
    body.lat != null && body.lng != null
      ? { lat: body.lat, lng: body.lng }
      : await geocodeAddress(body.address);
  const shop = await prisma.serviceShop.create({
    data: { orgId, name: body.name, address: body.address, lat: geo?.lat ?? null, lng: geo?.lng ?? null, phone: body.phone },
  });
  res.status(201).json(shop);
}));

dispatcherFleetRouter.get("/fleet/records", asyncRoute(async (req, res) => {
  const scope = orgWhere(req);
  const unitFilter =
    typeof req.query.tractorId === "string"
      ? { tractorId: req.query.tractorId }
      : typeof req.query.trailerId === "string"
        ? { trailerId: req.query.trailerId }
        : {};
  const records = await prisma.serviceRecord.findMany({
    where: { ...("orgId" in scope ? { orgId: scope.orgId } : {}), ...unitFilter },
    orderBy: { performedAt: "desc" },
    take: 100,
    include: {
      shop: { select: { name: true } },
      tractor: { select: { unit: true } },
      trailer: { select: { unit: true, type: true } },
    },
  });
  res.json({
    records: records.map((r) => ({
      id: r.id,
      kind: r.kind,
      notes: r.notes,
      performedAt: r.performedAt,
      nextDueAt: r.nextDueAt,
      shopName: r.shop.name,
      unit: r.tractor ? `Tractor #${r.tractor.unit}` : r.trailer ? `Trailer ${r.trailer.unit} (${r.trailer.type})` : "—",
    })),
  });
}));

const recordSchema = z
  .object({
    shopId: z.string().min(1),
    tractorId: z.string().min(1).optional(),
    trailerId: z.string().min(1).optional(),
    kind: z.enum(["inspection", "registration", "service", "repair"]),
    notes: z.string().max(500).optional(),
    performedAt: z.string().datetime().optional(),
    nextDueAt: z.string().datetime().optional(),
  })
  .refine((b) => (b.tractorId ? 1 : 0) + (b.trailerId ? 1 : 0) === 1, {
    message: "exactly one of tractorId or trailerId is required",
  });

// Which compliance clock a record kind refreshes (repair refreshes nothing).
const CLOCK_FIELD: Record<string, "inspectionExpiresAt" | "registrationExpiresAt" | "nextServiceAt" | null> = {
  inspection: "inspectionExpiresAt",
  registration: "registrationExpiresAt",
  service: "nextServiceAt",
  repair: null,
};

/** POST /fleet/records' "what vanished?" answer (lib/writeConflict.ts). */
const RECORD_UNIT_GONE =
  "The tractor or trailer this record belongs to was removed while it was being saved — nothing was recorded. Re-check the fleet list.";

dispatcherFleetRouter.post("/fleet/records", validateBody(recordSchema), asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Service records require an org-scoped dispatcher account" });
  const body = req.body as z.infer<typeof recordSchema>;

  const [shop, unit] = await Promise.all([
    prisma.serviceShop.findUnique({ where: { id: body.shopId } }),
    body.tractorId
      ? prisma.tractor.findUnique({ where: { id: body.tractorId } })
      : prisma.trailer.findUnique({ where: { id: body.trailerId as string } }),
  ]);
  // Cross-tenant ids read as "not found".
  if (!shop || outsideOrg(req, shop.orgId)) return res.status(404).json({ error: "Service shop not found" });
  if (!unit || outsideOrg(req, unit.orgId)) return res.status(404).json({ error: "Unit not found" });

  const clockField = CLOCK_FIELD[body.kind];
  const nextDueAt = body.nextDueAt ? new Date(body.nextDueAt) : null;

  // The record and the compliance clock it refreshes are one write or none —
  // and one write that can fail. Without a mapping, a P2025 (the unit retired
  // between the check above and this transaction) or a Postgres deadlock
  // rejects out of an un-awaited async Express handler and the shop's entry
  // form gets NO response at all, so the same inspection gets typed in twice.
  let record: ServiceRecord;
  try {
    record = await prisma.$transaction(async (tx) => {
    const created = await tx.serviceRecord.create({
      data: {
        orgId,
        shopId: shop.id,
        tractorId: body.tractorId ?? null,
        trailerId: body.trailerId ?? null,
        kind: body.kind,
        notes: body.notes,
        performedAt: body.performedAt ? new Date(body.performedAt) : new Date(),
        nextDueAt,
      },
    });
    // The record IS the source of truth for the unit's next deadline — the
    // clock the dispatch engine checks refreshes in the same transaction.
    if (clockField && nextDueAt) {
      if (body.tractorId) {
        await tx.tractor.update({ where: { id: body.tractorId }, data: { [clockField]: nextDueAt } });
      } else {
        await tx.trailer.update({ where: { id: body.trailerId as string }, data: { [clockField]: nextDueAt } });
      }
    }
    return created;
    });
  } catch (err) {
    // What vanishes here is the UNIT, not an assignment or a tender: the
    // tractor or trailer whose clock this record refreshes was deleted from
    // the fleet between the ownership check above and the write. The
    // ServiceRecord rolled back with it, so nothing was half-saved.
    if (respondToWriteConflict(res, err, RECORD_UNIT_GONE)) return;
    throw err;
  }

  res.status(201).json(record);
}));
