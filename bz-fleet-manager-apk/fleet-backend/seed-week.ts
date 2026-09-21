// A full week of operations, generated rather than hand-placed.
//
//   npx tsx seed-week.ts
//
// Seven days of real work: every driver runs a sequence of loads on real
// lanes, and their GPS trail is interpolated ALONG THE ACTUAL ROAD returned by
// the routing provider — not a straight line between cities. Trucks therefore
// move hour by hour down I-70, I-55 and I-44 the way they really would, and
// every downstream feature (dwell, detention, break points, fuel advice, the
// trip card's ETA) is exercised against motion instead of a single frozen
// snapshot.
//
// Written in TypeScript and run with tsx SPECIFICALLY so it can import
// `resolveRoutes` from src/lib/routing.ts. Re-deriving road geometry inside a
// .mjs seed would be a second definition of "where does this truck drive",
// which is the duplication this codebase has been bitten by repeatedly — and
// it would drift the moment the provider changed.
//
// Destructive by design: it deletes the org's operational history first, so
// reruns produce the same week rather than stacking another one on top. The
// previous demo seed did not, and had silently grown to 352 "history" loads
// and 25 copies of every story load, inflating every KPI on the board.

import bcrypt from "bcrypt";
import { prisma } from "./src/db.js";
import { resolveRoutes, routeKey, type LatLng } from "./src/lib/routing.js";
import { haversineMi } from "./src/domain/dispatch/distance.js";
import { truckProfileFor } from "./src/lib/truckProfile.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;

/** How often a truck reports position while rolling. Real ELDs are 5-15 min;
 *  20 keeps the row count sane for a demo DB while still drawing a trail that
 *  visibly follows the road. */
const PING_EVERY_MIN = 20;

const CITY = {
  KC: { address: "Kansas City, MO", lat: 39.0997, lng: -94.5786 },
  STL: { address: "St. Louis, MO", lat: 38.627, lng: -90.1994 },
  OMA: { address: "Omaha, NE", lat: 41.2565, lng: -95.9345 },
  DSM: { address: "Des Moines, IA", lat: 41.5868, lng: -93.625 },
  MEM: { address: "Memphis, TN", lat: 35.1495, lng: -90.049 },
  CHI: { address: "Chicago, IL", lat: 41.8781, lng: -87.6298 },
  WIC: { address: "Wichita, KS", lat: 37.6872, lng: -97.3301 },
  OKC: { address: "Oklahoma City, OK", lat: 35.4676, lng: -97.5164 },
  DEN: { address: "Denver, CO", lat: 39.7392, lng: -104.9903 },
  MSP: { address: "Minneapolis, MN", lat: 44.9778, lng: -93.265 },
} as const;

type CityKey = keyof typeof CITY;

interface TripPlan {
  driver: string;
  from: CityKey;
  to: CityKey;
  /** days before today the trip STARTS. 0 = today; NEGATIVE = days ahead.
   *  The board's default window looks FORWARD, so a week entirely in the past
   *  renders as an empty board — the history feeds the KPIs while the lanes
   *  themselves look idle. Some of the week has to be ahead of now. */
  daysAgo: number;
  /** hour of day it starts, local-ish */
  startHour: number;
  revenueCents: number;
  broker: string;
  equip: string;
  /** extra minutes sat at the delivery beyond normal service — makes a
   *  detention claim appear naturally rather than being special-cased */
  detentionMin?: number;
  /** Start this trip N hours BEFORE now, whenever the seed runs, ignoring
   *  daysAgo/startHour. A demo needs a truck that is actually rolling when it
   *  is opened; pinning one to a wall-clock hour means it is only mid-trip if
   *  you happen to demo in the afternoon. */
  startHoursAgo?: number;
}

