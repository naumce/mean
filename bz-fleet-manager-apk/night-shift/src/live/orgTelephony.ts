// The org's own SMS sender and caller id, once it has one (spec §7.2). Every
// org starts on the env fallback (dev, and every org before slice 6 buys
// numbers); an org that has bought its own number texts and calls from it
// instead. Read through `OrgTelephony`, cached per org because every tick of
// every trip would otherwise read the same row.
import { prisma } from "../../../fleet-backend/src/db.js";

export interface Telephony {
  fromNumber: string;
  callerId: string;
}

type Row = { smsSender: string | null; callerId: string | null } | null;

const TTL_MS = 60_000;

/** Pure function of a `read` and a clock, so it can be tested without a
 *  database or a timer — `telephonyFor` below is this, wired to Prisma and
 *  `Date.now`. */
export function makeTelephonyFor(read: (orgId: string) => Promise<Row>, nowMs: () => number) {
  let cache: Record<string, { at: number; value: Telephony }> = {};
  return async (orgId: string, fallback: Telephony): Promise<Telephony> => {
    const hit = cache[orgId];
    if (hit && nowMs() - hit.at < TTL_MS) return hit.value;
    const row = await read(orgId);
    const value: Telephony = row?.smsSender ? { fromNumber: row.smsSender, callerId: row.callerId ?? row.smsSender } : fallback;
    cache = { ...cache, [orgId]: { at: nowMs(), value } };
    return value;
  };
}

export const telephonyFor = makeTelephonyFor(
  (orgId) => prisma.orgTelephony.findUnique({ where: { orgId }, select: { smsSender: true, callerId: true } }),
  () => Date.now(),
);
