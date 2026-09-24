import { prisma } from "../../db.js";
import type { Prisma } from "@prisma/client";
import { customerHistory, type CustomerHistory } from "../customers.js";

// dispatchTools/customers.ts (AI Dispatch Foundation, Task 5): read-only
// customer lookups. getCustomerHistory is a thin wrapper over
// lib/customers.ts's customerHistory (Task 3) — the org/existence check has
// to happen HERE first, because customerHistory itself has no concept of
// "missing customer": given an id that matches nothing, it happily reports
// an all-zero history instead of failing.

const CUSTOMER_DETAIL_INCLUDE = { _count: { select: { loads: true } } } satisfies Prisma.CustomerInclude;

export type CustomerDetail = Prisma.CustomerGetPayload<{ include: typeof CUSTOMER_DETAIL_INCLUDE }>;

/** One customer's profile plus its load count; null when it does not exist
 *  or belongs to another org. */
export async function getCustomer(orgId: string, customerId: string): Promise<CustomerDetail | null> {
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, include: CUSTOMER_DETAIL_INCLUDE });
  if (!customer || customer.orgId !== orgId) return null;
  return customer;
}

/** One customer's volume/on-time/lane/detention track record (Task 3); null
 *  when it does not exist or belongs to another org. */
export async function getCustomerHistory(orgId: string, customerId: string): Promise<CustomerHistory | null> {
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { orgId: true } });
  if (!customer || customer.orgId !== orgId) return null;
  return customerHistory(orgId, customerId);
}
