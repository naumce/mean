// The deep link a dispatcher's status cell points at (spec §6.2/§17.5, Task
// 9/10 split): Task 9 only needed `linkUrlFor` for the status cell's note.
// `verifyOrgToken` and the routes that consume this token
// (routes/nightShiftLink.ts) are Task 10.
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "../db.js";

export interface LinkOrg {
  id: string;
  linkSecret: string;
}

function digestFor(org: LinkOrg): string {
  return createHmac("sha256", org.linkSecret).update(org.id).digest("hex").slice(0, 32);
}

/** `hmacSha256(linkSecret, orgId).hex.slice(0, 32) + "." + orgId` — a link
 *  that has to work with no dispatcher session at all (a status cell's note
 *  is read outside any browser session), so it carries its own signature
 *  rather than relying on a cookie or bearer token. */
export function orgTokenFor(org: LinkOrg): string {
  return `${digestFor(org)}.${org.id}`;
}

/** Throws, by name, when PORTAL_URL is unset (final fix wave, I13) — a
 *  status cell's note must never read `undefined/n/...`. */
export function linkUrlFor(org: LinkOrg, loadId: string): string {
  const portalUrl = process.env.PORTAL_URL;
  if (!portalUrl) throw new Error("PORTAL_URL is not set — every Night Shift deep link is built from it");
  return `${portalUrl.replace(/\/+$/, "")}/n/${orgTokenFor(org)}/${loadId}`;
}

/** The inverse of `orgTokenFor` (Task 10): a token straight off a phone's
 *  URL bar, with no dispatcher session behind it — this IS the
 *  authentication for everything under /api/n (routes/nightShiftLink.ts).
 *  Returns the verified org id, or null for anything that does not check
 *  out: no ".", an unknown org id, or a digest that does not match. The
 *  digest comparison itself is constant-time (`timingSafeEqual`) so a
 *  byte-by-byte guessing attack against the URL cannot learn anything from
 *  response timing; comparing on length first (rather than padding) is safe
 *  because the lengths themselves reveal nothing an attacker doesn't already
 *  know — `orgTokenFor`'s digest is always exactly 32 hex characters. */
export async function verifyOrgToken(token: string): Promise<string | null> {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const digest = token.slice(0, dot);
  const orgId = token.slice(dot + 1);
  if (!orgId) return null;

  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { id: true, linkSecret: true } });
  if (!org) return null;
  // An empty secret signs nothing (final fix wave, I12): an HMAC keyed by
  // "" is a digest anyone can compute, so such an org has no valid link at
  // all until it gets a real secret (the DB default / the back-fill).
  if (!org.linkSecret) return null;

  const expected = Buffer.from(digestFor(org));
  const given = Buffer.from(digest);
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;

  return org.id;
}
