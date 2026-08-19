import { prisma } from "../src/db.js";
import { resetDb, createDriver } from "./helpers.js";
beforeEach(resetDb);
it("persists and reads a driver", async () => {
  const d = await createDriver({ email: "a@b.com" });
  const found = await prisma.driver.findUnique({ where: { id: d.id } });
  expect(found?.email).toBe("a@b.com");
});
