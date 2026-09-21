// Seed a demo Control Tower org: drivers with positions + HOS, tractors,
// trailers, and geocoded loads with appointment windows — enough to exercise
// the loadboard, ⚡Suggest and drag-to-dispatch flows end to end.
// Usage: DATABASE_URL="file:./smoke.db" node seed-control-tower.mjs
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

const CITIES = {
  kansasCity: { address: "Kansas City, MO", lat: 39.0997, lng: -94.5786 },
  omaha: { address: "Omaha, NE", lat: 41.2565, lng: -95.9345 },
  memphis: { address: "Memphis, TN", lat: 35.1495, lng: -90.049 },
  littleRock: { address: "Little Rock, AR", lat: 34.7465, lng: -92.2896 },
  desMoines: { address: "Des Moines, IA", lat: 41.5868, lng: -93.625 },
  stLouis: { address: "St. Louis, MO", lat: 38.627, lng: -90.1994 },
  wichita: { address: "Wichita, KS", lat: 37.6872, lng: -97.3301 },
};

const FRESH_HOS = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0, importedAt: new Date() };

function hoursFromNow(h) {
  return new Date(Date.now() + h * 3_600_000);
}

async function main() {
  const org = await prisma.org.create({ data: { name: "Heartland Freight Co" } });

  // Demo dispatcher, org-scoped (multi-tenancy): d@fleet.com / pass123
  const dispatcherHash = await bcrypt.hash("pass123", 10);
  await prisma.dispatcher.upsert({
    where: { email: "d@fleet.com" },
    update: { orgId: org.id, passwordHash: dispatcherHash },
    create: { email: "d@fleet.com", passwordHash: dispatcherHash, name: "Demo Dispatcher", orgId: org.id },
  });

  // Night Shift (spec §17.2): every org gets a Standard agent policy. This
  // literal mirrors STANDARD_POLICY in src/lib/agentPolicies.ts — duplicated
  // here because this seed runs under plain `node`, which cannot import a
  // .ts module.
  await prisma.agentPolicy.upsert({
    where: { orgId_name: { orgId: org.id, name: "Standard" } },
    update: {},
    create: {
      orgId: org.id,
      name: "Standard",
      stopMin: 15, delayMin: 30, darkMin: 20, darkAtStopMin: 60,
      offRouteMi: 3.1, offRouteMin: 10,
      rungGapMin: 5, maxCalls: 2,
      dispatcherEmail: "d@fleet.com",
      customerEmailOn: false, shadow: true, bossCallOn: true,
      quietFrom: null, quietTo: null,
    },
  });

  // Upsert (not create): the seed must be rerunnable against a dirty dev.db —
  // driver emails are globally unique, so a rerun re-points the demo drivers
  // at the freshly created org and refreshes position + HOS.
  const mkDriver = (email, name, city, hos, extra = {}) =>
    prisma.driver.upsert({
      where: { email },
      update: {
        name, orgId: org.id, lastLat: city.lat, lastLng: city.lng,
        lastLocationAt: new Date(), hazmatEndorsed: true,
        ...(hos ? { hos: { upsert: { create: hos, update: hos } } } : {}),
        ...extra,
      },
      create: {
        email, passwordHash: "$2b$10$seedseedseedseedseedse.seedseedseedseedseedseedseedse",
        name, orgId: org.id, lastLat: city.lat, lastLng: city.lng,
        lastLocationAt: new Date(), hazmatEndorsed: true,
        ...(hos ? { hos: { create: hos } } : {}),
        ...extra,
      },
    });

  const [jake, maria, tyrone, dale] = await Promise.all([
    mkDriver("jake@heartland.demo", "Jake Morrow", CITIES.kansasCity, FRESH_HOS),
    mkDriver("maria@heartland.demo", "Maria Delgado", CITIES.stLouis, FRESH_HOS),
    mkDriver("tyrone@heartland.demo", "Tyrone Banks", CITIES.memphis, { ...FRESH_HOS, driveRemainingMin: 300, minutesSinceBreak: 400 }),
    // Dale: barely any hours left — the classic ❌ HOS row in Suggest.
    mkDriver("dale@heartland.demo", "Dale Hutchins", CITIES.desMoines, { ...FRESH_HOS, driveRemainingMin: 45, windowRemainingMin: 90 }),
  ]);
  // Sam: no HOS imported at all — exercises the unknown-HOS warning.
  const sam = await mkDriver("sam@heartland.demo", "Sam Whitfield", CITIES.wichita, null, { hazmatEndorsed: false });

  await prisma.tractor.createMany({
    data: [
      { orgId: org.id, unit: "1207", make: "Freightliner Cascadia", status: "active" },
      { orgId: org.id, unit: "1212", make: "Kenworth T680", status: "active" },
      { orgId: org.id, unit: "1199", make: "Volvo VNL", status: "in_shop" },
    ],
  });
  await prisma.trailer.createMany({
    data: [
      { orgId: org.id, unit: "DV-4450", type: "DryVan", length: "53'", status: "active" },
      { orgId: org.id, unit: "RF-2201", type: "Reefer", length: "53'", status: "active" },
      { orgId: org.id, unit: "FB-3310", type: "Flatbed", length: "48'", status: "idle" },
    ],
  });

  const mkLoad = (ref, equip, from, to, revenue, extra = {}) =>
    prisma.load.create({
      data: {
        orgId: org.id, externalId: ref, requiredEquip: equip,
        revenueCents: revenue, fscCents: Math.round(revenue * 0.12), status: "open",
        brokerName: extra.broker ?? "Landstar", commodity: extra.commodity ?? "General freight",
        hazmatClass: extra.hazmatClass ?? null,
        stops: {
          create: [
            { sequence: 1, type: "pickup", address: from.address, lat: from.lat, lng: from.lng,
              geocodeStatus: "ok", dwellMin: 60,
              appointment: { create: { windowStart: hoursFromNow(1), windowEnd: hoursFromNow(8), type: "pickup" } } },
            { sequence: 2, type: "delivery", address: to.address, lat: to.lat, lng: to.lng,
              geocodeStatus: "ok", dwellMin: 60,
              appointment: { create: { windowEnd: hoursFromNow(30), type: "delivery" } } },
          ],
        },
      },
    });

  await Promise.all([
    mkLoad("L-51217", "DryVan", CITIES.kansasCity, CITIES.omaha, 34000),
    mkLoad("L-51218", "Reefer", CITIES.memphis, CITIES.littleRock, 33200, { commodity: "Frozen produce", broker: "CH Robinson" }),
    mkLoad("L-51219", "DryVan", CITIES.stLouis, CITIES.kansasCity, 41800),
    mkLoad("L-51220", "Reefer", CITIES.omaha, CITIES.desMoines, 28500, { commodity: "Dairy", broker: "CH Robinson" }),
    mkLoad("L-51221", "DryVan", CITIES.wichita, CITIES.stLouis, 52000, { hazmatClass: "8", commodity: "Corrosives (UN1830)", broker: "TQL" }),
  ]);

  const drivers = [jake, maria, tyrone, dale, sam];
  console.log(`Seeded org "${org.name}" (${org.id}):`);
  console.log(`  dispatcher: d@fleet.com / pass123 (org-scoped)`);
  console.log(`  drivers:  ${drivers.map((d) => d.name).join(", ")}`);
  console.log(`  tractors: 1207, 1212 (active), 1199 (in shop)`);
  console.log(`  trailers: DV-4450 DryVan, RF-2201 Reefer, FB-3310 Flatbed`);
  console.log(`  loads:    L-51217..L-51221 (open; one HAZ-8)`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
