import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";

// Makes the NEXT matching Prisma write fail with P2025 ("record to update/delete
// not found") — the deterministic stand-in for a row deleted by a concurrent
// request between a handler's read and its transaction.
//
// A $use middleware rather than vi.spyOn on a Prisma delegate: spying on a
// delegate replaces it with a stub that resolves undefined instead of calling
// through (established in tests/dispatcher-mount-order.test.ts), so the spy
// would measure a request it had itself broken.
//
// Lives in its own module, imported by the four suites that need it, rather
// than being copy-pasted into each: vitest isolates every test file's module
// graph, so each importer registers its own middleware over its own prisma
// singleton and no suite that does not import this is affected. Putting it in
// helpers.ts instead would add a middleware to all 81 suites.
//
// $use has no deregister, which is why arming is explicit and one-shot: the
// middleware is inert until vanishNext() is called and disarms itself the
// moment it fires.

let armed: { model: string; action: string } | null = null;

prisma.$use(async (params: Prisma.MiddlewareParams, next: (p: Prisma.MiddlewareParams) => Promise<unknown>) => {
  if (armed && params.model === armed.model && params.action === armed.action) {
    armed = null;
    throw new Prisma.PrismaClientKnownRequestError(
      "An operation failed because it depends on one or more records that were required but not found.",
      { code: "P2025", clientVersion: "5.22.0" },
    );
  }
  return next(params);
});

/** Arm: the next `model.action` write raises P2025, once. */
export function vanishNext(model: string, action: string): void {
  armed = { model, action };
}

/** Disarm, for a test whose armed write was never reached. */
export function disarmVanish(): void {
  armed = null;
}
