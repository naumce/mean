import bcrypt from "bcrypt";
import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb } from "./helpers.js";

beforeEach(resetDb);

it("login returns the dispatcher's org (id, name, timezone) so the portal can render org-local time", async () => {
  const org = await prisma.org.create({ data: { name: "Heartland", timezone: "America/Denver" } });
  const hash = await bcrypt.hash("pass123", 4);
  await prisma.dispatcher.create({ data: { email: "d@x.com", passwordHash: hash, name: "D", orgId: org.id } });
  const res = await request(app).post("/api/auth/dispatcher/login").send({ email: "d@x.com", password: "pass123" });
  expect(res.status).toBe(200);
  expect(res.body.org).toEqual({ id: org.id, name: "Heartland", timezone: "America/Denver" });

  await prisma.dispatcher.create({ data: { email: "legacy@x.com", passwordHash: hash, name: "L" } });
  const legacy = await request(app).post("/api/auth/dispatcher/login").send({ email: "legacy@x.com", password: "pass123" });
  expect(legacy.status).toBe(200);
  expect(legacy.body.org).toBeNull();
});
