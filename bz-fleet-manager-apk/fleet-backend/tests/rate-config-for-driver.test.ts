import { resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { rateConfigForDriver } from "../src/lib/rateConfig.js";
import { DEFAULT_RATE_CONFIG } from "../src/domain/dispatch/economics.js";

// T1 combined review, Minor: rateConfigForDriver had no test of its own (its
// integration test was deleted along the way) — only exercised indirectly
// through carrier-pricing.test.ts's HTTP round trips. These are direct, DB-
// level tests of the three branches its own doc comment promises: a driver
// on a carrier, a driver with no carrier (org-only), and an id this table
// doesn't recognize.

beforeEach(resetDb);

it("resolves a driver on a carrier to the carrier's rate, field-by-field over the org's", async () => {
  const org = await prisma.org.create({
    data: { name: "Acme Fleet", mpg: 6.5, dieselCentsPerGal: 400, driverPayCentsPerMi: 60, fixedCentsPerMi: 45 },
  });
  // Carrier sets only driverPayCentsPerMi; every other field stays null and
  // must still inherit the org's — the same field-by-field rule
  // resolveRateConfig enforces, exercised here through the driver-id path.
  const carrier = await prisma.carrier.create({
    data: { orgId: org.id, name: "Carrier A", driverPayCentsPerMi: 90 },
  });
  const driver = await prisma.driver.create({
    data: { email: "carried@x.com", passwordHash: "x", name: "Carried Driver", orgId: org.id, carrierId: carrier.id },
  });

  const cfg = await rateConfigForDriver(driver.id);
  expect(cfg).toEqual({ mpg: 6.5, dieselCentsPerGal: 400, driverPayCentsPerMi: 90, fixedCentsPerMi: 45 });
});

it("resolves a driver with no carrier to the org's own rate, not the planning default", async () => {
  const org = await prisma.org.create({
    data: { name: "Acme Fleet", mpg: 5, dieselCentsPerGal: 1000, driverPayCentsPerMi: 200, fixedCentsPerMi: 300 },
  });
  const driver = await prisma.driver.create({
    data: { email: "orgonly@x.com", passwordHash: "x", name: "Org-only Driver", orgId: org.id }, // carrierId left null
  });

  const cfg = await rateConfigForDriver(driver.id);
  expect(cfg).toEqual({ mpg: 5, dieselCentsPerGal: 1000, driverPayCentsPerMi: 200, fixedCentsPerMi: 300 });
});

it("resolves a driver with neither org nor carrier to the planning defaults", async () => {
  const driver = await prisma.driver.create({
    data: { email: "orgless@x.com", passwordHash: "x", name: "Orgless Driver" }, // orgId and carrierId both null
  });

  const cfg = await rateConfigForDriver(driver.id);
  expect(cfg).toEqual(DEFAULT_RATE_CONFIG);
});

it("resolves an unknown driver id to the planning defaults, same as an orgless driver", async () => {
  const cfg = await rateConfigForDriver("does-not-exist");
  expect(cfg).toEqual(DEFAULT_RATE_CONFIG);
});