// A week of work. Deliberately uneven: different lane lengths, some days
// doubled up, one driver idle mid-week, two long hauls that force an HOS
// break. This is a schedule, not a pattern — a demo where every day looks the
// same teaches a viewer nothing about the product.
const WEEK: TripPlan[] = [
  // NOTE ON THE SHAPE OF THIS SCHEDULE: consecutive trips deliberately do NOT
  // chain perfectly. An earlier version had every pickup at the previous
  // drop's city, which made deadhead exactly zero on all 16 loads — and a
  // fleet with 0% empty miles is not a fleet. "Empty miles avoided" is the
  // number a dispatch service is buying, so the demo has to have empty miles
  // to avoid. Each driver below repositions between most loads.

  // ── Jake: short midwest runs, high frequency
  { driver: "jake", from: "KC", to: "OMA", daysAgo: 6, startHour: 6, revenueCents: 64000, broker: "Landstar", equip: "DryVan" },
  { driver: "jake", from: "DSM", to: "CHI", daysAgo: 5, startHour: 7, revenueCents: 78000, broker: "TQL", equip: "DryVan" },      // deadhead OMA→DSM
  { driver: "jake", from: "STL", to: "KC", daysAgo: 4, startHour: 6, revenueCents: 61000, broker: "Coyote", equip: "DryVan" },     // deadhead CHI→STL
  { driver: "jake", from: "OMA", to: "DSM", daysAgo: 2, startHour: 8, revenueCents: 41000, broker: "Landstar", equip: "DryVan" },  // deadhead KC→OMA
  { driver: "jake", from: "KC", to: "STL", daysAgo: -1, startHour: 7, revenueCents: 66000, broker: "TQL", equip: "DryVan" },        // deadhead DSM→KC

  // ── Maria: the long western hauls — these cross the 8h break threshold
  { driver: "maria", from: "KC", to: "DEN", daysAgo: 6, startHour: 5, revenueCents: 218000, broker: "CH Robinson", equip: "DryVan" },
  { driver: "maria", from: "DEN", to: "WIC", daysAgo: 4, startHour: 6, revenueCents: 154000, broker: "Coyote", equip: "DryVan" },
  { driver: "maria", from: "OKC", to: "KC", daysAgo: 3, startHour: 9, revenueCents: 88000, broker: "TQL", equip: "DryVan", detentionMin: 190 }, // deadhead WIC→OKC
  { driver: "maria", from: "KC", to: "MSP", daysAgo: -1, startHour: 6, revenueCents: 168000, broker: "Landstar", equip: "DryVan" },

  // ── Tyrone: the southern reefer lanes
  { driver: "tyrone", from: "MEM", to: "STL", daysAgo: 5, startHour: 7, revenueCents: 74000, broker: "TQL", equip: "Reefer" },
  { driver: "tyrone", from: "CHI", to: "MEM", daysAgo: 3, startHour: 6, revenueCents: 132000, broker: "TQL", equip: "Reefer", detentionMin: 240 }, // deadhead STL→CHI
  { driver: "tyrone", from: "OKC", to: "WIC", daysAgo: 2, startHour: 5, revenueCents: 44000, broker: "CH Robinson", equip: "Reefer" },             // deadhead MEM→OKC
  { driver: "tyrone", from: "KC", to: "MEM", daysAgo: -2, startHour: 5, revenueCents: 91000, broker: "Coyote", equip: "Reefer" },                   // deadhead WIC→KC

  // ── Dale: idle early in the week, then two runs (an available driver on the
  //     board is as important to see as a busy one)
  { driver: "dale", from: "KC", to: "WIC", daysAgo: 2, startHour: 7, revenueCents: 47000, broker: "Landstar", equip: "DryVan" },
  { driver: "dale", from: "OKC", to: "DSM", daysAgo: -2, startHour: 9, revenueCents: 96000, broker: "TQL", equip: "DryVan" },                       // deadhead WIC→OKC

  // ── Always rolling, whenever this seed runs. Two trucks mid-trip so the map
  //     has motion and the trip card has something to count down to the moment
  //     the demo is opened.
  { driver: "tyrone", from: "MEM", to: "KC", daysAgo: 0, startHour: 0, startHoursAgo: 4, revenueCents: 91000, broker: "Coyote", equip: "Reefer" },
  { driver: "maria", from: "KC", to: "DEN", daysAgo: 0, startHour: 0, startHoursAgo: 6, revenueCents: 218000, broker: "CH Robinson", equip: "DryVan" },

  // ── The next three days. The board's default view looks FORWARD, so without
  //     these it renders as five idle lanes: the week's work was all behind the
  //     window and only the KPI strip showed it happened.
  { driver: "jake", from: "STL", to: "MEM", daysAgo: -1, startHour: 6, revenueCents: 79000, broker: "TQL", equip: "DryVan" },
  { driver: "jake", from: "KC", to: "DSM", daysAgo: -2, startHour: 7, revenueCents: 54000, broker: "Coyote", equip: "DryVan" },
  { driver: "dale", from: "WIC", to: "KC", daysAgo: -1, startHour: 10, revenueCents: 44000, broker: "Landstar", equip: "DryVan" },
  { driver: "dale", from: "KC", to: "CHI", daysAgo: -3, startHour: 6, revenueCents: 121000, broker: "CH Robinson", equip: "DryVan" },
  { driver: "tyrone", from: "KC", to: "OKC", daysAgo: -1, startHour: 13, revenueCents: 86000, broker: "TQL", equip: "Reefer" },
  { driver: "tyrone", from: "MEM", to: "STL", daysAgo: -3, startHour: 7, revenueCents: 76000, broker: "Coyote", equip: "Reefer" },
  { driver: "maria", from: "DEN", to: "WIC", daysAgo: -2, startHour: 8, revenueCents: 154000, broker: "Coyote", equip: "DryVan" },

  // ── Rico: finished yesterday and is sitting in Kansas City, available
  { driver: "rico", from: "CHI", to: "KC", daysAgo: 1, startHour: 6, revenueCents: 118000, broker: "Landstar", equip: "DryVan" },

  // ── Sam: one run, then parked (medical expiry keeps him off the board)
  { driver: "sam", from: "STL", to: "CHI", daysAgo: 5, startHour: 6, revenueCents: 69000, broker: "Coyote", equip: "Flatbed" },
];

