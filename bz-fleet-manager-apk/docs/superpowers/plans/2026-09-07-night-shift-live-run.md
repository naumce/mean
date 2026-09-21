# Night-Shift Agent — First Live Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One real load on one real phone — an SMS invite, a link that shares location from the browser, a chat the agent talks through, real emails to the dispatcher with a one-click "send the customer email", real truck-legal routing, a real voice call, and every event in Postgres — driven by the core built in `2026-09-06-night-shift-core.md`, unchanged in its rules.

**Architecture:** A `src/live/` layer beside the core: one Express worker process that owns an `Agent` per active load and ticks it every minute, plus one adapter per port (`twilioMessenger`, `twilioPhone`, `smtpMailer`, `mapboxRouter`, `prismaEvents`, `prismaRestStops`). The driver link is a static page the worker serves; it posts pings and replies to the worker and polls for the agent's messages. The dispatcher's emails carry a signed one-click link that performs `send the customer email`. Config is one zod-validated object from `.env`; missing values fail at startup by name, never at 3 a.m. The sheet (Microsoft Graph) is the next plan; a load is started from a JSON file here.

**Tech Stack:** Node 22 (`--env-file`), TypeScript ESM, Express 4, zod, `twilio`, `nodemailer`, Prisma via `fleet-backend`'s generated client, Mapbox via `fleet-backend/src/lib/routing.ts`, Vitest + supertest. `cloudflared` quick tunnel for the public URL during testing.

**Spec:** `docs/superpowers/specs/2026-09-06-night-shift-agent-design.md` — §4 (invite/accept/tracking), §7 (ladder), §8 (emails, reply commands), §10 (voice), §11 (honesty), §12 (data), §15 (assumptions). The core plan's rulings in `.superpowers/sdd/2026-09-06-night-shift-core/progress.md` bind this plan too.

## Global Constraints

- **The core does not change its rules.** `src/core/**` is touched in exactly one task (Task 9, the delivery-failure budget) and nowhere else. Adapters implement the ports in `src/ports/index.ts` as they are.
- **Honesty (spec §11) crosses the wire intact.** An adapter never fabricates: a call that could not be placed is not "no answer" (Task 8 throws, and the core records a failed delivery); a text that failed to send is a failed `action` event, not a sent one; a page that stopped pinging is "gone dark", not "stopped".
- **Config fails fast, by name.** `src/live/config.ts` parses `process.env` with zod; a missing or malformed value stops the process at startup with the variable's name. No `??` defaults for secrets, ever.
- **Secrets never reach a log, an event, or an email.** Evidence carries message ids and call ids, never tokens or auth headers.
- **One-click links are signed.** Every action link carries an HMAC of `(tripId, action, expiry)` under `LINK_SECRET`; the worker refuses a link it did not sign or that has expired. A dispatcher's inbox is not a trusted network.
- **Twilio webhooks are verified** with the `X-Twilio-Signature` header against `PUBLIC_URL`; an unsigned request is a 403 and an event, never an `onReply`.
- **Every adapter is tested with its dependency injected** (a fake Twilio client, a fake nodemailer transport, the real Postgres). No test makes a paid network call. Tests that need `DATABASE_URL` or `MAPBOX_TOKEN` skip with a printed reason when the variable is absent, and run when it is present.
- **American English** in every driver- and dispatcher-facing string. Times rendered in `TZ` from config.
- **No commits** unless the human partner lifts the standing rule; commit steps below are conditional exactly as in the core plan.
- Coding conventions of the repo: immutable updates, small files (≤ 300 lines here), named constants, no `console.log` in library code (the worker's own startup lines go through one `log()` in `src/live/log.ts`).

---

## File Structure

```
night-shift/
  .env.example                  (exists) every variable, with a comment
  package.json                  + deps: express, zod, twilio, nodemailer; devDeps: supertest, @types/express, @types/nodemailer, @types/supertest
  loads/
    test-drive.json             the first load: a short drive from the tester's own doorstep
  src/live/
    config.ts                   zod schema for .env → Config; loadConfig() throws by name
    log.ts                      one structured logger (level, ts, msg, fields) — the only console use
    tokens.ts                   tripId/driver-link tokens and HMAC-signed action links
    chatBus.ts                  in-memory per-trip outbox: agent → driver messages the page polls; inbox: page → agent
    registry.ts                 the live trips: Map<tripId, LiveTrip { agent, brief, token, startedAt }>; start/stop/tick
    prismaEvents.ts             EventStore on fleet-backend's Prisma: AgentTrip + AgentEvent rows, scoped by tripId
    prismaRestStops.ts          RestStop rows within the route's bounding box → RestStop[]
    mapboxRouter.ts             RouterPort over fleet-backend's resolveRoutes + truckProfileFor
    twilioMessenger.ts          MessengerPort: chat → chatBus; sms → Twilio Messages
    twilioPhone.ts              PhonePort: outbound call with TwiML <Say> + <Gather input="speech">; webhook resolves the outcome
    smtpMailer.ts               MailerPort over nodemailer; appends the signed one-click link to dispatcher emails
    driverLink.ts               Express router: GET /d/:token (page), POST accept/ping/reply, GET messages
    actions.ts                  Express router: GET /act/:signed → onDispatcherReply("send the customer email")
    twilioWebhooks.ts           Express router: POST /twilio/sms (inbound reply), POST /twilio/voice/... (TwiML + gather + status)
    server.ts                   createServer(config, registry): the Express app with every router mounted
    worker.ts                   entry: load config, open Prisma, build deps, start the load from argv[2], tick every 60 s
    driverPage.html             the driver link page (served by driverLink.ts; inlined at build via readFileSync)
  tests/live/
    config.test.ts, tokens.test.ts, chatBus.test.ts, registry.test.ts, prismaEvents.test.ts,
    mapboxRouter.test.ts, twilioMessenger.test.ts, smtpMailer.test.ts, driverLink.test.ts,
    actions.test.ts, twilioWebhooks.test.ts, twilioPhone.test.ts, failureBudget.test.ts
  README-live.md                the runbook: fill .env, tunnel, start, what you will see on the phone
fleet-backend/prisma/
  schema.prisma                 + AgentTrip, AgentEvent
  migrations/<ts>_night_shift_events/
```

---

### Task 1: Config, logger, tokens, and the package's live dependencies

**Files:**
- Modify: `night-shift/package.json` (deps, scripts)
- Create: `night-shift/src/live/config.ts`, `night-shift/src/live/log.ts`, `night-shift/src/live/tokens.ts`
- Test: `night-shift/tests/live/config.test.ts`, `night-shift/tests/live/tokens.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv = process.env): Config` and the `Config` type — fields exactly as `.env.example` lists them, plus `linkSecret`; `log(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void`; `newTripId(): string`, `newDriverToken(): string`, `signAction(secret, tripId, action, expiresAtMs): string`, `verifyAction(secret, signed, nowMs): { tripId: string; action: string } | null`.

- [ ] **Step 1: Add dependencies and scripts**

In `night-shift/package.json` add:
```json
  "dependencies": {
    "express": "^4.21.0",
    "nodemailer": "^6.9.0",
    "twilio": "^5.3.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "@types/nodemailer": "^6.4.15",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "night:start": "node --env-file=.env --import tsx src/live/worker.ts",
    "night:tunnel": "cloudflared tunnel --url http://localhost:3010"
  }
```
Keep the existing devDependency versions where they already resolve. Run `npm install`.

Add one line to `.env.example` and `.env` under the Twilio block:
```
# Signs the one-click links in dispatcher emails. Any long random string.
LINK_SECRET=
```

- [ ] **Step 2: Write the failing tests**

`night-shift/tests/live/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/live/config.js";

// A worker that starts with a missing secret and finds out at 3 a.m. is the
// failure this file exists to prevent. Every variable is named in the error.
const full = {
  TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM_NUMBER: "+15550001",
  SMTP_HOST: "smtp.example.com", SMTP_PORT: "465", SMTP_USER: "u@example.com", SMTP_PASS: "p", MAIL_FROM: "agent@example.com",
  DISPATCHER_EMAIL: "boss@example.com", DRIVER_PHONE: "+38970000000", DRIVER_NAME: "Trajce",
  MAPBOX_TOKEN: "pk.test", DATABASE_URL: "postgresql://x", PUBLIC_URL: "https://demo.trycloudflare.com",
  PORT: "3010", TZ: "Europe/Skopje", LINK_SECRET: "s3cret-s3cret-s3cret",
};

describe("loadConfig", () => {
  it("parses a complete environment into typed config", () => {
    const c = loadConfig(full);
    expect(c.smtp.port).toBe(465);
    expect(c.port).toBe(3010);
    expect(c.publicUrl).toBe("https://demo.trycloudflare.com");
    expect(c.driver.phone).toBe("+38970000000");
  });

  it("names every missing variable and refuses to start", () => {
    const { TWILIO_AUTH_TOKEN: _a, SMTP_PASS: _b, ...partial } = full;
    expect(() => loadConfig(partial)).toThrow(/TWILIO_AUTH_TOKEN/);
    expect(() => loadConfig(partial)).toThrow(/SMTP_PASS/);
  });

  it("rejects a public URL that is not https, and a port that is not a number", () => {
    expect(() => loadConfig({ ...full, PUBLIC_URL: "http://demo.trycloudflare.com" })).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ ...full, PORT: "abc" })).toThrow(/PORT/);
  });

  it("strips a trailing slash from PUBLIC_URL so links never get a double slash", () => {
    expect(loadConfig({ ...full, PUBLIC_URL: "https://demo.trycloudflare.com/" }).publicUrl).toBe("https://demo.trycloudflare.com");
  });

  it("rejects a driver phone that is not E.164", () => {
    expect(() => loadConfig({ ...full, DRIVER_PHONE: "070 000 000" })).toThrow(/DRIVER_PHONE/);
  });
});
```

`night-shift/tests/live/tokens.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newDriverToken, newTripId, signAction, verifyAction } from "../../src/live/tokens.js";

describe("tokens", () => {
  it("makes ids that do not collide and are URL-safe", () => {
    const a = newTripId(), b = newTripId();
    expect(a).not.toBe(b);
    expect(newDriverToken()).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });

  it("signs an action link and verifies it back", () => {
    const s = signAction("secret", "trip1", "send_customer_email", 1_000_000);
    expect(verifyAction("secret", s, 999_999)).toEqual({ tripId: "trip1", action: "send_customer_email" });
  });

  it("refuses a link after it expires, and a link signed with another secret", () => {
    const s = signAction("secret", "trip1", "send_customer_email", 1_000_000);
    expect(verifyAction("secret", s, 1_000_001)).toBeNull();
    expect(verifyAction("other", s, 1)).toBeNull();
  });

  it("refuses a tampered link", () => {
    // A dispatcher's inbox is not a trusted network: changing the trip in the
    // URL must not send someone else's customer an email.
    const s = signAction("secret", "trip1", "send_customer_email", 1_000_000);
    const tampered = s.replace("trip1", "trip2");
    expect(verifyAction("secret", tampered, 1)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/live/config.test.ts tests/live/tokens.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Write config.ts**

`night-shift/src/live/config.ts`:
```ts
// Every value the live worker needs, validated once at startup. A worker
// that discovers a missing secret when it first tries to text a driver has
// discovered it at the worst possible moment; this file makes that moment
// the moment the process starts, and names the variable.
import { z } from "zod";

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +38970123456");

const schema = z.object({
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_FROM_NUMBER: e164,
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  MAIL_FROM: z.string().min(3),
  DISPATCHER_EMAIL: z.string().email(),
  DRIVER_PHONE: e164,
  DRIVER_NAME: z.string().min(1),
  MAPBOX_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  PUBLIC_URL: z.string().url().refine((u) => u.startsWith("https://"), "must be https — Twilio and browsers refuse http"),
  PORT: z.coerce.number().int().positive(),
  TZ: z.string().min(1),
  LINK_SECRET: z.string().min(16, "at least 16 characters"),
});

export interface Config {
  twilio: { accountSid: string; authToken: string; fromNumber: string };
  smtp: { host: string; port: number; user: string; pass: string; from: string };
  dispatcherEmail: string;
  driver: { phone: string; name: string };
  mapboxToken: string;
  databaseUrl: string;
  publicUrl: string;
  port: number;
  tz: string;
  linkSecret: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error("night-shift config is incomplete — " + names);
  }
  const v = parsed.data;
  return {
    twilio: { accountSid: v.TWILIO_ACCOUNT_SID, authToken: v.TWILIO_AUTH_TOKEN, fromNumber: v.TWILIO_FROM_NUMBER },
    smtp: { host: v.SMTP_HOST, port: v.SMTP_PORT, user: v.SMTP_USER, pass: v.SMTP_PASS, from: v.MAIL_FROM },
    dispatcherEmail: v.DISPATCHER_EMAIL,
    driver: { phone: v.DRIVER_PHONE, name: v.DRIVER_NAME },
    mapboxToken: v.MAPBOX_TOKEN,
    databaseUrl: v.DATABASE_URL,
    publicUrl: v.PUBLIC_URL.replace(/\/+$/, ""),
    port: v.PORT,
    tz: v.TZ,
    linkSecret: v.LINK_SECRET,
  };
}
```

- [ ] **Step 5: Write log.ts and tokens.ts**

`night-shift/src/live/log.ts`:
```ts
// The one place the worker writes to the console. Structured, one line per
// event, so a log can be grepped by trip id. Adapters never log secrets;
// nothing here redacts, so nothing here may be handed one.
export type Level = "info" | "warn" | "error";

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}
```

`night-shift/src/live/tokens.ts`:
```ts
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
```

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run tests/live/config.test.ts tests/live/tokens.test.ts && npm run typecheck`
Expected: 9 passed; tsc clean.

