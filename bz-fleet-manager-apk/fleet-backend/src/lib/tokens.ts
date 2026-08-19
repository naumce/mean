import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
const A = process.env.JWT_ACCESS_SECRET ?? "dev-access";
const R = process.env.JWT_REFRESH_SECRET ?? "dev-refresh";
export const signAccess = (driverId: string) => jwt.sign({ driverId }, A, { expiresIn: "15m" });
export function signRefresh(driverId: string) {
  const jti = randomUUID();
  return { token: jwt.sign({ driverId, jti }, R, { expiresIn: "30d" }), jti };
}
export const verifyAccess = (t: string) => jwt.verify(t, A) as { driverId: string };
export const verifyRefresh = (t: string) => jwt.verify(t, R) as { driverId: string; jti: string };