/** Unassigned freight waiting to be covered — the backlog a dispatcher works. */
const BACKLOG: Array<{ from: CityKey; to: CityKey; inHours: number; revenueCents: number; broker: string; equip: string }> = [
  // Two constraints shape this list, both learned by running ⚡Suggest against it:
  //
  // 1. Pickup windows sit PAST the committed work above. Inside it, every
  //    driver ranked as "already committed in this window" and the feature had
  //    nothing to say.
  // 2. Most lanes are short enough to run in ONE shift. `evaluate` fits a whole
  //    trip inside the driver's remaining drive clock — it does not split a
  //    load across days — so a 600-mile lane plus deadhead is ~18h and blocks
  //    every candidate on HOS, correctly and unhelpfully.
  //
  // B-05 is deliberately left long: "no driver can legally take this in one
  //    shift" is a true and useful answer, and worth showing once.
  // Origins chosen where drivers actually FINISH the week (STL, DSM, MEM, WIC),
  // so the deadhead to the pickup is small. With origins picked arbitrarily the
  // top suggestion carried a -22% margin: true, since 200 empty miles on a
  // 250-mile load really does lose money, but a poor first thing to show. The
  // long-deadhead lesson is better told by B-05.
  { from: "STL", to: "CHI", inHours: 92, revenueCents: 82000, broker: "Landstar", equip: "DryVan" },
  { from: "DSM", to: "OMA", inHours: 100, revenueCents: 42000, broker: "Coyote", equip: "DryVan" },
  { from: "MEM", to: "STL", inHours: 110, revenueCents: 79000, broker: "TQL", equip: "Reefer" },
  { from: "WIC", to: "KC", inHours: 120, revenueCents: 52000, broker: "TQL", equip: "DryVan" },
  { from: "KC", to: "DEN", inHours: 134, revenueCents: 218000, broker: "CH Robinson", equip: "DryVan" },
];

