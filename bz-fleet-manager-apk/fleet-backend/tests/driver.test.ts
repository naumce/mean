import request from "supertest";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

it("returns the caller's own profile only", async () => {
  const d = await createDriver({ email: "me@f.com" });
  const res = await request(app).get("/api/driver/profile").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body.email).toBe("me@f.com");
  expect(res.body).not.toHaveProperty("passwordHash");
});

it("rejects an unauthenticated request", async () => {
  expect((await request(app).get("/api/driver/profile")).status).toBe(401);
});

it("updates driver status", async () => {
  const d = await createDriver();
  const res = await request(app).put("/api/driver/status")
    .set("authorization", `Bearer ${signAccess(d.id)}`).send({ status: "on_duty" });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("on_duty");
});
