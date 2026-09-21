import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

beforeEach(resetDb);

async function orgScopedDispatcher() {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  await prisma.dispatcher.create({ data: {
    email: "d@x.com", passwordHash: await hashPassword("secret123"), name: "D", orgId: org.id,
  } });
  const login = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "d@x.com", password: "secret123" });
  return { org, token: login.body.token as string };
}

it("GET returns the planning defaults with the derived all-in $/mi", async () => {
  const { token } = await orgScopedDispatcher();
  const res = await request(app).get("/api/dispatcher/settings/cost-model")
    .set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    mpg: 6.5, dieselCentsPerGal: 400, driverPayCentsPerMi: 60, fixedCentsPerMi: 45,
    allInCentsPerMi: Math.round(400 / 6.5 + 60 + 45), // 167
  });
});

it("PATCH persists a partial update and recomputes the all-in figure", async () => {
  const { org, token } = await orgScopedDispatcher();
  const res = await request(app).patch("/api/dispatcher/settings/cost-model")
    .set("authorization", `Bearer ${token}`)
    .send({ dieselCentsPerGal: 500, driverPayCentsPerMi: 70 });
  expect(res.status).toBe(200);
  expect(res.body.dieselCentsPerGal).toBe(500);
  expect(res.body.mpg).toBe(6.5); // untouched field keeps its value
  expect(res.body.allInCentsPerMi).toBe(Math.round(500 / 6.5 + 70 + 45)); // 192

  const persisted = await prisma.org.findUniqueOrThrow({ where: { id: org.id } });
  expect(persisted.dieselCentsPerGal).toBe(500);
  expect(persisted.driverPayCentsPerMi).toBe(70);
});

it("rejects out-of-rails values and empty updates with 400", async () => {
  const { token } = await orgScopedDispatcher();
  const auth = `Bearer ${token}`;
  const tooThirsty = await request(app).patch("/api/dispatcher/settings/cost-model")
    .set("authorization", auth).send({ mpg: 2 });
  expect(tooThirsty.status).toBe(400);
  const nothing = await request(app).patch("/api/dispatcher/settings/cost-model")
    .set("authorization", auth).send({});
  expect(nothing.status).toBe(400);
});

it("requires an org-scoped dispatcher account", async () => {
  const orgless = await prisma.dispatcher.create({ data: { email: "solo@x.com", passwordHash: "x", name: "S" } });
  const res = await request(app).get("/api/dispatcher/settings/cost-model")
    .set("authorization", `Bearer ${signDispatcherAccess(orgless.id)}`);
  expect(res.status).toBe(400);
});
