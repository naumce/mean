import { describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";

describe("Carrier schema", () => {
  it("exists with a NULLABLE cost model — null means inherit the org", async () => {
    const cols: Array<{ column_name: string; is_nullable: string }> = await prisma.$queryRawUnsafe(
      // table_schema = current_schema(): each vitest process migrates its own
      // schema (vitest.config.ts), so an unscoped information_schema query
      // would count each column once per concurrent run.
      `select column_name, is_nullable from information_schema.columns
         where table_schema = current_schema()
           and table_name = 'Carrier'
           and column_name in ('mpg','dieselCentsPerGal','driverPayCentsPerMi','fixedCentsPerMi')`,
    );
    expect(cols).toHaveLength(4);
    // Every one nullable: a carrier that has not set a rate must fall back to
    // the org, never price at zero.
    for (const c of cols) expect(c.is_nullable).toBe("YES");
  });

  it("links drivers, tractors and trailers by a NULLABLE carrierId", async () => {
    for (const table of ["Driver", "Tractor", "Trailer"]) {
      const cols: Array<{ is_nullable: string }> = await prisma.$queryRawUnsafe(
        `select is_nullable from information_schema.columns
           where table_schema = current_schema()
             and table_name = '${table}' and column_name = 'carrierId'`,
      );
      expect(cols, `${table}.carrierId missing`).toHaveLength(1);
      // Nullable is what lets every existing row keep working untouched.
      expect(cols[0].is_nullable, `${table}.carrierId must be nullable`).toBe("YES");
    }
  });
});
