import { Router } from "express";
import { z } from "zod";
import type { Driver, DriverAvailability } from "@prisma/client";
import { prisma } from "../db.js";
import { availabilityFor } from "../lib/driverAvailability.js";
import { emitToDispatchers } from "../realtime.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import { DRIVER_PAGE_HTML } from "./driverAvailabilityPage.html.js";

// AI Dispatch Foundation (Task 10): the driver-facing availability page —
// authenticated by DriverAvailability.shareToken (a link, not a login), same
// family as night-shift's driverLink.ts. Two routers, mounted separately in
// app.ts:
//  - driverPageRouter: GET /driver/:shareToken (the HTML), mounted BEFORE
//    mountHosting(app) so the SPA fallback never swallows it.
//  - driverPageApiRouter: the JSON routes, mounted at /api/driver-page next
//    to the other public (token-, not session-, authenticated) mounts like
//    /api/n — a request here carries no Authorization header at all, so
//    neither router sits behind the /api/dispatcher gate.
export const driverPageRouter = Router();
export const driverPageApiRouter = Router();

// Every route in this file shares one limiter/name, same convention as
// nightShiftLink.ts's own linkLimiter — a bearer-equivalent credential
// embedded in a URL is more exposed than an Authorization header.
const pageLimiter = rateLimit({ name: "driver-page", windowMs: 60_000, max: 120 });

const NOT_FOUND = "This link is not valid.";

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

type TokenRow = DriverAvailability & { driver: Driver & { orgId: string } };

/** Every handler below keys off the shareToken — and, because a shareToken
 *  only exists ON a DriverAvailability row, a successful lookup here means
 *  the row (not just the driver) already exists. That is what lets the
 *  PATCH handler below use a plain `update` rather than an `upsert`: the
 *  "no row yet" branch dispatcherDriverSupply.ts's own PATCH has to handle
 *  can never occur on this path. A missing row, or (never expected for a
 *  real tenant driver, but the same defensive rule every cross-tenant lookup
 *  in this codebase follows) one whose driver has no org, reads as 404 —
 *  identical to an unknown token, never a 403 and never a hint that the
 *  token format alone was close. */
async function rowByToken(shareToken: string): Promise<TokenRow | null> {
  const row = await prisma.driverAvailability.findUnique({
    where: { shareToken },
    include: { driver: true },
  });
  if (!row || row.driver.orgId == null) return null;
  return row as TokenRow;
}

function firstNameOf(driver: { firstName: string | null; name: string }): string {
  return driver.firstName?.trim() || driver.name.trim().split(/\s+/)[0] || driver.name;
}

/** A JS string literal safe to splice into an HTML `<script>` block.
 *  `JSON.stringify` alone escapes `"`/`\`/control chars but NOT `<` — and
 *  the HTML tokenizer ends a `<script>` block on the literal byte sequence
 *  "</script" wherever it occurs in the source, even inside a JS string
 *  literal, before any JS parsing happens. `<` is `<` as a JS escape
 *  sequence, so the browser's JS engine still sees the original character
 *  at runtime — only the HTML parser's view of the byte stream changes. */
export function jsStringLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Pure and directly unit-testable — a request-level test of a hostile
 *  token is moot (rowByToken's 404 path means an unknown token never
 *  reaches this function at all), so this is exercised directly instead. */
export function renderDriverPage(driver: { firstName: string | null; name: string }, shareToken: string): string {
  return DRIVER_PAGE_HTML.replace(/__NAME__/g, escapeHtml(firstNameOf(driver))).replace(
    /__TOKEN__/g,
    jsStringLiteral(shareToken),
  );
}

driverPageRouter.get(
  "/driver/:shareToken",
  pageLimiter,
  asyncRoute(async (req, res) => {
    const row = await rowByToken(req.params.shareToken as string);
    if (!row) {
      res.status(404).type("text/plain").send(NOT_FOUND);
      return;
    }
    res.type("html").send(renderDriverPage(row.driver, req.params.shareToken as string));
  }),
);

// ---------------------------------------------------------------------------
// JSON API — /api/driver-page/:shareToken/*
// ---------------------------------------------------------------------------

interface AvailabilityPageView {
  driver: { firstName: string; name: string };
  status: string;
  acceptingLoads: boolean;
  locationSharingEnabled: boolean;
  locationSharingUpdatedAt: string | null;
  availableAt: number;
  available: { city: string | null; state: string | null };
}

/** Reuses the same shared projection every other availability surface reads
 *  (lib/driverAvailability.ts's availabilityFor) rather than re-deriving
 *  status/availableAt a second way — this page and the dispatcher's Driver
 *  Supply drawer must never disagree about what "available" means. */
