// Identity and signatures for the live worker. A driver link token is a
// bearer secret for one trip; an action link is an HMAC over what it may
// do, for whom, until when — so a forwarded or edited email cannot act.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const newTripId = (): string => "t_" + randomBytes(8).toString("base64url");
export const newDriverToken = (): string => randomBytes(24).toString("base64url");

function mac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** `<tripId>.<action>.<expiresAtMs>.<mac>` — all URL-safe. */
export function signAction(secret: string, tripId: string, action: string, expiresAtMs: number): string {
  const payload = [tripId, action, String(expiresAtMs)].join(".");
  return payload + "." + mac(secret, payload);
}

export function verifyAction(secret: string, signed: string, nowMs: number): { tripId: string; action: string } | null {
  const parts = signed.split(".");
  if (parts.length !== 4) return null;
  const [tripId, action, exp, given] = parts;
  const expected = mac(secret, [tripId, action, exp].join("."));
  const a = Buffer.from(given), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!/^\d+$/.test(exp) || Number(exp) < nowMs) return null;
  return { tripId, action };
}
