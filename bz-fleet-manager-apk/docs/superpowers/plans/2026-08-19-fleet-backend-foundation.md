# Fleet Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a contract-faithful backend that the existing Fleet Driver app could authenticate against and drive a trip through — login → read current trip → start trip — with driver-scoped authorization enforced by construction.

**Architecture:** A TypeScript Express API over PostgreSQL (Prisma ORM). Stateless JWT access tokens (short TTL) + rotating refresh tokens with a server-side revocation list. Zod validates every request body at the boundary. Every driver-scoped read derives the owner from the verified token, never from a path parameter — this closes the IDOR class the audit flagged. Tests are HTTP-level (Supertest) against a real Postgres test database, TDD throughout.

**Tech Stack:** Node 20, TypeScript 5 (strict, ESM), Express 4, PostgreSQL 15, Prisma 5, Zod 3, jsonwebtoken 9, bcrypt 5, Vitest 1, Supertest 6.

**Spec:** The reverse-engineering artifacts in this repo are the de-facto spec — primarily `decompiled/API-CONTRACT.md` (endpoints, methods, payloads, entities), plus `THREAT-SCENARIOS.md` and `SECURITY-AUDIT.md` (the authz/token requirements this plan must satisfy by design). This plan implements the **auth + trip-start vertical slice** of that contract.

## Global Constraints

- **Contract fidelity:** routes, verbs, and JSON shapes must match `decompiled/API-CONTRACT.md` exactly. All routes are mounted under `/api`. Auth is `Authorization: Bearer <accessToken>`; bodies are `application/json`.
- **Login response shape (verbatim from contract):** `{ driver, vehicle, token, requiresPasswordChange }`.
- **Authorization by construction:** any resource scoped to a driver MUST be selected with `where: { driverId: req.auth.driverId }`. Never trust a driver/trip/vehicle id taken from the URL for ownership. This is the fix for the IDOR class in `THREAT-SCENARIOS.md`.
- **Tokens:** access token TTL = 15 minutes; refresh token TTL = 30 days, single-use (rotated on refresh), revocable on logout via a `RevokedToken` (jti) table.
- **Passwords:** bcrypt, cost 12. Never logged, never returned.
- **Platform:** Node ≥ 20, TypeScript `strict: true`, PostgreSQL ≥ 15.
- **Process:** TDD (failing test first), frequent commits (one per task minimum), DRY, YAGNI.
- **Env:** `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` read from environment; a `.env.test` points at a disposable test database.

---

## File Structure

- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example` — project config.
- `prisma/schema.prisma` — data model (Driver, Vehicle, Trip, Stop, RevokedToken).
- `src/app.ts` — Express app factory (`createApp()`), no `listen`; imported by both server and tests.
- `src/server.ts` — process entrypoint (`createApp().listen`).
- `src/db.ts` — singleton `PrismaClient`.
- `src/lib/tokens.ts` — sign/verify access + refresh tokens.
- `src/lib/password.ts` — bcrypt hash/compare wrappers.
- `src/middleware/auth.ts` — Bearer verification → `req.auth = { driverId }`.
- `src/middleware/validate.ts` — Zod body-validation middleware.
- `src/routes/auth.ts` — `/api/auth/*`.
- `src/routes/driver.ts` — `/api/driver/*`.
- `src/routes/trips.ts` — `/api/trips/*`.
- `src/domain/tripState.ts` — pure trip state-machine guard.
- `tests/helpers.ts` — test app + DB reset + driver factory.
- `tests/*.test.ts` — one spec file per route group.

Files split by responsibility: token crypto, password crypto, and the state machine are pure modules independent of Express, so they're unit-testable without HTTP.

---

### Task 1: Project scaffold + health check

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`
- Create: `src/app.ts`, `src/server.ts`
- Test: `tests/health.test.ts`

**Interfaces:**
- Produces: `createApp(): express.Express` — the app factory every later task and test imports.

- [ ] **Step 1: Initialize the project and install dependencies**

```bash
npm init -y
npm i express@4
npm i -D typescript@5 tsx @types/node @types/express vitest@1 supertest@6 @types/supertest
npx tsc --init
```

- [ ] **Step 2: Configure TypeScript (ESM, strict) — overwrite `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

Add to `package.json`: `"type": "module"` and scripts:
```json
"scripts": { "dev": "tsx watch src/server.ts", "test": "vitest run", "build": "tsc" }
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", globals: true, fileParallelism: false },
});
```
(`fileParallelism: false` keeps DB-touching specs from racing on the shared test database.)

- [ ] **Step 4: Write the failing test — `tests/health.test.ts`**

```ts
import request from "supertest";
import { createApp } from "../src/app.js";

it("GET /health returns ok", async () => {
  const res = await request(createApp()).get("/health");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: "ok" });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/app.js`.

- [ ] **Step 6: Create `src/app.ts` and `src/server.ts`**

```ts
// src/app.ts
import express from "express";
export function createApp() {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  return app;
}
```
```ts
// src/server.ts
import { createApp } from "./app.js";
const port = Number(process.env.PORT ?? 3001);
createApp().listen(port, () => console.log(`api on :${port}`));
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: express app scaffold with health check"
```

---

### Task 2: Data model + Prisma migration

**Files:**
- Create: `prisma/schema.prisma`, `src/db.ts`, `.env.test`
- Test: `tests/db.test.ts`, `tests/helpers.ts`

**Interfaces:**
- Produces: Prisma models `Driver`, `Vehicle`, `Trip`, `Stop`, `RevokedToken`; `prisma` client from `src/db.ts`; `resetDb()` and `createDriver()` test helpers.

- [ ] **Step 1: Install Prisma**

```bash
npm i @prisma/client@5 && npm i -D prisma@5
npx prisma init --datasource-provider postgresql
```
Create `.env.test` with a disposable DB, e.g. `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/fleet_test"`.

- [ ] **Step 2: Define the schema — `prisma/schema.prisma`**

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

model Driver {
  id                    String   @id @default(uuid())
  email                 String   @unique
  passwordHash          String
  name                  String
  phone                 String?
  status                String   @default("offline")
  requiresPasswordChange Boolean @default(false)
  pushToken             String?
  vehicle               Vehicle?
  trips                 Trip[]
  createdAt             DateTime @default(now())
}

model Vehicle {
  id        String  @id @default(uuid())
  plate     String  @unique
  model     String?
  driver    Driver? @relation(fields: [driverId], references: [id])
  driverId  String? @unique
}

model Trip {
  id                    String   @id @default(uuid())
  identifier            String   @unique
  status                String   @default("pending")
  preTripCheckCompleted Boolean  @default(false)
  driver                Driver   @relation(fields: [driverId], references: [id])
  driverId              String
  stops                 Stop[]
  startedAt             DateTime?
  completedAt           DateTime?
  createdAt             DateTime @default(now())
  @@index([driverId, status])
}

model Stop {
  id        String  @id @default(uuid())
  trip      Trip    @relation(fields: [tripId], references: [id])
  tripId    String
  sequence  Int
  address   String
  status    String  @default("pending")
  @@index([tripId])
}

model RevokedToken {
  jti       String   @id
  expiresAt DateTime
}
```

- [ ] **Step 3: Create the migration and the client singleton**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/fleet_test" npx prisma migrate dev --name init
```
```ts
// src/db.ts
import { PrismaClient } from "@prisma/client";
export const prisma = new PrismaClient();
```

- [ ] **Step 4: Write test helpers — `tests/helpers.ts`**

```ts
import { prisma } from "../src/db.js";
import { createApp } from "../src/app.js";
export const app = createApp();

export async function resetDb() {
  await prisma.$transaction([
    prisma.stop.deleteMany(), prisma.trip.deleteMany(),
    prisma.vehicle.deleteMany(), prisma.revokedToken.deleteMany(),
    prisma.driver.deleteMany(),
  ]);
}
export async function createDriver(over: Partial<{ email: string; passwordHash: string; name: string }> = {}) {
  return prisma.driver.create({
    data: { email: over.email ?? "d@x.com", passwordHash: over.passwordHash ?? "x",
            name: over.name ?? "Test Driver" },
  });
}
```

- [ ] **Step 5: Write the failing test — `tests/db.test.ts`**

```ts
import { prisma } from "../src/db.js";
import { resetDb, createDriver } from "./helpers.js";
beforeEach(resetDb);
it("persists and reads a driver", async () => {
  const d = await createDriver({ email: "a@b.com" });
  const found = await prisma.driver.findUnique({ where: { id: d.id } });
  expect(found?.email).toBe("a@b.com");
});
```

- [ ] **Step 6: Run to verify it passes (client generated by migrate)**

Run: `npm test -- tests/db.test.ts`
Expected: PASS. (If the client is missing, run `npx prisma generate`.)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: prisma schema for driver/vehicle/trip/stop + test harness"
```

---

### Task 3: Driver login

**Files:**
- Create: `src/lib/password.ts`, `src/lib/tokens.ts`, `src/middleware/validate.ts`, `src/routes/auth.ts`
- Modify: `src/app.ts` (mount `/api/auth`)
- Test: `tests/auth-login.test.ts`

**Interfaces:**
- Consumes: `prisma` (Task 2).
- Produces:
  - `hashPassword(pw: string): Promise<string>`, `verifyPassword(pw: string, hash: string): Promise<boolean>`
  - `signAccess(driverId: string): string`, `signRefresh(driverId: string): { token: string; jti: string }`
  - `validateBody(schema)` Express middleware
  - `POST /api/auth/driver/login` → `200 { driver, vehicle, token, requiresPasswordChange }` | `400` | `401`

- [ ] **Step 1: Install crypto deps**

```bash
npm i bcrypt@5 jsonwebtoken@9 zod@3 && npm i -D @types/bcrypt @types/jsonwebtoken
```

- [ ] **Step 2: Write pure helpers — `src/lib/password.ts` and `src/lib/tokens.ts`**

```ts
// src/lib/password.ts
import bcrypt from "bcrypt";
export const hashPassword = (pw: string) => bcrypt.hash(pw, 12);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
```
```ts
// src/lib/tokens.ts
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
```

- [ ] **Step 3: Write Zod validation middleware — `src/middleware/validate.ts`**

```ts
import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";
export const validateBody = (schema: ZodSchema): RequestHandler => (req, res, next) => {
  const r = schema.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: "Invalid request", details: r.error.flatten() });
  req.body = r.data;
  next();
};
```

- [ ] **Step 4: Write the failing test — `tests/auth-login.test.ts`**

```ts
import request from "supertest";
import { app, resetDb, createDriver } from "./helpers.js";
import { hashPassword } from "../src/lib/password.js";
beforeEach(resetDb);

it("logs in with valid credentials", async () => {
  await createDriver({ email: "drv@fleet.com", passwordHash: await hashPassword("secret123") });
  const res = await request(app).post("/api/auth/driver/login")
    .send({ email: "drv@fleet.com", password: "secret123" });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeTruthy();
  expect(res.body.driver.email).toBe("drv@fleet.com");
  expect(res.body).toHaveProperty("requiresPasswordChange", false);
  expect(res.body.driver).not.toHaveProperty("passwordHash");
});

it("rejects a wrong password with 401", async () => {
  await createDriver({ email: "drv@fleet.com", passwordHash: await hashPassword("secret123") });
  const res = await request(app).post("/api/auth/driver/login")
    .send({ email: "drv@fleet.com", password: "nope" });
  expect(res.status).toBe(401);
});

it("rejects a missing field with 400", async () => {
  const res = await request(app).post("/api/auth/driver/login").send({ email: "x@y.com" });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `npm test -- tests/auth-login.test.ts`
Expected: FAIL — route not mounted (404).

- [ ] **Step 6: Implement the route — `src/routes/auth.ts` and mount it**

```ts
// src/routes/auth.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { verifyPassword } from "../lib/password.js";
import { signAccess } from "../lib/tokens.js";
import { validateBody } from "../middleware/validate.js";

export const authRouter = Router();
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

authRouter.post("/driver/login", validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body as z.infer<typeof loginSchema>;
  const driver = await prisma.driver.findUnique({ where: { email }, include: { vehicle: true } });
  if (!driver || !(await verifyPassword(password, driver.passwordHash)))
    return res.status(401).json({ error: "Invalid email or password" });
  const { passwordHash, vehicle, ...safe } = driver;
  res.json({
    driver: safe, vehicle: vehicle ?? null,
    token: signAccess(driver.id), requiresPasswordChange: driver.requiresPasswordChange,
  });
});
```
In `src/app.ts`, after `app.use(express.json())`:
```ts
import { authRouter } from "./routes/auth.js";
app.use("/api/auth", authRouter);
```

- [ ] **Step 7: Run to verify it passes**

Run: `npm test -- tests/auth-login.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: POST /api/auth/driver/login with bcrypt + jwt"
```

---

### Task 4: Auth middleware, refresh rotation, logout revocation

**Files:**
- Create: `src/middleware/auth.ts`
- Modify: `src/routes/auth.ts` (add `/refresh`, `/logout`; issue refresh on login)
- Test: `tests/auth-session.test.ts`

**Interfaces:**
- Consumes: `signRefresh`, `verifyRefresh`, `signAccess` (Task 3), `prisma`.
- Produces:
  - `requireAuth` middleware → sets `req.auth = { driverId: string }`, else `401`.
  - `POST /api/auth/refresh` `{ refreshToken }` → `200 { token, refreshToken }` (rotated) | `401`.
  - `POST /api/auth/logout` (Bearer) `{ refreshToken }` → `204`, refresh jti revoked.
  - Login now also returns `refreshToken`.

- [ ] **Step 1: Declare the `req.auth` type and write the middleware — `src/middleware/auth.ts`**

```ts
import type { RequestHandler } from "express";
import { verifyAccess } from "../lib/tokens.js";
declare global { namespace Express { interface Request { auth?: { driverId: string } } } }

export const requireAuth: RequestHandler = (req, res, next) => {
  const h = req.header("authorization");
  if (!h?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing token" });
  try { req.auth = { driverId: verifyAccess(h.slice(7)).driverId }; next(); }
  catch { return res.status(401).json({ error: "Invalid token" }); }
};
```

- [ ] **Step 2: Write the failing test — `tests/auth-session.test.ts`**

```ts
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- tests/auth-session.test.ts`
Expected: FAIL — no `refreshToken` in login body / routes missing.

- [ ] **Step 4: Extend `src/routes/auth.ts`**

Add imports: `import { signRefresh, verifyRefresh, signAccess } from "../lib/tokens.js";` and `import { requireAuth } from "../middleware/auth.js";`
In the login handler, replace the `res.json({...})` with:
```ts
  const refresh = signRefresh(driver.id);
  res.json({
    driver: safe, vehicle: vehicle ?? null, token: signAccess(driver.id),
    refreshToken: refresh.token, requiresPasswordChange: driver.requiresPasswordChange,
  });
```
Append the two routes:
```ts
authRouter.post("/refresh", validateBody(z.object({ refreshToken: z.string() })), async (req, res) => {
  try {
    const { driverId, jti } = verifyRefresh(req.body.refreshToken);
    if (await prisma.revokedToken.findUnique({ where: { jti } }))
      return res.status(401).json({ error: "Token revoked" });
    await prisma.revokedToken.create({ data: { jti, expiresAt: new Date(Date.now() + 30 * 864e5) } });
    const next = signRefresh(driverId);
    res.json({ token: signAccess(driverId), refreshToken: next.token });
  } catch { res.status(401).json({ error: "Invalid refresh token" }); }
});

authRouter.post("/logout", requireAuth, validateBody(z.object({ refreshToken: z.string() })), async (req, res) => {
  try {
    const { jti } = verifyRefresh(req.body.refreshToken);
    await prisma.revokedToken.upsert({
      where: { jti }, create: { jti, expiresAt: new Date(Date.now() + 30 * 864e5) }, update: {} });
  } catch { /* already invalid — nothing to revoke */ }
  res.status(204).end();
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- tests/auth-session.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: auth middleware, refresh rotation, logout revocation"
```

---

### Task 5: Driver profile + status (ownership from token)

**Files:**
- Create: `src/routes/driver.ts`
- Modify: `src/app.ts` (mount `/api/driver`)
- Test: `tests/driver.test.ts`

**Interfaces:**
- Consumes: `requireAuth` (Task 4), `prisma`.
- Produces:
  - `GET /api/driver/profile` (Bearer) → `200` driver (no `passwordHash`) | `401`.
  - `PUT /api/driver/status` (Bearer) `{ status }` → `200 { status }` | `400` | `401`.

- [ ] **Step 1: Write the failing test — `tests/driver.test.ts`**

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/driver.test.ts`
Expected: FAIL — 404, route missing.

