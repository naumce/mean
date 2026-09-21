import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb } from "./helpers.js";
import { signDispatcherAccess, signAccess } from "../src/lib/tokens.js";

// T5 Dwell and Detention, Task 5 — GET /dispatcher/detention.
//
// scanDetention (src/lib/detentionScan.ts) and the pure dwell/detention math
// underneath it (src/domain/dwell/{segments,detention}.ts) are unit-covered
// elsewhere; this file only exercises the HTTP surface the brief calls out:
// the auth gate, org scoping, the sinceHours guardrail (Zod, bounded, 400 —
// never silently clamped — on an out-of-range value), and that a claim's
// evidence object survives a real JSON round trip through the route.
//
// Global Constraint 4 ("404, never 403") has no :id route to bite on here —
// this is a plain list endpoint — but tenancy is still load-bearing:
// scanDetention takes ONE concrete orgId, so every assertion below goes
// through the real app (./helpers.js's `app`, built by the real
// createApp()), never a router mounted in isolation. This codebase has
// shipped cross-tenant defects caused by mount order before (see
// tests/dispatcher-mount-order.test.ts) — the same discipline
// dispatcher-fuel-prices.test.ts follows.

beforeEach(resetDb);

const HOUR_MS = 3_600_000;

async function scopedDispatcher(orgId: string) {
  const disp = await prisma.dispatcher.create({
    data: { email: `disp-${orgId}@x.com`, passwordHash: "x", name: "D", orgId },
  });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

async function unscopedDispatcher() {
  const disp = await prisma.dispatcher.create({
    data: { email: "legacy-detention@x.com", passwordHash: "x", name: "Legacy D" },
  });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

/** `count` pings, one per `stepMs`, starting at `startMs`, all at `center` —
 *  the dense, minute-by-minute-realistic evidence shape the brief describes
 *  for a clean claim. */
async function densePings(
  driverId: string,
  center: { lat: number; lng: number },
  startMs: number,
  count: number,
  stepMs: number,
) {
  await prisma.driverLocation.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      driverId,
      latitude: center.lat,
      longitude: center.lng,
      createdAt: new Date(startMs + i * stepMs),
    })),
  });
}

/** One load / stop / appointment / assignment in `orgId`, driven by
 *  `driverId`. `windowStartMs` anchors the detention clock; `lat`/`lng`/
 *  `geocodeStatus` are caller-controlled since geocodeStatus is the one knob
 *  the "dwell but no claim" scenario needs. */
async function seedStop(
  orgId: string,
  driverId: string,
  opts: {
    windowStartMs: number;
    lat?: number | null;
    lng?: number | null;
    geocodeStatus?: string;
  },
) {
  const lat = opts.lat === undefined ? 39.0997 : opts.lat;
  const lng = opts.lng === undefined ? -94.5786 : opts.lng;
  const load = await prisma.load.create({
    data: {
      orgId,
      requiredEquip: "DryVan",
      status: "in_progress",
      stops: {
        create: [
          {
            sequence: 1,
            type: "delivery",
            address: "Test Dock",
            lat,
            lng,
            geocodeStatus: opts.geocodeStatus ?? "ok",
            appointment: {
              create: {
                windowStart: new Date(opts.windowStartMs),
                windowEnd: new Date(opts.windowStartMs + 6 * HOUR_MS),
              },
            },
          },
        ],
      },
      assignment: {
        create: {
          orgId,
          driverId,
          plannedStart: new Date(opts.windowStartMs - HOUR_MS),
          plannedEnd: new Date(opts.windowStartMs + 6 * HOUR_MS),
        },
      },
    },
    include: { stops: true },
  });
  return { load, stop: load.stops[0]! };
}

