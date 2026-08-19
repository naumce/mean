import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";

const accessSecret = process.env.JWT_ACCESS_SECRET;
const refreshSecret = process.env.JWT_REFRESH_SECRET;
if (!accessSecret || !refreshSecret) throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set");
// Re-bound as explicitly-typed `string` consts: TS's narrowing above doesn't
// persist into the closures below, so the guard alone isn't enough for `strict`.
const A: string = accessSecret;
const R: string = refreshSecret;

export type AccessPayload = { driverId: string; role: "driver" } | { dispatcherId: string; role: "dispatcher" };
export type RefreshPayload =
  | { driverId: string; role: "driver"; jti: string }
  | { dispatcherId: string; role: "dispatcher"; jti: string };

export const signAccess = (driverId: string) => jwt.sign({ driverId, role: "driver" }, A, { expiresIn: "15m" });
export const signDispatcherAccess = (dispatcherId: string) =>
  jwt.sign({ dispatcherId, role: "dispatcher" }, A, { expiresIn: "15m" });

export function signRefresh(driverId: string) {
  const jti = randomUUID();
  return { token: jwt.sign({ driverId, role: "driver", jti }, R, { expiresIn: "30d" }), jti };
}
export function signDispatcherRefresh(dispatcherId: string) {
  const jti = randomUUID();
  return { token: jwt.sign({ dispatcherId, role: "dispatcher", jti }, R, { expiresIn: "30d" }), jti };
}

export const verifyAccess = (t: string) => jwt.verify(t, A, { algorithms: ["HS256"] }) as AccessPayload;
export const verifyRefresh = (t: string) => jwt.verify(t, R, { algorithms: ["HS256"] }) as RefreshPayload;