- [ ] **Step 3: Implement — `src/routes/driver.ts` and mount it**

```ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

export const driverRouter = Router();
driverRouter.use(requireAuth);

driverRouter.get("/profile", async (req, res) => {
  const d = await prisma.driver.findUnique({ where: { id: req.auth!.driverId } });
  if (!d) return res.status(404).json({ error: "Not found" });
  const { passwordHash, ...safe } = d;
  res.json(safe);
});

driverRouter.put("/status", validateBody(z.object({ status: z.string().min(1) })), async (req, res) => {
  const d = await prisma.driver.update({
    where: { id: req.auth!.driverId }, data: { status: req.body.status } });
  res.json({ status: d.status });
});
```
In `src/app.ts`:
```ts
import { driverRouter } from "./routes/driver.js";
app.use("/api/driver", driverRouter);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/driver.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: driver profile + status, owner derived from token"
```

---

### Task 6: Current + active trips (IDOR-safe by construction)

**Files:**
- Modify: `src/routes/driver.ts` (add trip reads)
- Test: `tests/driver-trips.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `prisma`.
- Produces:
  - `GET /api/driver/trip/current` (Bearer) → `200 { success, tripId, tripIdentifier, preTripCheckCompleted } | 200 { success: false }`.
  - `GET /api/driver/trips/active` (Bearer) → `200 Trip[]` (only the caller's).

- [ ] **Step 1: Write the failing test — `tests/driver-trips.test.ts`** (includes the cross-driver isolation assertion)

```ts
import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