- [ ] **Step 7: Break it**

In `verifyAction`, remove the `Number(exp) < nowMs` check → "refuses a link after it expires" must fail. Restore. In `loadConfig`, replace `throw` with returning a partial object → "names every missing variable" must fail. Restore.

- [ ] **Step 8: Commit (if lifted)**

```bash
git add night-shift/package.json night-shift/src/live/config.ts night-shift/src/live/log.ts night-shift/src/live/tokens.ts night-shift/tests/live/config.test.ts night-shift/tests/live/tokens.test.ts
git commit -m "feat(night-shift): live config, logger and signed action links"
```

---

### Task 2: Event store and rest-stop registry on Postgres

**Files:**
- Modify: `fleet-backend/prisma/schema.prisma` (append two models); run `npx prisma migrate dev --name night_shift_events` in `fleet-backend/`
- Create: `night-shift/src/live/prismaEvents.ts`, `night-shift/src/live/prismaRestStops.ts`
- Test: `night-shift/tests/live/prismaEvents.test.ts`

**Interfaces:**
- Consumes: `fleet-backend/src/db.js` (`prisma`), `EventStore` and `AgentEvent` from the core.
- Produces: `class PrismaEvents implements EventStore` with `constructor(tripId: string)`, plus `static async createTrip(args: { tripId; loadRef; driverToken; brief: unknown }): Promise<void>` and `static async setStatus(tripId, status)`; `async function restStopsNear(geometry: LngLat[], orgId: string | null): Promise<RestStop[]>` — every registered stop inside the route's bounding box padded by `REST_STOP_SEARCH_MI`.

- [ ] **Step 1: Add the models**

Append to `fleet-backend/prisma/schema.prisma`:
```prisma
/// One live run of the night-shift agent. The brief is stored as it was read
/// so the run can be replayed exactly; status mirrors the agent's TripStatus.
model AgentTrip {
  id          String       @id
  loadRef     String
  driverToken String       @unique
  brief       Json
  status      String       @default("assigned")
  createdAt   DateTime     @default(now())
  events      AgentEvent[]
}

/// Append-only. Evidence is the core's evidence object, verbatim.
model AgentEvent {
  id          Int       @id @default(autoincrement())
  tripId      String
  trip        AgentTrip @relation(fields: [tripId], references: [id])
  atMs        BigInt
  kind        String
  evidence    Json
  actionTaken String?

  @@index([tripId, atMs])
}
```
Run from `fleet-backend/`: `npx prisma migrate dev --name night_shift_events --skip-seed`. Expected: migration created and applied; client regenerated.

- [ ] **Step 2: Write the failing test**

`night-shift/tests/live/prismaEvents.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs against the real database named by DATABASE_URL (the dev one on
// :5434). Skipped, with a printed reason, when it is not set — an adapter
// test that silently passes without its dependency is not a test.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
if (!url) console.warn("prismaEvents.test: DATABASE_URL not set — skipped");
// Imported at the top level (ESM top-level await) so the describe callback
// stays synchronous — Vitest does not collect tests from an async describe.
const mod = url ? await import("../../src/live/prismaEvents.js") : null;
const db = url ? await import("../../../fleet-backend/src/db.js") : null;

run("PrismaEvents", () => {
  // A describe.skip body still RUNS at collection; only its hooks and tests
  // are skipped. So nothing here may dereference the null modules — the
  // locals are typed as present and only touched inside hooks and tests.
  const PrismaEvents = mod?.PrismaEvents as NonNullable<typeof mod>["PrismaEvents"];
  const prisma = db?.prisma as NonNullable<typeof db>["prisma"];
  const tripId = "t_test_" + Date.now();

  beforeAll(async () => {
    await PrismaEvents.createTrip({ tripId, loadRef: "T-01", driverToken: "tok_" + tripId, brief: { loadRef: "T-01" } });
  });
  afterAll(async () => {
    await prisma.agentEvent.deleteMany({ where: { tripId } });
    await prisma.agentTrip.deleteMany({ where: { id: tripId } });
    await prisma.$disconnect();
  });

  it("appends and reads back in order, scoped to its trip", async () => {
    const store = new PrismaEvents(tripId);
    await store.append({ atMs: 2000, kind: "action", evidence: { kind: "b" } });
    await store.append({ atMs: 1000, kind: "plan", evidence: { distanceMi: 12 }, actionTaken: "planned" });
    const all = await store.all();
    expect(all.map((e) => e.atMs)).toEqual([1000, 2000]);
    expect(all[0].evidence).toEqual({ distanceMi: 12 });
    expect(all[0].actionTaken).toBe("planned");
    // Another trip sees nothing of this one.
    expect(await new PrismaEvents(tripId + "_other").all()).toEqual([]);
  });

  it("keeps millisecond precision on atMs across the BigInt column", async () => {
    const store = new PrismaEvents(tripId);
    await store.append({ atMs: 1788696660123, kind: "ping", evidence: {} });
    const last = (await store.all()).at(-1)!;
    expect(last.atMs).toBe(1788696660123);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run (from `night-shift/`, with `DATABASE_URL` exported or via `node --env-file`): `npx vitest run tests/live/prismaEvents.test.ts`
Expected: FAIL — cannot find module `../../src/live/prismaEvents.js`.

- [ ] **Step 4: Write the adapters**

`night-shift/src/live/prismaEvents.ts`:
```ts
// The event log on Postgres, through fleet-backend's own Prisma client so the
// agent's rows live beside the platform's. One store per trip; `all()` is
// that trip's events in time order and nothing else.
import { prisma } from "../../../fleet-backend/src/db.js";
import type { AgentEvent } from "../core/types.js";
import type { EventStore } from "../ports/index.js";

export class PrismaEvents implements EventStore {
  constructor(private readonly tripId: string) {}

  static async createTrip(args: { tripId: string; loadRef: string; driverToken: string; brief: unknown }): Promise<void> {
    await prisma.agentTrip.create({
      data: { id: args.tripId, loadRef: args.loadRef, driverToken: args.driverToken, brief: args.brief as object },
    });
  }

  static async setStatus(tripId: string, status: string): Promise<void> {
    await prisma.agentTrip.update({ where: { id: tripId }, data: { status } });
  }

  async append(event: AgentEvent): Promise<void> {
    await prisma.agentEvent.create({
      data: {
        tripId: this.tripId,
        atMs: BigInt(event.atMs),
        kind: event.kind,
        evidence: event.evidence as object,
        actionTaken: event.actionTaken ?? null,
      },
    });
  }

  async all(): Promise<AgentEvent[]> {
    const rows = await prisma.agentEvent.findMany({ where: { tripId: this.tripId }, orderBy: [{ atMs: "asc" }, { id: "asc" }] });
    return rows.map((r) => ({
      atMs: Number(r.atMs),
      kind: r.kind as AgentEvent["kind"],
      evidence: r.evidence as Record<string, unknown>,
      ...(r.actionTaken ? { actionTaken: r.actionTaken } : {}),
    }));
  }
}
```

`night-shift/src/live/prismaRestStops.ts`:
```ts
// The registered rest/fuel stops the break planner and the stop rule read —
// the platform's own registry, boxed to the route so a cross-country table
// is not loaded for a 40-mile run.
import { prisma } from "../../../fleet-backend/src/db.js";
import { REST_STOP_SEARCH_MI } from "../core/constants.js";
import type { LngLat, RestStop } from "../core/types.js";

const MI_PER_DEG_LAT = 69.09;

export async function restStopsNear(geometry: LngLat[], orgId: string | null): Promise<RestStop[]> {
  if (geometry.length === 0) return [];
  const lats = geometry.map((p) => p[1]);
  const lngs = geometry.map((p) => p[0]);
  const padLat = REST_STOP_SEARCH_MI / MI_PER_DEG_LAT;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const padLng = padLat / Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const rows = await prisma.restStop.findMany({
    where: {
      ...(orgId ? { orgId } : {}),
      lat: { gte: Math.min(...lats) - padLat, lte: Math.max(...lats) + padLat },
      lng: { gte: Math.min(...lngs) - padLng, lte: Math.max(...lngs) + padLng },
    },
    select: { name: true, lat: true, lng: true },
  });
  return rows.map((r) => ({ name: r.name, lat: r.lat, lng: r.lng }));
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/live/prismaEvents.test.ts && npm run typecheck`
Expected: 2 passed; tsc clean. If tsc cannot find `@prisma/client` types through the relative import, add `"../fleet-backend/src/db.ts"` to `tsconfig.json`'s `include` — the client is generated in `fleet-backend/node_modules` and resolves from there.

- [ ] **Step 6: Break it**

In `all()`, drop the `orderBy` → "appends and reads back in order" must fail (insertion order was 2000 then 1000). Restore.

- [ ] **Step 7: Commit (if lifted)**

```bash
git add fleet-backend/prisma/schema.prisma fleet-backend/prisma/migrations night-shift/src/live/prismaEvents.ts night-shift/src/live/prismaRestStops.ts night-shift/tests/live/prismaEvents.test.ts
git commit -m "feat(night-shift): event log and rest-stop registry on Postgres"
```

---

### Task 3: Truck-legal routing through the platform's router

**Files:**
- Create: `night-shift/src/live/mapboxRouter.ts`
- Test: `night-shift/tests/live/mapboxRouter.test.ts`

**Interfaces:**
- Consumes: `resolveRoutes(pairs, profile)`, `routeKey(from, to, profile)`, `LatLng` from `fleet-backend/src/lib/routing.js`; `truckProfileFor({ trailerType })` from `fleet-backend/src/lib/truckProfile.js`; `RouterPort`, `RouteAnswer`, `GeoPoint` from the core.
- Produces: `class MapboxRouter implements RouterPort` with `constructor(resolve = resolveRoutes)` (injectable for tests) and `route(from, to, { equipment, departAtMs })`. Throws `Error("no truck-legal route from the provider…")` when the provider returns nothing or no geometry — the core turns that into *Attention* (Task I7 of the core).

`resolveRoutes` reads `MAPBOX_TOKEN`/`ROUTER_URL` from `process.env` itself and caches in `RouteDistance`; the worker's `--env-file` makes that work with no plumbing. `departAtMs` is accepted and unused here — the traffic-aware departure is a later plan; the port carries it now so the signature does not change twice.

- [ ] **Step 1: Write the failing test**

`night-shift/tests/live/mapboxRouter.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MapboxRouter } from "../../src/live/mapboxRouter.js";

const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
const opts = { equipment: "DryVan", departAtMs: Date.now() };

