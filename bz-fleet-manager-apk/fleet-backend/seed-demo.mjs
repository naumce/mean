// Demo-story seed: layers the SALES-PITCH scenario on top of seed-control-tower.
// Run AFTER it, against the same DB:
//   node seed-control-tower.mjs && node seed-demo.mjs
// Adds: an unread driver message, completed-work history (Money/settlements/
// trend/broker analytics all light up), a live LATE-RISK trip, GPS pings for
// the map, a stale-HOS driver, and an alerts-feed entry — everything the
// Playwright pitch (fleet-portal/demo/pitch.mjs) walks through.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

const KC = { address: "Kansas City, MO", lat: 39.0997, lng: -94.5786 };
const OMAHA = { address: "Omaha, NE", lat: 41.2565, lng: -95.9345 };
const STL = { address: "St. Louis, MO", lat: 38.627, lng: -90.1994 };
const MEMPHIS = { address: "Memphis, TN", lat: 35.1495, lng: -90.049 };
const DAY = 24 * 3_600_000;

async function main() {
  const dispatcher = await prisma.dispatcher.findUniqueOrThrow({ where: { email: "d@fleet.com" } });
  const orgId = dispatcher.orgId;
  if (!orgId) throw new Error("run seed-control-tower.mjs first");

  const byEmail = async (email) => prisma.driver.findUniqueOrThrow({ where: { email } });
  const jake = await byEmail("jake@heartland.demo");
  const maria = await byEmail("maria@heartland.demo");
  const tyrone = await byEmail("tyrone@heartland.demo");
  const dale = await byEmail("dale@heartland.demo");
  const sam = await byEmail("sam@heartland.demo");

  // ── Carrier layer (T1): split the fleet across two carriers with
  // genuinely different pay rates, so the same lane visibly prices
  // differently by carrier — the whole point of tasks 1-9 having nothing to
  // show without this. Idempotent by (orgId, name): a rerun against the
  // same org updates the two rows in place instead of duplicating them.
  const upsertCarrier = async (name, data) => {
    const existing = await prisma.carrier.findFirst({ where: { orgId, name } });
    return existing
      ? prisma.carrier.update({ where: { id: existing.id }, data })
      : prisma.carrier.create({ data: { orgId, name, ...data } });
  };
  const carrierA = await upsertCarrier("Cornhusker Carriers LLC", {
    mcNumber: "MC-873421", dotNumber: "DOT-2204471", status: "active", driverPayCentsPerMi: 60,
  });
  const carrierB = await upsertCarrier("Ozark Trail Transport Inc", {
    mcNumber: "MC-559102", dotNumber: "DOT-1987733", status: "active", driverPayCentsPerMi: 78,
  });
  // Jake + Dale run for Cornhusker (60c/mi driver pay — matches the org
  // default, so their all-in rate equals an org-only driver's); Maria + Sam
  // run for Ozark Trail (78c/mi — visibly the pricier carrier on the same
  // lane). Tyrone is left WITHOUT a carrier on purpose: L-90411 below is
  // costed at "the org's own all-in rate" in a comment that has to stay
  // literally true against a live, undispatched driver, and the board's
  // "No carrier" group needs at least one real lane.
  await Promise.all([
    prisma.driver.update({ where: { id: jake.id }, data: { carrierId: carrierA.id } }),
    prisma.driver.update({ where: { id: dale.id }, data: { carrierId: carrierA.id } }),
    prisma.driver.update({ where: { id: maria.id }, data: { carrierId: carrierB.id } }),
    prisma.driver.update({ where: { id: sam.id }, data: { carrierId: carrierB.id } }),
    prisma.driver.update({ where: { id: tyrone.id }, data: { carrierId: null } }),
  ]);

  // Rerunnability: driver rows survive reseeds (upsert-by-email) but each
  // seed-control-tower run creates a NEW org — assignments from a previous
  // demo run would still mark the drivers busy and wreck the ⚡Suggest scene.
  // Drop every prior-org assignment for the demo drivers.
  const demoDriverIds = [jake.id, maria.id, tyrone.id, dale.id, sam.id];
  const stale = await prisma.assignment.findMany({
    where: { driverId: { in: demoDriverIds }, orgId: { not: orgId } },
    select: { id: true, loadId: true },
  });
  if (stale.length > 0) {
    const staleIds = stale.map((a) => a.id);
    const staleLoadIds = stale.map((a) => a.loadId);
    await prisma.deadheadLeg.deleteMany({ where: { assignmentId: { in: staleIds } } });
    await prisma.rate.deleteMany({ where: { loadId: { in: staleLoadIds } } });
    await prisma.assignment.deleteMany({ where: { id: { in: staleIds } } });
    console.log(`  cleanup:  removed ${stale.length} stale assignment(s) from earlier demo runs`);
  }

  // Jake can log into the driver app in a live demo: demo123.
  await prisma.driver.update({
    where: { id: jake.id },
    data: { passwordHash: await bcrypt.hash("demo123", 10), status: "online" },
  });

  // ── Scene: the unread driver message waiting in the inbox ────────────────
  await prisma.message.deleteMany({ where: { conversation: { driverId: jake.id } } });
  await prisma.conversation.deleteMany({ where: { driverId: jake.id } });
  await prisma.conversation.create({
    data: {
      driverId: jake.id,
      messages: {
        create: [
          { senderType: "driver", text: "Just dropped in Kansas City, trailer's empty. Got anything heading north today?", createdAt: new Date(Date.now() - 4 * 60_000) },
        ],
      },
    },
  });

  // ── Completed history: Money, settlements, trend, brokers all light up ───
  // Calibrated for the film: realistic lanes/rates, deliberate money-losers,
  // savedMi values that sum to a quotable "empty miles avoided" figure.
  /** Delete every load carrying one of these orderRefs, plus everything that
   *  references it. The seed creates its story loads with `load.create` and a
   *  fixed orderRef, but orderRef is NOT unique — so without this every rerun
   *  appended another copy. This DB had 25 copies each of L-77080/L-90411/
   *  L-88012 and 352 history loads before it was noticed, and every KPI built
   *  from them (committed gross, net margin, empty miles avoided) had been
   *  drifting upward on each reseed. Idempotency here is not tidiness; it is
   *  the difference between a demo whose numbers mean something and one whose
   *  numbers grow because it was run again. */
  const purgeLoadsByRef = async (refs) => {
    const prior = await prisma.load.findMany({
      where: { orgId, orderRef: { in: refs } }, select: { id: true },
    });
    if (prior.length === 0) return 0;
    const ids = prior.map((l) => l.id);
    const priorAssignments = await prisma.assignment.findMany({
      where: { loadId: { in: ids } }, select: { id: true },
    });
    await prisma.deadheadLeg.deleteMany({ where: { assignmentId: { in: priorAssignments.map((a) => a.id) } } });
    await prisma.dispatchConflict.deleteMany({ where: { loadId: { in: ids } } });
    await prisma.appointment.deleteMany({ where: { stop: { loadId: { in: ids } } } });
    await prisma.loadStop.deleteMany({ where: { loadId: { in: ids } } });
    await prisma.rate.deleteMany({ where: { loadId: { in: ids } } });
    await prisma.assignment.deleteMany({ where: { loadId: { in: ids } } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    return ids.length;
  };

  const completedRun = async (driver, from, to, broker, revenue, cost, daysAgo, loadedMi, deadheadMi, savedMi) => {
    const completedAt = new Date(Date.now() - daysAgo * DAY);
    return prisma.load.create({
      data: {
        orgId, requiredEquip: "DryVan", status: "delivered", brokerName: broker,
        orderRef: `H-${String(daysAgo).padStart(2, "0")}${driver.name.split(" ")[0].toUpperCase()}`,
        revenueCents: revenue, fscCents: 0, commodity: "Mixed freight",
        stops: { create: [
          { sequence: 1, type: "pickup", address: from.address, lat: from.lat, lng: from.lng, geocodeStatus: "ok" },
          { sequence: 2, type: "delivery", address: to.address, lat: to.lat, lng: to.lng, geocodeStatus: "ok" },
        ] },
        rate: { create: {
          linehaulCents: revenue, fscCents: 0, totalMi: loadedMi + deadheadMi, loadedMi, deadheadMi,
          ratePerLoadedMiCents: Math.round(revenue / loadedMi), estCostCents: cost, marginCents: revenue - cost,
        } },
        assignment: { create: {
          orgId, driverId: driver.id, status: "completed", completedAt,
          plannedStart: new Date(completedAt.getTime() - 9 * 3_600_000), plannedEnd: completedAt,
          loadedMi, deadheadMi, marginCents: revenue - cost, savedMi,
        } },
      },
    });
  };

  const CHI = { address: "Chicago, IL", lat: 41.8781, lng: -87.6298 };
  const DAL = { address: "Dallas, TX", lat: 32.7767, lng: -96.797 };
  const MSP = { address: "Minneapolis, MN", lat: 44.9778, lng: -93.265 };
  const DEN = { address: "Denver, CO", lat: 39.7392, lng: -104.9903 };

  // 16 delivered loads over 21 days, 4 brokers, mixed lanes at $1.9–$2.9 per
  // loaded mile. Two calibrated losers (H-03TYRONE loses EXACTLY $140 — the
  // film's red-row line quotes it). savedMi sums to ~390 for the ROI beat.
  //                 driver  from     to      broker         revenue  cost   d  loaded dh  saved
  // Story loads are recreated below; clear the previous run's copies first.
  const historyRefs = await prisma.load.findMany({
    where: { orgId, orderRef: { startsWith: "H-" } }, select: { orderRef: true },
  });
  await purgeLoadsByRef([...new Set(historyRefs.map((l) => l.orderRef))]);
  await purgeLoadsByRef(["L-77080", "L-90411", "L-88012"]);

  await completedRun(jake,   KC,      CHI,    "Landstar",     132000,  91000, 1, 510, 12, 34);
  await completedRun(maria,  STL,     KC,     "CH Robinson",   61000,  46000, 2, 250, 18, 21);
  await completedRun(tyrone, MEMPHIS, STL,    "TQL",           40000,  54000, 3, 285, 45, 8);  // LOSES $140
  await completedRun(jake,   KC,      DAL,    "Coyote",       143000, 101000, 4, 550, 10, 35);
  await completedRun(maria,  OMAHA,   MSP,    "Landstar",      88000,  64000, 5, 380, 15, 27);
  await completedRun(tyrone, STL,     MEMPHIS,"TQL",           72000,  55000, 6, 285, 20, 19);
  await completedRun(jake,   KC,      OMAHA,  "Landstar",      52000,  38000, 6, 190,  8, 14);
  await completedRun(maria,  KC,      DEN,    "CH Robinson",  151000, 112000, 8, 600, 14, 33);
  await completedRun(tyrone, MEMPHIS, DAL,    "Coyote",       118000,  86000, 9, 450, 25, 24);
  await completedRun(jake,   CHI,     KC,     "Landstar",     124000,  93000, 10, 510, 16, 31);
  await completedRun(maria,  STL,     CHI,    "TQL",           78000,  59000, 11, 300, 12, 22);
  await completedRun(dale,   OMAHA,   KC,     "CH Robinson",   47000,  36000, 12, 185, 10, 12);
  await completedRun(jake,   KC,      MSP,    "Landstar",     105000,  78000, 15, 440, 18, 29);
  await completedRun(maria,  DAL,     KC,     "Coyote",       128000, 104000, 16, 550, 60, 9);  // barely paid
  await completedRun(tyrone, STL,     KC,     "TQL",           58000,  44000, 18, 250, 14, 18);
  await completedRun(jake,   KC,      CHI,    "Landstar",     129000,  92000, 20, 510, 12, 30);

  // ── Act II's "brick, decoded": Maria assigned TODAY with visible deadhead ─
  const briefStart = new Date(Date.now() + 2 * 3_600_000);
  await prisma.load.create({
    data: {
      orgId, requiredEquip: "DryVan", status: "assigned", brokerName: "CH Robinson",
      orderRef: "L-77080", revenueCents: 64000, commodity: "Paper rolls",
      stops: { create: [
        { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng, geocodeStatus: "ok",
          appointment: { create: { windowEnd: new Date(briefStart.getTime() + 2 * 3_600_000), type: "pickup" } } },
        { sequence: 2, type: "delivery", address: OMAHA.address, lat: OMAHA.lat, lng: OMAHA.lng, geocodeStatus: "ok",
          appointment: { create: { windowEnd: new Date(briefStart.getTime() + 9 * 3_600_000), type: "delivery" } } },
      ] },
      rate: { create: {
        linehaulCents: 64000, fscCents: 0, totalMi: 235, loadedMi: 190, deadheadMi: 45,
        ratePerLoadedMiCents: 337, estCostCents: 39200, marginCents: 24800,
      } },
      assignment: { create: {
        orgId, driverId: maria.id, status: "assigned",
        plannedStart: briefStart, plannedEnd: new Date(briefStart.getTime() + 5 * 3_600_000),
        loadedMi: 190, deadheadMi: 45, marginCents: 24800, savedMi: 18,
      } },
    },
  });

  // ── The hot load: L-51217's pickup window closes in 2.5h → red "cover
  // now" chip, and it deterministically leads the urgency-sorted backlog
  // (it's the load Jake gets in Act III). ─────────────────────────────────
  const hot = await prisma.load.findFirst({
    where: { orgId, externalId: "L-51217" },
    include: { stops: { orderBy: { sequence: "asc" }, include: { appointment: true } } },
  });
  const hotPickup = hot?.stops.find((s) => s.type === "pickup");
  if (hotPickup?.appointment) {
    await prisma.appointment.update({
      where: { id: hotPickup.appointment.id },
      data: { windowEnd: new Date(Date.now() + 2.5 * 3_600_000) },
    });
  }

  // ── The live problem: Tyrone rolling from Memphis, KC window closes in 1h ─
  const lateLoad = await prisma.load.create({
    data: {
      orgId, requiredEquip: "DryVan", status: "in_progress", brokerName: "TQL",
      orderRef: "L-90411", revenueCents: 74000, commodity: "Retail goods",
      stops: { create: [
        { sequence: 1, type: "pickup", address: MEMPHIS.address, lat: MEMPHIS.lat, lng: MEMPHIS.lng, geocodeStatus: "ok" },
        { sequence: 2, type: "delivery", address: KC.address, lat: KC.lat, lng: KC.lng, geocodeStatus: "ok",
          appointment: { create: { windowEnd: new Date(Date.now() + 3_600_000), type: "delivery" } } },
      ] },
      // Priced like every other seeded load: Memphis->KC is 455 loaded mi plus
      // 15 mi of deadhead, costed at the org's own all-in rate (400c/gal ÷ 6.5
      // mpg + 60c driver + 45c fixed = 167c/mi) -> $784.90. At $740 of revenue
      // this cheap TQL load genuinely loses $44.90, so margin heat paints it
      // red for a real reason. Without a Rate row the board would have shown
      // "+$0 MARGIN" and painted it red anyway — a claim about nothing.
      rate: { create: {
        linehaulCents: 74000, fscCents: 0, totalMi: 470, loadedMi: 455, deadheadMi: 15,
        ratePerLoadedMiCents: 163, estCostCents: 78490, marginCents: -4490,
      } },
      assignment: { create: {
        orgId, driverId: tyrone.id, status: "in_progress", startedAt: new Date(Date.now() - 2 * 3_600_000),
        plannedStart: new Date(Date.now() - 2 * 3_600_000), plannedEnd: new Date(Date.now() + 30 * 60_000),
        loadedMi: 455, deadheadMi: 15, marginCents: -4490, savedMi: 0,
      } },
    },
  });

  // ── Alerts feed: a warning that was accepted at commit time ──────────────
  await prisma.dispatchConflict.create({
    data: {
      orgId, loadId: lateLoad.id, driverId: tyrone.id,
      kind: "hos", severity: "warn",
      detail: "Tight arrival: only 25 min of slack against the delivery window at commit",
    },
  });

  // ── Live map: recent GPS pings ───────────────────────────────────────────
  // Cleared first, for the same reason the history block above is: these three
  // rows were being appended on every run, so the "live" map slowly filled
  // with stale positions from previous seeds.
  await prisma.driverLocation.deleteMany({
    where: { driverId: { in: [jake.id, maria.id, tyrone.id] } },
  });
  await prisma.driverLocation.createMany({
    data: [
      { driverId: jake.id, latitude: KC.lat, longitude: KC.lng, createdAt: new Date(Date.now() - 2 * 60_000) },
      { driverId: maria.id, latitude: STL.lat, longitude: STL.lng, createdAt: new Date(Date.now() - 5 * 60_000) },
      { driverId: tyrone.id, latitude: 36.8, longitude: -92.5, createdAt: new Date(Date.now() - 60_000) },
    ],
  });

  // ── Honesty beat: Maria's clocks are three days old → 'stale' chip ───────
  await prisma.hosState.update({
    where: { driverId: maria.id },
    data: { importedAt: new Date(Date.now() - 3 * DAY) },
  });

  // ── Fleet compliance: clocks, shops, and the maintenance ledger ──────────
  // Tractor 1207 + trailer DV-4450 stay CLEAN (the film's dispatch uses them);
  // the trouble lives on 1212 (inspection closing in), the Flatbed (expired
  // registration -> blocks), Tyrone (medical due soon), Sam (medical expired).
  const tractors = await prisma.tractor.findMany({ where: { orgId }, orderBy: { unit: "asc" } });
  const trailers = await prisma.trailer.findMany({ where: { orgId }, orderBy: { unit: "asc" } });
  const t1207 = tractors.find((t) => t.unit === "1207");
  const t1212 = tractors.find((t) => t.unit === "1212");
  const flatbed = trailers.find((t) => t.type === "Flatbed");
  const dryVan = trailers.find((t) => t.type === "DryVan");

  // Cockpit pairing: the unit each driver normally runs (lane header + drop default).
  const byUnit = (arr, unit) => arr.find((u) => u.unit === unit) ?? null;
  const t1199 = byUnit(tractors, "1199");
  const pair = async (driver, tractor, trailer) =>
    driver && (await prisma.driver.update({ where: { id: driver.id }, data: { defaultTractorId: tractor?.id ?? null, defaultTrailerId: trailer?.id ?? null } }));
  await pair(jake, t1207, byUnit(trailers, "DV-4450"));
  await pair(tyrone, t1212, byUnit(trailers, "RF-2201"));
  await pair(maria, t1199, byUnit(trailers, "FB-3310")); // in-shop tractor + expired-reg trailer: the chips light up

  // Carrier-tag the units riding with each carrier's driver: the loadboard
  // filters tractors/trailers by carrierId the same way it filters drivers
  // (T1 Task 8), so a carrier-filtered board must not strand a lane's own
  // paired equipment outside the filter. Tyrone's pair (1212 / RF-2201)
  // stays carrierless on purpose, matching his driver record above. 1199
  // isn't touched elsewhere in this file, so it gets its own tiny update.
  if (t1199) await prisma.tractor.update({ where: { id: t1199.id }, data: { carrierId: carrierB.id } });

  if (t1207) await prisma.tractor.update({ where: { id: t1207.id }, data: {
    inspectionExpiresAt: new Date(Date.now() + 200 * DAY), registrationExpiresAt: new Date(Date.now() + 300 * DAY), nextServiceAt: new Date(Date.now() + 45 * DAY),
    lastLat: KC.lat, lastLng: KC.lng, // parked KC -> nearest-shop picker has a basis
    carrierId: carrierA.id,
  } });
  if (t1212) await prisma.tractor.update({ where: { id: t1212.id }, data: {
    inspectionExpiresAt: new Date(Date.now() + 6 * DAY), registrationExpiresAt: new Date(Date.now() + 120 * DAY), nextServiceAt: new Date(Date.now() - 5 * DAY),
    lastLat: STL.lat, lastLng: STL.lng,
  } });
  if (flatbed) await prisma.trailer.update({ where: { id: flatbed.id }, data: {
    registrationExpiresAt: new Date(Date.now() - 12 * DAY), inspectionExpiresAt: new Date(Date.now() + 90 * DAY),
    carrierId: carrierB.id,
    // Live map (T2): FB-3310 is Maria's default pairing only — no active
    // assignment ever puts it on the road in this seed — so it's genuinely
    // DROPPED and its last-known position is honest, not stale. Dropped in
    // Omaha 4 days ago: the map's trailer-pin layer has nothing to show
    // without this, since none of the 16 delivered loads above went through
    // the completion route that stamps a trailer's position (they were
    // seeded directly). This is also the exact trailer mapData.ts's own doc
    // comment uses as its running example ("where is FB-3310?").
    lastLat: OMAHA.lat, lastLng: OMAHA.lng, lastSeenAt: new Date(Date.now() - 4 * DAY),
  } });
  if (dryVan) await prisma.trailer.update({ where: { id: dryVan.id }, data: {
    inspectionExpiresAt: new Date(Date.now() + 150 * DAY), registrationExpiresAt: new Date(Date.now() + 220 * DAY), nextServiceAt: new Date(Date.now() + 60 * DAY),
    carrierId: carrierA.id,
  } });
  await prisma.driver.update({ where: { id: tyrone.id }, data: { medicalCertExpiresAt: new Date(Date.now() + 20 * DAY) } });
  await prisma.driver.update({ where: { id: sam.id }, data: { medicalCertExpiresAt: new Date(Date.now() - 30 * DAY) } });
  await prisma.driver.update({ where: { id: jake.id }, data: { medicalCertExpiresAt: new Date(Date.now() + 300 * DAY) } });
  await prisma.driver.update({ where: { id: maria.id }, data: { medicalCertExpiresAt: new Date(Date.now() + 140 * DAY) } });

  // The film's Act IV prop: a Flatbed load. The org's only Flatbed has an
  // expired registration, so ⚡Suggest blocks EVERY driver — proving on
  // camera that the problem is the trailer, not the people.
  await prisma.load.create({ data: {
    orgId, requiredEquip: "Flatbed", status: "open", brokerName: "Coyote",
    orderRef: "L-88012", revenueCents: 98000, commodity: "Machinery (crated)",
    stops: { create: [
      { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng, geocodeStatus: "ok",
        appointment: { create: { windowEnd: new Date(Date.now() + 3 * DAY), type: "pickup" } } },
      { sequence: 2, type: "delivery", address: STL.address, lat: STL.lat, lng: STL.lng, geocodeStatus: "ok",
        appointment: { create: { windowEnd: new Date(Date.now() + 4 * DAY), type: "delivery" } } },
    ] },
  } });

  const kcShop = await prisma.serviceShop.create({ data: {
    orgId, name: "KC Truck Center", address: "Kansas City, MO", lat: 39.0997, lng: -94.5786, phone: "816-555-0101",
  } });
  const stlShop = await prisma.serviceShop.create({ data: {
    orgId, name: "Gateway Fleet Service", address: "St. Louis, MO", lat: 38.627, lng: -90.1994, phone: "314-555-0177",
  } });
  if (t1207) await prisma.serviceRecord.create({ data: {
    orgId, shopId: kcShop.id, tractorId: t1207.id, kind: "inspection", notes: "annual DOT — passed",
    performedAt: new Date(Date.now() - 165 * DAY), nextDueAt: new Date(Date.now() + 200 * DAY),
  } });
  if (t1212) await prisma.serviceRecord.create({ data: {
    orgId, shopId: stlShop.id, tractorId: t1212.id, kind: "service", notes: "PM B — oil, brakes",
    performedAt: new Date(Date.now() - 95 * DAY), nextDueAt: new Date(Date.now() - 5 * DAY),
  } });

  // ── T3 Break and Rest Planning: demo rest stops ──────────────────────────
  // Idempotent by (orgId, name), same shape as upsertCarrier above. Every row
  // is tagged source: "demo" and named generically (road + facility type +
  // nearest city) — never a real brand (Pilot, Love's, TA, Flying J) and
  // never a claim to have surveyed an exact facility address. We have not
  // imported any real facility data; this is flavor for the CRUD/import demo
  // and a fixture for the no_rest scenario below, not an assertion that a
  // specific truck stop exists at these coordinates.
  const upsertRestStop = async (name, data) => {
    const existing = await prisma.restStop.findFirst({ where: { orgId, name } });
    const row = { name, source: "demo", ...data };
    return existing
      ? prisma.restStop.update({ where: { id: existing.id }, data: row })
      : prisma.restStop.create({ data: { orgId, ...row } });
  };

  // General corridor coverage (KC<->STL<->MEMPHIS<->OMAHA, the lanes Tyrone,
  // Maria and Jake actually run above) — plausible I-70/I-55/I-29 waypoints,
  // not tied to any one break-point computation.
  await upsertRestStop("I-70 Rest Area — Columbia MO", {
    kind: "rest_area", lat: 38.9517, lng: -92.3341, spaces: 45, amenities: ["restrooms", "vending"],
  });
  await upsertRestStop("Truck Parking — Effingham IL", {
    kind: "truck_stop", lat: 39.12, lng: -88.5434, spaces: 120, amenities: ["fuel", "showers", "parking"],
  });
  await upsertRestStop("I-55 Rest Area — Cape Girardeau MO", {
    // Capacity genuinely unknown for this one — kept null on purpose so the
    // demo also shows the "absent, not zero" case outside the test suite.
    kind: "rest_area", lat: 37.3059, lng: -89.5181, amenities: [],
  });
  await upsertRestStop("I-29 Rest Area — St Joseph MO", {
    kind: "rest_area", lat: 39.7391, lng: -94.8467, spaces: 30, amenities: ["restrooms"],
  });

  // ── The deliberate coverage gap: KC -> DEN (Maria's Landstar lane above,
  // I-70 West) ───────────────────────────────────────────────────────────
  // A fresh driver's 8h/480-min break on this ~560-mi great-circle lane
  // (driveLeg's interpolation, not a real road) lands at approximately
  // (39.594, -100.786) — see the computation this seed was built from:
  // haversineMi(KC, DEN) ≈ 557 mi; roadMiles (×1.2) ≈ 669 mi; legMin ≈ 802;
  // break fraction = 480/802 ≈ 0.598 of the great-circle arc ≈ 333 mi out of
  // KC. The two stops below sit ~100 mi to either side of that point —
  // inside COVERAGE_RADIUS_MI (150, restConflict.ts), so the org
  // demonstrably has rest data on this corridor — but neither is within
  // REST_SEARCH_RADIUS_MI (35, restOptions.ts) of the break itself. That gap
  // is what should make Task 10's break-and-rest evaluation surface a
  // `no_rest` block instead of either a false option or false silence.
  // Named generically/regionally rather than after a specific town: the
  // computed points don't sit on a real named exit, so a precise city tag
  // here would overclaim exactly the kind of fact this product refuses to
  // fabricate.
  await upsertRestStop("I-70 Rest Area — North Central Kansas", {
    kind: "rest_area", lat: 39.4801, lng: -98.9084, spaces: 25, amenities: ["restrooms"],
  });
  await upsertRestStop("I-70 Truck Parking — Northwest Kansas", {
    kind: "truck_stop", lat: 39.6775, lng: -102.6555, amenities: [],
  });

  // ── T4 Fuel and Stops: demo diesel prices ─────────────────────────────────
  // Idempotent by (orgId, state, effectiveOn) — same shape as upsertRestStop
  // above, but keyed on the model's own unique constraint
  // (@@unique([orgId, state, effectiveOn]), prisma/schema.prisma) via an
  // explicit find-then-branch rather than a bare create, since a duplicate
  // create against that constraint would throw (P2002) on the second run
  // instead of updating in place.
  //
  // ILLUSTRATIVE FIGURES ONLY. These numbers are invented for this demo, not
  // observed EIA (U.S. Energy Information Administration) prices or any other
  // real market data — that's exactly what source: "demo" flags them as, so
  // nothing downstream can present them as an actual observed price. Never
  // treat these as real diesel prices anywhere — not in code, not in the UI,
  // not in a console line.
  //
  // Priced for five of the six states the live demo lanes touch: MO
  // (KC/STL — the hub every lane runs through), TN (Memphis, L-90411's live
  // late-risk pickup), CO (Denver, L-70255's KC->DEN gap-lane delivery), and
  // KS/IL (corridor states under the rest-stop coverage seeded just above,
  // not a load's own pickup/delivery but on the paths those lanes run).
  //
  // NE (Nebraska) is DELIBERATELY left unpriced. L-77080 — Act II's "brick,
  // decoded" load, KC -> Omaha, assigned to Maria and one of the pitch's most
  // visible beats — delivers into NE, so its buy-here advice has nowhere to
  // read a price from and renders "unknown" rather than a fabricated number:
  // the absent-not-zero path (Global Constraint 1), demonstrable live in the
  // running product and not only in a test.
  const priceDay = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const upsertFuelPrice = async (state, centsPerGal) => {
    const existing = await prisma.fuelPrice.findFirst({ where: { orgId, state, effectiveOn: priceDay } });
    return existing
      ? prisma.fuelPrice.update({ where: { id: existing.id }, data: { centsPerGal, source: "demo" } })
      : prisma.fuelPrice.create({ data: { orgId, state, centsPerGal, effectiveOn: priceDay, source: "demo" } });
  };
  await upsertFuelPrice("MO", 389);
  await upsertFuelPrice("TN", 372);
  await upsertFuelPrice("CO", 415);
  await upsertFuelPrice("KS", 379);
  await upsertFuelPrice("IL", 401);

  // ── The load that makes the gap reachable ────────────────────────────────
  // The two stops above put a coverage gap over KC->DEN's break point, but a
  // gap nobody can dispatch into demonstrates nothing: the KC->DEN lane above
  // is a COMPLETED historical run, so before this load there was no live work
  // on that corridor at all. This is the load a dispatcher drags to see
  // `no_rest` fire.
  await purgeLoadsByRef(["L-70255"]);
  await prisma.load.create({
    data: {
      orgId, requiredEquip: "DryVan", status: "open", brokerName: "Landstar",
      orderRef: "L-70255", revenueCents: 218000, commodity: "Palletized freight",
      stops: { create: [
        { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng, geocodeStatus: "ok" },
        { sequence: 2, type: "delivery", address: DEN.address, lat: DEN.lat, lng: DEN.lng, geocodeStatus: "ok",
          appointment: { create: { windowEnd: new Date(Date.now() + 40 * 3_600_000), type: "delivery" } } },
      ] },
    },
  });

  // ── T5 Dwell and Detention: demo detention scenarios ─────────────────────
  // Three deliberately different stops, each named below so the live pass can
  // find it (task-5-brief.md Step 4). Dedicated drivers — not jake/maria/
  // tyrone/dale/sam — so this section owns its own DriverLocation rows
  // outright: it can delete-then-recreate them by driverId on every rerun
  // without touching the "live map" pings the earlier scenes above seed for
  // jake/maria/tyrone.
  //
  // Idempotent by orderRef, same shape as L-70255 above: stops/appointments/
  // assignments hold FKs onto the load, so they're all cleared (dependency
  // order — appointment/stop/assignment before load) before every recreate,
  // and each dedicated driver's own pings are cleared by driverId before
  // their fresh batch is inserted. Checked by running this script three
  // times in a row and diffing row counts.
  const mkDetentionDriver = async (email, name) =>
    prisma.driver.upsert({
      where: { email },
      update: { name, orgId },
      create: {
        email, orgId, name,
        passwordHash: "$2b$10$seedseedseedseedseedse.seedseedseedseedseedseedseedse",
      },
    });
  const nadia = await mkDetentionDriver("nadia@heartland.demo", "Nadia Kessler");
  const priya = await mkDetentionDriver("priya@heartland.demo", "Priya Anand");
  const cole = await mkDetentionDriver("cole@heartland.demo", "Cole Whitmore");

  const resetDetentionLoad = async (orderRef) => {
    const prior = await prisma.load.findMany({ where: { orgId, orderRef }, select: { id: true } });
    if (prior.length === 0) return;
    const ids = prior.map((l) => l.id);
    await prisma.appointment.deleteMany({ where: { stop: { loadId: { in: ids } } } });
    await prisma.loadStop.deleteMany({ where: { loadId: { in: ids } } });
    await prisma.assignment.deleteMany({ where: { loadId: { in: ids } } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
  };
  const MIN_MS = 60_000;

  // 1. DET-CLEAN — a clean, billable claim. Minute-by-minute pings (dense,
  // realistic) for 3h at the dock against the org's 2h (120min) default free
  // time -> 60 billable minutes, plus a later out-of-fence ping so departure
  // is observed. The "3h at a dock" case from the spec.
  await resetDetentionLoad("DET-CLEAN");
  await prisma.driverLocation.deleteMany({ where: { driverId: nadia.id } });
  {
    const windowStart = Date.now() - 5 * 3_600_000;
    const dock = { address: "Heartland DC 14 dock door — Kansas City, MO", lat: KC.lat, lng: KC.lng };
    await prisma.load.create({
      data: {
        orgId, requiredEquip: "DryVan", status: "in_progress", orderRef: "DET-CLEAN",
        brokerName: "Landstar", commodity: "Palletized freight",
        stops: { create: [
          { sequence: 1, type: "delivery", address: dock.address, lat: dock.lat, lng: dock.lng, geocodeStatus: "ok",
            appointment: { create: { windowStart: new Date(windowStart), windowEnd: new Date(windowStart + 8 * 3_600_000), type: "delivery" } } },
        ] },
        assignment: { create: {
          orgId, driverId: nadia.id,
          plannedStart: new Date(windowStart - 3_600_000), plannedEnd: new Date(windowStart + 8 * 3_600_000),
        } },
      },
    });
    const pingCount = 181; // minute-by-minute, 0..180min inclusive
    await prisma.driverLocation.createMany({
      data: Array.from({ length: pingCount }, (_, i) => ({
        driverId: nadia.id, latitude: dock.lat, longitude: dock.lng, createdAt: new Date(windowStart + i * MIN_MS),
      })),
    });
    // Departure: a ping well outside the 0.5mi fence, after the last in-fence one.
    await prisma.driverLocation.create({
      data: { driverId: nadia.id, latitude: dock.lat + 0.1, longitude: dock.lng + 0.1, createdAt: new Date(windowStart + 185 * MIN_MS) },
    });
  }

  // 2. DET-REVIEW — a claim needing review. Same shape as DET-CLEAN, but a
  // deliberate ~3h hole in the pings (well past GAP_REVIEW_MIN) so
  // needsReview fires with its gap reason, even though evidence is dense on
  // both sides of the hole and departure is observed.
  await resetDetentionLoad("DET-REVIEW");
  await prisma.driverLocation.deleteMany({ where: { driverId: priya.id } });
  {
    const windowStart = Date.now() - 6 * 3_600_000;
    const dock = { address: "Gateway Yard 3 dock door — St. Louis, MO", lat: STL.lat, lng: STL.lng };
    await prisma.load.create({
      data: {
        orgId, requiredEquip: "DryVan", status: "in_progress", orderRef: "DET-REVIEW",
        brokerName: "CH Robinson", commodity: "Mixed freight",
        stops: { create: [
          { sequence: 1, type: "delivery", address: dock.address, lat: dock.lat, lng: dock.lng, geocodeStatus: "ok",
            appointment: { create: { windowStart: new Date(windowStart), windowEnd: new Date(windowStart + 8 * 3_600_000), type: "delivery" } } },
        ] },
        assignment: { create: {
          orgId, driverId: priya.id,
          plannedStart: new Date(windowStart - 3_600_000), plannedEnd: new Date(windowStart + 8 * 3_600_000),
        } },
      },
    });
    // Dense cluster on arrival (0..30min), a ~3h gap, dense cluster again
    // (210..240min) — maxGapMin (~180) is well past GAP_REVIEW_MIN (30), and
    // 8 pings total keeps this above DENSE_EVIDENCE_PINGS so only the gap
    // reason fires, not the thin-evidence one.
    const clusterMinutes = [0, 10, 20, 30, 210, 220, 230, 240];
    await prisma.driverLocation.createMany({
      data: clusterMinutes.map((m) => ({
        driverId: priya.id, latitude: dock.lat, longitude: dock.lng, createdAt: new Date(windowStart + m * MIN_MS),
      })),
    });
    await prisma.driverLocation.create({
      data: { driverId: priya.id, latitude: dock.lat + 0.1, longitude: dock.lng + 0.1, createdAt: new Date(windowStart + 245 * MIN_MS) },
    });
  }

  // 3. DET-NOCLAIM — dwell observed, but NO claim: pings are present and
  // there's a real ~3h dwell, but geocodeStatus is "pending" (never
  // confirmed "ok") — the fence sits on an unconfirmed city-centroid guess,
  // not a surveyed dock. This is the most important of the three: it proves
  // the product refuses to invoice on bad geometry, even with plenty of
  // ping evidence and a real appointment sitting right there.
  await resetDetentionLoad("DET-NOCLAIM");
  await prisma.driverLocation.deleteMany({ where: { driverId: cole.id } });
  {
    const windowStart = Date.now() - 5.5 * 3_600_000;
    const guess = { address: "Memphis, TN (ungeocoded delivery address)", lat: MEMPHIS.lat, lng: MEMPHIS.lng };
    await prisma.load.create({
      data: {
        orgId, requiredEquip: "DryVan", status: "in_progress", orderRef: "DET-NOCLAIM",
        brokerName: "TQL", commodity: "Retail goods",
        stops: { create: [
          { sequence: 1, type: "delivery", address: guess.address, lat: guess.lat, lng: guess.lng, geocodeStatus: "pending",
            appointment: { create: { windowStart: new Date(windowStart), windowEnd: new Date(windowStart + 8 * 3_600_000), type: "delivery" } } },
        ] },
        assignment: { create: {
          orgId, driverId: cole.id,
          plannedStart: new Date(windowStart - 3_600_000), plannedEnd: new Date(windowStart + 8 * 3_600_000),
        } },
      },
    });
    const pingMinutes = Array.from({ length: 19 }, (_, i) => i * 10); // 0..180min, every 10min
    await prisma.driverLocation.createMany({
      data: pingMinutes.map((m) => ({
        driverId: cole.id, latitude: guess.lat, longitude: guess.lng, createdAt: new Date(windowStart + m * MIN_MS),
      })),
    });
    await prisma.driverLocation.create({
      data: { driverId: cole.id, latitude: guess.lat + 0.1, longitude: guess.lng + 0.1, createdAt: new Date(windowStart + 190 * MIN_MS) },
    });
  }

  console.log("demo story seeded (film calibration):");
  console.log("  inbox:    1 unread message from Jake Morrow");
  console.log("  history:  16 delivered loads / 21 days / 4 brokers — H-03TYRONE loses exactly $140");
  console.log("  brick:    L-77080 assigned to Maria today w/ 45mi deadhead hatch (Act II zoom)");
  console.log("  hot load: L-51217 pickup closes in 2.5h -> red 'cover now', leads the backlog");
  console.log("  problem:  L-90411 rolling Memphis->KC, window closes in 1h -> LATE RISK");
  console.log("  alerts:   1 commit-time warning; map: 3 live pings; Maria's HOS 3 days stale");
  console.log("  map:      FB-3310 dropped in Omaha, NE 4d ago -> trailer pin with age label (default-paired to Maria, not hooked)");
  console.log("  fleet:    1212 inspection 6d + PM overdue; Flatbed registration EXPIRED; Sam medical EXPIRED; 2 shops + ledger");
  console.log("  cockpit:  Jake↔1207/DV-4450 · Tyrone↔1212/RF-2201 · Maria↔1199/FB-3310 paired");
  console.log("  carriers: Cornhusker Carriers LLC @60c/mi (Jake, Dale) · Ozark Trail Transport Inc @78c/mi (Maria, Sam) · Tyrone: no carrier (org rate)");
  console.log("  rest stops: 6 seeded (source: demo) — KC->DEN carries a deliberate coverage gap ~mile 333");
  console.log("  no_rest:  L-70255 KC->DEN is the live backlog load that drags into that gap");
  console.log("  fuel:     5 states priced (source: demo, illustrative figures only — not EIA data): MO/TN/CO/KS/IL");
  console.log("  unknown:  NE intentionally unpriced — L-77080's Omaha delivery renders buy-here advice as 'unknown'");
  console.log("  detention: DET-CLEAN (Nadia, KC dock) 60min billable, no review needed");
  console.log("             DET-REVIEW (Priya, STL dock) 120min billable, needsReview via a ~180min ping gap");
  console.log("             DET-NOCLAIM (Cole, Memphis) ~180min real dwell but geocodeStatus 'pending' -> no claim");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