describe("GET /dispatcher/detention — auth gate", () => {
  it("401s an unauthenticated call", async () => {
    const res = await request(app).get("/api/dispatcher/detention");
    expect(res.status).toBe(401);
  });

  it("401s a garbage bearer token", async () => {
    const res = await request(app)
      .get("/api/dispatcher/detention")
      .set("authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("403s a valid driver-role token — requireDispatcher, not requireAuth", async () => {
    const driver = await prisma.driver.create({
      data: { email: "driver-detention@x.com", passwordHash: "x", name: "Driver" },
    });
    const res = await request(app)
      .get("/api/dispatcher/detention")
      .set("authorization", `Bearer ${signAccess(driver.id)}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /dispatcher/detention — sinceHours validation", () => {
  it("rejects sinceHours=0 (below the 1..720 range) with 400, not a clamp to 1", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedDispatcher(org.id);
    const res = await request(app)
      .get("/api/dispatcher/detention?sinceHours=0")
      .set("authorization", auth);
    expect(res.status).toBe(400);
  });

  it("rejects sinceHours=721 (one past the cap) with 400, not a clamp to 720", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedDispatcher(org.id);
    const res = await request(app)
      .get("/api/dispatcher/detention?sinceHours=721")
      .set("authorization", auth);
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric sinceHours with 400", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedDispatcher(org.id);
    const res = await request(app)
      .get("/api/dispatcher/detention?sinceHours=not-a-number")
      .set("authorization", auth);
    expect(res.status).toBe(400);
  });

  it("accepts sinceHours=720 (the top of the allowed range)", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedDispatcher(org.id);
    const res = await request(app)
      .get("/api/dispatcher/detention?sinceHours=720")
      .set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("defaults sinceHours when omitted, rather than 400ing or scanning unbounded", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedDispatcher(org.id);
    const res = await request(app).get("/api/dispatcher/detention").set("authorization", auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("GET /dispatcher/detention — org scoping", () => {
  it("requires an org-scoped dispatcher account — a legacy/unscoped account gets 400, not an all-org scan", async () => {
    const auth = await unscopedDispatcher();
    const res = await request(app).get("/api/dispatcher/detention").set("authorization", auth);
    expect(res.status).toBe(400);
  });

  it("never returns another org's stops — a foreign claim is absent, not merely unlabeled", async () => {
    const orgA = await prisma.org.create({ data: { name: "Alpha" } });
    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const driverA = await prisma.driver.create({
      data: { email: "driverA-detention@x.com", passwordHash: "x", name: "Driver A" },
    });

    const windowStartMs = Date.now() - 4 * HOUR_MS;
    const { stop } = await seedStop(orgA.id, driverA.id, { windowStartMs });
    await densePings(driverA.id, { lat: 39.0997, lng: -94.5786 }, windowStartMs, 19, 10 * 60_000);

    const authA = await scopedDispatcher(orgA.id);
    const authB = await scopedDispatcher(orgB.id);

    const resA = await request(app).get("/api/dispatcher/detention").set("authorization", authA);
    expect(resA.status).toBe(200);
    expect(resA.body.map((r: { stopId: string }) => r.stopId)).toContain(stop.id);

    const resB = await request(app).get("/api/dispatcher/detention").set("authorization", authB);
    expect(resB.status).toBe(200);
    expect(resB.body).toEqual([]);
  });
});

describe("GET /dispatcher/detention — claim evidence round-trips through JSON", () => {
  it("returns a billable claim whose evidence survives the HTTP/JSON round trip intact", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const driver = await prisma.driver.create({
      data: { email: "driver-evidence@x.com", passwordHash: "x", name: "Driver E" },
    });
    const auth = await scopedDispatcher(org.id);
    const center = { lat: 39.0997, lng: -94.5786 };

    // Appointment window opens 4h ago; dense (10-min) pings run for the first
    // 3h of that window, so the observed dwell is 180 raw minutes. Org free
    // time defaults to 120 (Org.detentionFreeMin), so billableMin = 60 —
    // clean and > 0, but not so large it trips the "thin evidence" review
    // flag (LONG_CLAIM_MIN=60 requires STRICTLY more). A later out-of-fence
    // ping proves departure was observed. No gap exceeds GAP_REVIEW_MIN (30),
    // so this claim should need no review at all.
    const windowStartMs = Date.now() - 4 * HOUR_MS;
    const pingCount = 19;
    const stepMs = 10 * 60_000;
    const { stop, load } = await seedStop(org.id, driver.id, { windowStartMs });
    await densePings(driver.id, center, windowStartMs, pingCount, stepMs);
    // Departure: a ping far outside the 0.5mi fence, after the last in-fence one.
    await prisma.driverLocation.create({
      data: {
        driverId: driver.id,
        latitude: center.lat + 5,
        longitude: center.lng + 5,
        createdAt: new Date(windowStartMs + pingCount * stepMs),
      },
    });

    const res = await request(app).get("/api/dispatcher/detention").set("authorization", auth);
    expect(res.status).toBe(200);

    const row = res.body.find((r: { stopId: string }) => r.stopId === stop.id);
    expect(row).toBeDefined();
    expect(row.loadId).toBe(load.id);
    expect(row.driverId).toBe(driver.id);
    expect(row.claim).not.toBeNull();
    expect(row.noClaimReason).toBeNull();

    const claim = row.claim;
    expect(claim.freeMin).toBe(120);
    expect(claim.billableMin).toBe(60);
    expect(claim.clockStartMs).toBe(windowStartMs);
    expect(claim.needsReview).toBe(false);
    expect(claim.reviewReasons).toEqual([]);

    // The evidence object itself — Global Constraint 6 ("every claim carries
    // its own evidence"). Every field must arrive as a genuine JSON number/
    // boolean, not a stringified Date or an object that only looked right
    // server-side.
    const lastSeenMs = windowStartMs + (pingCount - 1) * stepMs;
    expect(claim.evidence).toEqual({
      pingCount,
      maxGapMin: 10,
      firstSeenMs: windowStartMs,
      lastSeenMs,
      departureObserved: true,
    });
    expect(typeof claim.evidence.firstSeenMs).toBe("number");
    expect(typeof claim.evidence.lastSeenMs).toBe("number");
    expect(typeof claim.evidence.departureObserved).toBe("boolean");
  });

  it("reports needsReview with a gap reason when the pings have a multi-hour hole", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const driver = await prisma.driver.create({
      data: { email: "driver-gap@x.com", passwordHash: "x", name: "Driver G" },
    });
    const auth = await scopedDispatcher(org.id);
    const center = { lat: 39.0997, lng: -94.5786 };

    // Same overall window as the clean-claim test, but the middle hour of
    // pings is missing — a maxGapMin comfortably past GAP_REVIEW_MIN (30).
    const windowStartMs = Date.now() - 4 * HOUR_MS;
    await densePings(driver.id, center, windowStartMs, 6, 10 * 60_000); // 0..50min
    await densePings(driver.id, center, windowStartMs + 3 * HOUR_MS, 6, 10 * 60_000); // 180..230min
    await prisma.driverLocation.create({
      data: { driverId: driver.id, latitude: center.lat + 5, longitude: center.lng + 5, createdAt: new Date(windowStartMs + 3 * HOUR_MS + 60 * 60_000) },
    });
    const { stop } = await seedStop(org.id, driver.id, { windowStartMs });

    const res = await request(app).get("/api/dispatcher/detention").set("authorization", auth);
    expect(res.status).toBe(200);
    const row = res.body.find((r: { stopId: string }) => r.stopId === stop.id);
    expect(row.claim).not.toBeNull();
    expect(row.claim.needsReview).toBe(true);
    expect(row.claim.reviewReasons.some((r: string) => r.includes("gap"))).toBe(true);
  });

  it("reports dwell but no claim when geocodeStatus is not 'ok', even with real pings", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const driver = await prisma.driver.create({
      data: { email: "driver-badgeo@x.com", passwordHash: "x", name: "Driver B" },
    });
    const auth = await scopedDispatcher(org.id);
    const center = { lat: 39.0997, lng: -94.5786 };
    const windowStartMs = Date.now() - 4 * HOUR_MS;

    const { stop } = await seedStop(org.id, driver.id, {
      windowStartMs,
      geocodeStatus: "pending",
    });
    await densePings(driver.id, center, windowStartMs, 19, 10 * 60_000);

    const res = await request(app).get("/api/dispatcher/detention").set("authorization", auth);
    expect(res.status).toBe(200);
    const row = res.body.find((r: { stopId: string }) => r.stopId === stop.id);
    expect(row.claim).toBeNull();
    expect(row.observedMin).not.toBeNull();
    expect(row.observedMin).toBeGreaterThan(0);
    expect(typeof row.noClaimReason).toBe("string");
    expect(row.noClaimReason.length).toBeGreaterThan(0);
  });
});
