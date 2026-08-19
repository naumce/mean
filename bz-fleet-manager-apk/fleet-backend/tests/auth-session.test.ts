import request from "supertest";
import { app, resetDb, createDriver } from "./helpers.js";
import { hashPassword } from "../src/lib/password.js";
beforeEach(resetDb);

async function login() {
  await createDriver({ email: "s@f.com", passwordHash: await hashPassword("pw12345") });
  const r = await request(app).post("/api/auth/driver/login").send({ email: "s@f.com", password: "pw12345" });
  return r.body as { token: string; refreshToken: string };
}

it("issues a refresh token on login", async () => {
  const { refreshToken } = await login();
  expect(refreshToken).toBeTruthy();
});

it("rotates the refresh token", async () => {
  const { refreshToken } = await login();
  const res = await request(app).post("/api/auth/refresh").send({ refreshToken });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeTruthy();
  expect(res.body.refreshToken).not.toBe(refreshToken);
});

it("revokes a refresh token on logout", async () => {
  const { token, refreshToken } = await login();
  await request(app).post("/api/auth/logout").set("authorization", `Bearer ${token}`).send({ refreshToken });
  const res = await request(app).post("/api/auth/refresh").send({ refreshToken });
  expect(res.status).toBe(401);
});
