import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);

it("a driver can carry a default tractor/trailer pairing", async () => {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "1207" } });
  const trailer = await prisma.trailer.create({ data: { orgId: org.id, unit: "DV-4450", type: "DryVan" } });
  const driver = await prisma.driver.create({
    data: { email: "j@x.com", passwordHash: "x", name: "Jake", orgId: org.id,
            defaultTractorId: tractor.id, defaultTrailerId: trailer.id },
  });
  const read = await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
  expect(read.defaultTractorId).toBe(tractor.id);
  expect(read.defaultTrailerId).toBe(trailer.id);
  // Unpaired drivers keep nulls — pairing is optional.
  const solo = await prisma.driver.create({ data: { email: "s@x.com", passwordHash: "x", name: "Solo", orgId: org.id } });
  expect(solo.defaultTractorId).toBeNull();
});