describe("MapboxRouter", () => {
  it("turns the provider's answer into a RouteAnswer, miles and minutes from the same response", async () => {
    // The key the adapter looks up is the platform's own routeKey; the fake
    // answers under exactly that key.
    const resolve = async (pairs: [unknown, unknown][]) => {
      const { routeKey } = await import("../../../fleet-backend/src/lib/routing.js");
      const { truckProfileFor } = await import("../../../fleet-backend/src/lib/truckProfile.js");
      const [a, b] = pairs[0] as [{ lat: number; lng: number }, { lat: number; lng: number }];
      return new Map([[routeKey(a, b, truckProfileFor({ trailerType: "DryVan" })), { miles: 193.4, minutes: 181, geometry: [[-94.58, 39.1], [-94.1, 40.0], [-93.62, 41.59]] as [number, number][], source: "mapbox" }]]);
    };
    const r = await new MapboxRouter(resolve as never).route(KC, DSM, opts);
    expect(r.distanceMi).toBe(193.4);
    expect(r.driveMin).toBe(181);
    expect(r.geometry).toHaveLength(3);
  });

  it("refuses to hand the core a route with no geometry — a plan line needs a line", async () => {
    const resolve = async () => new Map();
    await expect(new MapboxRouter(resolve as never).route(KC, DSM, opts)).rejects.toThrow(/no truck-legal route/);
  });

  const live = process.env.MAPBOX_TOKEN ? it : it.skip;
  if (!process.env.MAPBOX_TOKEN) console.warn("mapboxRouter.test: MAPBOX_TOKEN not set — live route skipped");
  live("routes Kansas City to Des Moines on real road (live, one cached request)", async () => {
    const r = await new MapboxRouter().route(KC, DSM, opts);
    expect(r.distanceMi).toBeGreaterThan(180);
    expect(r.distanceMi).toBeLessThan(215);
    expect(r.geometry.length).toBeGreaterThan(100);
  }, 20_000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/live/mapboxRouter.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the adapter**

`night-shift/src/live/mapboxRouter.ts`:
```ts
// The platform's router, wrapped as the agent's RouterPort. Truck profile from
// the load's equipment — the legal maximum when the type is unknown — so the
// line the agent measures against is one a truck can actually drive.
import { resolveRoutes, routeKey, type LatLng } from "../../../fleet-backend/src/lib/routing.js";
import { truckProfileFor } from "../../../fleet-backend/src/lib/truckProfile.js";
import type { GeoPoint, RouteAnswer } from "../core/types.js";
import type { RouterPort } from "../ports/index.js";

type Resolve = typeof resolveRoutes;

export class MapboxRouter implements RouterPort {
  constructor(private readonly resolve: Resolve = resolveRoutes) {}

  async route(from: GeoPoint, to: GeoPoint, opts: { equipment: string; departAtMs: number }): Promise<RouteAnswer> {
    const profile = truckProfileFor({ trailerType: opts.equipment });
    const a: LatLng = { lat: from.lat, lng: from.lng };
    const b: LatLng = { lat: to.lat, lng: to.lng };
    const answers = await this.resolve([[a, b]], profile);
    const r = answers.get(routeKey(a, b, profile));
    if (!r) throw new Error("no truck-legal route from the provider (nothing returned — is MAPBOX_TOKEN set?)");
    if (!r.geometry || r.geometry.length < 2) throw new Error("no truck-legal route from the provider (miles without geometry)");
    return { geometry: r.geometry, distanceMi: r.miles, driveMin: r.minutes };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/live/mapboxRouter.test.ts && npm run typecheck`
Expected: 2 passed (+1 live when the token is set); tsc clean.

- [ ] **Step 5: Break it**

Return `{ geometry: [], … }` from the fake in the first test and remove the `length < 2` guard → the second test's cousin passes wrongly; put the guard back and confirm "refuses … no geometry" fails without it. Restore.

- [ ] **Step 6: Commit (if lifted)**

```bash
git add night-shift/src/live/mapboxRouter.ts night-shift/tests/live/mapboxRouter.test.ts
git commit -m "feat(night-shift): Mapbox router adapter over the platform's routing"
```

---

### Task 4: The chat bus and the trip registry

**Files:**
- Create: `night-shift/src/live/chatBus.ts`, `night-shift/src/live/registry.ts`
- Test: `night-shift/tests/live/chatBus.test.ts`, `night-shift/tests/live/registry.test.ts`

**Interfaces:**
- Produces:
  - `interface ChatMessage { id: number; atMs: number; text: string }`; `class ChatBus { push(tripId, text, atMs): ChatMessage; since(tripId, afterId: number): ChatMessage[]; markOpened(tripId, atMs): void; openedAt(tripId): number | null }` — the agent's outbox toward the driver's page. Immutable arrays per trip.
  - `interface LiveTrip { tripId: string; driverToken: string; brief: Brief; agent: Agent; startedAtMs: number }`; `class Registry { constructor(build: (trip: { tripId; driverToken; brief }) => Agent); async start(brief, ids?): Promise<LiveTrip>; byId(tripId): LiveTrip | null; byToken(token): LiveTrip | null; all(): LiveTrip[]; async tickAll(): Promise<void>; async stop(tripId): Promise<void> }` — `start()` calls `agent.start()`; `tickAll()` calls every agent's `tick()` and never lets one trip's throw stop the others (log + continue).

- [ ] **Step 1: Write the failing tests**

`night-shift/tests/live/chatBus.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ChatBus } from "../../src/live/chatBus.js";

describe("ChatBus", () => {
  it("hands the page only what it has not seen, in order", () => {
    const bus = new ChatBus();
    const a = bus.push("t1", "first", 1000);
    const b = bus.push("t1", "second", 2000);
    expect(bus.since("t1", 0).map((m) => m.text)).toEqual(["first", "second"]);
    expect(bus.since("t1", a.id).map((m) => m.text)).toEqual(["second"]);
    expect(bus.since("t1", b.id)).toEqual([]);
    expect(bus.since("other", 0)).toEqual([]);
  });

  it("records when the link was first opened, and only the first time", () => {
    const bus = new ChatBus();
    expect(bus.openedAt("t1")).toBeNull();
    bus.markOpened("t1", 5000);
    bus.markOpened("t1", 9000);
    expect(bus.openedAt("t1")).toBe(5000);
  });
});
```

`night-shift/tests/live/registry.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { Registry } from "../../src/live/registry.js";
import type { Brief } from "../../src/core/types.js";

const brief: Brief = {
  loadRef: "T-01", origin: { name: "A", lat: 41.99, lng: 21.43 }, destination: { name: "B", lat: 42.0, lng: 21.5 },
  equipment: "DryVan", departAtMs: 1, deadlineAtMs: 2, driverName: "Trajce", driverPhone: "+38970000000",
  customerEmail: null, minutesSinceBreakAtDepart: null,
};
const fakeAgent = () => ({ start: vi.fn(async () => {}), tick: vi.fn(async () => {}), state: { status: "tracking" } });

describe("Registry", () => {
  it("starts a trip, calls the agent's start, and finds it by id and by token", async () => {
    const built: ReturnType<typeof fakeAgent>[] = [];
    const reg = new Registry(() => { const a = fakeAgent(); built.push(a); return a as never; });
    const trip = await reg.start(brief);
    expect(built[0].start).toHaveBeenCalledTimes(1);
    expect(reg.byId(trip.tripId)).toBe(trip);
    expect(reg.byToken(trip.driverToken)).toBe(trip);
    expect(reg.byToken("nope")).toBeNull();
  });

  it("ticks every trip, and one trip's failure does not stop the others", async () => {
    const good = fakeAgent();
    const bad = { ...fakeAgent(), tick: vi.fn(async () => { throw new Error("boom"); }) };
    let n = 0;
    const reg = new Registry(() => (n++ === 0 ? bad : good) as never);
    await reg.start(brief); await reg.start({ ...brief, loadRef: "T-02" });
    await reg.tickAll();
    expect(bad.tick).toHaveBeenCalledTimes(1);
    expect(good.tick).toHaveBeenCalledTimes(1);
  });

  it("stops a trip and forgets its token", async () => {
    const reg = new Registry(() => fakeAgent() as never);
    const trip = await reg.start(brief);
    await reg.stop(trip.tripId);
    expect(reg.byToken(trip.driverToken)).toBeNull();
    expect(reg.all()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/live/chatBus.test.ts tests/live/registry.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write chatBus.ts**

`night-shift/src/live/chatBus.ts`:
```ts
// The agent's outbox toward the driver's page. The page polls `since(lastId)`;
// the agent's MessengerPort `sendChat` lands here. In memory: a restart
// loses undelivered chat, which the event log still records as sent —
// acceptable for the first live run and noted in the runbook.
export interface ChatMessage {
  id: number;
  atMs: number;
  text: string;
}

export class ChatBus {
  private outbox: Record<string, readonly ChatMessage[]> = {};
  private opened: Record<string, number> = {};
  private nextId = 1;

  push(tripId: string, text: string, atMs: number): ChatMessage {
    const msg: ChatMessage = { id: this.nextId++, atMs, text };
    this.outbox = { ...this.outbox, [tripId]: [...(this.outbox[tripId] ?? []), msg] };
    return msg;
  }

  since(tripId: string, afterId: number): ChatMessage[] {
    return (this.outbox[tripId] ?? []).filter((m) => m.id > afterId);
  }

  markOpened(tripId: string, atMs: number): void {
    if (this.opened[tripId] === undefined) this.opened = { ...this.opened, [tripId]: atMs };
  }

  openedAt(tripId: string): number | null {
    return this.opened[tripId] ?? null;
  }
}
```

- [ ] **Step 4: Write registry.ts**

`night-shift/src/live/registry.ts`:
```ts
// The live trips this worker is watching. One Agent per load; the worker
// ticks them all once a minute. A throw inside one trip's tick is logged and
// contained — the other trucks are still on the road.
import type { Agent } from "../core/agent.js";
import type { Brief, RestStop } from "../core/types.js";
import { log } from "./log.js";
import { newDriverToken, newTripId } from "./tokens.js";

export interface LiveTrip {
  tripId: string;
  driverToken: string;
  brief: Brief;
  agent: Agent;
  startedAtMs: number;
}

/** What `build` gets: the ids, the brief, and the registered stops near the
 *  road — resolved by the worker before the trip starts, because the agent
 *  needs them to plan the break and the stop rule needs them on every ping. */
export type BuildAgent = (trip: { tripId: string; driverToken: string; brief: Brief; restStops: RestStop[] }) => Agent;

export class Registry {
  private trips: Record<string, LiveTrip> = {};

  constructor(private readonly build: BuildAgent) {}

  async start(brief: Brief, ids: { tripId?: string; driverToken?: string } = {}, extras: { restStops?: RestStop[] } = {}): Promise<LiveTrip> {
    const tripId = ids.tripId ?? newTripId();
    const driverToken = ids.driverToken ?? newDriverToken();
    const agent = this.build({ tripId, driverToken, brief, restStops: extras.restStops ?? [] });
    const trip: LiveTrip = { tripId, driverToken, brief, agent, startedAtMs: Date.now() };
    this.trips = { ...this.trips, [tripId]: trip };
    await agent.start();
    log("info", "trip started", { tripId, loadRef: brief.loadRef, status: agent.state.status });
    return trip;
  }

  byId(tripId: string): LiveTrip | null {
    return this.trips[tripId] ?? null;
  }

  byToken(token: string): LiveTrip | null {
    return Object.values(this.trips).find((t) => t.driverToken === token) ?? null;
  }

  all(): LiveTrip[] {
    return Object.values(this.trips);
  }

  async tickAll(): Promise<void> {
    for (const trip of this.all()) {
      try {
        await trip.agent.tick();
      } catch (e) {
        log("error", "tick failed", { tripId: trip.tripId, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  async stop(tripId: string): Promise<void> {
    const { [tripId]: _gone, ...rest } = this.trips;
    void _gone;
    this.trips = rest;
    log("info", "trip stopped", { tripId });
  }
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/live/chatBus.test.ts tests/live/registry.test.ts && npm run typecheck`
Expected: 5 passed; tsc clean.

- [ ] **Step 6: Break it**

Remove the `try/catch` in `tickAll` → "one trip's failure does not stop the others" must fail. Restore. Make `markOpened` overwrite unconditionally → "only the first time" must fail. Restore.

- [ ] **Step 7: Commit (if lifted)**

```bash
git add night-shift/src/live/chatBus.ts night-shift/src/live/registry.ts night-shift/tests/live/chatBus.test.ts night-shift/tests/live/registry.test.ts
git commit -m "feat(night-shift): chat bus and live trip registry"
```

---

### Task 5: The driver link — accept, share location, talk

**Files:**
- Create: `night-shift/src/live/driverLink.ts`, `night-shift/src/live/driverPage.html`
- Test: `night-shift/tests/live/driverLink.test.ts`

**Interfaces:**
- Consumes: `Registry`, `ChatBus`, the agent's `onAccept()`, `onPing()`, `onReply()`.
- Produces: `driverLinkRouter(registry: Registry, bus: ChatBus, clock: () => number): express.Router` mounting:
  - `GET  /d/:token` → the page (HTML), or 404 for an unknown token. Marks the link opened.
  - `POST /d/:token/accept` → `agent.onAccept()`; `{ ok: true }`.
  - `POST /d/:token/ping` body `{ lat, lng, atMs? }` (zod-validated; `atMs` defaults to the server clock) → `agent.onPing()`; `{ ok: true }`.
  - `POST /d/:token/reply` body `{ text }` (1–500 chars) → `agent.onReply({ atMs: now, channel: "chat", rawText: text })`; `{ ok: true }`.
  - `GET  /d/:token/messages?after=<id>` → `{ messages: ChatMessage[] }`.
  All JSON routes answer 404 for an unknown token and 400 with the zod issue for a bad body.

The page (`driverPage.html`): a single screen in American English. Before accept: the load line and one big **Accept** button. After accept: `navigator.geolocation.watchPosition` with `enableHighAccuracy`; a ping is posted when the position has moved more than 50 m from the last sent one or 60 s have passed, whichever first; a `navigator.wakeLock` request where supported; a status line ("Sharing location · last sent 10:42"); a message list polled every 5 s; a text box and Send. No framework, no external asset — the CSP of a random browser on a truck's phone is not ours to assume.

- [ ] **Step 1: Write the failing test**

`night-shift/tests/live/driverLink.test.ts`:
```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ChatBus } from "../../src/live/chatBus.js";
import { driverLinkRouter } from "../../src/live/driverLink.js";
import { Registry } from "../../src/live/registry.js";
import type { Brief } from "../../src/core/types.js";

const brief: Brief = {
  loadRef: "T-01", origin: { name: "Skopje", lat: 41.99, lng: 21.43 }, destination: { name: "Tetovo", lat: 42.01, lng: 20.97 },
  equipment: "DryVan", departAtMs: 1, deadlineAtMs: 2, driverName: "Trajce", driverPhone: "+38970000000",
  customerEmail: null, minutesSinceBreakAtDepart: null,
};

async function setup() {
  const agent = { start: vi.fn(async () => {}), onAccept: vi.fn(async () => {}), onPing: vi.fn(async () => {}), onReply: vi.fn(async () => {}), tick: vi.fn(async () => {}), state: { status: "invited" } };
  const reg = new Registry(() => agent as never);
  const trip = await reg.start(brief);
  const bus = new ChatBus();
  const app = express().use(express.json()).use(driverLinkRouter(reg, bus, () => 5_000));
  return { app, agent, trip, bus };
}

describe("driver link", () => {
  it("serves the page for a known token and 404s an unknown one", async () => {
    const { app, trip, bus } = await setup();
    const ok = await request(app).get(`/d/${trip.driverToken}`);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("T-01");
    expect(ok.text).toContain("Accept");
    expect(bus.openedAt(trip.tripId)).toBe(5_000);
    expect((await request(app).get("/d/nope")).status).toBe(404);
  });

  it("accept, ping and reply reach the agent with the server's clock", async () => {
    const { app, agent, trip } = await setup();
    await request(app).post(`/d/${trip.driverToken}/accept`).expect(200);
    expect(agent.onAccept).toHaveBeenCalledTimes(1);
    await request(app).post(`/d/${trip.driverToken}/ping`).send({ lat: 41.99, lng: 21.43 }).expect(200);
    expect(agent.onPing).toHaveBeenCalledWith({ atMs: 5_000, lat: 41.99, lng: 21.43 });
    await request(app).post(`/d/${trip.driverToken}/reply`).send({ text: "bathroom, rolling now" }).expect(200);
    expect(agent.onReply).toHaveBeenCalledWith({ atMs: 5_000, channel: "chat", rawText: "bathroom, rolling now" });
  });

  it("refuses a malformed ping or an empty reply with a 400 that names the field", async () => {
    const { app, agent, trip } = await setup();
    const bad = await request(app).post(`/d/${trip.driverToken}/ping`).send({ lat: "x" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/lat/);
    expect(agent.onPing).not.toHaveBeenCalled();
    expect((await request(app).post(`/d/${trip.driverToken}/reply`).send({ text: "" })).status).toBe(400);
  });

  it("hands the page the agent's messages it has not yet seen", async () => {
    const { app, trip, bus } = await setup();
    const m1 = bus.push(trip.tripId, "You've been stopped 15 min near Skopje, everything OK?", 6_000);
    bus.push(trip.tripId, "Got it, thanks.", 7_000);
    const first = await request(app).get(`/d/${trip.driverToken}/messages?after=0`);
    expect(first.body.messages.map((m: { text: string }) => m.text)).toHaveLength(2);
    const later = await request(app).get(`/d/${trip.driverToken}/messages?after=${m1.id}`);
    expect(later.body.messages.map((m: { text: string }) => m.text)).toEqual(["Got it, thanks."]);
  });

  it("never lets a driver's request throw out of the server", async () => {
    const { app, agent, trip } = await setup();
    agent.onPing.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app).post(`/d/${trip.driverToken}/ping`).send({ lat: 41.99, lng: 21.43 });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/could not record/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/live/driverLink.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write driverLink.ts**

`night-shift/src/live/driverLink.ts`:
```ts
// The driver's side of the agent: one link, one page, no install. Everything
// the page sends is validated here and handed to the trip's Agent; nothing
// the page sends is trusted for time — the server's clock stamps the event.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ChatBus } from "./chatBus.js";
import { log } from "./log.js";
import type { Registry } from "./registry.js";

const PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "driverPage.html"), "utf8");

const pingSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const replySchema = z.object({ text: z.string().trim().min(1).max(500) });

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function driverLinkRouter(registry: Registry, bus: ChatBus, clock: () => number): Router {
  const r = Router();

  const withTrip = (handler: (req: Request, res: Response, trip: NonNullable<ReturnType<Registry["byToken"]>>) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      const trip = registry.byToken(String(req.params.token));
      if (!trip) { res.status(404).json({ error: "This link is not valid." }); return; }
      try {
        await handler(req, res, trip);
      } catch (e) {
        log("error", "driver link handler failed", { tripId: trip.tripId, path: req.path, error: e instanceof Error ? e.message : String(e) });
        res.status(500).json({ error: "Could not record that — please try again." });
      }
    };

  r.get("/d/:token", withTrip(async (_req, res, trip) => {
    bus.markOpened(trip.tripId, clock());
    const b = trip.brief;
    const html = PAGE
      .replace(/__TOKEN__/g, escapeHtml(trip.driverToken))
      .replace(/__LOAD__/g, escapeHtml(`${b.loadRef}: ${b.origin.name} to ${b.destination.name}`))
      .replace(/__NAME__/g, escapeHtml(b.driverName));
    res.type("html").send(html);
  }));

  r.post("/d/:token/accept", withTrip(async (_req, res, trip) => {
    await trip.agent.onAccept();
    res.json({ ok: true });
  }));

  r.post("/d/:token/ping", withTrip(async (req, res, trip) => {
    const parsed = pingSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ") }); return; }
    await trip.agent.onPing({ atMs: clock(), lat: parsed.data.lat, lng: parsed.data.lng });
    res.json({ ok: true });
  }));

  r.post("/d/:token/reply", withTrip(async (req, res, trip) => {
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ") }); return; }
    await trip.agent.onReply({ atMs: clock(), channel: "chat", rawText: parsed.data.text });
    res.json({ ok: true });
  }));

  r.get("/d/:token/messages", withTrip(async (req, res, trip) => {
    const after = Number(req.query.after ?? 0);
    res.json({ messages: bus.since(trip.tripId, Number.isFinite(after) ? after : 0) });
  }));

  return r;
}
```

- [ ] **Step 4: Write driverPage.html**

`night-shift/src/live/driverPage.html`:
```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__LOAD__</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 17px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0f1422; color: #eef1f7; }
  main { max-width: 480px; margin: 0 auto; padding: 20px 16px 40px; display: grid; gap: 16px; }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .muted { color: #9aa4bd; font-size: 14px; }
  button { font: inherit; border: 0; border-radius: 12px; padding: 16px; background: #3b82f6; color: #fff; font-weight: 600; width: 100%; }
  button:disabled { opacity: .5; }
  #status { font-size: 14px; color: #9aa4bd; }
  #status.on { color: #58c08a; }
  #chat { display: grid; gap: 8px; }
  .msg { padding: 10px 14px; border-radius: 14px; max-width: 85%; }
  .msg.agent { background: #1e2c4a; border-bottom-left-radius: 4px; justify-self: start; }
  .msg.me { background: #2a3450; border-bottom-right-radius: 4px; justify-self: end; }
  form { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
  input { font: inherit; padding: 12px; border-radius: 10px; border: 1px solid #2a3450; background: #141b2e; color: inherit; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>__LOAD__</h1>
  <div class="muted">Hi __NAME__. Tap Accept to share your location for this run. It stops when the run ends.</div>
  <button id="accept">Accept</button>
  <div id="status"></div>
  <div id="chat" hidden></div>
  <form id="form" hidden><input id="text" placeholder="Reply to dispatch…" autocomplete="off"><button type="submit" style="width:auto">Send</button></form>
</main>
<script>
(function () {
  var token = "__TOKEN__", base = "/d/" + token;
  var $ = function (id) { return document.getElementById(id); };
  var lastSent = null, lastSentAt = 0, lastId = 0, timer = null;
  function post(path, body) { return fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }); }
  function fmt(ms) { var d = new Date(ms); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
  function meters(a, b) { var R = 6371000, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180, s = Math.sin(dLat / 2), t = Math.sin(dLng / 2); var h = s * s + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * t * t; return 2 * R * Math.asin(Math.sqrt(h)); }
  function sendPing(pos) {
    var p = { lat: pos.coords.latitude, lng: pos.coords.longitude }, now = Date.now();
    if (lastSent && meters(lastSent, p) < 50 && now - lastSentAt < 60000) return;
    lastSent = p; lastSentAt = now;
    post("/ping", p).then(function (r) { $("status").textContent = r.ok ? "Sharing location · last sent " + fmt(now) : "Could not send location — retrying"; $("status").className = r.ok ? "on" : ""; });
  }
  function poll() {
    fetch(base + "/messages?after=" + lastId).then(function (r) { return r.json(); }).then(function (j) {
      (j.messages || []).forEach(function (m) { lastId = m.id; add("agent", m.text); });
    }).catch(function () {});
  }
  function add(who, text) { var d = document.createElement("div"); d.className = "msg " + who; d.textContent = text; $("chat").appendChild(d); d.scrollIntoView({ block: "end" }); }
  $("accept").onclick = function () {
    $("accept").disabled = true;
    post("/accept").then(function () {
      $("accept").hidden = true; $("chat").hidden = false; $("form").hidden = false;
      $("status").textContent = "Getting your location…";
      if (!navigator.geolocation) { $("status").textContent = "This phone cannot share location."; return; }
      navigator.geolocation.watchPosition(sendPing, function (e) { $("status").textContent = "Location off — " + e.message; $("status").className = ""; }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
      if (navigator.wakeLock && navigator.wakeLock.request) { navigator.wakeLock.request("screen").catch(function () {}); }
      timer = setInterval(poll, 5000); poll();
    });
  };
  $("form").onsubmit = function (ev) {
    ev.preventDefault(); var t = $("text").value.trim(); if (!t) return;
    add("me", t); $("text").value = "";
    post("/reply", { text: t }).catch(function () { add("agent", "Could not send — please try again."); });
  };
})();
</script>
</body>
</html>
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/live/driverLink.test.ts && npm run typecheck`
Expected: 5 passed; tsc clean. (Vitest runs `readFileSync` against the real `driverPage.html` — the page must exist for the test to pass.)

- [ ] **Step 6: Break it**

Remove the `try/catch` in `withTrip` → "never lets a driver's request throw" must fail. Restore. Change the ping handler to use `req.body.atMs ?? clock()` → the accept/ping/reply test still passes (no `atMs` sent); add `{ lat, lng, atMs: 1 }` to that test's ping and confirm the server's clock still wins. Keep that assertion.

- [ ] **Step 7: Commit (if lifted)**

```bash
git add night-shift/src/live/driverLink.ts night-shift/src/live/driverPage.html night-shift/tests/live/driverLink.test.ts
git commit -m "feat(night-shift): driver link page — accept, location, chat"
```

---

### Task 6: Twilio SMS out, driver SMS in

**Files:**
- Create: `night-shift/src/live/twilioMessenger.ts`, `night-shift/src/live/twilioWebhooks.ts`
- Modify: `night-shift/src/live/registry.ts` (add `byPhone`)
- Test: `night-shift/tests/live/twilioMessenger.test.ts`, `night-shift/tests/live/twilioWebhooks.test.ts`

**Interfaces:**
- Consumes: `MessengerPort`; `ChatBus`; `Registry`; the `twilio` package's `validateRequest(authToken, signature, url, params): boolean`.
- Produces:
  - `interface SmsClient { messages: { create(opts: { from: string; to: string; body: string }): Promise<{ sid: string }> } }` — the slice of the Twilio client the adapter uses; the real `twilio(sid, token)` satisfies it.
  - `class TwilioMessenger implements MessengerPort` with `constructor(client: SmsClient, from: string, bus: ChatBus, trip: { tripId: string; driverToken: string }, publicUrl: string, clock: () => number)`. `sendChat(phone, text)` → `bus.push(tripId, text, clock())`. `sendSms(phone, text)` → Twilio, with the driver link appended: `text + "\n" + publicUrl + "/d/" + driverToken`. Every SMS carries the link because every SMS is an invitation to talk there — the invite needs it to accept, a rung-2 fallback needs it to reply.
  - `Registry.byPhone(phone: string): LiveTrip | null`.
  - `twilioSmsRouter(registry: Registry, validate: (signature: string, url: string, params: Record<string, string>) => boolean, publicUrl: string, clock: () => number): express.Router` mounting `POST /twilio/sms` (Twilio posts `application/x-www-form-urlencoded`; the router mounts `express.urlencoded` itself). Verifies `X-Twilio-Signature` against `publicUrl + "/twilio/sms"` and the body; 403 on failure. Finds the trip by `From`; 404 if none. Calls `agent.onReply({ atMs: clock(), channel: "sms", rawText: Body })`. Answers `<Response></Response>` (an empty TwiML — the agent replies through its own port, never by auto-reply).

- [ ] **Step 1: Write the failing tests**

`night-shift/tests/live/twilioMessenger.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { ChatBus } from "../../src/live/chatBus.js";
import { TwilioMessenger } from "../../src/live/twilioMessenger.js";

const client = () => ({ messages: { create: vi.fn(async () => ({ sid: "SM123" })) } });
const trip = { tripId: "t1", driverToken: "tok_abc" };

describe("TwilioMessenger", () => {
  it("delivers chat to the driver's page, not to Twilio", async () => {
    const c = client(); const bus = new ChatBus();
    const m = new TwilioMessenger(c, "+15550001", bus, trip, "https://x.example", () => 7_000);
    await m.sendChat("+38970000000", "Everything OK?");
    expect(bus.since("t1", 0).map((x) => x.text)).toEqual(["Everything OK?"]);
    expect(c.messages.create).not.toHaveBeenCalled();
  });

  it("sends SMS through Twilio with the driver link appended", async () => {
    const c = client();
    const m = new TwilioMessenger(c, "+15550001", new ChatBus(), trip, "https://x.example", () => 7_000);
    await m.sendSms("+38970000000", "Load T-01: … Tap Accept to share your location for this run.");
    expect(c.messages.create).toHaveBeenCalledWith({
      from: "+15550001", to: "+38970000000",
      body: "Load T-01: … Tap Accept to share your location for this run.\nhttps://x.example/d/tok_abc",
    });
  });

  it("lets a Twilio failure propagate — the core records a failed delivery, not a sent one", async () => {
    const c = client(); c.messages.create.mockRejectedValueOnce(new Error("21610 unsubscribed"));
    const m = new TwilioMessenger(c, "+15550001", new ChatBus(), trip, "https://x.example", () => 7_000);
    await expect(m.sendSms("+38970000000", "hi")).rejects.toThrow(/21610/);
  });
});
```

`night-shift/tests/live/twilioWebhooks.test.ts`:
```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { Registry } from "../../src/live/registry.js";
import { twilioSmsRouter } from "../../src/live/twilioWebhooks.js";
import type { Brief } from "../../src/core/types.js";

const brief: Brief = {
  loadRef: "T-01", origin: { name: "A", lat: 41.99, lng: 21.43 }, destination: { name: "B", lat: 42.0, lng: 21.5 },
  equipment: "DryVan", departAtMs: 1, deadlineAtMs: 2, driverName: "Trajce", driverPhone: "+38970000000",
  customerEmail: null, minutesSinceBreakAtDepart: null,
};

async function setup(valid = true) {
  const agent = { start: vi.fn(async () => {}), onReply: vi.fn(async () => {}), tick: vi.fn(async () => {}), state: { status: "tracking" } };
  const reg = new Registry(() => agent as never);
  await reg.start(brief);
  const validate = vi.fn(() => valid);
  const app = express().use(twilioSmsRouter(reg, validate, "https://x.example", () => 9_000));
  return { app, agent, validate };
}

describe("POST /twilio/sms", () => {
  it("verifies the signature against the public URL and hands the text to the driver's agent", async () => {
    const { app, agent, validate } = await setup();
    const res = await request(app).post("/twilio/sms").set("X-Twilio-Signature", "sig").type("form").send({ From: "+38970000000", Body: "had to pee" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Response");
    expect(validate).toHaveBeenCalledWith("sig", "https://x.example/twilio/sms", expect.objectContaining({ From: "+38970000000", Body: "had to pee" }));
    expect(agent.onReply).toHaveBeenCalledWith({ atMs: 9_000, channel: "sms", rawText: "had to pee" });
  });

  it("refuses an unsigned request with 403 and never calls the agent", async () => {
    const { app, agent } = await setup(false);
    const res = await request(app).post("/twilio/sms").type("form").send({ From: "+38970000000", Body: "hi" });
    expect(res.status).toBe(403);
    expect(agent.onReply).not.toHaveBeenCalled();
  });

  it("404s a text from a phone that is not a live driver", async () => {
    const { app, agent } = await setup();
    const res = await request(app).post("/twilio/sms").set("X-Twilio-Signature", "sig").type("form").send({ From: "+15550009", Body: "hi" });
    expect(res.status).toBe(404);
    expect(agent.onReply).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/live/twilioMessenger.test.ts tests/live/twilioWebhooks.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Add `byPhone` to the registry**

In `night-shift/src/live/registry.ts`, after `byToken`:
```ts
  byPhone(phone: string): LiveTrip | null {
    return Object.values(this.trips).find((t) => t.brief.driverPhone === phone) ?? null;
  }
```

- [ ] **Step 4: Write twilioMessenger.ts**

`night-shift/src/live/twilioMessenger.ts`:
```ts
// The driver's two channels. Chat is the page (the bus); SMS is Twilio, and
// every SMS carries the driver link because every SMS is an invitation to
// talk there. A Twilio error is thrown, not swallowed: the core records a
// failed delivery and retries on the ladder's cooldown.
import type { ChatBus } from "./chatBus.js";
import type { MessengerPort } from "../ports/index.js";

export interface SmsClient {
  messages: { create(opts: { from: string; to: string; body: string }): Promise<{ sid: string }> };
}

export class TwilioMessenger implements MessengerPort {
  constructor(
    private readonly client: SmsClient,
    private readonly from: string,
    private readonly bus: ChatBus,
    private readonly trip: { tripId: string; driverToken: string },
    private readonly publicUrl: string,
    private readonly clock: () => number,
  ) {}

  async sendChat(_phone: string, text: string): Promise<void> {
    this.bus.push(this.trip.tripId, text, this.clock());
  }

  async sendSms(phone: string, text: string): Promise<void> {
    await this.client.messages.create({ from: this.from, to: phone, body: text + "\n" + this.publicUrl + "/d/" + this.trip.driverToken });
  }
}
```

- [ ] **Step 5: Write twilioWebhooks.ts (SMS half; Task 8 adds the voice routes to this file)**

`night-shift/src/live/twilioWebhooks.ts`:
```ts
// Twilio calling us. Every request is verified against the public URL and
// the auth token before anything reaches an agent — an unsigned POST from
// the open internet is a 403 and a log line, never a driver's reply.
import { Router, urlencoded, type Request, type Response } from "express";
import { log } from "./log.js";
import type { Registry } from "./registry.js";

export type Validate = (signature: string, url: string, params: Record<string, string>) => boolean;

export function twilioSmsRouter(registry: Registry, validate: Validate, publicUrl: string, clock: () => number): Router {
  const r = Router();
  r.use(urlencoded({ extended: false }));

  r.post("/twilio/sms", async (req: Request, res: Response) => {
    const params = req.body as Record<string, string>;
    if (!validate(String(req.header("X-Twilio-Signature") ?? ""), publicUrl + "/twilio/sms", params)) {
      log("warn", "twilio sms webhook: bad signature", { from: params.From ?? null });
      res.status(403).type("text/plain").send("forbidden");
      return;
    }
    const trip = registry.byPhone(String(params.From ?? ""));
    if (!trip) {
      log("warn", "twilio sms webhook: no live trip for sender", { from: params.From ?? null });
      res.status(404).type("text/plain").send("no live trip for this number");
      return;
    }
    try {
      await trip.agent.onReply({ atMs: clock(), channel: "sms", rawText: String(params.Body ?? "") });
    } catch (e) {
      log("error", "twilio sms webhook: agent failed", { tripId: trip.tripId, error: e instanceof Error ? e.message : String(e) });
    }
    // Empty TwiML: the agent answers through its own port, never by auto-reply.
    res.type("text/xml").send("<Response></Response>");
  });

  return r;
}
```

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run tests/live/twilioMessenger.test.ts tests/live/twilioWebhooks.test.ts tests/live/registry.test.ts && npm run typecheck`
Expected: 6 + 3 passed; tsc clean.

- [ ] **Step 7: Break it**

Make the router skip `validate` → "refuses an unsigned request" must fail. Restore. Drop the link suffix in `sendSms` → "with the driver link appended" must fail. Restore.

- [ ] **Step 8: Commit (if lifted)**

```bash
git add night-shift/src/live/twilioMessenger.ts night-shift/src/live/twilioWebhooks.ts night-shift/src/live/registry.ts night-shift/tests/live/twilioMessenger.test.ts night-shift/tests/live/twilioWebhooks.test.ts
git commit -m "feat(night-shift): Twilio SMS out and verified driver SMS in"
```

---

### Task 7: Email to the dispatcher, and the one-click send

**Files:**
- Create: `night-shift/src/live/smtpMailer.ts`, `night-shift/src/live/actions.ts`
- Test: `night-shift/tests/live/smtpMailer.test.ts`, `night-shift/tests/live/actions.test.ts`

**Interfaces:**
- Consumes: `MailerPort`, `Attachment`; `signAction`/`verifyAction`; `Registry`.
- Produces:
  - `interface MailTransport { sendMail(opts: { from: string; to: string; subject: string; text: string; attachments?: { filename: string; content: string }[] }): Promise<{ messageId?: string }> }` — nodemailer's transport satisfies it.
  - `class SmtpMailer implements MailerPort` with `constructor(transport: MailTransport, from: string, opts: { dispatcherEmail: string; publicUrl: string; linkSecret: string; tripId: string; clock: () => number })`. `send(to, subject, body, attachments)`: when `to === dispatcherEmail`, appends `"\n\nOne click to send the customer email: " + publicUrl + "/act/" + signAction(linkSecret, tripId, "send_customer_email", clock() + ACTION_LINK_TTL_MS)`; returns `{ messageId }`. `ACTION_LINK_TTL_MS = 24 h`, named.
  - `actionsRouter(registry: Registry, linkSecret: string, clock: () => number): express.Router` mounting `GET /act/:signed` → `verifyAction`; 403 HTML "This link is not valid or has expired." on failure; 404 if the trip is gone; on `send_customer_email` → `agent.onDispatcherReply("send the customer email")` and a small HTML "Done. The agent has acted on it — check your inbox for the confirmation." The link is GET on purpose: it must work from a phone's mail app with one tap. It is idempotent by construction — a second tap reaches the agent's own "Nothing to send".

- [ ] **Step 1: Write the failing tests**

`night-shift/tests/live/smtpMailer.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { SmtpMailer } from "../../src/live/smtpMailer.js";
import { verifyAction } from "../../src/live/tokens.js";

const transport = () => ({ sendMail: vi.fn(async () => ({ messageId: "<m1@x>" })) });
const opts = { dispatcherEmail: "boss@x.example", publicUrl: "https://x.example", linkSecret: "secret-secret-secret", tripId: "t1", clock: () => 1_000_000 };

describe("SmtpMailer", () => {
  it("sends through the transport and returns the message id", async () => {
    const t = transport();
    const r = await new SmtpMailer(t, "agent@x.example", opts).send("ops@c.example", "Update on load T-01", "current ETA 10:36", [{ name: "a.txt", body: "x" }]);
    expect(r.messageId).toBe("<m1@x>");
    expect(t.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: "agent@x.example", to: "ops@c.example", subject: "Update on load T-01", attachments: [{ filename: "a.txt", content: "x" }] }));
  });

  it("appends a SIGNED one-click link to the dispatcher's email only", async () => {
    const t = transport();
    const m = new SmtpMailer(t, "agent@x.example", opts);
    await m.send("boss@x.example", "[T-01] escalation", "body");
    const text: string = t.sendMail.mock.calls[0][0].text;
    const url = text.match(/https:\/\/x\.example\/act\/(\S+)/);
    expect(url).not.toBeNull();
    expect(verifyAction("secret-secret-secret", url![1], 1_000_000)).toEqual({ tripId: "t1", action: "send_customer_email" });
    await m.send("ops@c.example", "customer", "body");
    expect(t.sendMail.mock.calls[1][0].text).not.toContain("/act/");
  });

  it("lets a transport failure propagate — the core records the email as not sent", async () => {
    const t = transport(); t.sendMail.mockRejectedValueOnce(new Error("535 auth"));
    await expect(new SmtpMailer(t, "agent@x.example", opts).send("boss@x.example", "s", "b")).rejects.toThrow(/535/);
  });
});
```

`night-shift/tests/live/actions.test.ts`:
```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actionsRouter } from "../../src/live/actions.js";
import { Registry } from "../../src/live/registry.js";
import { signAction } from "../../src/live/tokens.js";
import type { Brief } from "../../src/core/types.js";

const brief: Brief = {
  loadRef: "T-01", origin: { name: "A", lat: 41.99, lng: 21.43 }, destination: { name: "B", lat: 42.0, lng: 21.5 },
  equipment: "DryVan", departAtMs: 1, deadlineAtMs: 2, driverName: "Trajce", driverPhone: "+38970000000",
  customerEmail: "ops@c.example", minutesSinceBreakAtDepart: null,
};

async function setup() {
  const agent = { start: vi.fn(async () => {}), onDispatcherReply: vi.fn(async () => {}), tick: vi.fn(async () => {}), state: { status: "tracking" } };
  const reg = new Registry(() => agent as never);
  const trip = await reg.start(brief, { tripId: "t1" });
  const app = express().use(actionsRouter(reg, "secret-secret-secret", () => 5_000));
  return { app, agent, trip };
}

describe("GET /act/:signed", () => {
  it("performs the signed action through the agent's own command vocabulary", async () => {
    const { app, agent } = await setup();
    const signed = signAction("secret-secret-secret", "t1", "send_customer_email", 6_000);
    const res = await request(app).get("/act/" + signed);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Done/);
    expect(agent.onDispatcherReply).toHaveBeenCalledWith("send the customer email");
  });

  it("refuses an expired or tampered link with 403 and touches nothing", async () => {
    const { app, agent } = await setup();
    const expired = signAction("secret-secret-secret", "t1", "send_customer_email", 4_000);
    expect((await request(app).get("/act/" + expired)).status).toBe(403);
    const tampered = signAction("secret-secret-secret", "t1", "send_customer_email", 6_000).replace("t1", "t2");
    expect((await request(app).get("/act/" + tampered)).status).toBe(403);
    expect(agent.onDispatcherReply).not.toHaveBeenCalled();
  });

  it("404s a valid link for a trip this worker does not hold", async () => {
    const { app, agent } = await setup();
    const gone = signAction("secret-secret-secret", "t_gone", "send_customer_email", 6_000);
    expect((await request(app).get("/act/" + gone)).status).toBe(404);
    expect(agent.onDispatcherReply).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/live/smtpMailer.test.ts tests/live/actions.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write smtpMailer.ts**

`night-shift/src/live/smtpMailer.ts`:
```ts
// Email out. The dispatcher's copies get a signed one-click link that does
// what the reply vocabulary does — one tap from a phone's mail app, no
// reply-parsing, nothing to misread. A transport error is thrown: the core
// records that the escalation did NOT go out.
import { signAction } from "./tokens.js";
import type { Attachment, MailerPort } from "../ports/index.js";

/** How long a one-click link works. A day: long enough for a morning
 *  briefing to be acted on after lunch, short enough that a forwarded email
 *  is not a permanent button. */
export const ACTION_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export interface MailTransport {
  sendMail(opts: { from: string; to: string; subject: string; text: string; attachments?: { filename: string; content: string }[] }): Promise<{ messageId?: string }>;
}

export class SmtpMailer implements MailerPort {
  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
    private readonly opts: { dispatcherEmail: string; publicUrl: string; linkSecret: string; tripId: string; clock: () => number },
  ) {}

  async send(to: string, subject: string, body: string, attachments: Attachment[] = []): Promise<{ messageId: string | null }> {
    let text = body;
    if (to === this.opts.dispatcherEmail) {
      const signed = signAction(this.opts.linkSecret, this.opts.tripId, "send_customer_email", this.opts.clock() + ACTION_LINK_TTL_MS);
      text += "\n\nOne click to send the customer email: " + this.opts.publicUrl + "/act/" + signed;
    }
    const info = await this.transport.sendMail({
      from: this.from, to, subject, text,
      attachments: attachments.map((a) => ({ filename: a.name, content: a.body })),
    });
    return { messageId: info.messageId ?? null };
  }
}
```

- [ ] **Step 4: Write actions.ts**

`night-shift/src/live/actions.ts`:
```ts
// The one-click links from dispatcher emails land here. A link is a signed
// statement of trip + action + expiry; anything else is refused before an
// agent is looked up.
import { Router, type Request, type Response } from "express";
import { log } from "./log.js";
import type { Registry } from "./registry.js";
import { verifyAction } from "./tokens.js";

const page = (title: string, line: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font:18px/1.5 system-ui;padding:32px;max-width:480px;margin:auto"><h1 style="font-size:22px">${title}</h1><p>${line}</p></body>`;

export function actionsRouter(registry: Registry, linkSecret: string, clock: () => number): Router {
  const r = Router();
  r.get("/act/:signed", async (req: Request, res: Response) => {
    const v = verifyAction(linkSecret, String(req.params.signed), clock());
    if (!v) { res.status(403).type("html").send(page("This link is not valid", "It may have expired. Reply to the agent's email instead.")); return; }
    const trip = registry.byId(v.tripId);
    if (!trip) { res.status(404).type("html").send(page("This load is no longer live", "The agent has finished with it.")); return; }
    if (v.action !== "send_customer_email") { res.status(400).type("html").send(page("Unknown action", v.action)); return; }
    try {
      await trip.agent.onDispatcherReply("send the customer email");
      res.type("html").send(page("Done", "The agent has acted on it — check your inbox for the confirmation."));
    } catch (e) {
      log("error", "action link failed", { tripId: trip.tripId, error: e instanceof Error ? e.message : String(e) });
      res.status(500).type("html").send(page("That did not work", "The agent could not act on it. Reply to the email instead."));
    }
  });
  return r;
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/live/smtpMailer.test.ts tests/live/actions.test.ts && npm run typecheck`
Expected: 6 passed; tsc clean.

- [ ] **Step 6: Break it**

In `actions.ts` skip `verifyAction` and parse the trip id from the string → "refuses an expired or tampered link" must fail. Restore. In `SmtpMailer.send` append the link regardless of recipient → "to the dispatcher's email only" must fail. Restore.

- [ ] **Step 7: Commit (if lifted)**

```bash
git add night-shift/src/live/smtpMailer.ts night-shift/src/live/actions.ts night-shift/tests/live/smtpMailer.test.ts night-shift/tests/live/actions.test.ts
git commit -m "feat(night-shift): SMTP mailer with signed one-click send"
```

---

### Task 8: The voice call

**Files:**
- Create: `night-shift/src/live/twilioPhone.ts`
- Modify: `night-shift/src/live/twilioWebhooks.ts` (add `twilioVoiceRouter`)
- Test: `night-shift/tests/live/twilioPhone.test.ts`

**Interfaces:**
- Consumes: `PhonePort`, `CallOutcome` (`{ answered, transcript, confidence }`) from the core.
- Produces:
  - `interface VoiceClient { calls: { create(opts: { from: string; to: string; url: string; statusCallback: string; statusCallbackEvent: string[]; timeout: number }): Promise<{ sid: string }> } }`.
  - `class TwilioPhone implements PhonePort` with `constructor(client: VoiceClient, from: string, publicUrl: string, opts: { ringSeconds?: number; outcomeTimeoutMs?: number } = {})`. `call(phone, script)`: mints `callId`, stores `{ script, resolve }` in a pending map, creates the call with `url = publicUrl + "/twilio/voice/" + callId + "/answer"` and `statusCallback = … + "/status"`, and returns a Promise that resolves when a webhook settles it or when `outcomeTimeoutMs` (default 90 s) passes — a call nobody answered and Twilio never reported is `{ answered: false, transcript: null, confidence: null }`. A `create()` error is thrown: a call that could not be placed is a failed delivery in the core's log, never "no answer".
  - `TwilioPhone.answerTwiml(callId)`, `gather(callId, speech, confidence)`, `status(callId, callStatus)` — the three webhook entry points, so the router stays thin and the state machine is testable without HTTP.
  - `twilioVoiceRouter(phone: TwilioPhone, validate: Validate, publicUrl: string): express.Router` mounting `POST /twilio/voice/:id/answer` (TwiML), `POST /twilio/voice/:id/gather`, `POST /twilio/voice/:id/status`, all signature-verified.

TwiML for `answer`: `<Say voice="Polly.Matthew" language="en-US">{script}</Say><Gather input="speech" language="en-US" speechTimeout="auto" action="{gatherUrl}" method="POST"><Say voice="Polly.Matthew">Go ahead.</Say></Gather><Say voice="Polly.Matthew">Thanks, I'll let dispatch know.</Say>`; for `gather`: `<Say voice="Polly.Matthew">Thanks, I'll let dispatch know.</Say><Hangup/>`. Twilio posts `SpeechResult` and `Confidence` (0–1, as a string) to the gather action. Status events `no-answer`, `busy`, `failed`, `canceled` resolve unanswered; `completed` after a gather is already settled; `completed` with no gather resolves `{ answered: true, transcript: null, confidence: null }` — he picked up and said nothing the recognizer caught, which the core renders as an unknown reply.

Known limitation, recorded in the runbook: `Agent.execute()` awaits `phone.call()`, so a trip's tick blocks for up to the call's duration; with one live trip that is fine, and the registry's per-trip try/catch means a second trip is delayed, not broken.

- [ ] **Step 1: Write the failing test**

`night-shift/tests/live/twilioPhone.test.ts`:
```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { TwilioPhone } from "../../src/live/twilioPhone.js";
import { twilioVoiceRouter } from "../../src/live/twilioWebhooks.js";

const client = () => ({ calls: { create: vi.fn(async () => ({ sid: "CA1" })) } });

describe("TwilioPhone", () => {
  it("places the call with our webhook URLs and resolves from the gather", async () => {
    const c = client();
    const phone = new TwilioPhone(c, "+15550001", "https://x.example");
    const pending = phone.call("+38970000000", "You're about 45 minutes behind. Is everything OK?");
    const create = c.calls.create.mock.calls[0][0];
    expect(create.to).toBe("+38970000000");
    const id = create.url.match(/\/twilio\/voice\/([^/]+)\/answer$/)![1];
    expect(create.statusCallback).toBe("https://x.example/twilio/voice/" + id + "/status");
    expect(phone.answerTwiml(id)).toContain("45 minutes behind");
    expect(phone.answerTwiml(id)).toContain('input="speech"');
    phone.gather(id, "truck broke down", "0.87");
    await expect(pending).resolves.toEqual({ answered: true, transcript: "truck broke down", confidence: 0.87 });
  });

  it("resolves unanswered from a no-answer status, and never invents a transcript", async () => {
    const c = client();
    const phone = new TwilioPhone(c, "+15550001", "https://x.example");
    const pending = phone.call("+38970000000", "hello");
    const id = c.calls.create.mock.calls[0][0].url.match(/voice\/([^/]+)\//)![1];
    phone.status(id, "no-answer");
    await expect(pending).resolves.toEqual({ answered: false, transcript: null, confidence: null });
  });

  it("times out as unanswered when Twilio never reports back", async () => {
    const phone = new TwilioPhone(client(), "+15550001", "https://x.example", { outcomeTimeoutMs: 20 });
    await expect(phone.call("+38970000000", "hello")).resolves.toEqual({ answered: false, transcript: null, confidence: null });
  });

  it("throws when the call cannot be placed — a failed delivery, not a no-answer", async () => {
    const c = client(); c.calls.create.mockRejectedValueOnce(new Error("21215 geo permission"));
    await expect(new TwilioPhone(c, "+15550001", "https://x.example").call("+38970000000", "hi")).rejects.toThrow(/21215/);
  });

  it("serves TwiML over the verified webhook routes", async () => {
    const c = client();
    const phone = new TwilioPhone(c, "+15550001", "https://x.example");
    const pending = phone.call("+38970000000", "Is everything OK?");
    const id = c.calls.create.mock.calls[0][0].url.match(/voice\/([^/]+)\//)![1];
    const app = express().use(twilioVoiceRouter(phone, () => true, "https://x.example"));
    const answer = await request(app).post(`/twilio/voice/${id}/answer`).set("X-Twilio-Signature", "s").type("form").send({ CallSid: "CA1" });
    expect(answer.status).toBe(200);
    expect(answer.text).toContain("<Gather");
    const gather = await request(app).post(`/twilio/voice/${id}/gather`).set("X-Twilio-Signature", "s").type("form").send({ SpeechResult: "all good", Confidence: "0.91" });
    expect(gather.text).toContain("<Hangup");
    await expect(pending).resolves.toEqual({ answered: true, transcript: "all good", confidence: 0.91 });
    const bad = await request(express().use(twilioVoiceRouter(phone, () => false, "https://x.example"))).post(`/twilio/voice/${id}/answer`).type("form").send({});
    expect(bad.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/live/twilioPhone.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write twilioPhone.ts**

`night-shift/src/live/twilioPhone.ts`:
```ts
// The voice rung. We place the call and Twilio calls US back three times:
// for what to say, with what was said, and with how it ended. Each call is
// a pending promise keyed by an id we minted, settled by whichever webhook
// arrives first — or by a timeout, so a call Twilio never reports on still
// resolves as unanswered instead of hanging the ladder forever.
import { randomBytes } from "node:crypto";
import type { CallOutcome, PhonePort } from "../ports/index.js";

export interface VoiceClient {
  calls: { create(opts: { from: string; to: string; url: string; statusCallback: string; statusCallbackEvent: string[]; timeout: number }): Promise<{ sid: string }> };
}

/** Seconds Twilio lets it ring before giving up. */
const RING_SECONDS = 30;
/** How long we wait for any webhook before calling it unanswered. */
const OUTCOME_TIMEOUT_MS = 90_000;
const VOICE = 'voice="Polly.Matthew" language="en-US"';
const SIGN_OFF = "Thanks, I'll let dispatch know.";

const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);

interface Pending { script: string; resolve: (o: CallOutcome) => void; timer: NodeJS.Timeout }

export class TwilioPhone implements PhonePort {
  private pending: Record<string, Pending> = {};

  constructor(
    private readonly client: VoiceClient,
    private readonly from: string,
    private readonly publicUrl: string,
    private readonly opts: { ringSeconds?: number; outcomeTimeoutMs?: number } = {},
  ) {}

  call(phone: string, script: string): Promise<CallOutcome> {
    const id = "c_" + randomBytes(8).toString("base64url");
    const base = this.publicUrl + "/twilio/voice/" + id;
    const outcome = new Promise<CallOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(id, { answered: false, transcript: null, confidence: null }), this.opts.outcomeTimeoutMs ?? OUTCOME_TIMEOUT_MS);
      this.pending = { ...this.pending, [id]: { script, resolve, timer } };
    });
    // Placing the call can fail (geo permissions, bad number). Then the
    // promise must not linger: reject to the caller and forget the id.
    const placed = this.client.calls.create({
      from: this.from, to: phone, url: base + "/answer", statusCallback: base + "/status",
      statusCallbackEvent: ["completed", "no-answer", "busy", "failed", "canceled"], timeout: this.opts.ringSeconds ?? RING_SECONDS,
    });
    return placed.then(() => outcome, (e) => { this.forget(id); throw e; });
  }

  answerTwiml(id: string): string {
    const p = this.pending[id];
    const script = p ? p.script : "Hi, this is the dispatch assistant. Is everything OK?";
    const gatherUrl = this.publicUrl + "/twilio/voice/" + id + "/gather";
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say ${VOICE}>${esc(script)}</Say>` +
      `<Gather input="speech" language="en-US" speechTimeout="auto" action="${gatherUrl}" method="POST"><Say ${VOICE}>Go ahead.</Say></Gather>` +
      `<Say ${VOICE}>${SIGN_OFF}</Say></Response>`;
  }

  gather(id: string, speech: string, confidence: string): string {
    const c = Number(confidence);
    this.settle(id, { answered: true, transcript: speech.trim() || null, confidence: Number.isFinite(c) ? c : null });
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say ${VOICE}>${SIGN_OFF}</Say><Hangup/></Response>`;
  }

  status(id: string, callStatus: string): void {
    if (["no-answer", "busy", "failed", "canceled"].includes(callStatus)) this.settle(id, { answered: false, transcript: null, confidence: null });
    else if (callStatus === "completed") this.settle(id, { answered: true, transcript: null, confidence: null });
  }

  private settle(id: string, outcome: CallOutcome): void {
    const p = this.pending[id];
    if (!p) return;
    clearTimeout(p.timer);
    this.forget(id);
    p.resolve(outcome);
  }

  private forget(id: string): void {
    const { [id]: _gone, ...rest } = this.pending;
    void _gone;
    this.pending = rest;
  }
}
```

- [ ] **Step 4: Add the voice router to twilioWebhooks.ts**

Append to `night-shift/src/live/twilioWebhooks.ts` (import `TwilioPhone` as a type at the top):
```ts
export function twilioVoiceRouter(phone: TwilioPhone, validate: Validate, publicUrl: string): Router {
  const r = Router();
  r.use(urlencoded({ extended: false }));
  const guarded = (path: string, handle: (id: string, params: Record<string, string>) => string | void) =>
    r.post(`/twilio/voice/:id/${path}`, (req: Request, res: Response) => {
      const params = req.body as Record<string, string>;
      const url = publicUrl + "/twilio/voice/" + req.params.id + "/" + path;
      if (!validate(String(req.header("X-Twilio-Signature") ?? ""), url, params)) {
        log("warn", "twilio voice webhook: bad signature", { path, id: req.params.id });
        res.status(403).type("text/plain").send("forbidden");
        return;
      }
      const twiml = handle(String(req.params.id), params);
      res.type("text/xml").send(twiml ?? "<Response></Response>");
    });
  guarded("answer", (id) => phone.answerTwiml(id));
  guarded("gather", (id, p) => phone.gather(id, String(p.SpeechResult ?? ""), String(p.Confidence ?? "")));
  guarded("status", (id, p) => { phone.status(id, String(p.CallStatus ?? "")); });
  return r;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/live/twilioPhone.test.ts tests/live/twilioWebhooks.test.ts && npm run typecheck`
Expected: 5 + 3 passed; tsc clean.

- [ ] **Step 6: Break it**

In `status()`, treat `no-answer` as `{ answered: true, … }` → "resolves unanswered from a no-answer status" must fail. Restore. Remove the timeout → "times out as unanswered" must hang; confirm it fails by timeout and restore.

- [ ] **Step 7: Commit (if lifted)**

```bash
git add night-shift/src/live/twilioPhone.ts night-shift/src/live/twilioWebhooks.ts night-shift/tests/live/twilioPhone.test.ts
git commit -m "feat(night-shift): Twilio voice rung with verified TwiML webhooks"
```

---

### Task 9: The delivery-failure budget (the one core change)

**Files:**
- Modify: `night-shift/src/core/constants.ts` (append), `night-shift/src/core/ladder.ts`, `night-shift/src/core/agent.ts` (`execute()` failure branch only)
- Test: `night-shift/tests/live/failureBudget.test.ts`

**Why.** The core's I5 error story holds the rung and retries after the cooldown when a send throws. With a real gateway that is down, that is a ladder retrying every ten minutes for the rest of the night, never reaching the dispatcher. Three consecutive failures on one rung is the point at which "I could not reach him" is itself the news.

**Interfaces:**
- `MAX_DELIVERY_FAILURES = 3` in constants, with its reason.
- `LadderState` gains `failures: number` (0 in `initialLadder`; `applyFailure` increments; `applyAction` resets to 0).
- `Agent.execute()`: after `applyFailure`, if `failures >= MAX_DELIVERY_FAILURES`, stop the ladder (`stoppedReason: "escalated"`) and call `escalate("could not reach the driver — <n> delivery failures at rung <r>", null, anomaly)`.

- [ ] **Step 1: Write the failing test**

`night-shift/tests/live/failureBudget.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/core/agent.js";
import { MAX_DELIVERY_FAILURES } from "../../src/core/constants.js";
import { pointAlongRoute } from "../../src/core/geo.js";
import { FakeClock, KeywordClassifier, MemoryEvents, MemoryMailer, MemoryMessenger, MemoryPhone, MemorySheet, StraightRouter } from "../../src/fakes/index.js";
import type { Brief, LngLat } from "../../src/core/types.js";

// A messenger whose gateway is down for the night.
class DeadMessenger extends MemoryMessenger {
  attempts = 0;
  override async sendChat(): Promise<void> { this.attempts += 1; throw new Error("503 gateway"); }
  override async sendSms(): Promise<void> { this.attempts += 1; throw new Error("503 gateway"); }
}

const KC = { lat: 39.1, lng: -94.58 }, DSM = { lat: 41.59, lng: -93.62 };
const T0 = Date.UTC(2026, 8, 6, 11, 10), MIN = 60_000, t = (m: number) => T0 + m * MIN;
const brief: Brief = {
  loadRef: "W-19", origin: { name: "Kansas City, MO", ...KC }, destination: { name: "Des Moines, IA", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: t(245), driverName: "Jake", driverPhone: "+15550001", customerEmail: null, minutesSinceBreakAtDepart: 0,
};

describe("delivery-failure budget", () => {
  let clock: FakeClock, messenger: DeadMessenger, mailer: MemoryMailer, events: MemoryEvents, agent: Agent, geometry: LngLat[];
  beforeEach(async () => {
    clock = new FakeClock(T0); messenger = new DeadMessenger(); mailer = new MemoryMailer(); events = new MemoryEvents();
    const router = new StraightRouter(60);
    geometry = (await router.route(KC, DSM, { equipment: "DryVan", departAtMs: T0 })).geometry;
    agent = new Agent({ clock, router, sheet: new MemorySheet(), messenger, phone: new MemoryPhone(), mailer, classifier: new KeywordClassifier(), events, restStops: [], landmarks: [], dispatcherEmail: "boss@x", tz: "America/Chicago" }, brief);
    await agent.start(); clock.set(T0); await agent.onAccept();
  });
  const at = (mi: number) => pointAlongRoute(geometry, mi / 179.5);
  const drive = async (a: number, b: number, mi: (m: number) => number) => { for (let m = a; m <= b; m++) { clock.set(t(m)); await agent.onPing({ atMs: t(m), ...at(mi(m)) }); } };

  it("escalates to the dispatcher after MAX_DELIVERY_FAILURES consecutive failed sends, and stops trying", async () => {
    await drive(0, 61, (m) => m);
    // Parked at mile 62: the stop rule fires at 77; each attempt fails; the
    // rung is held; retries come on the cooldown; the budget then trips.
    await drive(62, 120, () => 62);
    expect(messenger.attempts).toBe(MAX_DELIVERY_FAILURES);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toMatch(/could not reach/i);
    const failed = events.events.filter((e) => e.kind === "action" && e.evidence.failed === true);
    expect(failed).toHaveLength(MAX_DELIVERY_FAILURES);
    // No message was ever claimed sent.
    expect(events.events.some((e) => e.kind === "action" && e.evidence.kind === "message" && !e.evidence.failed)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/live/failureBudget.test.ts`
Expected: FAIL — `MAX_DELIVERY_FAILURES` is not exported (and, once it is, `attempts` keeps growing past 3 and no email is sent).

- [ ] **Step 3: The core change**

`constants.ts`, append:
```ts
/** Consecutive failed deliveries on one rung before "I could not reach him"
 *  becomes the news itself and goes to the dispatcher. Three: one is a blip,
 *  two is a pattern, three is a gateway that is down for the night. */
export const MAX_DELIVERY_FAILURES = 3;
```

`ladder.ts`: add `failures: number` to `LadderState`; `initialLadder` → `failures: 0`; `applyAction` → `failures: 0`; `applyFailure` → `failures: state.failures + 1`.

`agent.ts`, in `execute()`'s failure branch, after `this.patch({ ladders: { …, [a.key]: applyFailure(ladder, nowMs) } })` and the failed `action` event:
```ts
      const after = this.state.ladders[a.key];
      if (after.failures >= MAX_DELIVERY_FAILURES) {
        this.patch({ ladders: { ...this.state.ladders, [a.key]: { ...after, stopped: true, stoppedReason: "escalated" } }, openQuestionKey: null });
        await this.escalate(`could not reach the driver — ${after.failures} delivery failures at rung ${action.rung}`, null, a);
      }
```
(`MAX_DELIVERY_FAILURES` imported from constants.)

- [ ] **Step 4: Run to verify it passes, and that nothing in the core moved**

Run: `npx vitest run && npm run typecheck`
Expected: all previous core tests still pass (the replay's minutes unchanged — the replay's fakes never fail), the new test passes; tsc clean.

- [ ] **Step 5: Break it**

Set `MAX_DELIVERY_FAILURES = 1000` → the test fails on `attempts` (the ladder retries forever). Restore.

- [ ] **Step 6: Commit (if lifted)**

```bash
git add night-shift/src/core/constants.ts night-shift/src/core/ladder.ts night-shift/src/core/agent.ts night-shift/tests/live/failureBudget.test.ts
git commit -m "feat(night-shift): escalate after repeated delivery failures"
```

---

### Task 10: The worker, the server, the first load, and the runbook

**Files:**
- Create: `night-shift/src/live/logSheet.ts`, `night-shift/src/live/loadFile.ts`, `night-shift/src/live/server.ts`, `night-shift/src/live/worker.ts`, `night-shift/loads/test-drive.json`, `night-shift/README-live.md`
- Test: `night-shift/tests/live/loadFile.test.ts`, `night-shift/tests/live/server.test.ts`

**Interfaces:**
- `logSheet.ts`: `class LogSheet implements SheetPort` — Slice 1 has no sheet; every `writeStatus`/`appendLog` becomes a `log("info", "sheet", …)` line. Honest by name: the runbook says the sheet is the log until the Graph plan lands.
- `loadFile.ts`: `readLoad(path: string, driver: { name; phone }, nowMs: number): Brief` — zod schema `{ loadRef, origin: { name, lat, lng }, destination: { name, lat, lng }, equipment, departAt: ISO | "now", deadlineAt: ISO | "+<n>m", customerEmail?: string | null, minutesSinceBreakAtDepart?: number | null }`. `"now"` and `"+45m"` exist so a test drive does not need its clock edited every time.
- `server.ts`: `createServer(args: { registry; bus; phone; validate; publicUrl; linkSecret; clock }): express.Express` — `express.json()`, `GET /health` → `{ ok: true, trips: n }`, and the four routers mounted.
- `worker.ts`: the entry. `loadConfig()`; `twilio(sid, token)`; `nodemailer.createTransport({ host, port, secure: port === 465, auth })`; `new MapboxRouter()`; `new TwilioPhone(client, from, publicUrl)`; `validate = (sig, url, params) => twilio.validateRequest(authToken, sig, url, params)`; a `Registry` whose `build()` makes, per trip, `PrismaEvents` (after `createTrip`), `TwilioMessenger`, `SmtpMailer`, and looks up `restStopsNear` from a first `router.route()` (cached, so the agent's own routing call is free); starts the server on `config.port`; starts the load from `process.argv[2]`; `setInterval(() => registry.tickAll(), 60_000)`; on SIGINT logs and exits. Startup logs the driver link once so the runbook can say "open it on the phone if the SMS is late".

- [ ] **Step 1: Write the failing tests**

`night-shift/tests/live/loadFile.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLoad } from "../../src/live/loadFile.js";

const write = (obj: unknown): string => { const p = join(mkdtempSync(join(tmpdir(), "ns-")), "load.json"); writeFileSync(p, JSON.stringify(obj)); return p; };
const driver = { name: "Trajce", phone: "+38970000000" };
const base = { loadRef: "T-01", origin: { name: "Skopje", lat: 41.99, lng: 21.43 }, destination: { name: "Tetovo", lat: 42.01, lng: 20.97 }, equipment: "DryVan" };

describe("readLoad", () => {
  it("resolves 'now' and '+45m' against the worker's clock", () => {
    const b = readLoad(write({ ...base, departAt: "now", deadlineAt: "+45m" }), driver, 1_000_000);
    expect(b.departAtMs).toBe(1_000_000);
    expect(b.deadlineAtMs).toBe(1_000_000 + 45 * 60_000);
    expect(b.driverPhone).toBe("+38970000000");
    expect(b.customerEmail).toBeNull();
    expect(b.minutesSinceBreakAtDepart).toBeNull();
  });

  it("takes ISO times and explicit hours when given", () => {
    const b = readLoad(write({ ...base, departAt: "2026-09-07T06:10:00+02:00", deadlineAt: "2026-09-07T10:15:00+02:00", customerEmail: "ops@c.example", minutesSinceBreakAtDepart: 370 }), driver, 0);
    expect(b.departAtMs).toBe(Date.parse("2026-09-07T06:10:00+02:00"));
    expect(b.customerEmail).toBe("ops@c.example");
    expect(b.minutesSinceBreakAtDepart).toBe(370);
  });

  it("refuses a load whose deadline is not after its departure, by name", () => {
    expect(() => readLoad(write({ ...base, departAt: "now", deadlineAt: "+0m" }), driver, 1)).toThrow(/deadlineAt/);
  });
});
```

`night-shift/tests/live/server.test.ts`:
```ts
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ChatBus } from "../../src/live/chatBus.js";
import { Registry } from "../../src/live/registry.js";
import { createServer } from "../../src/live/server.js";
import { TwilioPhone } from "../../src/live/twilioPhone.js";

describe("createServer", () => {
  it("answers health with the number of live trips and mounts every router", async () => {
    const reg = new Registry(() => ({ start: vi.fn(async () => {}), tick: vi.fn(async () => {}), state: { status: "invited" } }) as never);
    const app = createServer({ registry: reg, bus: new ChatBus(), phone: new TwilioPhone({ calls: { create: vi.fn(async () => ({ sid: "x" })) } }, "+1", "https://x.example"), validate: () => true, publicUrl: "https://x.example", linkSecret: "secret-secret-secret", clock: () => 1 });
    const h = await request(app).get("/health");
    expect(h.body).toEqual({ ok: true, trips: 0 });
    expect((await request(app).get("/d/nope")).status).toBe(404);
    expect((await request(app).get("/act/nope")).status).toBe(403);
    expect((await request(app).post("/twilio/sms").type("form").send({})).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/live/loadFile.test.ts tests/live/server.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write logSheet.ts and loadFile.ts**

`night-shift/src/live/logSheet.ts`:
```ts
// There is no sheet in the first live run. The agent still "writes" — to the
// log, under the name it will use on SharePoint — so the runbook can show
// what the row would say, and nothing pretends a write happened elsewhere.
import type { AgentEvent } from "../core/types.js";
import type { SheetPort } from "../ports/index.js";
import { log } from "./log.js";

export class LogSheet implements SheetPort {
  async writeStatus(loadRef: string, cells: Record<string, string>): Promise<void> {
    log("info", "sheet row (no sheet configured — logged)", { loadRef, ...cells });
  }
  async appendLog(loadRef: string, event: AgentEvent): Promise<void> {
    log("info", "sheet log", { loadRef, kind: event.kind, actionTaken: event.actionTaken ?? null });
  }
}
```

`night-shift/src/live/loadFile.ts`:
```ts
// A load from a JSON file, for the runs before the sheet exists. "now" and
// "+45m" are conveniences for a test drive; a real load carries ISO times.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Brief } from "../core/types.js";

const place = z.object({ name: z.string().min(1), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const when = z.union([z.literal("now"), z.string().regex(/^\+\d+m$/), z.string().datetime({ offset: true })]);
const schema = z.object({
  loadRef: z.string().min(1),
  origin: place,
  destination: place,
  equipment: z.string().min(1),
  departAt: when,
  deadlineAt: when,
  customerEmail: z.string().email().nullable().optional(),
  minutesSinceBreakAtDepart: z.number().int().min(0).nullable().optional(),
});

function resolve(v: string, nowMs: number): number {
  if (v === "now") return nowMs;
  const rel = /^\+(\d+)m$/.exec(v);
  if (rel) return nowMs + Number(rel[1]) * 60_000;
  return Date.parse(v);
}

export function readLoad(path: string, driver: { name: string; phone: string }, nowMs: number): Brief {
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error("load file is invalid — " + parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; "));
  const l = parsed.data;
  const departAtMs = resolve(l.departAt, nowMs);
  const deadlineAtMs = resolve(l.deadlineAt, nowMs);
  if (!(deadlineAtMs > departAtMs)) throw new Error("load file is invalid — deadlineAt must be after departAt");
  return {
    loadRef: l.loadRef, origin: l.origin, destination: l.destination, equipment: l.equipment,
    departAtMs, deadlineAtMs, driverName: driver.name, driverPhone: driver.phone,
    customerEmail: l.customerEmail ?? null, minutesSinceBreakAtDepart: l.minutesSinceBreakAtDepart ?? null,
  };
}
```

- [ ] **Step 4: Write server.ts and worker.ts**

`night-shift/src/live/server.ts`:
```ts
import express, { type Express } from "express";
import { actionsRouter } from "./actions.js";
import type { ChatBus } from "./chatBus.js";
import { driverLinkRouter } from "./driverLink.js";
import type { Registry } from "./registry.js";
import type { TwilioPhone } from "./twilioPhone.js";
import { twilioSmsRouter, twilioVoiceRouter, type Validate } from "./twilioWebhooks.js";

export function createServer(args: { registry: Registry; bus: ChatBus; phone: TwilioPhone; validate: Validate; publicUrl: string; linkSecret: string; clock: () => number }): Express {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.get("/health", (_req, res) => { res.json({ ok: true, trips: args.registry.all().length }); });
  app.use(driverLinkRouter(args.registry, args.bus, args.clock));
  app.use(actionsRouter(args.registry, args.linkSecret, args.clock));
  app.use(twilioSmsRouter(args.registry, args.validate, args.publicUrl, args.clock));
  app.use(twilioVoiceRouter(args.phone, args.validate, args.publicUrl));
  return app;
}
```

`night-shift/src/live/worker.ts`:
```ts
// The night shift, running. One process: the HTTP server the driver's page
// and Twilio talk to, and a one-minute tick over every live trip.
import nodemailer from "nodemailer";
import twilio from "twilio";
import { Agent } from "../core/agent.js";
import { KeywordClassifier } from "../fakes/index.js";
import { ChatBus } from "./chatBus.js";
import { loadConfig } from "./config.js";
import { readLoad } from "./loadFile.js";
import { log } from "./log.js";
import { LogSheet } from "./logSheet.js";
import { MapboxRouter } from "./mapboxRouter.js";
import { PrismaEvents } from "./prismaEvents.js";
import { restStopsNear } from "./prismaRestStops.js";
import { Registry } from "./registry.js";
import { createServer } from "./server.js";
import { SmtpMailer } from "./smtpMailer.js";
import { newDriverToken, newTripId } from "./tokens.js";
import { TwilioMessenger } from "./twilioMessenger.js";
import { TwilioPhone } from "./twilioPhone.js";

const TICK_MS = 60_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const loadPath = process.argv[2];
  if (!loadPath) throw new Error("usage: npm run night:start -- loads/<load>.json");

  const clock = { nowMs: () => Date.now() };
  const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
  const transport = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465, auth: { user: config.smtp.user, pass: config.smtp.pass } });
  const router = new MapboxRouter();
  const phone = new TwilioPhone(twilioClient, config.twilio.fromNumber, config.publicUrl);
  const bus = new ChatBus();
  const validate = (sig: string, url: string, params: Record<string, string>): boolean => twilio.validateRequest(config.twilio.authToken, sig, url, params);

  const registry = new Registry((trip) => {
    const events = new PrismaEvents(trip.tripId);
    return new Agent(
      {
        clock, router, sheet: new LogSheet(), phone, events, classifier: new KeywordClassifier(),
        messenger: new TwilioMessenger(twilioClient, config.twilio.fromNumber, bus, trip, config.publicUrl, clock.nowMs),
        mailer: new SmtpMailer(transport, config.smtp.from, { dispatcherEmail: config.dispatcherEmail, publicUrl: config.publicUrl, linkSecret: config.linkSecret, tripId: trip.tripId, clock: clock.nowMs }),
        restStops: trip.restStops, landmarks: [], dispatcherEmail: config.dispatcherEmail, tz: config.tz,
      },
      trip.brief,
    );
  });

  const app = createServer({ registry, bus, phone, validate, publicUrl: config.publicUrl, linkSecret: config.linkSecret, clock: clock.nowMs });
  await new Promise<void>((resolve) => app.listen(config.port, resolve));
  log("info", "night-shift worker listening", { port: config.port, publicUrl: config.publicUrl });

  const brief = readLoad(loadPath, config.driver, clock.nowMs());
  // Registered stops near the road: route once here (cached in RouteDistance,
  // so the agent's own routing call inside start() costs nothing more).
  const route = await router.route(brief.origin, brief.destination, { equipment: brief.equipment, departAtMs: brief.departAtMs });
  const restStops = await restStopsNear(route.geometry, null);
  log("info", "route resolved", { loadRef: brief.loadRef, miles: Math.round(route.distanceMi), driveMin: Math.round(route.driveMin), registeredStopsNearby: restStops.length });

  // The trip row exists before the agent starts: its first event is written
  // during start(), and that event needs a trip to belong to.
  const ids = { tripId: newTripId(), driverToken: newDriverToken() };
  await PrismaEvents.createTrip({ tripId: ids.tripId, loadRef: brief.loadRef, driverToken: ids.driverToken, brief });
  const trip = await registry.start(brief, ids, { restStops });
  log("info", "driver link", { url: config.publicUrl + "/d/" + trip.driverToken, status: trip.agent.state.status });

  setInterval(() => { void registry.tickAll(); }, TICK_MS);
  process.on("SIGINT", () => { log("info", "night-shift worker stopping"); process.exit(0); });
}

main().catch((e) => {
  log("error", "night-shift worker failed to start", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
```
The worker resolves the route once before the trip starts so the registered stops can be looked up; the agent's own routing call inside `start()` hits the `RouteDistance` cache and costs nothing more.

- [ ] **Step 5: The first load and the runbook**

`night-shift/loads/test-drive.json` — change the coordinates to the tester's own doorstep and a point 20–40 minutes away before running:
```json
{
  "loadRef": "T-01",
  "origin": { "name": "Skopje", "lat": 41.9981, "lng": 21.4254 },
  "destination": { "name": "Tetovo", "lat": 42.0100, "lng": 20.9715 },
  "equipment": "DryVan",
  "departAt": "now",
  "deadlineAt": "+60m",
  "customerEmail": null,
  "minutesSinceBreakAtDepart": null
}
```

`night-shift/README-live.md`:
```markdown
# Night shift — first live run

## Before the first run (once)
1. `npm install` in `night-shift/`.
2. Fill `night-shift/.env` (copy `.env.example`). Twilio SID/token/number, Gmail user + App Password, your phone as DRIVER_PHONE, your inbox as DISPATCHER_EMAIL. MAPBOX_TOKEN and LINK_SECRET are already filled.
3. In the Twilio console, enable Geo Permissions for your driver's country under Messaging → Settings and Voice → Settings.
4. `cd fleet-backend && npx prisma migrate deploy` (the AgentTrip/AgentEvent tables).

## Every run
1. Terminal A: `npm run night:tunnel` — copy the `https://….trycloudflare.com` URL it prints.
2. Put it in `.env` as `PUBLIC_URL=` (no trailing slash). The tunnel URL changes every time you start it.
3. Twilio console → your number → Messaging → "A message comes in": Webhook, `https://….trycloudflare.com/twilio/sms`, HTTP POST. (Voice needs no console setting — the worker tells Twilio what to say per call.)
4. Edit `loads/test-drive.json`: origin = where you are, destination = 20–40 minutes away, `deadlineAt` tight enough to be late if you dawdle.
5. Terminal B: `npm run night:start -- loads/test-drive.json`. It prints the driver link; your phone gets it by SMS within seconds.

## What you will see
- Phone: the SMS with the link → tap → **Accept** → "Sharing location · last sent HH:MM". Leave the tab open in the foreground; iOS suspends background tabs and the agent will honestly report *gone dark*.
- Drive. Stop somewhere for 15 minutes → the page shows *"You've been stopped 15 min near …, everything OK?"* Reply in the box (or by SMS to the Twilio number) — "bathroom" → *"Got it, thanks."*
- Ignore the next question → 10 min later it asks again → 15 min later **your phone rings** and the agent speaks. Say anything, or don't answer.
- Your inbox: the escalation email with the whole ladder and a one-click link. Tap it: the customer email goes (to the address in the load, or nowhere if null).
- Arrive: on time → nothing more; late → an email to you with the arrival note drafted.
- Terminal B: every event as a JSON line; the "sheet row" lines are what the SharePoint row will say once that plan lands.

## Known limits of this slice
- No sheet: rows go to the log. Next plan.
- Chat is in memory: restarting the worker loses undelivered chat (the event log still has it).
- A voice call blocks that trip's tick for up to 90 s. One trip at a time is the design point here.
- The tunnel URL changes per run and Twilio's SMS webhook must be updated to match. A fixed hostname is a hosting decision.
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run && npm run typecheck`
Expected: the whole package green (core + live); tsc clean. Then, with `.env` complete and the tunnel up: `npm run night:start -- loads/test-drive.json` prints `night-shift worker listening`, `route resolved`, and `driver link`, and the SMS arrives.

- [ ] **Step 7: Commit (if lifted)**

```bash
git add night-shift/src/live/logSheet.ts night-shift/src/live/loadFile.ts night-shift/src/live/server.ts night-shift/src/live/worker.ts night-shift/loads/test-drive.json night-shift/README-live.md night-shift/tests/live/loadFile.test.ts night-shift/tests/live/server.test.ts
git commit -m "feat(night-shift): live worker, first load, runbook"
```

---

## Self-review

**Spec coverage.** §4 invite/accept/tracking → Tasks 5–6 (link, SMS, pings). §7 ladder → core unchanged; Task 9 adds the failure budget the live gateways need. §8 emails → Task 7 (SMTP + signed one-click); the sheet → `LogSheet` by name, deferred to the Graph plan; the morning briefing → Briefing plan. §10 voice → Task 8 (Polly en-US, `<Gather input="speech">`, confidence to the core's floor). §11 honesty → every adapter throws on failure rather than reporting success; the log sheet is named as a log; a call not placed is a failed delivery. §12 data → Task 2 (AgentTrip/AgentEvent). §15 → `readLoad` supplies what the sheet will.

**Placeholders.** None; every file's code is in its task.

**Type consistency.** `MessengerPort`, `PhonePort` (`CallOutcome` with `confidence`), `MailerPort` (`{ messageId }`), `RouterPort` (`opts: { equipment; departAtMs }`), `SheetPort`, `EventStore` — all as the core's `ports/index.ts` defines them after the final fix wave. `Registry.start(brief, ids)` gains an `extras` argument in Task 10; Task 4's tests pass `ids` only and still hold. `Validate` is defined once in `twilioWebhooks.ts` and imported by `server.ts`.

**Follow-on plans, in order:** Sheet adapter (Microsoft Graph, replaces `LogSheet`, starts loads from rows); Briefing (morning email from the event log, the rest of the reply vocabulary, scheduled customer status); Library (LLM classifier behind the same floor, the supervised loop); Hosting (a fixed hostname, the worker as a service, restart-recovery from `AgentTrip`).