const startOfTrip = (daysAgo: number, hour: number, hoursAgo?: number): number => {
  if (hoursAgo != null) return Date.now() - hoursAgo * HOUR;
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

/** Position along a polyline at `t` of its total length (0..1). */
function pointAt(geometry: [number, number][], t: number): [number, number] {
  if (geometry.length === 0) return [0, 0];
  if (t <= 0) return geometry[0];
  if (t >= 1) return geometry[geometry.length - 1];
  const idx = Math.min(geometry.length - 1, Math.floor(t * (geometry.length - 1)));
  return geometry[idx];
}

async function wipeOrgOperations(orgId: string): Promise<void> {
  // Order matters: children before parents. This is the part the old demo seed
  // lacked, which is why it accumulated.
  const loads = await prisma.load.findMany({ where: { orgId }, select: { id: true } });
  const loadIds = loads.map((l) => l.id);
  const assignments = await prisma.assignment.findMany({ where: { orgId }, select: { id: true } });
  const assignmentIds = assignments.map((a) => a.id);
  const drivers = await prisma.driver.findMany({ where: { orgId }, select: { id: true } });
  const driverIds = drivers.map((d) => d.id);

  await prisma.deadheadLeg.deleteMany({ where: { assignmentId: { in: assignmentIds } } });
  await prisma.dispatchConflict.deleteMany({ where: { orgId } });
  await prisma.appointment.deleteMany({ where: { stop: { loadId: { in: loadIds } } } });
  await prisma.loadStop.deleteMany({ where: { loadId: { in: loadIds } } });
  await prisma.rate.deleteMany({ where: { loadId: { in: loadIds } } });
  await prisma.assignment.deleteMany({ where: { orgId } });
  await prisma.load.deleteMany({ where: { orgId } });
  await prisma.driverLocation.deleteMany({ where: { driverId: { in: driverIds } } });
}

/** Delete an org outright, children first. Used to collapse the duplicate demo
 *  orgs below — `Org.name` has no unique constraint and seed-control-tower.mjs
 *  used `org.create`, so every run of it minted ANOTHER "Heartland Freight Co".
 *  Four had accumulated, holding 96 loads and 211 pings between them, and the
 *  dispatcher login pointed at one while a fresh seed wrote to another. */
async function deleteOrg(orgId: string): Promise<void> {
  const loads = await prisma.load.findMany({ where: { orgId }, select: { id: true } });
  const loadIds = loads.map((l) => l.id);
  const assignments = await prisma.assignment.findMany({ where: { orgId }, select: { id: true } });
  const drivers = await prisma.driver.findMany({ where: { orgId }, select: { id: true } });
  const driverIds = drivers.map((d) => d.id);
  const shops = await prisma.serviceShop.findMany({ where: { orgId }, select: { id: true } });

  await prisma.deadheadLeg.deleteMany({ where: { assignmentId: { in: assignments.map((a) => a.id) } } });
  await prisma.dispatchConflict.deleteMany({ where: { orgId } });
  await prisma.appointment.deleteMany({ where: { stop: { loadId: { in: loadIds } } } });
  await prisma.loadStop.deleteMany({ where: { loadId: { in: loadIds } } });
  await prisma.rate.deleteMany({ where: { loadId: { in: loadIds } } });
  await prisma.assignment.deleteMany({ where: { orgId } });
  await prisma.load.deleteMany({ where: { orgId } });
  await prisma.driverLocation.deleteMany({ where: { driverId: { in: driverIds } } });
  await prisma.hosState.deleteMany({ where: { driverId: { in: driverIds } } });
  await prisma.serviceRecord.deleteMany({ where: { shopId: { in: shops.map((s) => s.id) } } });
  await prisma.serviceShop.deleteMany({ where: { orgId } });
  await prisma.restStop.deleteMany({ where: { orgId } });
  await prisma.fuelPrice.deleteMany({ where: { orgId } });
  await prisma.driver.deleteMany({ where: { orgId } });
  await prisma.tractor.deleteMany({ where: { orgId } });
  await prisma.trailer.deleteMany({ where: { orgId } });
  await prisma.carrier.deleteMany({ where: { orgId } });
  await prisma.dispatcher.deleteMany({ where: { orgId } });
  await prisma.org.delete({ where: { id: orgId } });
}

async function main(): Promise<void> {
  // Collapse the demo org down to exactly one. Whichever the dispatcher login
  // currently points at wins, so the credentials in the summary keep working;
  // the rest are deleted outright rather than left as orphans the board can
  // never reach but every global count still includes.
  const existing = await prisma.org.findMany({ where: { name: "Heartland Freight Co" }, select: { id: true } });
  const boundTo = await prisma.dispatcher.findUnique({ where: { email: "d@fleet.com" }, select: { orgId: true } });
  const keepId = boundTo?.orgId && existing.some((o) => o.id === boundTo.orgId) ? boundTo.orgId : existing[0]?.id;
  let removed = 0;
  for (const o of existing) {
    if (o.id === keepId) continue;
    await deleteOrg(o.id);
    removed++;
  }

  const org =
    (keepId ? await prisma.org.findUnique({ where: { id: keepId } }) : null) ??
    (await prisma.org.create({ data: { name: "Heartland Freight Co" } }));
  if (removed > 0) console.log(`  cleanup:    removed ${removed} duplicate "Heartland Freight Co" org(s) and everything in them`);

  await prisma.dispatcher.upsert({
    where: { email: "d@fleet.com" },
    update: { orgId: org.id, passwordHash: await bcrypt.hash("pass123", 10) },
    create: { email: "d@fleet.com", passwordHash: await bcrypt.hash("pass123", 10), name: "Demo Dispatcher", orgId: org.id },
  });

  await wipeOrgOperations(org.id);

  const carriers = {
    cornhusker:
      (await prisma.carrier.findFirst({ where: { orgId: org.id, name: "Cornhusker Carriers LLC" } })) ??
      (await prisma.carrier.create({
        data: {
          orgId: org.id, name: "Cornhusker Carriers LLC",
          // Cheaper drivers, thirstier trucks — an older fleet. The two
          // carriers differ on BOTH levers so the same load genuinely prices
          // differently depending on whose truck runs it. That is the whole
          // reason the carrier layer exists, and one differing field would
          // only half-show it.
          driverPayCentsPerMi: 60, mpg: 5.8, dieselCentsPerGal: 402, fixedCentsPerMi: 41,
          // 8% of linehaul — the common dispatch-service arrangement.
          commissionModel: "percent_linehaul", commissionPctBps: 800,
        },
      })),
    ozark:
      (await prisma.carrier.findFirst({ where: { orgId: org.id, name: "Ozark Trail Transport Inc" } })) ??
      (await prisma.carrier.create({
        data: {
          orgId: org.id, name: "Ozark Trail Transport Inc",
          // Pays drivers more, runs newer and more efficient equipment.
          driverPayCentsPerMi: 78, mpg: 7.1, dieselCentsPerGal: 394, fixedCentsPerMi: 48,
          // A flat weekly per truck instead — the other model carriers ask for,
          // and worth having both on screen so the statement view has to handle
          // them side by side.
          commissionModel: "per_truck_week", commissionFlatCents: 22_500,
        },
      })),
  };

  // `org`/`carrier` as connects, not raw `orgId`/`carrierId`: mixing scalar
  // foreign keys with the spread `extra` makes Prisma resolve to its
  // relation-shaped create input, which then rejects the scalar outright.
  const mkDriver = async (key: string, name: string, carrierId: string | null, extra: Record<string, unknown> = {}) => {
    const hash = await bcrypt.hash("demo123", 10);
    const rel = {
      org: { connect: { id: org.id } },
      ...(carrierId ? { carrier: { connect: { id: carrierId } } } : {}),
    };
    return prisma.driver.upsert({
      where: { email: `${key}@heartland.demo` },
      update: { name, hazmatEndorsed: true, status: "active", ...rel, ...extra },
      create: {
        email: `${key}@heartland.demo`,
        passwordHash: hash,
        name, hazmatEndorsed: true, status: "active", ...rel, ...extra,
      } as never,
    });
  };

  // Every driver gets a medical cert date. Setting it on only some left blank
  // "MED: —" chips on half the lane heads, which reads as an unfinished screen
  // rather than as missing data — and the drivers who DID show a date only had
  // one because an older seed's row survived the upsert.
  const med = (months: number) => ({ medicalCertExpiresAt: new Date(Date.now() + months * 30 * DAY) });
  const drivers: Record<string, { id: string; name: string }> = {
    jake: await mkDriver("jake", "Jake Morrow", carriers.cornhusker.id, med(9)),
    maria: await mkDriver("maria", "Maria Delgado", carriers.ozark.id, med(4)),
    tyrone: await mkDriver("tyrone", "Tyrone Banks", null, med(1)),
    dale: await mkDriver("dale", "Dale Hutchins", carriers.cornhusker.id, med(14)),
    // Sixth truck, deliberately unbooked and parked centrally. With five
    // drivers — two rolling, one medically out — ⚡Suggest had two candidates
    // to rank, which understates what the ranking is for.
    rico: await mkDriver("rico", "Rico Alvarez", carriers.cornhusker.id, med(11)),
    sam: await mkDriver("sam", "Sam Whitfield", carriers.ozark.id, {
      // Kept off the board on purpose: an unavailable unit is part of the
      // picture a dispatcher has to read.
      medicalCertExpiresAt: new Date(Date.now() - 30 * DAY),
    }),
  };

  // One tractor and one trailer PER DRIVER. Sharing a pool looked harmless
  // until six concurrent assignments were drawing from three units: the same
  // trailer showed on three lane heads at once, and a trailer cannot be on two
  // trucks. That is the kind of thing a freight buyer spots in the first
  // thirty seconds and stops believing the rest of the screen.
  const driverKeys = ["jake", "maria", "tyrone", "dale", "sam", "rico"] as const;
  const tractors: Record<string, { id: string }> = {};
  const trailers: Record<string, { id: string }> = {};
  const TRAILER_SPEC: Record<string, { unit: string; type: string }> = {
    jake: { unit: "DV-4450", type: "DryVan" },
    maria: { unit: "DV-4460", type: "DryVan" },
    tyrone: { unit: "RF-2201", type: "Reefer" },
    dale: { unit: "DV-4470", type: "DryVan" },
    sam: { unit: "FB-3310", type: "Flatbed" },
    rico: { unit: "DV-4480", type: "DryVan" },
  };
  for (const [i, key] of driverKeys.entries()) {
    const tUnit = String(1207 + i);
    const found = await prisma.tractor.findFirst({ where: { orgId: org.id, unit: tUnit } });
    tractors[key] =
      found ??
      (await prisma.tractor.create({
        data: {
          orgId: org.id, unit: tUnit, make: i % 2 ? "Kenworth" : "Freightliner", cab: "Sleeper", status: "active",
          // Real compliance clocks. Blank chips on every lane head read as an
          // unfinished screen; one unit deliberately runs close so the
          // inspection alert has something true to point at.
          inspectionExpiresAt: new Date(Date.now() + (i === 2 ? 6 : 120 + i * 30) * DAY),
          registrationExpiresAt: new Date(Date.now() + (200 + i * 20) * DAY),
          nextServiceAt: new Date(Date.now() + (i === 1 ? -3 : 45 + i * 15) * DAY),
        },
      }));
    const spec = TRAILER_SPEC[key];
    const foundTr = await prisma.trailer.findFirst({ where: { orgId: org.id, unit: spec.unit } });
    trailers[key] =
      foundTr ??
      (await prisma.trailer.create({
        data: {
          orgId: org.id, unit: spec.unit, type: spec.type, length: "53'", status: "active",
          inspectionExpiresAt: new Date(Date.now() + (150 + i * 25) * DAY),
          registrationExpiresAt: new Date(Date.now() + (i === 4 ? -12 : 240 + i * 15) * DAY),
        },
      }));
  }

  // ── Resolve every lane's REAL road once, up front ────────────────────────
  const lanes = [...WEEK.map((t) => [CITY[t.from], CITY[t.to]] as [LatLng, LatLng]),
                 ...BACKLOG.map((b) => [CITY[b.from], CITY[b.to]] as [LatLng, LatLng])];
  // Truck geometry, so the seeded GPS trail follows the road a 13'6" / 36 t
  // combination can legally drive — not the car route through a low tunnel.
  const truck = truckProfileFor({});
  const routes = await resolveRoutes(lanes, truck);
  // Compare unique-to-unique. Counting resolved routes against the raw PAIR
  // count reported "24/31 ... rest fall back to haversine" when every lane had
  // in fact resolved — the other 7 were duplicate lanes that collapse to the
  // same key. A false failure in a summary line is worse than no line: it sent
  // me hunting a timeout that did not exist.
  const uniqueLanes = new Set(lanes.map(([a, b]) => routeKey(a, b, truck))).size;
  const routed = routes.size;

  let pingCount = 0;
  let tripCount = 0;
  /** Where each driver finished their last trip — the empty miles to the next
   *  pickup come from here. A seed with deadheadMi: 0 on every load makes the
   *  product's own "empty miles avoided" ROI metric read zero, which is the
   *  one number a dispatch service is buying. */
  const lastDropByDriver = new Map<string, LatLng>();

  for (const [i, trip] of WEEK.entries()) {
    const from = CITY[trip.from];
    const to = CITY[trip.to];
    const route = routes.get(routeKey(from, to, truck));
    const miles = route?.miles ?? 0;
    // Empty miles from wherever this driver last dropped. First trip of the
    // week starts at its pickup, so no deadhead — that is true, not a gap.
    const prevDrop = lastDropByDriver.get(trip.driver);
    const deadheadMi = prevDrop ? Math.round(haversineMi(prevDrop, from) * 1.2) : 0;
    lastDropByDriver.set(trip.driver, to);
    // 50 mph planning speed plus an hour of service at each end.
    const driveMs = (miles / 50) * HOUR;
    const start = startOfTrip(trip.daysAgo, trip.startHour, trip.startHoursAgo);
    const end = start + HOUR + driveMs + HOUR + (trip.detentionMin ?? 0) * MIN;
    const now = Date.now();
    const status = end < now ? "delivered" : start < now ? "in_progress" : "assigned";
    const driver = drivers[trip.driver];
    const isReefer = trip.equip === "Reefer";

    // Cost covers TOTAL miles — the deadhead burns the same fuel and pays the
    // same driver. Costing only loaded miles put net margin at 38%, which no
    // freight operator would believe for a second (real net is 5-15%) and
    // would discredit every other number on the screen.
    const costCents = Math.round((miles + deadheadMi) * 167); // org all-in, cents/mi
    const load = await prisma.load.create({
      data: {
        orgId: org.id,
        requiredEquip: trip.equip,
        status,
        brokerName: trip.broker,
        orderRef: `W-${String(i + 1).padStart(2, "0")}-${trip.driver.toUpperCase()}`,
        revenueCents: trip.revenueCents,
        commodity: isReefer ? "Frozen produce" : "Palletized freight",
        stops: {
          create: [
            { sequence: 1, type: "pickup", address: from.address, lat: from.lat, lng: from.lng, geocodeStatus: "ok",
              appointment: { create: { windowStart: new Date(start), windowEnd: new Date(start + 2 * HOUR), type: "pickup" } } },
            { sequence: 2, type: "delivery", address: to.address, lat: to.lat, lng: to.lng, geocodeStatus: "ok",
              appointment: { create: { windowStart: new Date(end - 2 * HOUR), windowEnd: new Date(end + HOUR), type: "delivery" } } },
          ],
        },
        rate: {
          create: {
            linehaulCents: trip.revenueCents, fscCents: 0,
            totalMi: Math.round(miles) + deadheadMi, loadedMi: Math.round(miles), deadheadMi,
            ratePerLoadedMiCents: miles > 0 ? Math.round(trip.revenueCents / miles) : 0,
            estCostCents: costCents, marginCents: trip.revenueCents - costCents,
          },
        },
        assignment: {
          create: {
            orgId: org.id, driverId: driver.id,
            tractorId: tractors[trip.driver].id, trailerId: trailers[trip.driver].id,
            status: status === "delivered" ? "completed" : status === "in_progress" ? "in_progress" : "assigned",
            plannedStart: new Date(start), plannedEnd: new Date(end),
            ...(status === "delivered" ? { completedAt: new Date(end) } : {}),
            ...(status !== "assigned" ? { startedAt: new Date(start) } : {}),
            loadedMi: Math.round(miles), deadheadMi,
            // Empty miles this choice AVOIDED versus the median alternative
            // driver. Normally computed at commit time by rankOrgDrivers; a
            // seed that writes assignments directly has to supply it, or the
            // "EMPTY MI AVOIDED · ROI PROOF" tile — the first number on the
            // pitch screen — reads 0 mi / $0.00.
            savedMi: Math.max(0, Math.round(deadheadMi * 0.9 + 25)),
            marginCents: trip.revenueCents - costCents,
          },
        },
      },
    });
    tripCount++;

    // ── The GPS trail: interpolated along the REAL road, every 20 minutes ──
    const geometry = route?.geometry;
    if (geometry && geometry.length > 1) {
      const driveStart = start + HOUR; // an hour loading before the wheels turn
      const driveEnd = driveStart + driveMs;
      for (let t = driveStart; t <= Math.min(driveEnd, Date.now()); t += PING_EVERY_MIN * MIN) {
        const progress = driveMs > 0 ? (t - driveStart) / driveMs : 1;
        const [lng, lat] = pointAt(geometry, progress);
        await prisma.driverLocation.create({
          data: { driverId: driver.id, latitude: lat, longitude: lng, createdAt: new Date(t) },
        });
        pingCount++;
      }
      // Sitting at the delivery: repeated pings at the dock are what turn into
      // an observed dwell, and (past free time) a detention claim.
      const dwellEnd = Math.min(end, Date.now());
      for (let t = driveEnd; t <= dwellEnd; t += PING_EVERY_MIN * MIN) {
        await prisma.driverLocation.create({
          data: { driverId: driver.id, latitude: to.lat, longitude: to.lng, createdAt: new Date(t) },
        });
        pingCount++;
      }
      // ...and then the truck LEAVES. Without this the dwell never closes:
      // dwellSegments only ends a segment on an out-of-fence ping, so a
      // delivery on Monday and the next pickup from the same city on Tuesday
      // merged into one 24-hour "dwell". The week reported 21,792 billable
      // detention minutes — 363 hours across five trucks — every claim flagged
      // for review, which was the evidence guard correctly objecting to
      // nonsense. A truck that pulls out of the yard is what makes the claim
      // end where it really ended.
      if (dwellEnd >= driveEnd && dwellEnd + 30 * MIN <= Date.now()) {
        await prisma.driverLocation.create({
          data: {
            driverId: driver.id,
            latitude: to.lat + 0.15, // ~10 mi down the road
            longitude: to.lng + 0.15,
            createdAt: new Date(dwellEnd + 30 * MIN),
          },
        });
        pingCount++;
      }
    }

    // Keep the driver's own last-known position in step with their trail.
    const lastPing = await prisma.driverLocation.findFirst({ where: { driverId: driver.id }, orderBy: { createdAt: "desc" } });
    if (lastPing) {
      await prisma.driver.update({
        where: { id: driver.id },
        data: { lastLat: lastPing.latitude, lastLng: lastPing.longitude, lastLocationAt: lastPing.createdAt },
      });
    }
  }

  // ── HOS, derived from what each driver actually drove in the last 24h ────
  for (const [key, d] of Object.entries(drivers)) {
    // Only trips that have ALREADY STARTED count against the clock. The first
    // version filtered on "within the last 24h", which every FUTURE trip also
    // satisfies — so each driver was charged for work they had not done yet,
    // every clock collapsed to the 2h floor, and ⚡Suggest reported "needs 17h
    // drive; 2h remaining" for all five. The engine was right about the
    // arithmetic and the input was fiction.
    const recent = WEEK.filter((t) => {
      if (t.driver !== key) return false;
      const st = startOfTrip(t.daysAgo, t.startHour, t.startHoursAgo);
      return st <= Date.now() && st > Date.now() - DAY;
    });
    const drivenMin = recent.reduce((a, t) => {
      const r = routes.get(routeKey(CITY[t.from], CITY[t.to], truck));
      const fullMin = ((r?.miles ?? 0) / 50) * 60;
      // Only the part actually DRIVEN so far. Charging the whole trip put a
      // driver six hours into a twelve-hour run at 2h remaining instead of 5h,
      // and ⚡Suggest then rejected them for work they could legally take.
      const st = startOfTrip(t.daysAgo, t.startHour, t.startHoursAgo);
      const elapsedMin = Math.max(0, (Date.now() - st) / MIN - 60); // 60m loading first
      return a + Math.min(fullMin, elapsedMin);
    }, 0);
    // A driver does not accumulate a whole day's driving with no reset. Cap the
    // charge at a realistic single shift so the clocks read like a real ELD:
    // the earlier version subtracted every mile of the last 24h and produced
    // "9.1 / 0.0h" in red, which reads as a broken field rather than a driver
    // near their limit. One genuine tight clock is worth more than five
    // impossible ones.
    const shiftMin = Math.min(drivenMin, 540);
    const hos = {
      driveRemainingMin: Math.max(45, Math.round(660 - shiftMin)),
      windowRemainingMin: Math.max(60, Math.round(840 - shiftMin - 90)),
      cycleRemainingMin: Math.max(600, 4200 - Math.round(shiftMin * 2.5)),
      minutesSinceBreak: Math.round(Math.min(430, shiftMin)),
      importedAt: new Date(Date.now() - 20 * MIN),
    };
    await prisma.hosState.upsert({ where: { driverId: d.id }, create: { driverId: d.id, ...hos }, update: hos });
  }

  // ── Open freight waiting to be covered ──────────────────────────────────
  for (const [i, b] of BACKLOG.entries()) {
    const from = CITY[b.from];
    const to = CITY[b.to];
    const open = Date.now() + b.inHours * HOUR;
    await prisma.load.create({
      data: {
        orgId: org.id, requiredEquip: b.equip, status: "open", brokerName: b.broker,
        orderRef: `B-${String(i + 1).padStart(2, "0")}`,
        revenueCents: b.revenueCents, commodity: "General freight",
        stops: {
          create: [
            { sequence: 1, type: "pickup", address: from.address, lat: from.lat, lng: from.lng, geocodeStatus: "ok",
              appointment: { create: { windowStart: new Date(open), windowEnd: new Date(open + 3 * HOUR), type: "pickup" } } },
            { sequence: 2, type: "delivery", address: to.address, lat: to.lat, lng: to.lng, geocodeStatus: "ok",
              appointment: { create: { windowEnd: new Date(open + 30 * HOUR), type: "delivery" } } },
          ],
        },
      },
    });
  }

  const delivered = await prisma.load.count({ where: { orgId: org.id, status: "delivered" } });
  const rolling = await prisma.load.count({ where: { orgId: org.id, status: "in_progress" } });
  const openLoads = await prisma.load.count({ where: { orgId: org.id, status: "open" } });

  console.log("seeded one week of operations");
  console.log(`  window:     ${new Date(Date.now() - 6 * DAY).toDateString()} → today`);
  console.log(
    `  lanes:      ${routed}/${uniqueLanes} unique lanes on REAL truck-legal road geometry` +
      `${routed < uniqueLanes ? "  (rest fall back to haversine)" : ""}`,
  );
  console.log(`  trips:      ${tripCount}  (${delivered} delivered · ${rolling} rolling · ${tripCount - delivered - rolling} assigned)`);
  console.log(`  backlog:    ${openLoads} open loads awaiting cover`);
  console.log(`  GPS pings:  ${pingCount}, every ${PING_EVERY_MIN} min, interpolated along the road`);
  console.log(`  drivers:    ${Object.keys(drivers).length} (Sam parked — medical expired)`);
  console.log(`  detention:  Maria WIC→KC and Tyrone STL→MEM sit past free time on arrival`);
  // Record the moment this scenario is generated for. The demo time-shift
  // measures drift from here; without an anchor the button refuses rather than
  // guessing how stale the week has become (src/lib/demoTimeShift.ts).
  await prisma.demoAnchor.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", anchorAt: new Date() },
    update: { anchorAt: new Date() },
  });

  console.log(`  login:      d@fleet.com / pass123`);
  console.log(`  anchor:     set to now — the demo time-shift measures drift from here`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
