import { describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";

it("Assignment carries a nullable tenderedAt", async () => {
  const cols: Array<{ column_name: string; is_nullable: string }> = await prisma.$queryRawUnsafe(
    // table_schema = current_schema(): each vitest process migrates its own
    // schema (vitest.config.ts), so an unscoped information_schema query would
    // count the same column once per concurrent run instead of once.
    `select column_name, is_nullable from information_schema.columns
       where table_schema = current_schema()
         and table_name = 'Assignment' and column_name = 'tenderedAt'`,
  );
  expect(cols).toHaveLength(1);
  expect(cols[0].is_nullable).toBe("YES"); // never priced ≠ tendered at epoch 0
});
