// GET /dispatcher/route-pois?loadId=… — the fuel stops and rest areas along
// one load's route, plus where its mandatory break falls and the nearest rest
// area to that point.
//
// This is the "you've got a rest area eight miles ahead, take your break"
// answer, assembled server-side so the client renders it rather than deriving
// it. Mounted under dispatcherRouter — auth and role are already enforced.

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { orgWhere } from "../middleware/orgScope.js";
import { resolveRoutes, routeKey, type LatLng } from "../lib/routing.js";
import { truckProfileFor } from "../lib/truckProfile.js";
import { nextPoiAfter, poisAlongRoute, type RoutePoi } from "../lib/routePois.js";
import { asyncRoute } from "../lib/asyncRoute.js";

export const dispatcherRoutePoisRouter = Router();

const querySchema = z.object({ loadId: z.string().min(1) });

dispatcherRoutePoisRouter.get("/route-pois", asyncRoute(async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "loadId is required" });

    const load = await prisma.load.findFirst({
      // Org-scoped: a load id from another tenant is NOT FOUND, never
      // forbidden — a 403 would confirm the id exists.
      where: { id: parsed.data.loadId, ...orgWhere(req) },
      select: {
        id: true,
        stops: {
          orderBy: { sequence: "asc" },
          select: { lat: true, lng: true, address: true, sequence: true },
        },
      },
    });
    if (!load) return res.status(404).json({ error: "Load not found" });

    const pts = load.stops.filter((s) => s.lat != null && s.lng != null);
    if (pts.length < 2) {
      return res.json({ pois: [], totalMi: 0, routed: false, reason: "Load has fewer than two geocoded stops" });
    }

    // Same resolution pass the map's geometry and the engine's mileage use, so
    // the POIs are measured against the road the truck will actually drive.
    const pairs: [LatLng, LatLng][] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      pairs.push([
        { lat: pts[i].lat as number, lng: pts[i].lng as number },
        { lat: pts[i + 1].lat as number, lng: pts[i + 1].lng as number },
      ]);
    }
    // Same truck profile the board draws with. POIs measured against car
    // geometry would sit at distances along a road this truck never takes.
    const profile = truckProfileFor({});
    const routes = await resolveRoutes(pairs, profile);

    const line: [number, number][] = [];
    let keyParts = "";
    for (let i = 0; i < pts.length - 1; i++) {
      const k = routeKey(
        { lat: pts[i].lat as number, lng: pts[i].lng as number },
        { lat: pts[i + 1].lat as number, lng: pts[i + 1].lng as number },
        profile,
      );
      const leg = routes.get(k);
      if (!leg?.geometry) {
        // No real road for some leg: POIs measured against an arc would be
        // placed at distances the driver will never see. Refuse rather than
        // offer a plausible wrong number.
        return res.json({
          pois: [],
          totalMi: 0,
          routed: false,
          reason: "No road geometry for this route yet — POIs need a real road to measure against",
        });
      }
      keyParts += k + "|";
      line.push(...(i === 0 ? leg.geometry : leg.geometry.slice(1)));
    }

    const pois: RoutePoi[] = await poisAlongRoute(keyParts, line);
    const totalMi = [...routes.values()].reduce((a, r) => a + r.miles, 0);

    res.json({ pois, totalMi, routed: true, reason: null });
  } catch (err) {
    // Express 4 does not await handlers: without this the request hangs with
    // no response at all rather than failing.
    next(err);
  }
}));

export { nextPoiAfter };
