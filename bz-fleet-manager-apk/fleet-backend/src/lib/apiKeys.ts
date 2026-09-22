import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import type { OrgApiKey } from "@prisma/client";

// Night Shift's own API keys (spec §10/§12) — separate from `Org.apiKey`,
// the pre-existing webhook ingest credential (dispatcherIntegrations.ts,
// webhooks.ts), which stays untouched. A `nightshift`-role key lets the MCP
// server (night-shift-mcp/) and any other machine caller drive the
// dispatcher-scoped Night Shift routes without a dispatcher's own bearer
// session — see src/middleware/apiKeyAuth.ts for how a request carrying one
// gets the same `req.orgScope` a session would.

const KEY_PREFIX = "ns_live_";
/** First 10 characters of the full key ("ns_live_XX") — enough for a
 *  dispatcher to tell two keys apart in the management UI without the
 *  server ever holding anything that reconstructs the secret. */
const PREFIX_LEN = 10;

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface IssuedKey {
  /** The raw key — shown exactly once, at creation. Never persisted. */
  key: string;
  record: OrgApiKey;
}

/** Mints a new `nightshift`-role key for the org and stores only its hash
 *  and prefix. The caller (the key-management route) is responsible for
 *  returning `key` to the dispatcher and never logging or re-reading it —
 *  there is no path in this file that reconstructs it from what is stored. */
export async function issueKey(orgId: string, name: string): Promise<IssuedKey> {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const record = await prisma.orgApiKey.create({
    data: {
      orgId,
      name,
      role: "nightshift",
      prefix: key.slice(0, PREFIX_LEN),
      keyHash: hashKey(key),
    },
  });
  return { key, record };
}

export interface VerifiedKey {
  orgId: string;
  role: string;
  /** The key's own name — used to build the actor label ("api:<name>",
   *  src/lib/actor.ts) so a Night Shift trace line can say which key acted
   *  without ever naming a dispatcher who was not there. */
  name: string;
}

/** Looks a presented key up by its hash and returns the org/role it grants,
 *  or null for anything that does not resolve to a live (non-revoked) row —
 *  an unknown key, a mistyped one, and a revoked one all read identically to
 *  the caller, same "404 not 403" discipline the rest of the API follows. */
export async function verifyKey(key: string): Promise<VerifiedKey | null> {
  const record = await prisma.orgApiKey.findUnique({ where: { keyHash: hashKey(key) } });
  if (!record || record.revokedAt !== null) return null;
  return { orgId: record.orgId, role: record.role, name: record.name };
}