async function tripFor(driverId: string, ident: string, status = "in_progress") {
  return prisma.trip.create({ data: { identifier: ident, status, driverId } });
}

it("returns the caller's current trip", async () => {
  const d = await createDriver();
  await tripFor(d.id, "TR-1");
  const res = await request(app).get("/api/driver/trip/current").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.tripIdentifier).toBe("TR-1");
});

it("never returns another driver's trip", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  await tripFor(other.id, "TR-OTHER");
  const res = await request(app).get("/api/driver/trips/active").set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/driver-trips.test.ts`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement — append to `src/routes/driver.ts`**

```ts
driverRouter.get("/trip/current", async (req, res) => {
  const t = await prisma.trip.findFirst({
    where: { driverId: req.auth!.driverId, status: { in: ["assigned", "in_progress", "arrived"] } },
    orderBy: { createdAt: "desc" } });
  if (!t) return res.json({ success: false });
  res.json({ success: true, tripId: t.id, tripIdentifier: t.identifier,
             preTripCheckCompleted: t.preTripCheckCompleted });
});

driverRouter.get("/trips/active", async (req, res) => {
  const trips = await prisma.trip.findMany({
    where: { driverId: req.auth!.driverId, status: { in: ["assigned", "in_progress", "arrived"] } } });
  res.json(trips);
});
```
Note: the `where` is keyed on `req.auth.driverId` — no trip/driver id ever comes from the URL, which is what makes the endpoint IDOR-safe.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/driver-trips.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: current/active trips scoped to authenticated driver"
```

---

### Task 7: Start-trip transition (guarded state machine)

**Files:**
- Create: `src/domain/tripState.ts`
- Create: `src/routes/trips.ts`
- Modify: `src/app.ts` (mount `/api/trips`)
- Test: `tests/trip-state.test.ts` (unit), `tests/trips-start.test.ts` (HTTP)

**Interfaces:**
- Consumes: `requireAuth`, `prisma`.
- Produces:
  - `canStart(trip: { status: string; preTripCheckCompleted: boolean }): { ok: true } | { ok: false; reason: string }`
  - `POST /api/trips/:id/start` (Bearer) → `200` updated trip | `404` (not caller's) | `409` (bad state / checklist incomplete).

- [ ] **Step 1: Write the failing unit test — `tests/trip-state.test.ts`**

```ts
import { canStart } from "../src/domain/tripState.js";
it("allows start from assigned when checklist done", () => {
  expect(canStart({ status: "assigned", preTripCheckCompleted: true })).toEqual({ ok: true });
});
it("blocks start when checklist not complete", () => {
  expect(canStart({ status: "assigned", preTripCheckCompleted: false }).ok).toBe(false);
});
it("blocks start from a non-startable state", () => {
  expect(canStart({ status: "completed", preTripCheckCompleted: true }).ok).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/trip-state.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the pure guard — `src/domain/tripState.ts`**

```ts
export function canStart(trip: { status: string; preTripCheckCompleted: boolean }) {
  if (trip.status !== "assigned") return { ok: false as const, reason: `cannot start from '${trip.status}'` };
  if (!trip.preTripCheckCompleted) return { ok: false as const, reason: "pre-trip check incomplete" };
  return { ok: true as const };
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npm test -- tests/trip-state.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing HTTP test — `tests/trips-start.test.ts`**

```ts
import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

it("starts an assigned, checklist-complete trip", async () => {
  const d = await createDriver();
  const t = await prisma.trip.create({ data: { identifier: "TR-1", status: "assigned",
    preTripCheckCompleted: true, driverId: d.id } });
  const res = await request(app).post(`/api/trips/${t.id}/start`).set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("in_progress");
  expect(res.body.startedAt).toBeTruthy();
});

it("returns 409 when the checklist is incomplete", async () => {
  const d = await createDriver();
  const t = await prisma.trip.create({ data: { identifier: "TR-2", status: "assigned",
    preTripCheckCompleted: false, driverId: d.id } });
  const res = await request(app).post(`/api/trips/${t.id}/start`).set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(409);
});

it("returns 404 when starting another driver's trip", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "o@f.com" });
  const t = await prisma.trip.create({ data: { identifier: "TR-3", status: "assigned",
    preTripCheckCompleted: true, driverId: other.id } });
  const res = await request(app).post(`/api/trips/${t.id}/start`).set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -- tests/trips-start.test.ts`
Expected: FAIL — route missing.

- [ ] **Step 7: Implement — `src/routes/trips.ts` and mount it**

```ts
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { canStart } from "../domain/tripState.js";

export const tripsRouter = Router();
tripsRouter.use(requireAuth);

tripsRouter.post("/:id/start", async (req, res) => {
  // ownership by construction: match id AND driverId together
  const trip = await prisma.trip.findFirst({ where: { id: req.params.id, driverId: req.auth!.driverId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const guard = canStart(trip);
  if (!guard.ok) return res.status(409).json({ error: guard.reason });
  const updated = await prisma.trip.update({
    where: { id: trip.id }, data: { status: "in_progress", startedAt: new Date() } });
  res.json(updated);
});
```
In `src/app.ts`:
```ts
import { tripsRouter } from "./routes/trips.js";
app.use("/api/trips", tripsRouter);
```

- [ ] **Step 8: Run to verify it passes**

Run: `npm test -- tests/trips-start.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Run the full suite and commit**

```bash
npm test
git add -A && git commit -m "feat: guarded start-trip transition with ownership + checklist gate"
```

---

## Self-Review

**Spec coverage (against `decompiled/API-CONTRACT.md`, auth+trip slice):**
- `POST /auth/driver/login` → Task 3 ✓ · `POST /auth/refresh`, `POST /auth/logout` → Task 4 ✓
- `GET /driver/profile`, `PUT /driver/status` → Task 5 ✓
- `GET /driver/trip/current`, `GET /driver/trips/active` → Task 6 ✓
- `POST /trips/{id}/start` → Task 7 ✓
- Login response `{ driver, vehicle, token, requiresPasswordChange }` → Task 3 ✓ (adds `refreshToken` in Task 4, a superset — acceptable and more secure).
- Out of this plan's slice (deferred to follow-on plans): stops, checklist submit, uploads, messaging, notifications, location, sessions, safety, navigation, WebSocket, Chime. Each is a later plan in the program.

**Security-requirement coverage (against `THREAT-SCENARIOS.md` / `SECURITY-AUDIT.md`):**
- IDOR class → every read/write scoped by `driverId` from the token (Tasks 5–7), with an explicit cross-driver isolation test (Task 6, Task 7). ✓
- Token model → short access + rotating, revocable refresh (Task 4). ✓
- Password handling → bcrypt cost 12, never returned/logged (Tasks 2–3, asserted in Task 3). ✓

**Placeholder scan:** none — every code and test step carries real content.

**Type consistency:** `req.auth.driverId` (declared Task 4) used identically in Tasks 5–7; `signAccess`/`signRefresh`/`verifyRefresh` names consistent across Tasks 3–4; `canStart` signature identical in its definition (Task 7 Step 3) and consumers (Task 7 Steps 1, 7).

---

## Follow-on plans (the rest of the program)

Each is a separate plan, written after this keystone lands, and each produces working software on its own:
1. **Backend — trip execution** (stops arrive/depart/complete, checklist submit, can-proceed gate, signs-proof upload with S3-compatible storage, multipart).
2. **Backend — comms & ops** (messaging + unread counts, notifications, driver sessions, safety: panic/emergency/fuel, navigation, vehicle issues).
3. **Realtime** (WebSocket server with the recovered event types, auth on connect; AWS Chime meeting/attendee provisioning).
4. **Mobile client** (Expo/RN rebuild against this API — auth store, trip store, the ~20 screens, design tokens from `UI-AND-LOGIC.md`, SecureStore for the token, signed OTA).
5. **Web dispatcher console** (the "designed, not recovered" admin side: assignment, approval queues, pricing).
6. **Infra & security hardening** (cert pinning, code-signed OTA, CI with scoped tokens, per-object-authz test gate in CI).
