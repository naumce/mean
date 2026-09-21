import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM box for tokens at rest (refresh tokens, etc.). Reads
 *  `SECRET_BOX_KEY` from the environment at CALL time (not at import time) so
 *  tests can set it per-case, and throws naming the variable when it is
 *  missing or malformed. */
const key = (): Buffer => {
  const hex = process.env.SECRET_BOX_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("SECRET_BOX_KEY must be 32 bytes as 64 hex characters");
  return Buffer.from(hex, "hex");
};

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function open(sealed: string): string {
  const [iv, tag, body] = sealed.split(".").map((s) => Buffer.from(s, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}