async function pageView(driver: Driver & { orgId: string }): Promise<AvailabilityPageView | null> {
  const [view] = await availabilityFor(driver.orgId, [driver.id]);
  if (!view) return null;
  return {
    driver: { firstName: firstNameOf(driver), name: driver.name },
    status: view.status,
    acceptingLoads: view.acceptingLoads,
    locationSharingEnabled: view.locationSharingEnabled,
    locationSharingUpdatedAt: view.locationSharingUpdatedAt ? view.locationSharingUpdatedAt.toISOString() : null,
    availableAt: view.availableAt,
    available: { city: view.available.city, state: view.available.state },
  };
}

driverPageApiRouter.get(
  "/:shareToken/availability",
  pageLimiter,
  asyncRoute(async (req, res) => {
    const row = await rowByToken(req.params.shareToken as string);
    if (!row) return res.status(404).json({ error: NOT_FOUND });
    const view = await pageView(row.driver);
    if (!view) return res.status(404).json({ error: NOT_FOUND });
    res.json(view);
  }),
);

const patchSchema = z
  .object({ acceptingLoads: z.boolean().optional(), locationSharingEnabled: z.boolean().optional() })
  .refine((d) => "acceptingLoads" in d || "locationSharingEnabled" in d, { message: "at least one field is required" });

type PatchBody = z.infer<typeof patchSchema>;

driverPageApiRouter.patch(
  "/:shareToken/availability",
  pageLimiter,
  validateBody(patchSchema),
  asyncRoute(async (req, res) => {
    const row = await rowByToken(req.params.shareToken as string);
    if (!row) return res.status(404).json({ error: NOT_FOUND });

    const body = req.body as PatchBody;

    // Stamped ONLY when locationSharingEnabled is actually changing — a
    // PATCH that only touches acceptingLoads (or resends the current value)
    // must not bump this clock.
    const sharingChanged =
      "locationSharingEnabled" in body && body.locationSharingEnabled !== row.locationSharingEnabled;

    const patch: { acceptingLoads?: boolean; locationSharingEnabled?: boolean; locationSharingUpdatedAt?: Date } = {};
    if ("acceptingLoads" in body) patch.acceptingLoads = body.acceptingLoads;
    if ("locationSharingEnabled" in body) patch.locationSharingEnabled = body.locationSharingEnabled;
    if (sharingChanged) patch.locationSharingUpdatedAt = new Date();

    // A driver's own toggles never create a manual status override: this
    // route has no availabilityStatus field to accept at all, and `source`/
    // `availabilityStatus` are simply absent from `patch` above — a plain
    // `update` (never `upsert`; see rowByToken's own comment on why the row
    // is already guaranteed to exist) leaves both columns exactly as they
    // were, whether that's the schema's "derived"/UNAVAILABLE defaults or a
    // dispatcher's own earlier manual override.
    await prisma.driverAvailability.update({ where: { driverId: row.driverId }, data: patch });

    const view = await pageView(row.driver);
    if (!view) return res.status(404).json({ error: NOT_FOUND });
    res.json(view);
  }),
);

const pingSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

driverPageApiRouter.post(
  "/:shareToken/ping",
  pageLimiter,
  validateBody(pingSchema),
  asyncRoute(async (req, res) => {
    const row = await rowByToken(req.params.shareToken as string);
    if (!row) return res.status(404).json({ error: NOT_FOUND });

    if (!row.locationSharingEnabled) {
      // Not an error — the driver (or the lab's test-position form) simply
      // has sharing off. Nothing is written.
      return res.status(202).json({ ignored: true, reason: "location sharing is off" });
    }

    const { lat, lng } = req.body as z.infer<typeof pingSchema>;
    const driver = row.driver;
    const [loc] = await prisma.$transaction([
      prisma.driverLocation.create({ data: { driverId: driver.id, latitude: lat, longitude: lng } }),
      prisma.driver.update({
        where: { id: driver.id },
        data: { lastLat: lat, lastLng: lng, lastLocationAt: new Date() },
      }),
    ]);
    // Byte-for-byte the same payload shape src/routes/driver.ts's own
    // POST /location emits (~line 90) — one "driver moved" event on the wire,
    // whichever door it came through.
    emitToDispatchers(driver.orgId, "driver_location", {
      driverId: driver.id, driverName: driver.name, latitude: lat, longitude: lng, at: loc.createdAt.toISOString(),
    });
    res.status(204).end();
  }),
);
