# Night-Shift Agent — Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent's brain — plan, detection, situation library, escalation ladder and event log — with every external system behind a port and an in-memory fake, proven end to end by the spec's Kansas City → Des Moines replay running as a test.

**Architecture:** A new `night-shift/` package beside `fleet-backend/` and `fleet-portal/`. Pure domain logic (`src/core`) that imports the existing router-agnostic domain modules from `fleet-backend` (HOS, break geometry, dwell segments, haversine) through one bridge file so the rules live once. All I/O — sheet, messenger, phone, mailer, classifier, router, clock — is a port (`src/ports`) with an in-memory fake (`src/fakes`). The agent (`src/core/agent.ts`) is a loop over events. Real adapters (Microsoft Graph, SMS link, Twilio, email, LLM classifier, Mapbox) are separate follow-on plans.

**Tech Stack:** Node 22, TypeScript ESM (`.js` import specifiers), Vitest. No database, no network, no LLM in this plan.

**Spec:** `docs/superpowers/specs/2026-09-06-night-shift-agent-design.md` — sections 3–7, 9, 11–13 are implemented here; 4 (real invite/accept), 8 (real writes/emails), 10 (real call) get ports and fakes only.

## Global Constraints

- **Rules decide, the model speaks** (spec §3): no language model anywhere in this plan. Anomalies, rungs, levels and states are deterministic code with named thresholds.
- **Every threshold is a named constant in `src/core/constants.ts` with the reason beside it** (spec §6). No literal numbers in rule code.
- **Honesty rules** (spec §11): a measurement is a measurement, a quote is a quote, no answer is "no answer", unknown stays unknown. No event may carry a claim without evidence.
- **Every `AgentEvent` carries `evidence`** — the ping, the minutes, the threshold that fired (spec §12). The event log is append-only.
- **The break exemption is load-bearing** (spec §6): a stop inside the mandatory-break window at a registered rest area produces no anomaly and no message.
- **One open question at a time** toward the driver (spec §7). A reply stops the ladder for that anomaly.
- **American English only** in every template (spec, header).
- Geometry convention: route polylines are `[lng, lat]` pairs, matching `fleet-backend`'s Mapbox geometry. Points elsewhere are `{ lat, lng }`.
- Coding conventions of the repo: immutable updates, small files, no `console.log` in library code, tests prove they discriminate (a "break it" step per rule).
- **No commits** unless the human partner has lifted the standing no-commit rule for this branch. Every task's commit step is conditional on that; when not lifted, stop at the passing test.

---

## File Structure

```
night-shift/
  package.json            workspace member; scripts test/typecheck; deps: vitest, tsx, typescript
  tsconfig.json           ES2022 / Bundler, noEmit, includes ../fleet-backend/src/domain
  vitest.config.ts
  src/
    domain.ts             THE bridge: re-exports from fleet-backend's pure domain modules
    core/
      types.ts            Brief, Plan, Ping, Anomaly, Situation, DriverReply, AgentEvent, TripState
      constants.ts        every threshold, named, with its reason
      geo.ts              pointAlongRoute, projectOntoRoute (vertex-based), routeMiles
      plan.ts             buildPlan, planLinePoint, liveEtaMs, minutesBehindPlan
      detect.ts           detectUnplannedStop, detectDelay, detectGoneDark, detectOffRoute, detectAnomalies
      situations.ts       the library table + situationFor(key)
      ladder.ts           rung state machine: nextAction, applyAction, stopForReply
      agent.ts            the loop: onPing / onReply / tick; owns TripState and the event log
    ports/
      index.ts            Clock, RouterPort, SheetPort, MessengerPort, PhonePort, MailerPort, ClassifierPort, EventStore
    fakes/
      index.ts            FakeClock, StraightRouter, MemorySheet, MemoryMessenger, MemoryPhone, MemoryMailer, KeywordClassifier, MemoryEvents
    replay/
      kcDesMoines.ts      the spec §13 scenario as data
      run.ts              runs a scenario through Agent with the fakes; returns the event log
  tests/
    bridge.test.ts, plan.test.ts, detect-stop.test.ts, detect-other.test.ts,
    situations.test.ts, ladder.test.ts, agent.test.ts, replay.test.ts
```

---

### Task 1: Package scaffold and the domain bridge

**Files:**
- Create: `night-shift/package.json`, `night-shift/tsconfig.json`, `night-shift/vitest.config.ts`, `night-shift/src/domain.ts`
- Test: `night-shift/tests/bridge.test.ts`

**Interfaces:**
- Produces: `src/domain.ts` re-exports `dwellSegments`, `DWELL_RADIUS_MI`, `DwellSegment`, `breaksRequired`, `BREAK_THRESHOLD_MIN`, `BREAK_DURATION_MIN`, `interpolate`, `haversineMi`. Every later task imports domain logic ONLY through this file.

- [ ] **Step 1: Create the package files**

`night-shift/package.json`:
```json
{
  "name": "night-shift",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`night-shift/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "tests", "../fleet-backend/src/domain"]
}
```

`night-shift/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
```

- [ ] **Step 2: Write the failing bridge test**

`night-shift/tests/bridge.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { breaksRequired, dwellSegments, haversineMi, interpolate, BREAK_THRESHOLD_MIN } from "../src/domain.js";

// The bridge is the ONLY path to fleet-backend's domain code. If it breaks,
// every rule in this package silently loses the definitions it shares with
// the dispatch platform, and "one definition per concept" becomes two.
describe("domain bridge", () => {
  it("reaches the HOS rule that dispatch already uses", () => {
    expect(BREAK_THRESHOLD_MIN).toBe(480);
    expect(breaksRequired(0, 500)).toBe(1);
  });

  it("reaches haversine and interpolate", () => {
    const a = { lat: 39.1, lng: -94.58 };
    const b = { lat: 41.59, lng: -93.62 };
    expect(haversineMi(a, b)).toBeGreaterThan(170);
    const mid = interpolate(a, b, 0.5);
    expect(mid.lat).toBeCloseTo((a.lat + b.lat) / 2, 1);
  });

  it("reaches dwellSegments", () => {
    const c = { lat: 40, lng: -94 };
    const segs = dwellSegments([{ atMs: 0, lat: 40, lng: -94 }, { atMs: 600_000, lat: 40, lng: -94 }], c);
    expect(segs[0].observedMin).toBe(10);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run (from `night-shift/`): `npm install && npx vitest run tests/bridge.test.ts`
Expected: FAIL — `Cannot find module '../src/domain.js'`

- [ ] **Step 4: Write the bridge**

`night-shift/src/domain.ts`:
```ts
// The one door into fleet-backend's domain logic.
//
// The agent's differentiator — telling a legal break from an unplanned stop,
// pricing a route on real road — IS the dispatch platform's domain code. It is
// imported, never copied: a copy is a second definition, and this codebase has
// paid for that mistake repeatedly. Every other file in this package imports
// domain functions from here and nowhere else, so if the path ever moves it
// moves in one place.
//
// Only PURE modules are bridged. Nothing here may pull in prisma, express or
// a network client; the core must run in a test with no environment at all.
export {
  dwellSegments,
  DWELL_RADIUS_MI,
  type DwellSegment,
} from "../../fleet-backend/src/domain/dwell/segments.js";
export {
  breaksRequired,
  BREAK_THRESHOLD_MIN,
  BREAK_DURATION_MIN,
} from "../../fleet-backend/src/domain/dispatch/hos.js";
export { interpolate } from "../../fleet-backend/src/domain/dispatch/breakGeo.js";
export { haversineMi } from "../../fleet-backend/src/domain/dispatch/distance.js";
```

- [ ] **Step 5: Run to verify it passes, and typecheck**

Run: `npx vitest run tests/bridge.test.ts && npm run typecheck`
Expected: 3 passed; tsc clean. If tsc complains about files outside `rootDir`, remove any `rootDir` (there is none above) — `include` of the sibling path is intentional.

- [ ] **Step 6: Commit (only if the no-commit rule is lifted)**

```bash
git add night-shift/package.json night-shift/tsconfig.json night-shift/vitest.config.ts night-shift/src/domain.ts night-shift/tests/bridge.test.ts
git commit -m "feat(night-shift): package scaffold and domain bridge"
```

---

### Task 2: Types and constants

**Files:**
- Create: `night-shift/src/core/types.ts`, `night-shift/src/core/constants.ts`
- Test: `night-shift/tests/constants.test.ts`

**Interfaces:**
- Produces every shared type below, used verbatim by Tasks 3–9.

- [ ] **Step 1: Write the failing test**

`night-shift/tests/constants.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import * as C from "../src/core/constants.js";

// Thresholds are product decisions from the spec. Pinning them here means a
// "tune" is a deliberate edit to two files, not a drive-by.
describe("constants", () => {
  it("match the spec's detection thresholds", () => {
    expect(C.STOP_MIN).toBe(15);
    expect(C.PLANNED_STOP_RADIUS_MI).toBe(0.5);
    expect(C.BREAK_WINDOW_SLACK_MIN).toBe(45);
    expect(C.DELAY_BEHIND_PLAN_MIN).toBe(30);
    expect(C.DARK_MIN).toBe(20);
    expect(C.DARK_AT_STOP_MIN).toBe(60);
    expect(C.OFF_ROUTE_MI).toBeCloseTo(3.1, 1);
    expect(C.OFF_ROUTE_MIN).toBe(10);
  });
  it("match the spec's ladder cooldowns", () => {
    expect(C.RUNG1_COOLDOWN_MIN).toBe(10);
    expect(C.RUNG2_COOLDOWN_MIN).toBe(15);
    expect(C.CALL_RETRY_MIN).toBe(5);
    expect(C.LINK_UNOPENED_SMS_MIN).toBe(30);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/constants.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write types and constants**

`night-shift/src/core/types.ts`:
```ts
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Route polyline as [lng, lat] pairs — the same convention as fleet-backend's
 *  Mapbox geometry, so a line drawn there and a plan computed here agree. */
export type LngLat = [number, number];

export interface Place extends GeoPoint {
  name: string;
}

/** Everything the sheet row says. Nothing is inferred; a missing required
 *  cell puts the trip in `attention` (spec §4). */
export interface Brief {
  loadRef: string;
  origin: Place;
  destination: Place;
  equipment: string;
  departAtMs: number;
  deadlineAtMs: number;
  driverName: string;
  driverPhone: string;
  customerEmail: string | null;
  /** Minutes already driven on the driver's clock at departure, from the
   *  platform's HOS state. `null` when the platform has no hours for this
   *  driver — NOT 0. Zero is a measurement ("fresh clock"); null makes the
   *  plan say "hours unknown" and plan no break rather than invent one. */
  minutesSinceBreakAtDepart: number | null;
}

export interface RouteAnswer {
  geometry: LngLat[];
  distanceMi: number;
  driveMin: number;
}

export interface RestStop extends Place {}

export interface BreakWindow {
  /** the drive-minute (from departure, excluding stops) the break is due */
  atDriveMin: number;
  /** where along the route that minute falls */
  at: GeoPoint;
  /** wall-clock window the break is accepted in: due ± BREAK_WINDOW_SLACK_MIN */
  startMs: number;
  endMs: number;
  recommended: RestStop | null;
}

export interface Plan {
  route: RouteAnswer;
  departAtMs: number;
  deadlineAtMs: number;
  plannedStops: Place[];
  breakWindow: BreakWindow | null;
  /** False when the brief carried no hours for the driver. Then breakWindow
   *  is null because nothing could be planned — not because no break is due —
   *  and the ETA excludes any break. Everything that speaks must say so. */
  hosKnown: boolean;
  /** departure + drive + required breaks */
  etaAtMs: number;
}

export interface Ping extends GeoPoint {
  atMs: number;
}

export type AnomalyKind = "unplanned_stop" | "delay" | "gone_dark" | "off_route";

export interface Anomaly {
  kind: AnomalyKind;
  /** stable id so the same underlying situation is not raised twice */
  key: string;
  atMs: number;
  evidence: Record<string, unknown>;
}

export type Level = 0 | 1 | 2 | 3;

export interface Situation {
  key: string;
  level: Level;
  /** what the agent says back to the driver, en-US */
  response: string;
  /** what the dispatcher is told, en-US */
  dispatcherNote: string;
  /** phrasings the keyword classifier matches on */
  examples: string[];
}

export type Channel = "chat" | "sms" | "call";

export interface DriverReply {
  atMs: number;
  channel: Channel;
  rawText: string;
}

export type EventKind = "ping" | "plan" | "anomaly" | "action" | "reply" | "escalation" | "sheet_write" | "email" | "call";

export interface AgentEvent {
  atMs: number;
  kind: EventKind;
  evidence: Record<string, unknown>;
  actionTaken?: string;
}

export type TripStatus = "assigned" | "invited" | "accepted" | "tracking" | "arrived" | "closed" | "attention";
```

`night-shift/src/core/constants.ts`:
```ts
// Every threshold the rules use, named, with the reason it has that value.
// Rule code contains no literal numbers; a tune is an edit here and in
// tests/constants.test.ts, deliberately.

/** Stationary this long, away from any planned stop, is a question. Shorter
 *  is traffic, a light, a weigh station. */
export const STOP_MIN = 15;
/** "At" a planned stop means inside this fence — matches DWELL_RADIUS_MI. */
export const PLANNED_STOP_RADIUS_MI = 0.5;
/** A mandatory break counts as on-plan anywhere in this window around when
 *  it is due. Drivers stop early for a good spot or late for a bad one. */
export const BREAK_WINDOW_SLACK_MIN = 45;
/** A rest stop is "the one on the plan" if within this of the break point. */
export const REST_STOP_SEARCH_MI = 35;

/** Behind the plan line by this much is a delay even if the deadline is
 *  still safe — it says the plan's assumptions are broken. */
export const DELAY_BEHIND_PLAN_MIN = 30;

/** No ping for this long while tracking is "gone dark". */
export const DARK_MIN = 20;
/** ...unless the last ping was at a stop; a phone indoors loses GPS. */
export const DARK_AT_STOP_MIN = 60;

/** 5 km, the spec's off-route distance, in the miles everything else uses. */
export const OFF_ROUTE_MI = 3.1;
/** Off route this long before it is raised — a detour that rejoins is noise. */
export const OFF_ROUTE_MIN = 10;

/** Ladder cooldowns (spec §7). */
export const RUNG1_COOLDOWN_MIN = 10;
export const RUNG2_COOLDOWN_MIN = 15;
export const CALL_RETRY_MIN = 5;
/** If the link has not been opened this long, rung 2 also sends an SMS. */
export const LINK_UNOPENED_SMS_MIN = 30;

/** Arrival: inside this of the destination, stationary this long. */
export const ARRIVAL_RADIUS_MI = 0.5;
export const ARRIVAL_DWELL_MIN = 5;

/** No accept by departure + this is the first escalation. */
export const ACCEPT_GRACE_MIN = 30;

/** Below this the classifier says "unknown". Unknown stays unknown. */
export const CLASSIFY_FLOOR = 0.7;

/** Milliseconds in a minute. Every rule thinks in minutes and every clock in
 *  ms; this is the one place the conversion is written. */
export const MIN_MS = 60_000;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/constants.test.ts && npm run typecheck`
Expected: 2 passed; tsc clean.

- [ ] **Step 5: Commit (if lifted)**

```bash
git add night-shift/src/core/types.ts night-shift/src/core/constants.ts night-shift/tests/constants.test.ts
git commit -m "feat(night-shift): core types and named thresholds"
```

---

### Task 3: Route geometry helpers and the plan

**Files:**
- Create: `night-shift/src/core/geo.ts`, `night-shift/src/core/plan.ts`
- Test: `night-shift/tests/plan.test.ts`

**Interfaces:**
- Consumes: `haversineMi`, `interpolate`, `breaksRequired`, `BREAK_THRESHOLD_MIN`, `BREAK_DURATION_MIN` from `src/domain.ts`; types and constants from Task 2.
- Produces:
  - `geo.ts`: `toPoint(LngLat): GeoPoint`, `cumulativeMiles(LngLat[]): number[]`, `routeMiles(LngLat[]): number`, `pointAlongRoute(LngLat[], fraction: number): GeoPoint`, `projectOntoRoute(LngLat[], GeoPoint): { alongMi: number; offRouteMi: number }`
  - `plan.ts`: `buildPlan(brief: Brief, route: RouteAnswer, restStops: RestStop[]): Plan`, `expectedAlongMi(plan, nowMs): number`, `planLinePoint(plan, nowMs): GeoPoint`, `liveEtaMs(plan, at: GeoPoint, nowMs, breakTaken: boolean): number`, `minutesBehindPlan(plan, at, nowMs): number`

`projectOntoRoute` projects onto the nearest **segment** (perpendicular foot, clamped to the segment), not the nearest vertex. Vertex snapping is off by up to half the vertex spacing, and that error lands directly in "minutes behind plan"; segment projection is exact on a straight line and accurate to well under a metre on real road geometry. Test routes are still densified to ~2 mi vertices so that a curved arc between two far-apart vertices is not mistaken for the road.

- [ ] **Step 1: Write the failing tests**

`night-shift/tests/plan.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { pointAlongRoute, projectOntoRoute, routeMiles } from "../src/core/geo.js";
import { buildPlan, expectedAlongMi, liveEtaMs, minutesBehindPlan, planLinePoint } from "../src/core/plan.js";
import type { Brief, LngLat, RouteAnswer } from "../src/core/types.js";

// Kansas City -> Des Moines, straight north-north-east, densified to one
// vertex per ~2 mi so vertex projection is meaningful.
const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
const dense = (n: number): LngLat[] =>
  Array.from({ length: n + 1 }, (_, i) => [KC.lng + ((DSM.lng - KC.lng) * i) / n, KC.lat + ((DSM.lat - KC.lat) * i) / n]);
const ROUTE: RouteAnswer = { geometry: dense(90), distanceMi: 180, driveMin: 180 }; // 60 mph flat

const T0 = Date.UTC(2026, 8, 6, 11, 10); // 06:10 Central
const brief = (over: Partial<Brief> = {}): Brief => ({
  loadRef: "W-19",
  origin: { name: "Kansas City, MO", ...KC },
  destination: { name: "Des Moines, IA", ...DSM },
  equipment: "DryVan",
  departAtMs: T0,
  deadlineAtMs: T0 + 245 * 60_000, // 10:15
  driverName: "Jake Morrow",
  driverPhone: "+15550001",
  customerEmail: null,
  minutesSinceBreakAtDepart: 0,
  ...over,
});
const MIN = 60_000;

describe("geo", () => {
  it("measures the route and walks along it", () => {
    expect(routeMiles(ROUTE.geometry)).toBeCloseTo(179.5, 0);
    const half = pointAlongRoute(ROUTE.geometry, 0.5);
    expect(half.lat).toBeCloseTo((KC.lat + DSM.lat) / 2, 2);
  });
  it("projects a point to miles-along and miles-off", () => {
    const p = projectOntoRoute(ROUTE.geometry, pointAlongRoute(ROUTE.geometry, 0.25));
    expect(p.alongMi).toBeCloseTo(routeMiles(ROUTE.geometry) * 0.25, 0);
    expect(p.offRouteMi).toBeLessThan(0.1);
    const off = projectOntoRoute(ROUTE.geometry, { lat: 40.3, lng: -95.5 });
    expect(off.offRouteMi).toBeGreaterThan(40);
  });
});

describe("buildPlan", () => {
  it("needs no break for a short run on a fresh clock", () => {
    const p = buildPlan(brief(), ROUTE, []);
    expect(p.breakWindow).toBeNull();
    expect(p.hosKnown).toBe(true);
    expect(p.etaAtMs).toBe(T0 + 180 * MIN);
  });

  it("plans NO break when the driver's hours are unknown, and says so", () => {
    // Null is not zero. A fresh clock is a measurement; no clock is an
    // absence, and inventing a break from it — or omitting one silently — is
    // how the agent ends up nagging a driver on his legal 30.
    const p = buildPlan(brief({ minutesSinceBreakAtDepart: null }), ROUTE, []);
    expect(p.hosKnown).toBe(false);
    expect(p.breakWindow).toBeNull();
    expect(p.etaAtMs).toBe(T0 + 180 * MIN);
  });

  it("places the mandatory break where the 8-hour mark falls, and adds 30 to the ETA", () => {
    // 6h10 already driven: the 480-min mark lands 110 min into this run.
    const p = buildPlan(brief({ minutesSinceBreakAtDepart: 370 }), ROUTE, []);
    expect(p.breakWindow?.atDriveMin).toBe(110);
    expect(p.breakWindow?.startMs).toBe(T0 + (110 - 45) * MIN);
    expect(p.breakWindow?.endMs).toBe(T0 + (110 + 45) * MIN);
    expect(p.etaAtMs).toBe(T0 + 210 * MIN);
  });

  it("recommends the nearest registered rest stop within range, or none", () => {
    const at = pointAlongRoute(ROUTE.geometry, 110 / 180);
    const nearStop = { name: "Love's I-35", lat: at.lat + 0.02, lng: at.lng };
    const farStop = { name: "Far away", lat: at.lat + 2, lng: at.lng };
    expect(buildPlan(brief({ minutesSinceBreakAtDepart: 370 }), ROUTE, [farStop, nearStop]).breakWindow?.recommended?.name).toBe("Love's I-35");
    expect(buildPlan(brief({ minutesSinceBreakAtDepart: 370 }), ROUTE, [farStop]).breakWindow?.recommended).toBeNull();
  });
});

describe("plan line and ETA", () => {
  const p = buildPlan(brief({ minutesSinceBreakAtDepart: 370 }), ROUTE, []);

  it("expects 60 miles covered after 60 minutes at 60 mph", () => {
    expect(expectedAlongMi(p, T0 + 60 * MIN)).toBeCloseTo(60, 0);
    expect(expectedAlongMi(p, T0 - 5 * MIN)).toBe(0);
  });

  it("holds the plan line still during the break", () => {
    // Minute 110 to 140 is the break: the truck is not expected to move.
    expect(expectedAlongMi(p, T0 + 125 * MIN)).toBeCloseTo(expectedAlongMi(p, T0 + 110 * MIN), 5);
    expect(expectedAlongMi(p, T0 + 150 * MIN)).toBeCloseTo(120, 0);
  });

  it("live ETA at the start equals the plan's ETA", () => {
    expect(liveEtaMs(p, KC, T0, false)).toBeCloseTo(p.etaAtMs, -3);
  });

  it("live ETA drops the break once it has been taken", () => {
    const at = pointAlongRoute(ROUTE.geometry, 0.5);
    const before = liveEtaMs(p, at, T0 + 100 * MIN, false);
    const after = liveEtaMs(p, at, T0 + 100 * MIN, true);
    expect(before - after).toBe(30 * MIN);
  });

  it("credits break time already taken — sixteen minutes in, fourteen are owed", () => {
    // Found by the replay: charging a driver the whole thirty while he is
    // sixteen minutes into it pushed the ETA past the deadline mid-break, and
    // the agent messaged him during the stop the plan required.
    const at = pointAlongRoute(ROUTE.geometry, 0.5);
    const full = liveEtaMs(p, at, T0 + 100 * MIN, false);
    const partial = liveEtaMs(p, at, T0 + 100 * MIN, false, 16);
    expect(full - partial).toBe(16 * MIN);
    // Over-crediting can never make the ETA earlier than the drive itself.
    expect(liveEtaMs(p, at, T0 + 100 * MIN, false, 45)).toBe(liveEtaMs(p, at, T0 + 100 * MIN, true));
  });

  it("reports minutes behind the plan line", () => {
    const at40 = pointAlongRoute(ROUTE.geometry, 40 / 180);
    expect(minutesBehindPlan(p, at40, T0 + 60 * MIN)).toBeCloseTo(20, 0);
    expect(minutesBehindPlan(p, pointAlongRoute(ROUTE.geometry, 70 / 180), T0 + 60 * MIN)).toBeCloseTo(-10, 0);
    expect(planLinePoint(p, T0 + 60 * MIN).lat).toBeCloseTo(at40.lat + (DSM.lat - KC.lat) * (20 / 180), 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/plan.test.ts`
Expected: FAIL — cannot find module `../src/core/geo.js`.

- [ ] **Step 3: Write geo.ts**

`night-shift/src/core/geo.ts`:
```ts
import { haversineMi, interpolate } from "../domain.js";
import type { GeoPoint, LngLat } from "./types.js";

export const toPoint = (p: LngLat): GeoPoint => ({ lat: p[1], lng: p[0] });

/** Miles from the start at each vertex. Index 0 is 0. */
export function cumulativeMiles(geometry: LngLat[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < geometry.length; i += 1) {
    out.push(out[i - 1] + haversineMi(toPoint(geometry[i - 1]), toPoint(geometry[i])));
  }
  return out;
}

export function routeMiles(geometry: LngLat[]): number {
  const cum = cumulativeMiles(geometry);
  return cum[cum.length - 1] ?? 0;
}

/** The point at `fraction` (0..1) of the route's length, interpolated
 *  within the segment it falls in. Clamped: there is no "before the start". */
export function pointAlongRoute(geometry: LngLat[], fraction: number): GeoPoint {
  if (geometry.length === 0) throw new Error("pointAlongRoute: empty route");
  if (geometry.length === 1) return toPoint(geometry[0]);
  const cum = cumulativeMiles(geometry);
  const target = Math.min(1, Math.max(0, fraction)) * cum[cum.length - 1];
  for (let i = 1; i < cum.length; i += 1) {
    if (cum[i] >= target) {
      const seg = cum[i] - cum[i - 1];
      const t = seg === 0 ? 0 : (target - cum[i - 1]) / seg;
      return interpolate(toPoint(geometry[i - 1]), toPoint(geometry[i]), t);
    }
  }
  return toPoint(geometry[geometry.length - 1]);
}

/** Projection onto the nearest SEGMENT, not the nearest vertex. Snapping to
 *  a vertex is off by up to half the vertex spacing — a mile on a coarse
 *  line — and that error lands directly in "minutes behind plan". Each
 *  segment is projected in a local equirectangular frame around the point,
 *  which is accurate to well under a metre at road-segment lengths; the
 *  off-route distance is then measured properly, with haversine, to the
 *  foot of the perpendicular. */
export function projectOntoRoute(geometry: LngLat[], p: GeoPoint): { alongMi: number; offRouteMi: number } {
  if (geometry.length === 0) return { alongMi: 0, offRouteMi: Number.POSITIVE_INFINITY };
  if (geometry.length === 1) return { alongMi: 0, offRouteMi: haversineMi(toPoint(geometry[0]), p) };
  const cum = cumulativeMiles(geometry);
  const cosLat = Math.cos((p.lat * Math.PI) / 180);
  let best = { alongMi: 0, offRouteMi: Number.POSITIVE_INFINITY };
  for (let i = 1; i < geometry.length; i += 1) {
    const a = toPoint(geometry[i - 1]);
    const b = toPoint(geometry[i]);
    // Segment endpoints relative to p, in a frame where one unit is one
    // degree of latitude in both axes.
    const ax = (a.lng - p.lng) * cosLat;
    const ay = a.lat - p.lat;
    const bx = (b.lng - p.lng) * cosLat;
    const by = b.lat - p.lat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    // Parameter of p's foot on the segment, clamped to the segment itself.
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
    const foot = interpolate(a, b, t);
    const off = haversineMi(p, foot);
    if (off < best.offRouteMi) best = { alongMi: cum[i - 1] + t * (cum[i] - cum[i - 1]), offRouteMi: off };
  }
  return best;
}
```

- [ ] **Step 4: Write plan.ts**

`night-shift/src/core/plan.ts`:
```ts
// The plan: what the row implies once the road is known. Built at invite,
// consulted on every ping. Pure.
import { BREAK_DURATION_MIN, BREAK_THRESHOLD_MIN, breaksRequired, haversineMi } from "../domain.js";
import { BREAK_WINDOW_SLACK_MIN, MIN_MS, REST_STOP_SEARCH_MI } from "./constants.js";
import { pointAlongRoute, projectOntoRoute } from "./geo.js";
import type { Brief, BreakWindow, GeoPoint, Plan, RestStop, RouteAnswer } from "./types.js";

function nearestRestStop(at: GeoPoint, stops: RestStop[]): RestStop | null {
  let best: { stop: RestStop; mi: number } | null = null;
  for (const stop of stops) {
    const mi = haversineMi(at, stop);
    if (mi <= REST_STOP_SEARCH_MI && (!best || mi < best.mi)) best = { stop, mi };
  }
  return best?.stop ?? null;
}

export function buildPlan(brief: Brief, route: RouteAnswer, restStops: RestStop[]): Plan {
  // The platform's own HOS rule decides whether a break is due on this run.
  // With no hours on file there is nothing to decide FROM: plan no break and
  // say so (hosKnown: false), rather than assume a fresh clock and later nag
  // a driver for a break the plan never knew he was owed.
  const hosKnown = brief.minutesSinceBreakAtDepart !== null;
  const sinceBreak = brief.minutesSinceBreakAtDepart ?? 0;
  const breaks = hosKnown ? breaksRequired(sinceBreak, route.driveMin) : 0;
  let breakWindow: BreakWindow | null = null;
  if (breaks >= 1) {
    const atDriveMin = Math.max(0, BREAK_THRESHOLD_MIN - sinceBreak);
    const at = pointAlongRoute(route.geometry, atDriveMin / route.driveMin);
    const dueMs = brief.departAtMs + atDriveMin * MIN_MS;
    breakWindow = {
      atDriveMin,
      at,
      startMs: dueMs - BREAK_WINDOW_SLACK_MIN * MIN_MS,
      endMs: dueMs + BREAK_WINDOW_SLACK_MIN * MIN_MS,
      recommended: nearestRestStop(at, restStops),
    };
  }
  return {
    route,
    departAtMs: brief.departAtMs,
    deadlineAtMs: brief.deadlineAtMs,
    plannedStops: [brief.origin, brief.destination],
    breakWindow,
    hosKnown,
    etaAtMs: brief.departAtMs + (route.driveMin + breaks * BREAK_DURATION_MIN) * MIN_MS,
  };
}

/** Planned average pace: the provider's distance over its drive time, so
 *  "on plan" means "at the pace the route was priced at". */
const milesPerMin = (plan: Plan): number => plan.route.distanceMi / plan.route.driveMin;

/** Miles the plan expects covered by wall-clock `nowMs`. Holds still for the
 *  30 minutes of a mandatory break: the truck is not expected to move then. */
export function expectedAlongMi(plan: Plan, nowMs: number): number {
  let driveMin = (nowMs - plan.departAtMs) / MIN_MS;
  if (driveMin <= 0) return 0;
  const w = plan.breakWindow;
  if (w && driveMin > w.atDriveMin) driveMin = Math.max(w.atDriveMin, driveMin - BREAK_DURATION_MIN);
  return Math.min(plan.route.distanceMi, driveMin * milesPerMin(plan));
}

export function planLinePoint(plan: Plan, nowMs: number): GeoPoint {
  return pointAlongRoute(plan.route.geometry, expectedAlongMi(plan, nowMs) / plan.route.distanceMi);
}

/** Now + remaining miles at planned pace + whatever of the break is still
 *  owed. `breakCreditMin` is time already spent on a break in progress: a
 *  driver sixteen minutes into his thirty owes fourteen, not thirty. Charging
 *  him the full thirty projects an ETA past the deadline in the middle of the
 *  one stop the plan itself required — and then messages him for it. */
export function liveEtaMs(plan: Plan, at: GeoPoint, nowMs: number, breakTaken: boolean, breakCreditMin = 0): number {
  const { alongMi } = projectOntoRoute(plan.route.geometry, at);
  const remainingMi = Math.max(0, plan.route.distanceMi - alongMi);
  let remainingMin = remainingMi / milesPerMin(plan);
  if (plan.breakWindow && !breakTaken) remainingMin += Math.max(0, BREAK_DURATION_MIN - breakCreditMin);
  return nowMs + remainingMin * MIN_MS;
}

/** Positive = behind the plan line, negative = ahead. */
export function minutesBehindPlan(plan: Plan, at: GeoPoint, nowMs: number): number {
  const { alongMi } = projectOntoRoute(plan.route.geometry, at);
  return (expectedAlongMi(plan, nowMs) - alongMi) / milesPerMin(plan);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/plan.test.ts && npm run typecheck`
Expected: 10 passed; tsc clean.

- [ ] **Step 6: Break it, to prove the tests bite**

Change `driveMin - BREAK_DURATION_MIN` to `driveMin` in `expectedAlongMi` → "holds the plan line still during the break" must fail. Restore. Change `breaks * BREAK_DURATION_MIN` to `0` in `buildPlan` → the 8-hour-mark test must fail on the ETA. Restore. Both must fail or the test is decoration.

- [ ] **Step 7: Commit (if lifted)**

```bash
git add night-shift/src/core/geo.ts night-shift/src/core/plan.ts night-shift/tests/plan.test.ts
git commit -m "feat(night-shift): route geometry and the plan (ETA, plan line, break window)"
```

---

### Task 4: Detection — the unplanned stop, and what is NOT one

**Files:**
- Create: `night-shift/src/core/detect.ts` (this task adds `detectUnplannedStop`; Task 5 adds the rest)
- Test: `night-shift/tests/detect-stop.test.ts`

**Interfaces:**
- Consumes: `dwellSegments`, `haversineMi` via the bridge; `Plan`, `Ping`, `RestStop`, `Anomaly`; constants.
- Produces: `detectUnplannedStop(plan: Plan, pings: Ping[], restStops: RestStop[], nowMs: number): Anomaly | null`. The anomaly's `key` is `unplanned_stop@<firstSeenMs>` so the same stop is raised once however many pings arrive during it.

The rule (spec §6): stationary — inside the dwell fence around the latest position — for `STOP_MIN` or more, not within `PLANNED_STOP_RADIUS_MI` of a planned stop. **Not** an anomaly: any stop at a registered rest/fuel stop — inside the break window it is compliance, outside it it is fueling or rest, and a stop long enough to cost the deadline is the delay rule's business, not a reason to nag a driver at a pump.

- [ ] **Step 1: Write the failing tests**

`night-shift/tests/detect-stop.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { detectUnplannedStop } from "../src/core/detect.js";
import { pointAlongRoute } from "../src/core/geo.js";
import { buildPlan } from "../src/core/plan.js";
import type { Brief, LngLat, Ping, RouteAnswer } from "../src/core/types.js";

const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
const dense = (n: number): LngLat[] =>
  Array.from({ length: n + 1 }, (_, i) => [KC.lng + ((DSM.lng - KC.lng) * i) / n, KC.lat + ((DSM.lat - KC.lat) * i) / n]);
const ROUTE: RouteAnswer = { geometry: dense(90), distanceMi: 180, driveMin: 180 };
const T0 = Date.UTC(2026, 8, 6, 11, 10);
const MIN = 60_000;
const brief: Brief = {
  loadRef: "W-19", origin: { name: "KC", ...KC }, destination: { name: "DSM", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: T0 + 245 * MIN, driverName: "Jake", driverPhone: "+1", customerEmail: null,
  minutesSinceBreakAtDepart: 370, // break due at drive-minute 110; window 65..155
};
const at = (frac: number) => pointAlongRoute(ROUTE.geometry, frac);

/** `n` pings a minute apart, all at the same spot, starting at `fromMin`. */
const parked = (spot: { lat: number; lng: number }, fromMin: number, n: number): Ping[] =>
  Array.from({ length: n }, (_, i) => ({ atMs: T0 + (fromMin + i) * MIN, ...spot }));

describe("detectUnplannedStop", () => {
  const restStop = { name: "Love's I-35", ...at(110 / 180) };
  const plan = buildPlan(brief, ROUTE, [restStop]);

  it("raises a 20-minute stop away from any planned stop, with the evidence", () => {
    // Bethany, MO: 62 min in, 20 minutes stationary, nowhere on the plan.
    const pings = parked(at(62 / 180), 62, 21);
    const a = detectUnplannedStop(plan, pings, [restStop], T0 + 82 * MIN);
    expect(a?.kind).toBe("unplanned_stop");
    expect(a?.evidence.observedMin).toBe(20);
    expect(a?.evidence.thresholdMin).toBe(15);
    expect(a?.key).toBe("unplanned_stop@" + (T0 + 62 * MIN));
  });

  it("stays quiet under the threshold", () => {
    const pings = parked(at(62 / 180), 62, 11); // 10 minutes
    expect(detectUnplannedStop(plan, pings, [restStop], T0 + 72 * MIN)).toBeNull();
  });

  it("stays quiet at a planned stop — the destination is not an incident", () => {
    const pings = parked(DSM, 200, 40);
    expect(detectUnplannedStop(plan, pings, [restStop], T0 + 239 * MIN)).toBeNull();
  });

  it("THE rule: the mandatory break at the recommended rest stop is compliance, not an anomaly", () => {
    // Minute 110 to 140 at the Love's. Inside the window, at a registered
    // stop. Pinging him for this is how the link gets deleted.
    const pings = parked(restStop, 110, 31);
    expect(detectUnplannedStop(plan, pings, [restStop], T0 + 140 * MIN)).toBeNull();
  });

  it("a stop at a registered fuel/rest stop outside the window is not an anomaly either", () => {
    // Fueling at minute 30 is legitimate. If it costs the deadline, the
    // delay rule says so; the stop rule does not nag.
    const pings = parked(restStop, 30, 25);
    expect(detectUnplannedStop(plan, pings, [restStop], T0 + 54 * MIN)).toBeNull();
  });

  it("a stop inside the break window but NOT at a registered stop is still raised", () => {
    // Parked on a shoulder at minute 100. In the window, but nowhere the
    // registry knows — the agent may ask.
    const shoulder = { lat: at(100 / 180).lat, lng: at(100 / 180).lng + 0.05 };
    const pings = parked(shoulder, 100, 21);
    const a = detectUnplannedStop(plan, pings, [restStop], T0 + 120 * MIN);
    expect(a?.kind).toBe("unplanned_stop");
    expect(a?.evidence.inBreakWindow).toBe(true);
  });

  it("does not raise a stop the truck has already left", () => {
    // Twenty minutes parked, then rolling again: the latest ping is not in
    // the fence, so there is no OPEN stop to ask about.
    const pings = [...parked(at(62 / 180), 62, 21), { atMs: T0 + 83 * MIN, ...at(64 / 180) }];
    expect(detectUnplannedStop(plan, pings, [restStop], T0 + 83 * MIN)).toBeNull();
  });

  it("returning to a spot it already left starts a NEW stop — the old one is not re-raised", () => {
    // Parked 20 min at A, drove off for 14 min, came back to A. dwellSegments
    // now holds TWO segments for A: the closed 20-minute one and the open one
    // that just began. Only the open one may be judged. A rule that took the
    // first segment it found would raise a 20-minute stop the moment the
    // truck reappeared — and it would carry the OLD stop's key.
    const A = at(62 / 180);
    const away = Array.from({ length: 14 }, (_, i) => ({ atMs: T0 + (82 + i) * MIN, ...at((64 + i) / 180) }));
    const back4 = [...parked(A, 62, 20), ...away, ...parked(A, 96, 5)];
    expect(detectUnplannedStop(plan, back4, [restStop], T0 + 100 * MIN)).toBeNull();
    // Fifteen minutes into the SECOND visit it is a stop again — keyed to it.
    const back15 = [...parked(A, 62, 20), ...away, ...parked(A, 96, 16)];
    const a = detectUnplannedStop(plan, back15, [restStop], T0 + 111 * MIN);
    expect(a?.key).toBe("unplanned_stop@" + (T0 + 96 * MIN));
    expect(a?.evidence.observedMin).toBe(15);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/detect-stop.test.ts`
Expected: FAIL — cannot find module `../src/core/detect.js`.

- [ ] **Step 3: Write the rule**

`night-shift/src/core/detect.ts`:
```ts
// Detection rules. Deterministic: each returns an Anomaly with the evidence
// that fired it, or null. No rule ever guesses; the thresholds are named in
// constants.ts with their reasons. Task 5 adds delay, gone-dark and off-route
// to this file.
import { dwellSegments, haversineMi } from "../domain.js";
import { PLANNED_STOP_RADIUS_MI, STOP_MIN } from "./constants.js";
import type { Anomaly, GeoPoint, Ping, Plan, RestStop } from "./types.js";

const near = (a: GeoPoint, b: GeoPoint, mi: number): boolean => haversineMi(a, b) <= mi;

/** Stationary at the latest position for STOP_MIN, away from every planned
 *  stop and every registered rest/fuel stop. A stop the truck has already
 *  left is not raised: there is nothing open to ask about. */
export function detectUnplannedStop(plan: Plan, pings: Ping[], restStops: RestStop[], nowMs: number): Anomaly | null {
  if (pings.length === 0) return null;
  const last = pings[pings.length - 1];

  // The fence is centred on where the truck IS. dwellSegments then tells us
  // how long it has evidently been there.
  const open = dwellSegments(pings, last).find((s) => !s.departureObserved && s.lastSeenMs === last.atMs);
  if (!open || open.observedMin < STOP_MIN) return null;

  if (plan.plannedStops.some((s) => near(s, last, PLANNED_STOP_RADIUS_MI))) return null;

  // A registered rest or fuel stop is a legitimate place to be stopped — in
  // the break window it is compliance, outside it it is fueling or rest. A
  // stop long enough to cost the deadline is the delay rule's business.
  if (restStops.some((r) => near(r, last, PLANNED_STOP_RADIUS_MI))) return null;

  const w = plan.breakWindow;
  const inBreakWindow = !!w && open.firstSeenMs >= w.startMs && open.firstSeenMs <= w.endMs;

  return {
    kind: "unplanned_stop",
    key: "unplanned_stop@" + open.firstSeenMs,
    atMs: nowMs,
    evidence: {
      firstSeenMs: open.firstSeenMs,
      lastSeenMs: open.lastSeenMs,
      observedMin: open.observedMin,
      pingCount: open.pingCount,
      at: { lat: last.lat, lng: last.lng },
      thresholdMin: STOP_MIN,
      inBreakWindow,
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/detect-stop.test.ts && npm run typecheck`
Expected: 8 passed; tsc clean.

- [ ] **Step 5: Break it — the exemption must be load-bearing**

Delete the registered-stop early return → "THE rule" and the fueling test must both fail. Restore. Change `open.observedMin < STOP_MIN` to `< 5` → "stays quiet under the threshold" must fail. Restore. Replace the open-segment predicate `(s) => !s.departureObserved && s.lastSeenMs === last.atMs` with `() => true` → "returning to a spot it already left" must fail (it would raise the old 20-minute stop). Restore.

- [ ] **Step 6: Commit (if lifted)**

```bash
git add night-shift/src/core/detect.ts night-shift/tests/detect-stop.test.ts
git commit -m "feat(night-shift): unplanned-stop rule with the break and rest-stop exemptions"
```

---

### Task 5: Detection — delay, gone dark, off route, and the aggregator

**Files:**
- Modify: `night-shift/src/core/detect.ts` (append; keep Task 4's function unchanged)
- Test: `night-shift/tests/detect-other.test.ts`

**Interfaces:**
- Consumes: `liveEtaMs`, `minutesBehindPlan` (Task 3), `projectOntoRoute` (Task 3), constants.
- Produces:
  - `detectDelay(plan: Plan, at: GeoPoint, nowMs: number, breakTaken: boolean): Anomaly | null` — key is the constant `"delay"`: one delay ladder per trip; a delay persists and must not restart the ladder on every ping.
  - `detectGoneDark(plan: Plan, pings: Ping[], restStops: RestStop[], nowMs: number): Anomaly | null` — key `gone_dark@<lastPingMs>`.
  - `detectOffRoute(plan: Plan, pings: Ping[], nowMs: number): Anomaly | null` — key `off_route@<firstOffMs>`.
  - `detectAnomalies(plan, pings, restStops, nowMs, breakTaken): Anomaly[]` — all four, in the order stop, delay, dark, off-route.

Ruling on the spec's off-route wording ("a detour that rejoins within 30 min is logged, not raised"): the rule raises after `OFF_ROUTE_MIN` continuously off route, because it cannot know at minute 10 whether the truck will rejoin by minute 30. Rejoining is handled by the key: once a ping is back on route the anomaly stops being produced, and the agent's ladder for it stops (Task 8).

- [ ] **Step 1: Write the failing tests**

`night-shift/tests/detect-other.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { detectAnomalies, detectDelay, detectGoneDark, detectOffRoute } from "../src/core/detect.js";
import { pointAlongRoute } from "../src/core/geo.js";
import { buildPlan } from "../src/core/plan.js";
import type { Brief, LngLat, Ping, RouteAnswer } from "../src/core/types.js";

const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
const dense = (n: number): LngLat[] =>
  Array.from({ length: n + 1 }, (_, i) => [KC.lng + ((DSM.lng - KC.lng) * i) / n, KC.lat + ((DSM.lat - KC.lat) * i) / n]);
const ROUTE: RouteAnswer = { geometry: dense(90), distanceMi: 180, driveMin: 180 };
const T0 = Date.UTC(2026, 8, 6, 11, 10);
const MIN = 60_000;
const brief: Brief = {
  loadRef: "W-19", origin: { name: "KC", ...KC }, destination: { name: "DSM", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: T0 + 245 * MIN, driverName: "Jake", driverPhone: "+1", customerEmail: null,
  minutesSinceBreakAtDepart: 370,
};
const at = (frac: number) => pointAlongRoute(ROUTE.geometry, frac);
const restStop = { name: "Love's I-35", ...at(110 / 180) };
const plan = buildPlan(brief, ROUTE, [restStop]); // plan ETA 09:40 (min 210); deadline 10:15 (min 245)
const t = (min: number) => T0 + min * MIN;

describe("detectDelay", () => {
  it("fires when the live ETA passes the deadline, and says by how much it is behind", () => {
    // Minute 150, break taken, only 80 mi covered: 100 mi to go = ETA min 250.
    const a = detectDelay(plan, at(80 / 180), t(150), true);
    expect(a?.kind).toBe("delay");
    expect(a?.key).toBe("delay");
    expect(a?.evidence.pastDeadline).toBe(true);
    expect(a?.evidence.behindMin).toBeCloseTo(40, 0);
  });

  it("fires on 30+ minutes behind the plan line even with the deadline still safe", () => {
    // Minute 60 at mile 28: 32 behind, but ETA = 60 + 152 + 30 = min 242, still
    // inside the 245 deadline. (Mile 25 would land 0.1 min PAST it on the real
    // great-circle length — a fixture inside its own ambiguity.)
    const a = detectDelay(plan, at(28 / 180), t(60), false);
    expect(a?.evidence.behindPlan).toBe(true);
    expect(a?.evidence.pastDeadline).toBe(false);
  });

  it("is quiet when merely a little behind", () => {
    // Minute 150 at mile 100: 20 behind, ETA min 230.
    expect(detectDelay(plan, at(100 / 180), t(150), true)).toBeNull();
  });

  it("does not call a driver late for the minutes of a break he is in the middle of", () => {
    // Deadline tight enough that the full thirty tips the ETA past it.
    const tight = buildPlan({ ...brief, deadlineAtMs: t(220) }, ROUTE, [restStop]);
    // Sixteen minutes into the mandatory break, at the recommended stop.
    // Uncredited, the whole thirty is still charged and this would fire.
    expect(detectDelay(tight, restStop, t(126), false, 16)).toBeNull();
  });
});

describe("detectGoneDark", () => {
  const rolling: Ping[] = [{ atMs: t(100), ...at(100 / 180) }];
  it("fires after 20 minutes without a ping on the road", () => {
    expect(detectGoneDark(plan, rolling, [restStop], t(115))).toBeNull();
    const a = detectGoneDark(plan, rolling, [restStop], t(121));
    expect(a?.kind).toBe("gone_dark");
    expect(a?.evidence.gapMin).toBeCloseTo(21, 0);
    expect(a?.evidence.limitMin).toBe(20);
  });

  it("gives a phone at a known stop an hour — GPS dies indoors", () => {
    const parkedAtRest: Ping[] = [{ atMs: t(110), ...restStop }];
    expect(detectGoneDark(plan, parkedAtRest, [restStop], t(160))).toBeNull();
    const a = detectGoneDark(plan, parkedAtRest, [restStop], t(171));
    expect(a?.evidence.atStop).toBe(true);
    expect(a?.evidence.limitMin).toBe(60);
  });
});

describe("detectOffRoute", () => {
  const east = (frac: number, mi: number) => ({ lat: at(frac).lat, lng: at(frac).lng + mi / 54 }); // ~54 mi per degree lng here
  const off = (fromMin: number, n: number): Ping[] =>
    Array.from({ length: n }, (_, i) => ({ atMs: t(fromMin + i), ...east((fromMin + i) / 180, 5) }));

  it("fires after 10 minutes continuously more than 3.1 mi off the line", () => {
    const a = detectOffRoute(plan, off(60, 11), t(70));
    expect(a?.kind).toBe("off_route");
    expect(a?.evidence.minOffRouteMi).toBeGreaterThan(3.1);
  });

  it("is quiet for a shorter excursion", () => {
    expect(detectOffRoute(plan, off(60, 6), t(65))).toBeNull();
  });

  it("is quiet once any recent ping is back on the route", () => {
    const pings = [...off(60, 10), { atMs: t(70), ...at(70 / 180) }];
    expect(detectOffRoute(plan, pings, t(70))).toBeNull();
  });

  it("keeps ONE key for the whole excursion, so the ladder is never restarted", () => {
    // Evaluated every minute across a 30-minute excursion, the key must stay
    // anchored to the first off-route ping. A key taken from a trailing
    // window slides a minute per tick, and the agent's per-key ladder would
    // start over from rung 1 on every evaluation.
    const pings = off(60, 31);
    const keys = new Set<string>();
    for (let m = 70; m <= 90; m += 1) {
      const a = detectOffRoute(plan, pings.filter((p) => p.atMs <= t(m)), t(m));
      if (a) keys.add(a.key);
    }
    expect(keys).toEqual(new Set(["off_route@" + t(60)]));
  });
});

describe("detectAnomalies", () => {
  it("returns every rule that fires, stop first", () => {
    // Parked 20 min at mile 62 at minute 150, which is also 40+ behind plan.
    const parked: Ping[] = Array.from({ length: 21 }, (_, i) => ({ atMs: t(130 + i), ...at(62 / 180) }));
    const kinds = detectAnomalies(plan, parked, [restStop], t(150), true).map((a) => a.kind);
    expect(kinds[0]).toBe("unplanned_stop");
    expect(kinds).toContain("delay");
    expect(kinds).not.toContain("gone_dark");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/detect-other.test.ts`
Expected: FAIL — `detectDelay` is not exported.

- [ ] **Step 3: Append the rules to detect.ts**

Add these imports at the top of `night-shift/src/core/detect.ts` (merge with the existing ones):
```ts
import { DARK_AT_STOP_MIN, DARK_MIN, DELAY_BEHIND_PLAN_MIN, MIN_MS, OFF_ROUTE_MI, OFF_ROUTE_MIN } from "./constants.js";
import { projectOntoRoute } from "./geo.js";
import { liveEtaMs, minutesBehindPlan } from "./plan.js";
```

Append:
```ts
/** Live ETA past the deadline, or more than DELAY_BEHIND_PLAN_MIN behind the
 *  plan line. The key is constant: a delay is one situation for the whole
 *  trip, and re-raising it on every ping would restart the ladder forever. */
export function detectDelay(plan: Plan, at: GeoPoint, nowMs: number, breakTaken: boolean, breakCreditMin = 0): Anomaly | null {
  const etaMs = liveEtaMs(plan, at, nowMs, breakTaken, breakCreditMin);
  const behindMin = minutesBehindPlan(plan, at, nowMs);
  const pastDeadline = etaMs > plan.deadlineAtMs;
  const behindPlan = behindMin > DELAY_BEHIND_PLAN_MIN;
  if (!pastDeadline && !behindPlan) return null;
  return {
    kind: "delay",
    key: "delay",
    atMs: nowMs,
    evidence: {
      etaMs,
      deadlineAtMs: plan.deadlineAtMs,
      behindMin: Math.round(behindMin),
      thresholdBehindMin: DELAY_BEHIND_PLAN_MIN,
      pastDeadline,
      behindPlan,
      at: { lat: at.lat, lng: at.lng },
    },
  };
}

/** No ping for DARK_MIN — or DARK_AT_STOP_MIN if the last one was at a stop,
 *  where a phone loses GPS indoors. */
export function detectGoneDark(plan: Plan, pings: Ping[], restStops: RestStop[], nowMs: number): Anomaly | null {
  if (pings.length === 0) return null;
  const last = pings[pings.length - 1];
  const gapMin = (nowMs - last.atMs) / MIN_MS;
  const atStop =
    plan.plannedStops.some((s) => near(s, last, PLANNED_STOP_RADIUS_MI)) ||
    restStops.some((r) => near(r, last, PLANNED_STOP_RADIUS_MI));
  const limitMin = atStop ? DARK_AT_STOP_MIN : DARK_MIN;
  if (gapMin < limitMin) return null;
  return {
    kind: "gone_dark",
    key: "gone_dark@" + last.atMs,
    atMs: nowMs,
    evidence: { lastPingMs: last.atMs, gapMin: Math.round(gapMin), limitMin, atStop, lastAt: { lat: last.lat, lng: last.lng } },
  };
}

/** The contiguous run of pings, ending at the latest one, that all sit more
 *  than OFF_ROUTE_MI from the line — raised once that run has lasted
 *  OFF_ROUTE_MIN. The key is anchored to the run's FIRST ping, so the same
 *  excursion keeps the same key however long it lasts; a trailing-window
 *  key slides a minute per tick and the ladder can never find its own entry.
 *  One ping back on the route ends the run, and with it the anomaly. */
export function detectOffRoute(plan: Plan, pings: Ping[], nowMs: number): Anomaly | null {
  if (pings.length === 0) return null;
  const offs: number[] = [];
  let start = pings.length;
  for (let i = pings.length - 1; i >= 0; i -= 1) {
    const off = projectOntoRoute(plan.route.geometry, pings[i]).offRouteMi;
    if (off <= OFF_ROUTE_MI) break;
    offs.push(off);
    start = i;
  }
  if (offs.length < 2) return null;
  const first = pings[start];
  const last = pings[pings.length - 1];
  const minutes = (last.atMs - first.atMs) / MIN_MS;
  if (minutes < OFF_ROUTE_MIN) return null;
  return {
    kind: "off_route",
    key: "off_route@" + first.atMs,
    atMs: nowMs,
    evidence: { sinceMs: first.atMs, minutes: Math.round(minutes), minOffRouteMi: Math.min(...offs), thresholdMi: OFF_ROUTE_MI },
  };
}

export function detectAnomalies(plan: Plan, pings: Ping[], restStops: RestStop[], nowMs: number, breakTaken: boolean, breakCreditMin = 0): Anomaly[] {
  const out: Anomaly[] = [];
  const stop = detectUnplannedStop(plan, pings, restStops, nowMs);
  if (stop) out.push(stop);
  if (pings.length > 0) {
    const delay = detectDelay(plan, pings[pings.length - 1], nowMs, breakTaken, breakCreditMin);
    if (delay) out.push(delay);
  }
  const dark = detectGoneDark(plan, pings, restStops, nowMs);
  if (dark) out.push(dark);
  const off = detectOffRoute(plan, pings, nowMs);
  if (off) out.push(off);
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/detect-other.test.ts tests/detect-stop.test.ts && npm run typecheck`
Expected: 10 + 7 passed; tsc clean.

- [ ] **Step 5: Break it**

In `detectGoneDark`, replace `atStop ? DARK_AT_STOP_MIN : DARK_MIN` with `DARK_MIN` → "gives a phone at a known stop an hour" must fail. Restore. In `detectDelay`, change `behindMin > DELAY_BEHIND_PLAN_MIN` to `behindMin > 0` → "quiet when merely a little behind" must fail. Restore. In `detectOffRoute`, change the key to `"off_route@" + pings[Math.max(start, pings.length - OFF_ROUTE_MIN)].atMs` (a sliding anchor) → "keeps ONE key for the whole excursion" must fail. Restore.

- [ ] **Step 6: Commit (if lifted)**

```bash
git add night-shift/src/core/detect.ts night-shift/tests/detect-other.test.ts
git commit -m "feat(night-shift): delay, gone-dark and off-route rules"
```

---

### Task 6: The situation library and keyword matching

**Files:**
- Create: `night-shift/src/core/situations.ts`
- Test: `night-shift/tests/situations.test.ts`

**Interfaces:**
- Produces:
  - `SITUATIONS: readonly Situation[]` — the spec §9 table, en-US, `all_good` deliberately last.
  - `situationFor(key: string): Situation | null`
  - `UNKNOWN_RESPONSE: string`
  - `matchByKeywords(text: string): { key: string | null; confidence: number }` — the deterministic classifier the fake uses. Whole-word matching of each situation's `examples` against the reply; the situation with the most matched examples wins; ties go to the **higher level** (a reply that mentions traffic and an engine light is a breakdown until proven otherwise), then to the earlier table row. No match → `{ key: null, confidence: 0 }`. A match → confidence `0.9`. The real LLM classifier (a later plan) implements the same port and the same floor.

- [ ] **Step 1: Write the failing tests**

`night-shift/tests/situations.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { CLASSIFY_FLOOR } from "../src/core/constants.js";
import { SITUATIONS, matchByKeywords, situationFor } from "../src/core/situations.js";

describe("situation library", () => {
  it("covers the spec's table with the spec's levels", () => {
    const levels = Object.fromEntries(SITUATIONS.map((s) => [s.key, s.level]));
    expect(levels).toMatchObject({ all_good: 0, rest: 0, fuel: 0, traffic: 1, inspection: 2, customer: 2, breakdown: 3, accident: 3 });
  });

  it("every response is a full sentence in American English with no template holes", () => {
    for (const s of SITUATIONS) {
      expect(s.response).toMatch(/[.?!]$/);
      expect(s.response).not.toMatch(/\{|\}/);
    }
  });

  it("looks a situation up by key, and admits an unknown key", () => {
    expect(situationFor("breakdown")?.level).toBe(3);
    expect(situationFor("teleport")).toBeNull();
  });
});

describe("matchByKeywords", () => {
  it("classifies the replay's reply as rest, not as all_good", () => {
    // "rolling" is an all_good phrase; "bathroom" is the information.
    const r = matchByKeywords("had to use the bathroom, rolling now");
    expect(r.key).toBe("rest");
    expect(r.confidence).toBeGreaterThanOrEqual(CLASSIFY_FLOOR);
  });

  it("breaks a TIE toward the more serious situation", () => {
    // One traffic phrase, one breakdown phrase — an actual tie on hits. (A
    // reply containing both "check engine" and "engine" is not a tie:
    // breakdown wins on count alone and the tie-break is never consulted.)
    expect(matchByKeywords("stuck in traffic with a flat").key).toBe("breakdown");
    // On count, the more-mentioned situation wins regardless of level.
    expect(matchByKeywords("traffic jam, construction, road closed, and a flat").key).toBe("traffic");
  });

  it("matches whole words only", () => {
    // "shit" must not match the accident phrase "hit".
    expect(matchByKeywords("oh shit forgot my wallet").key).toBeNull();
  });

  it("returns UNKNOWN below the floor rather than forcing a bucket", () => {
    const r = matchByKeywords("asdf qwer zxcv");
    expect(r.key).toBeNull();
    expect(r.confidence).toBeLessThan(CLASSIFY_FLOOR);
    expect(matchByKeywords("").key).toBeNull();
  });

  it("is case- and punctuation-insensitive", () => {
    expect(matchByKeywords("PULLED OVER!! DOT inspection.").key).toBe("inspection");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/situations.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write situations.ts**

`night-shift/src/core/situations.ts`:
```ts
// The situation library (spec §9): the bounded set of things a driver can
// actually be in. Each carries what the agent says back, how loudly the
// dispatcher hears about it, and the phrasings a reply is matched on.
//
// This file is the seed of the library; the supervised learning loop (a
// later plan) proposes additions here and a human approves them. Rules never
// rewrite themselves.
import type { Situation } from "./types.js";

export const UNKNOWN_RESPONSE = "Sorry, I didn't catch that — dispatch will follow up.";

/** `all_good` is LAST on purpose: it is the least informative match, so on a
 *  tie the more specific situation wins. */
export const SITUATIONS: readonly Situation[] = [
  {
    key: "breakdown", level: 3,
    response: "Understood. Are you safe? Dispatch is being notified now.",
    dispatcherNote: "Driver reports a breakdown.",
    examples: ["breakdown", "broke down", "broken down", "flat", "tire", "engine", "check engine", "won't start", "wont start", "tow", "mechanic", "overheating", "overheat"],
  },
  {
    key: "accident", level: 3,
    response: "Are you OK? Dispatch is being notified now.",
    dispatcherNote: "Driver reports an accident.",
    examples: ["accident", "crash", "crashed", "hit", "collision", "wreck", "rolled over", "ambulance"],
  },
  {
    key: "inspection", level: 2,
    response: "Understood. Message me when you're rolling.",
    dispatcherNote: "Driver is stopped for police or a DOT inspection.",
    examples: ["police", "cop", "cops", "dot", "inspection", "weigh station", "scale", "scales", "pulled over"],
  },
  {
    key: "customer", level: 2,
    response: "Understood, I'm telling dispatch.",
    dispatcherNote: "Customer not ready, or wrong address.",
    examples: ["not ready", "nobody here", "no one here", "closed", "wrong address", "can't find", "cant find", "no dock", "waiting to unload", "waiting to load", "waiting on them"],
  },
  {
    key: "traffic", level: 1,
    response: "Thanks — I'll update the ETA.",
    dispatcherNote: "Driver reports traffic or weather.",
    examples: ["traffic", "jam", "backed up", "construction", "weather", "snow", "ice", "rain", "fog", "wind", "road closed", "detour"],
  },
  {
    key: "rest", level: 0,
    response: "Got it, thanks.",
    dispatcherNote: "Driver stopped for rest, bathroom, or food.",
    examples: ["bathroom", "restroom", "pee", "rest", "nap", "sleep", "sleeping", "coffee", "food", "eat", "eating", "lunch", "breakfast", "dinner", "break"],
  },
  {
    key: "fuel", level: 0,
    response: "Got it.",
    dispatcherNote: "Driver stopped for fuel.",
    examples: ["fuel", "fueling", "gas", "diesel", "fill up", "filling up", "pump"],
  },
  {
    key: "all_good", level: 0,
    response: "Thanks, drive safe.",
    dispatcherNote: "Driver reports all good.",
    examples: ["all good", "on my way", "rolling", "fine", "ok", "okay", "yes", "yep", "good", "no problem", "moving"],
  },
];

export function situationFor(key: string): Situation | null {
  return SITUATIONS.find((s) => s.key === key) ?? null;
}

const KEYWORD_CONFIDENCE = 0.9;

const words = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

/** Whole-word phrase match: every word of the example appears consecutively
 *  in the reply. "hit" does not match "shit". */
function containsPhrase(replyWords: string[], example: string): boolean {
  const ex = words(example);
  if (ex.length === 0) return false;
  for (let i = 0; i + ex.length <= replyWords.length; i += 1) {
    if (ex.every((w, j) => replyWords[i + j] === w)) return true;
  }
  return false;
}

export function matchByKeywords(text: string): { key: string | null; confidence: number } {
  const replyWords = words(text);
  if (replyWords.length === 0) return { key: null, confidence: 0 };
  // A plain loop, not forEach: TypeScript does not track an assignment made
  // inside a callback, so `best` would still be typed `null` at the return.
  let best: { key: string; hits: number; level: number; index: number } | null = null;
  for (const [index, s] of SITUATIONS.entries()) {
    const hits = s.examples.filter((e) => containsPhrase(replyWords, e)).length;
    if (hits === 0) continue;
    const better =
      best === null ||
      hits > best.hits ||
      (hits === best.hits && s.level > best.level) ||
      (hits === best.hits && s.level === best.level && index < best.index);
    if (better) best = { key: s.key, hits, level: s.level, index };
  }
  return best === null ? { key: null, confidence: 0 } : { key: best.key, confidence: KEYWORD_CONFIDENCE };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/situations.test.ts && npm run typecheck`
Expected: 8 passed; tsc clean.

- [ ] **Step 5: Break it**

Change the tie-break `s.level > best.level` to `s.level < best.level` → "breaks a tie toward the more serious situation" must fail. Restore. Replace `containsPhrase` with `text.includes(example)` → "matches whole words only" must fail. Restore.

- [ ] **Step 6: Commit (if lifted)**

```bash
git add night-shift/src/core/situations.ts night-shift/tests/situations.test.ts
git commit -m "feat(night-shift): situation library and whole-word keyword matching"
```

---

### Task 7: The escalation ladder

**Files:**
- Create: `night-shift/src/core/ladder.ts`
- Test: `night-shift/tests/ladder.test.ts`

**Interfaces:**
- Produces:
  - `type Rung = 0 | 1 | 2 | 3 | 4`, `type ActionKind = "message" | "message_again" | "sms" | "call" | "call_retry" | "escalate"`
  - `interface LadderAction { rung: Rung; kind: ActionKind }`
  - `interface LadderState { rung: Rung; lastActionMs: number | null; callAttempts: number; stopped: boolean; stoppedReason: "replied" | "escalated" | "resolved" | null }`
  - `initialLadder(): LadderState`
  - `nextAction(state: LadderState, ctx: { nowMs: number; linkOpenedMs: number | null }): LadderAction | null`
  - `applyAction(state: LadderState, action: LadderAction, nowMs: number): LadderState` (returns a new state; never mutates)
  - `stopLadder(state: LadderState, reason: "replied" | "resolved"): LadderState`

Ruling: cooldowns are strict. The spec's "or delay endangers the deadline" at rung 3 is satisfied by the delay anomaly *reaching* rung 3 like any other; it does not skip the message rungs. A call before a message is rude and the replay's timeline (08:40 → 08:50 → 09:05) is exactly the strict cooldowns.

- [ ] **Step 1: Write the failing tests**

`night-shift/tests/ladder.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { applyAction, initialLadder, nextAction, stopLadder } from "../src/core/ladder.js";

const MIN = 60_000;
const T0 = 1_000_000;
const ctx = (min: number, linkOpenedMs: number | null = T0) => ({ nowMs: T0 + min * MIN, linkOpenedMs });

/** Walk the ladder, taking every action the moment it is offered. */
function walk(minutes: number[], linkOpenedMs: number | null = T0) {
  let s = initialLadder();
  const taken: string[] = [];
  for (const m of minutes) {
    const a = nextAction(s, ctx(m, linkOpenedMs));
    if (a) {
      s = applyAction(s, a, T0 + m * MIN);
      taken.push(m + ":" + a.kind);
    }
  }
  return { s, taken };
}

describe("ladder", () => {
  it("messages immediately on a fresh anomaly", () => {
    expect(nextAction(initialLadder(), ctx(0))).toEqual({ rung: 1, kind: "message" });
  });

  it("honors the cooldown between rungs — no machine-gunning the driver", () => {
    const { taken } = walk([0, 5, 9, 10]);
    expect(taken).toEqual(["0:message", "10:message_again"]);
  });

  it("runs the whole replay: message, again, call, retry, escalate on the spec's clock", () => {
    // 08:40 message · 08:50 again · 09:05 call · 09:10 retry · 09:15 escalate
    const { taken, s } = walk([0, 10, 25, 30, 35, 40]);
    expect(taken).toEqual(["0:message", "10:message_again", "25:call", "30:call_retry", "35:escalate"]);
    expect(s.stopped).toBe(true);
    expect(s.stoppedReason).toBe("escalated");
    expect(nextAction(s, ctx(60))).toBeNull();
  });

  it("sends an SMS at rung 2 when the link has never been opened", () => {
    const { taken } = walk([0, 10], null);
    expect(taken[1]).toBe("10:sms");
  });

  it("stops for a reply and never resumes", () => {
    let s = applyAction(initialLadder(), { rung: 1, kind: "message" }, T0);
    s = stopLadder(s, "replied");
    expect(nextAction(s, ctx(60))).toBeNull();
    expect(s.stoppedReason).toBe("replied");
  });

  it("never mutates a state it was given", () => {
    const before = initialLadder();
    const frozen = JSON.stringify(before);
    applyAction(before, { rung: 1, kind: "message" }, T0);
    stopLadder(before, "resolved");
    expect(JSON.stringify(before)).toBe(frozen);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/ladder.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write ladder.ts**

`night-shift/src/core/ladder.ts`:
```ts
// The escalation ladder (spec §7): what the agent does next about one
// anomaly, given what it has already done and when. Pure state machine; the
// agent executes the action through a port and records the new state.
import { CALL_RETRY_MIN, LINK_UNOPENED_SMS_MIN, MIN_MS, RUNG1_COOLDOWN_MIN, RUNG2_COOLDOWN_MIN } from "./constants.js";

export type Rung = 0 | 1 | 2 | 3 | 4;
export type ActionKind = "message" | "message_again" | "sms" | "call" | "call_retry" | "escalate";

export interface LadderAction {
  rung: Rung;
  kind: ActionKind;
}

export interface LadderState {
  rung: Rung;
  lastActionMs: number | null;
  callAttempts: number;
  stopped: boolean;
  stoppedReason: "replied" | "escalated" | "resolved" | null;
}

export const initialLadder = (): LadderState => ({
  rung: 0,
  lastActionMs: null,
  callAttempts: 0,
  stopped: false,
  stoppedReason: null,
});

/** How many calls before giving up and waking the dispatcher: one plus one retry. */
const MAX_CALLS = 2;

export function nextAction(state: LadderState, ctx: { nowMs: number; linkOpenedMs: number | null }): LadderAction | null {
  if (state.stopped) return null;
  const sinceMin = state.lastActionMs === null ? Number.POSITIVE_INFINITY : (ctx.nowMs - state.lastActionMs) / MIN_MS;

  switch (state.rung) {
    case 0:
      return { rung: 1, kind: "message" };
    case 1: {
      if (sinceMin < RUNG1_COOLDOWN_MIN) return null;
      // A link that has never been opened is not a channel; fall back to SMS.
      const linkUnopened = ctx.linkOpenedMs === null || ctx.nowMs - ctx.linkOpenedMs > LINK_UNOPENED_SMS_MIN * MIN_MS;
      return { rung: 2, kind: linkUnopened ? "sms" : "message_again" };
    }
    case 2:
      if (sinceMin < RUNG2_COOLDOWN_MIN) return null;
      return { rung: 3, kind: "call" };
    case 3:
      if (sinceMin < CALL_RETRY_MIN) return null;
      if (state.callAttempts < MAX_CALLS) return { rung: 3, kind: "call_retry" };
      return { rung: 4, kind: "escalate" };
    case 4:
      return null;
  }
}

export function applyAction(state: LadderState, action: LadderAction, nowMs: number): LadderState {
  const isCall = action.kind === "call" || action.kind === "call_retry";
  return {
    ...state,
    rung: action.rung,
    lastActionMs: nowMs,
    callAttempts: isCall ? state.callAttempts + 1 : state.callAttempts,
    stopped: action.kind === "escalate",
    stoppedReason: action.kind === "escalate" ? "escalated" : state.stoppedReason,
  };
}

export function stopLadder(state: LadderState, reason: "replied" | "resolved"): LadderState {
  return { ...state, stopped: true, stoppedReason: reason };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/ladder.test.ts && npm run typecheck`
Expected: 6 passed; tsc clean.

- [ ] **Step 5: Break it**

Remove the `if (sinceMin < RUNG1_COOLDOWN_MIN) return null;` line → "honors the cooldown" must fail. Restore. Change `MAX_CALLS` to `1` → the replay walk must fail (escalate comes one step early). Restore.

- [ ] **Step 6: Commit (if lifted)**

```bash
git add night-shift/src/core/ladder.ts night-shift/tests/ladder.test.ts
git commit -m "feat(night-shift): escalation ladder with strict cooldowns"
```

---

### Task 8: Ports, fakes, phrases, and the agent loop

**Files:**
- Create: `night-shift/src/ports/index.ts`, `night-shift/src/fakes/index.ts`, `night-shift/src/core/phrases.ts`, `night-shift/src/core/agent.ts`
- Modify: `night-shift/src/core/constants.ts` (append two constants)
- Test: `night-shift/tests/agent.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–7; `dwellSegments`, `haversineMi`, `BREAK_DURATION_MIN` via the bridge.
- Produces:
  - Ports (all methods return Promises so real adapters can be async): `Clock { nowMs(): number }`, `RouterPort { route(from: GeoPoint, to: GeoPoint): Promise<RouteAnswer> }`, `SheetPort { writeStatus(loadRef: string, cells: Record<string, string>): Promise<void>; appendLog(loadRef: string, event: AgentEvent): Promise<void> }`, `MessengerPort { sendChat(phone: string, text: string): Promise<void>; sendSms(phone: string, text: string): Promise<void> }`, `PhonePort { call(phone: string, script: string): Promise<{ answered: boolean; transcript: string | null }> }`, `MailerPort { send(to: string, subject: string, body: string, attachments?: { name: string; body: string }[]): Promise<void> }`, `ClassifierPort { classify(text: string): Promise<{ key: string | null; confidence: number }> }`, `EventStore { append(e: AgentEvent): Promise<void>; all(): Promise<AgentEvent[]> }`
  - Fakes: `FakeClock`, `StraightRouter`, `MemorySheet`, `MemoryMessenger`, `MemoryPhone`, `MemoryMailer`, `KeywordClassifier`, `MemoryEvents` — each records what it was asked so tests assert on it.
  - `Agent` with `start()`, `onAccept()`, `onPing(ping)`, `onReply(reply)`, `onDispatcherReply(text)`, `tick()`, and a readonly `state: TripState`.

Design rules the agent enforces (spec §7, §11): one open question at a time; a reply stops the ladder it answers; every action, reply, call, escalation and sheet write is an `AgentEvent` with evidence; pings are recorded to the event store but not to the sheet's log tab (hundreds per trip); the sheet is written every `SHEET_WRITE_EVERY_MIN` and immediately on any escalation, arrival or state change; a mandatory break taken in its window at a registered stop is recorded as a `plan` event ("compliance") and never messaged.

- [ ] **Step 1: Add two constants**

Append to `night-shift/src/core/constants.ts`:
```ts
/** Sheet cadence while tracking (spec §8). Escalations write immediately. */
export const SHEET_WRITE_EVERY_MIN = 15;
/** A named landmark within this is how a place is described to a human:
 *  "near Bethany, MO" rather than a coordinate. */
export const LANDMARK_RADIUS_MI = 5;
```

- [ ] **Step 2: Write the failing tests**

`night-shift/tests/agent.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/core/agent.js";
import { UNKNOWN_RESPONSE } from "../src/core/situations.js";
import type { Brief, LngLat } from "../src/core/types.js";
import { pointAlongRoute } from "../src/core/geo.js";
import {
  FakeClock, KeywordClassifier, MemoryEvents, MemoryMailer, MemoryMessenger, MemoryPhone, MemorySheet, StraightRouter,
} from "../src/fakes/index.js";

const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
const T0 = Date.UTC(2026, 8, 6, 11, 10); // 06:10 America/Chicago
const MIN = 60_000;
const t = (min: number) => T0 + min * MIN;

const brief: Brief = {
  loadRef: "W-19", origin: { name: "Kansas City, MO", ...KC }, destination: { name: "Des Moines, IA", ...DSM },
  equipment: "DryVan", departAtMs: T0, deadlineAtMs: t(245), driverName: "Jake Morrow", driverPhone: "+15550001",
  customerEmail: "ops@customer.example", minutesSinceBreakAtDepart: 370,
};

let clock: FakeClock, sheet: MemorySheet, messenger: MemoryMessenger, phone: MemoryPhone, mailer: MemoryMailer, events: MemoryEvents;
let geometry: LngLat[];
let agent: Agent;
const at = (mi: number) => pointAlongRoute(geometry, mi / 179.5);

beforeEach(async () => {
  clock = new FakeClock(T0);
  sheet = new MemorySheet(); messenger = new MemoryMessenger(); phone = new MemoryPhone(); mailer = new MemoryMailer(); events = new MemoryEvents();
  const router = new StraightRouter(60);
  geometry = (await router.route(KC, DSM)).geometry;
  const restStop = { name: "Love's Osceola", ...pointAlongRoute(geometry, 90 / 179.5) };
  agent = new Agent(
    { clock, router, sheet, messenger, phone, mailer, classifier: new KeywordClassifier(), events,
      restStops: [restStop], landmarks: [{ name: "Bethany, MO", ...pointAlongRoute(geometry, 62 / 179.5) }],
      dispatcherEmail: "boss@dispatch.example", tz: "America/Chicago" },
    brief,
  );
});

/** Drive the truck: one ping per minute from `fromMin` to `toMin`, at `mi(min)`. */
async function drive(fromMin: number, toMin: number, mi: (min: number) => number): Promise<void> {
  for (let m = fromMin; m <= toMin; m += 1) {
    clock.set(t(m));
    await agent.onPing({ atMs: t(m), ...at(mi(m)) });
  }
}
const accepted = async () => { await agent.start(); clock.set(t(0)); await agent.onAccept(); };

describe("Agent", () => {
  it("plans on start and invites the driver by SMS with the load's details", async () => {
    await agent.start();
    expect(agent.state.status).toBe("invited");
    expect(agent.state.plan?.breakWindow?.recommended?.name).toBe("Love's Osceola");
    const sms = messenger.sent.find((m) => m.channel === "sms");
    expect(sms?.text).toContain("W-19");
    expect(sms?.text).toContain("Des Moines");
    expect(sms?.text).toMatch(/accept/i);
    expect(events.events.map((e) => e.kind)).toEqual(["plan", "action", "sheet_write"]);
    expect(sheet.cells["W-19"]["Agent Status"]).toBe("Invited");
  });

  it("goes to Attention and emails the dispatcher when the driver has not accepted by departure + 30", async () => {
    await agent.start();
    clock.set(t(29)); await agent.tick();
    expect(mailer.sent).toHaveLength(0);
    clock.set(t(31)); await agent.tick();
    expect(agent.state.status).toBe("attention");
    expect(mailer.sent[0].to).toBe("boss@dispatch.example");
    expect(mailer.sent[0].body).toMatch(/not accepted/i);
    // The cell carries the reason after a dash — "Attention — not accepted…".
    expect(sheet.cells["W-19"]["Agent Status"]).toMatch(/^Attention/);
  });

  it("asks ONE question about an unplanned stop, naming the place, and respects the cooldown", async () => {
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 78, () => 62); // parked at Bethany
    const chats = messenger.sent.filter((m) => m.channel === "chat");
    expect(chats).toHaveLength(1);
    expect(chats[0].text).toMatch(/stopped 15 min/i);
    expect(chats[0].text).toContain("Bethany, MO");
    expect(agent.state.openQuestionKey).toBe("unplanned_stop@" + t(62));
    const anomaly = events.events.find((e) => e.kind === "anomaly");
    expect(anomaly?.evidence.observedMin).toBe(15);
  });

  it("records the driver's words verbatim, answers from the library, and stops the ladder", async () => {
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 77, () => 62);
    clock.set(t(81));
    await agent.onReply({ atMs: t(81), channel: "chat", rawText: "had to use the bathroom, rolling now" });
    const reply = events.events.find((e) => e.kind === "reply");
    expect(reply?.evidence.rawText).toBe("had to use the bathroom, rolling now");
    expect(reply?.evidence.situationKey).toBe("rest");
    expect(messenger.sent.at(-1)?.text).toBe("Got it, thanks.");
    expect(agent.state.openQuestionKey).toBeNull();
    expect(mailer.sent).toHaveLength(0); // level 0: the dispatcher hears in the morning
    await drive(82, 95, (m) => 62 + (m - 82));
    expect(messenger.sent.filter((m) => m.channel === "chat")).toHaveLength(2); // question + answer, nothing more
  });

  it("hands an unrecognized reply to the dispatcher with the words intact, never a guess", async () => {
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 77, () => 62);
    clock.set(t(80));
    await agent.onReply({ atMs: t(80), channel: "chat", rawText: "asdf qwer" });
    expect(messenger.sent.at(-1)?.text).toBe(UNKNOWN_RESPONSE);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].body).toContain("asdf qwer");
    expect(mailer.sent[0].body).toMatch(/didn't understand|not understood/i);
  });

  it("escalates a level-3 reply immediately", async () => {
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 77, () => 62);
    clock.set(t(80));
    await agent.onReply({ atMs: t(80), channel: "chat", rawText: "truck broke down, engine light" });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toMatch(/breakdown/i);
    expect(mailer.sent[0].body).toContain("truck broke down, engine light");
    // The 07:27 question WAS answered. Calling it silence in the same email
    // that quotes the answer is the kind of contradiction a dispatcher never
    // forgives.
    expect(mailer.sent[0].body).toMatch(/07:27 — chat: .* — answered 07:30/);
    expect(mailer.sent[0].body).not.toMatch(/— no reply/);
  });

  it("writes the sheet the moment tracking starts, not on the next cadence tick", async () => {
    await accepted();
    expect(sheet.cells["W-19"]["Agent Status"]).toBe("Accepted");
    await drive(0, 0, (m) => m);
    expect(sheet.cells["W-19"]["Agent Status"]).toBe("Tracking");
    expect(events.events.some((e) => e.kind === "action" && e.evidence.kind === "departed")).toBe(true);
  });

  it("treats the mandatory break at the recommended stop as compliance: no message, one plan event", async () => {
    await accepted();
    await drive(0, 89, (m) => m);
    await drive(90, 140, () => 90); // 50 min at Love's Osceola, window is 65..155
    expect(messenger.sent.filter((m) => m.channel === "chat")).toHaveLength(0);
    const compliance = events.events.filter((e) => e.kind === "plan" && e.evidence.breakTakenAtMs);
    expect(compliance).toHaveLength(1);
    expect(agent.state.breakTakenAt).toBe(t(90));
  });

  it("keeps ONE open question even when a second anomaly fires", async () => {
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 100, () => 62); // parked long enough for the delay rule too
    const chats = messenger.sent.filter((m) => m.channel === "chat");
    expect(chats.every((c) => !/behind/i.test(c.text))).toBe(true); // no delay question while the stop is open
    expect(events.events.filter((e) => e.kind === "anomaly").map((e) => e.evidence.kind)).toContain("delay");
  });

  it("calls when messages go unanswered, and escalates with the whole ladder after the retry", async () => {
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 100, () => 62);
    // 77 message · 87 again · 102 call · 107 retry · 112 escalate
    expect(phone.calls).toHaveLength(0);
    await drive(101, 107, () => 62);
    expect(phone.calls).toHaveLength(2);
    expect(phone.calls[0].script).toContain("Bethany, MO");
    expect(mailer.sent).toHaveLength(0);
    await drive(108, 112, () => 62);
    expect(mailer.sent).toHaveLength(1);
    const body = mailer.sent[0].body;
    expect(body).toMatch(/no reply/i);
    expect(body).toMatch(/no answer/i);
    expect(body).toMatch(/07:27/); // the first question, on the dispatcher's clock
  });

  it("does not raise a delay during the mandatory break, even on a tight deadline", async () => {
    // Replay finding: the whole thirty was charged until the break was
    // complete, so sixteen minutes in the ETA passed the deadline and the
    // agent messaged him — during the one stop the plan itself required.
    agent = new Agent(
      { clock, router: new StraightRouter(60), sheet, messenger, phone, mailer, classifier: new KeywordClassifier(), events,
        restStops: [{ name: "Love's Osceola", ...pointAlongRoute(geometry, 90 / 179.5) }], landmarks: [],
        dispatcherEmail: "boss@dispatch.example", tz: "America/Chicago" },
      { ...brief, deadlineAtMs: t(230) },
    );
    await accepted();
    await drive(0, 89, (m) => m);
    await drive(90, 125, () => 90); // at Love's, inside the window
    expect(messenger.sent.filter((m) => m.channel === "chat" && /behind/i.test(m.text))).toHaveLength(0);
    expect(events.events.some((e) => e.kind === "anomaly" && e.evidence.kind === "delay")).toBe(false);
  });

  it("a delay that clears and comes back climbs a FRESH ladder", async () => {
    // Replay finding: a resolved delay was kept as a stopped ladder, so the
    // real traffic delay later could never re-raise — no call, no escalation.
    await accepted();
    await drive(0, 76, (m) => m * 0.6); // slow: 30.4 behind at 76 -> delay, one question
    await drive(77, 90, (m) => 45.6 + (m - 76) * 3); // catches up: the delay clears
    await drive(91, 140, (m) => 87.6 + (m - 90) * 0.25); // slow again: ETA passes the deadline
    const delayChats = messenger.sent.filter((m) => m.channel === "chat" && /behind/i.test(m.text));
    expect(delayChats).toHaveLength(2);
    expect(events.events.filter((e) => e.kind === "anomaly" && e.evidence.key === "delay" && e.evidence.resolved === true)).toHaveLength(1);
  });

  it("credits a reply to the ask it answered, not to an earlier ask that shares the key", async () => {
    // Two delays in one trip share the key "delay". The first question was
    // never answered; the second was. The escalation email must say exactly
    // that — not credit the second answer to the first question.
    await accepted();
    await drive(0, 76, (m) => m * 0.6); // delay #1 -> question at 07:25, never answered
    await drive(77, 90, (m) => 45.6 + (m - 76) * 3); // clears
    await drive(91, 140, (m) => 87.6 + (m - 90) * 0.25); // delay #2 -> question at 08:25
    clock.set(t(141));
    await agent.onReply({ atMs: t(141), channel: "chat", rawText: "truck broke down" }); // answers #2, level 3 -> escalation
    const body = mailer.sent.at(-1)!.body;
    expect(body).toMatch(/07:25 — chat: .* — no reply/);
    expect(body).toMatch(/08:25 — chat: .* — answered 08:31/);
  });

  it("marks arrival, writes the sheet, and sends the customer the arrival status", async () => {
    await accepted();
    await drive(0, 179, (m) => m);
    await drive(180, 186, () => 179.5);
    expect(agent.state.status).toBe("arrived");
    expect(sheet.cells["W-19"]["Agent Status"]).toBe("Arrived");
    const toCustomer = mailer.sent.find((m) => m.to === "ops@customer.example");
    expect(toCustomer?.body).toMatch(/arrived/i);
    expect(toCustomer?.body).toMatch(/on time|ahead/i);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/agent.test.ts`
Expected: FAIL — cannot find module `../src/core/agent.js`.

- [ ] **Step 4: Write the ports**

`night-shift/src/ports/index.ts`:
```ts
// Every way the agent touches the world, as an interface. The core never
// imports an adapter; tests use the fakes, production uses the real ones.
import type { AgentEvent, GeoPoint, RouteAnswer } from "../core/types.js";

export interface Clock {
  nowMs(): number;
}

export interface RouterPort {
  route(from: GeoPoint, to: GeoPoint): Promise<RouteAnswer>;
}

export interface SheetPort {
  writeStatus(loadRef: string, cells: Record<string, string>): Promise<void>;
  appendLog(loadRef: string, event: AgentEvent): Promise<void>;
}

export interface MessengerPort {
  sendChat(phone: string, text: string): Promise<void>;
  sendSms(phone: string, text: string): Promise<void>;
}

export interface CallOutcome {
  answered: boolean;
  transcript: string | null;
}

export interface PhonePort {
  call(phone: string, script: string): Promise<CallOutcome>;
}

export interface Attachment {
  name: string;
  body: string;
}

export interface MailerPort {
  send(to: string, subject: string, body: string, attachments?: Attachment[]): Promise<void>;
}

export interface ClassifierPort {
  classify(text: string): Promise<{ key: string | null; confidence: number }>;
}

export interface EventStore {
  append(event: AgentEvent): Promise<void>;
  all(): Promise<AgentEvent[]>;
}
```

- [ ] **Step 5: Write the fakes**

`night-shift/src/fakes/index.ts`:
```ts
// In-memory adapters. Each records what it was asked so a test can assert
// on the agent's behaviour through the ports, exactly as production would
// observe it. Nothing here is mocked with a library; they are small classes.
import { haversineMi, interpolate } from "../domain.js";
import { matchByKeywords } from "../core/situations.js";
import type { AgentEvent, GeoPoint, LngLat, RouteAnswer } from "../core/types.js";
import type { CallOutcome, Clock, ClassifierPort, EventStore, MailerPort, MessengerPort, PhonePort, RouterPort, SheetPort, Attachment } from "../ports/index.js";

export class FakeClock implements Clock {
  constructor(private t: number) {}
  nowMs(): number { return this.t; }
  set(ms: number): void { this.t = ms; }
  advanceMin(min: number): void { this.t += min * 60_000; }
}

/** A straight line densified to ~2 mi vertices, at a flat speed. Stands in
 *  for Mapbox in tests; the vertex spacing keeps projection meaningful. */
export class StraightRouter implements RouterPort {
  constructor(private mph: number = 60) {}
  async route(from: GeoPoint, to: GeoPoint): Promise<RouteAnswer> {
    const distanceMi = haversineMi(from, to);
    const n = Math.max(1, Math.ceil(distanceMi / 2));
    const geometry: LngLat[] = Array.from({ length: n + 1 }, (_, i) => {
      const p = interpolate(from, to, i / n);
      return [p.lng, p.lat];
    });
    return { geometry, distanceMi, driveMin: (distanceMi / this.mph) * 60 };
  }
}

export class MemorySheet implements SheetPort {
  cells: Record<string, Record<string, string>> = {};
  log: Array<{ loadRef: string; event: AgentEvent }> = [];
  async writeStatus(loadRef: string, cells: Record<string, string>): Promise<void> {
    this.cells = { ...this.cells, [loadRef]: { ...(this.cells[loadRef] ?? {}), ...cells } };
  }
  async appendLog(loadRef: string, event: AgentEvent): Promise<void> {
    this.log = [...this.log, { loadRef, event }];
  }
}

export class MemoryMessenger implements MessengerPort {
  sent: Array<{ phone: string; channel: "chat" | "sms"; text: string }> = [];
  async sendChat(phone: string, text: string): Promise<void> { this.sent = [...this.sent, { phone, channel: "chat", text }]; }
  async sendSms(phone: string, text: string): Promise<void> { this.sent = [...this.sent, { phone, channel: "sms", text }]; }
}

/** Every call goes unanswered unless a test queues an outcome. */
export class MemoryPhone implements PhonePort {
  calls: Array<{ phone: string; script: string }> = [];
  outcomes: CallOutcome[] = [];
  async call(phone: string, script: string): Promise<CallOutcome> {
    this.calls = [...this.calls, { phone, script }];
    const [next, ...rest] = this.outcomes;
    this.outcomes = rest;
    return next ?? { answered: false, transcript: null };
  }
}

export class MemoryMailer implements MailerPort {
  sent: Array<{ to: string; subject: string; body: string; attachments: Attachment[] }> = [];
  async send(to: string, subject: string, body: string, attachments: Attachment[] = []): Promise<void> {
    this.sent = [...this.sent, { to, subject, body, attachments }];
  }
}

export class KeywordClassifier implements ClassifierPort {
  async classify(text: string): Promise<{ key: string | null; confidence: number }> { return matchByKeywords(text); }
}

export class MemoryEvents implements EventStore {
  events: AgentEvent[] = [];
  async append(event: AgentEvent): Promise<void> { this.events = [...this.events, event]; }
  async all(): Promise<AgentEvent[]> { return this.events; }
}
```

- [ ] **Step 6: Write the phrases**

`night-shift/src/core/phrases.ts`:
```ts
// Every sentence the agent says or writes, in American English, assembled
// from evidence. No template here may state something its inputs do not
// carry (spec §11): a place is a landmark only if one is within range, a
// reply is quoted, and silence is written as silence.
import { haversineMi } from "../domain.js";
import { LANDMARK_RADIUS_MI } from "./constants.js";
import { projectOntoRoute } from "./geo.js";
import type { AgentEvent, Anomaly, Brief, DriverReply, GeoPoint, Place, Plan } from "./types.js";

export function clockLabel(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(new Date(ms));
}

/** "Bethany, MO" if a landmark is within LANDMARK_RADIUS_MI, else the mile
 *  along the route — a coordinate is never read out to a human. */
export function placeLabel(at: GeoPoint, landmarks: Place[], plan: Plan, originName: string): string {
  let best: { name: string; mi: number } | null = null;
  for (const l of landmarks) {
    const mi = haversineMi(at, l);
    if (mi <= LANDMARK_RADIUS_MI && (!best || mi < best.mi)) best = { name: l.name, mi };
  }
  if (best) return best.name;
  const { alongMi } = projectOntoRoute(plan.route.geometry, at);
  return Math.round(alongMi) + " mi out of " + originName;
}

export function inviteText(brief: Brief, tz: string): string {
  return (
    "Load " + brief.loadRef + ": " + brief.origin.name + " to " + brief.destination.name +
    ", departing " + clockLabel(brief.departAtMs, tz) + ", deliver by " + clockLabel(brief.deadlineAtMs, tz) +
    ". Tap Accept to share your location for this run."
  );
}

export interface PhraseContext {
  brief: Brief;
  plan: Plan;
  landmarks: Place[];
  tz: string;
}

/** One sentence of situation, one question. */
export function questionFor(a: Anomaly, ctx: PhraseContext): string {
  const ev = a.evidence as Record<string, number | { lat: number; lng: number }>;
  switch (a.kind) {
    case "unplanned_stop": {
      const where = placeLabel(ev.at as GeoPoint, ctx.landmarks, ctx.plan, ctx.brief.origin.name);
      return "You've been stopped " + ev.observedMin + " min near " + where + ", everything OK?";
    }
    case "delay":
      return "You're about " + ev.behindMin + " minutes behind for " + ctx.brief.destination.name + ". Is everything OK?";
    case "gone_dark":
      return "I haven't seen your location for " + ev.gapMin + " minutes. Everything OK?";
    case "off_route":
      return "You look to be off the planned route. Everything OK?";
  }
}

export function callScriptFor(a: Anomaly, ctx: PhraseContext): string {
  return "Hi, this is the dispatch assistant. " + questionFor(a, ctx);
}

export function escalationSubject(brief: Brief, reason: string): string {
  return "[" + brief.loadRef + "] " + brief.driverName + " — " + reason;
}

/** The whole ladder for this load, from the event log, on the dispatcher's
 *  clock. Silence is written as "no reply" / "no answer", never omitted. */
export function escalationBody(
  brief: Brief, reason: string, events: AgentEvent[], reply: DriverReply | null, draftAttached: boolean, tz: string,
): string {
  const lines: string[] = [];
  lines.push(brief.loadRef + " · " + brief.origin.name + " → " + brief.destination.name + " · " + brief.driverName);
  lines.push("");
  lines.push("Reason: " + reason);
  lines.push("");
  lines.push("What I did:");
  for (const e of events) {
    const at = clockLabel(e.atMs, tz);
    const ev = e.evidence as Record<string, unknown>;
    if (e.kind === "anomaly" && !ev.resolved) lines.push(at + " — noticed: " + String(ev.kind) + (ev.observedMin ? " (" + ev.observedMin + " min)" : "") + (ev.behindMin ? " (" + ev.behindMin + " min behind)" : ""));
    if (e.kind === "action" && (ev.kind === "message" || ev.kind === "message_again" || ev.kind === "sms")) {
      // "No reply" is a claim about silence, made only when nothing answered
      // this question. A reply is matched by the key it answered, not by
      // time alone, so a later answer to a different question does not
      // count. When it was answered, the line says when.
      const isAskWithSameKey = (m: AgentEvent): boolean =>
        m.kind === "action" &&
        (m.evidence as Record<string, unknown>).anomalyKey === ev.anomalyKey &&
        ["message", "message_again", "sms"].includes(String((m.evidence as Record<string, unknown>).kind));
      const answered = events.find(
        (r) =>
          r.kind === "reply" &&
          r.atMs >= e.atMs &&
          (r.evidence as Record<string, unknown>).answersKey === ev.anomalyKey &&
          // A reply answers the MOST RECENT ask with its key, not every ask
          // that shares the key. "delay" keeps one key across recurrences, so
          // without this an answer to the second delay would be credited to
          // the first, unanswered one.
          !events.some((m) => isAskWithSameKey(m) && m.atMs > e.atMs && m.atMs <= r.atMs),
      );
      lines.push(
        at + " — " + String(ev.channel) + ": \"" + String(ev.text) + "\"" +
          (answered ? " — answered " + clockLabel(answered.atMs, tz) : " — no reply"),
      );
    }
    if (e.kind === "call") lines.push(at + " — called: " + (ev.answered ? "answered" : "no answer"));
    if (e.kind === "reply") lines.push(at + " — driver replied: \"" + String(ev.rawText) + "\"");
  }
  if (reply) {
    lines.push("");
    lines.push("The driver's words, verbatim: \"" + reply.rawText + "\"");
  }
  if (draftAttached) {
    lines.push("");
    lines.push("The deadline is at risk. A customer email is attached as a draft. Reply \"send the customer email\" to send it as-is.");
  }
  return lines.join("\n");
}

export function customerDraft(brief: Brief, etaMs: number, tz: string): { subject: string; body: string } {
  return {
    subject: "Update on load " + brief.loadRef,
    body: "Load " + brief.loadRef + " (" + brief.origin.name + " to " + brief.destination.name + "): current ETA " + clockLabel(etaMs, tz) + ".",
  };
}

export function customerArrival(brief: Brief, arrivedMs: number, tz: string): { subject: string; body: string } {
  const lateMin = Math.round((arrivedMs - brief.deadlineAtMs) / 60_000);
  const verdict = lateMin > 0 ? lateMin + " minutes after the " + clockLabel(brief.deadlineAtMs, tz) + " deadline" : "on time";
  return {
    subject: "Load " + brief.loadRef + " arrived",
    body: "Load " + brief.loadRef + " arrived " + brief.destination.name + " at " + clockLabel(arrivedMs, tz) + ", " + verdict + ".",
  };
}
```

- [ ] **Step 7: Write the agent**

`night-shift/src/core/agent.ts`:
```ts
// The loop. Owns one trip's state and the event log; everything it does to
// the world goes through a port. Rules (detect.ts, ladder.ts, situations.ts)
// decide; this file sequences them and records evidence.
import { BREAK_DURATION_MIN, dwellSegments, haversineMi } from "../domain.js";
import type { AgentDeps } from "./agentDeps.js";
import { ACCEPT_GRACE_MIN, ARRIVAL_DWELL_MIN, ARRIVAL_RADIUS_MI, CLASSIFY_FLOOR, MIN_MS, PLANNED_STOP_RADIUS_MI, SHEET_WRITE_EVERY_MIN } from "./constants.js";
import { detectAnomalies } from "./detect.js";
import { applyAction, initialLadder, nextAction, stopLadder, type LadderAction, type LadderState } from "./ladder.js";
import { callScriptFor, clockLabel, customerArrival, customerDraft, escalationBody, escalationSubject, inviteText, placeLabel, questionFor } from "./phrases.js";
import { buildPlan, liveEtaMs, minutesBehindPlan } from "./plan.js";
import { situationFor, UNKNOWN_RESPONSE } from "./situations.js";
import type { AgentEvent, Anomaly, Brief, DriverReply, EventKind, Ping, Plan, TripStatus } from "./types.js";

export interface TripState {
  brief: Brief;
  plan: Plan | null;
  status: TripStatus;
  attentionReason: string | null;
  pings: Ping[];
  linkOpenedMs: number | null;
  acceptedAt: number | null;
  departedAt: number | null;
  arrivedAt: number | null;
  breakTakenAt: number | null;
  ladders: Record<string, LadderState>;
  openQuestionKey: string | null;
  lastSheetWriteMs: number | null;
  acceptEscalated: boolean;
  customerDraft: { subject: string; body: string } | null;
}

const STATUS_LABEL: Record<TripStatus, string> = {
  assigned: "Assigned", invited: "Invited", accepted: "Accepted", tracking: "Tracking", arrived: "Arrived", closed: "Closed", attention: "Attention",
};

export class Agent {
  state: TripState;

  constructor(private readonly deps: AgentDeps, brief: Brief) {
    this.state = {
      brief, plan: null, status: "assigned", attentionReason: null, pings: [], linkOpenedMs: null, acceptedAt: null,
      departedAt: null, arrivedAt: null, breakTakenAt: null, ladders: {}, openQuestionKey: null, lastSheetWriteMs: null,
      acceptEscalated: false, customerDraft: null,
    };
  }

  private patch(p: Partial<TripState>): void {
    this.state = { ...this.state, ...p };
  }

  async start(): Promise<void> {
    const { brief } = this.state;
    const route = await this.deps.router.route(brief.origin, brief.destination);
    const plan = buildPlan(brief, route, this.deps.restStops);
    this.patch({ plan, status: "invited" });
    await this.record("plan", {
      distanceMi: Math.round(route.distanceMi), driveMin: Math.round(route.driveMin), etaAtMs: plan.etaAtMs,
      breakWindow: plan.breakWindow ? { startMs: plan.breakWindow.startMs, endMs: plan.breakWindow.endMs, recommended: plan.breakWindow.recommended?.name ?? null } : null,
    });
    const text = inviteText(brief, this.deps.tz);
    await this.deps.messenger.sendSms(brief.driverPhone, text);
    await this.record("action", { kind: "invite", channel: "sms", text }, "invite sent");
    await this.writeSheet(true);
  }

  async onAccept(): Promise<void> {
    const now = this.deps.clock.nowMs();
    this.patch({ status: "accepted", acceptedAt: now, linkOpenedMs: now });
    await this.record("action", { kind: "accepted" }, "driver accepted");
    await this.writeSheet(true);
  }

  async onPing(ping: Ping): Promise<void> {
    const s = this.state;
    if (s.status === "invited") await this.onAccept(); // a ping is only possible from an opened link
    const first = this.state.status === "accepted";
    this.patch({ pings: [...this.state.pings, ping], linkOpenedMs: ping.atMs, ...(first ? { status: "tracking", departedAt: ping.atMs } : {}) });
    await this.record("ping", { atMs: ping.atMs, lat: ping.lat, lng: ping.lng });
    if (first) {
      // A state change writes the sheet now, not on the next cadence tick —
      // otherwise the row reads "Accepted" for up to fifteen minutes of
      // driving. Logged as an action so the briefing can say when he left.
      await this.record("action", { kind: "departed", atMs: ping.atMs }, "first ping — tracking");
      await this.writeSheet(true, ping.atMs);
    }
    await this.evaluate(ping.atMs);
  }

  async tick(): Promise<void> {
    await this.evaluate(this.deps.clock.nowMs());
  }

  async onReply(reply: DriverReply): Promise<void> {
    const { key, confidence } = await this.deps.classifier.classify(reply.rawText);
    const situationKey = key !== null && confidence >= CLASSIFY_FLOOR ? key : null;
    const situation = situationKey ? situationFor(situationKey) : null;
    const answersKey = this.state.openQuestionKey;
    await this.record("reply", { channel: reply.channel, rawText: reply.rawText, situationKey, confidence, answersKey });

    const response = situation ? situation.response : UNKNOWN_RESPONSE;
    await this.deps.messenger.sendChat(this.state.brief.driverPhone, response);
    await this.record("action", { kind: "respond", channel: "chat", text: response, situationKey }, "responded");

    if (answersKey && this.state.ladders[answersKey]) {
      this.patch({ ladders: { ...this.state.ladders, [answersKey]: stopLadder(this.state.ladders[answersKey], "replied") }, openQuestionKey: null });
    }
    if (!situation) await this.escalate("driver reply not understood", reply, null);
    else if (situation.level >= 2) await this.escalate("driver reports: " + situation.dispatcherNote, reply, null);
  }

  /** The dispatcher's reply-command vocabulary (spec §8). Anything else is
   *  echoed back, never acted on. */
  async onDispatcherReply(text: string): Promise<void> {
    const cmd = text.trim().toLowerCase();
    const { brief, customerDraft: draft } = this.state;
    if (cmd === "send the customer email" && draft && brief.customerEmail) {
      await this.deps.mailer.send(brief.customerEmail, draft.subject, draft.body);
      await this.record("email", { to: brief.customerEmail, kind: "customer_delay", subject: draft.subject }, "customer email sent on instruction");
      return;
    }
    await this.deps.mailer.send(this.deps.dispatcherEmail, "[" + brief.loadRef + "] I didn't understand that", "You wrote: \"" + text + "\"\n\nI can act on: send the customer email.");
    await this.record("email", { to: this.deps.dispatcherEmail, kind: "echo", text }, "unrecognized command echoed");
  }

  // ---------------------------------------------------------------- loop

  private async evaluate(nowMs: number): Promise<void> {
    const s = this.state;
    if (!s.plan) return;

    if (s.status === "invited" && !s.acceptEscalated && nowMs >= s.brief.departAtMs + ACCEPT_GRACE_MIN * MIN_MS) {
      this.patch({ status: "attention", attentionReason: "not accepted by departure + " + ACCEPT_GRACE_MIN + " min", acceptEscalated: true });
      await this.escalate("load not accepted by " + clockLabel(s.brief.departAtMs + ACCEPT_GRACE_MIN * MIN_MS, this.deps.tz), null, null);
      return;
    }
    if (s.status !== "tracking") return;

    const last = s.pings[s.pings.length - 1];
    if (!last) return;

    if (haversineMi(last, s.brief.destination) <= ARRIVAL_RADIUS_MI) {
      const seg = dwellSegments(s.pings, s.brief.destination, ARRIVAL_RADIUS_MI).find((x) => !x.departureObserved && x.lastSeenMs === last.atMs);
      if (seg && seg.observedMin >= ARRIVAL_DWELL_MIN) {
        // Arrival is when the truck GOT there (the first ping in the fence),
        // not the minute we became sure of it five minutes later.
        await this.arrive(seg.firstSeenMs, nowMs);
        return;
      }
    }

    await this.noteBreakCompliance(last);

    const anomalies = detectAnomalies(s.plan, s.pings, this.deps.restStops, nowMs, this.state.breakTakenAt !== null, this.breakCreditMin());
    const current = new Set(anomalies.map((a) => a.key));

    for (const key of Object.keys(this.state.ladders)) {
      if (current.has(key)) continue;
      // The anomaly is gone. DROP its ladder rather than mark it: a delay
      // that clears and comes back is a new situation and must climb a fresh
      // ladder — a kept "resolved" entry would silence it for the rest of the
      // trip. The record says it resolved; the state forgets it.
      const ladders = Object.fromEntries(Object.entries(this.state.ladders).filter(([k]) => k !== key)) as Record<string, LadderState>;
      this.patch({ ladders, openQuestionKey: this.state.openQuestionKey === key ? null : this.state.openQuestionKey });
      await this.record("anomaly", { key, resolved: true }, "resolved on its own");
    }

    for (const a of anomalies) {
      let ladder = this.state.ladders[a.key];
      if (!ladder) {
        ladder = initialLadder();
        this.patch({ ladders: { ...this.state.ladders, [a.key]: ladder } });
        await this.record("anomaly", { ...a.evidence, kind: a.kind, key: a.key });
      }
      if (ladder.stopped) continue;
      if (this.state.openQuestionKey && this.state.openQuestionKey !== a.key) continue; // one open question at a time
      const action = nextAction(ladder, { nowMs, linkOpenedMs: this.state.linkOpenedMs });
      if (action) await this.execute(a, ladder, action, nowMs);
    }

    await this.writeSheet(false, nowMs);
  }

  /** The mandatory break, taken in its window at a registered stop, is
   *  compliance. Recorded once so the briefing can say so; never messaged. */
  private async noteBreakCompliance(last: Ping): Promise<void> {
    const s = this.state;
    const w = s.plan?.breakWindow;
    if (!w || s.breakTakenAt !== null) return;
    if (last.atMs < w.startMs || last.atMs > w.endMs) return;
    const stop = this.deps.restStops.find((r) => haversineMi(r, last) <= PLANNED_STOP_RADIUS_MI);
    if (!stop) return;
    const seg = dwellSegments(s.pings, last).find((x) => !x.departureObserved && x.lastSeenMs === last.atMs);
    if (!seg || seg.observedMin < BREAK_DURATION_MIN) return;
    this.patch({ breakTakenAt: seg.firstSeenMs });
    await this.record("plan", { breakTakenAtMs: seg.firstSeenMs, at: stop.name, observedMin: seg.observedMin, recommended: w.recommended?.name === stop.name }, "mandatory break taken — compliance, no action");
  }

  /** Minutes already spent on a mandatory break that is IN PROGRESS — parked
   *  at a registered stop inside the window, break not yet complete. Owed
   *  break time shrinks as it is taken, so the ETA cannot project past the
   *  deadline in the middle of the one stop the plan itself required. */
  private breakCreditMin(): number {
    const s = this.state;
    const w = s.plan?.breakWindow;
    const last = s.pings[s.pings.length - 1];
    if (!w || s.breakTakenAt !== null || !last) return 0;
    if (last.atMs < w.startMs || last.atMs > w.endMs) return 0;
    if (!this.deps.restStops.some((r) => haversineMi(r, last) <= PLANNED_STOP_RADIUS_MI)) return 0;
    const seg = dwellSegments(s.pings, last).find((x) => !x.departureObserved && x.lastSeenMs === last.atMs);
    return seg ? Math.min(BREAK_DURATION_MIN, seg.observedMin) : 0;
  }

  private async execute(a: Anomaly, ladder: LadderState, action: LadderAction, nowMs: number): Promise<void> {
    const s = this.state;
    const ctx = { brief: s.brief, plan: s.plan!, landmarks: this.deps.landmarks, tz: this.deps.tz };
    const phone = s.brief.driverPhone;

    if (action.kind === "escalate") {
      this.patch({ ladders: { ...s.ladders, [a.key]: applyAction(ladder, action, nowMs) }, openQuestionKey: null });
      await this.escalate(a.kind.replace("_", " ") + " unresolved after " + ladder.callAttempts + " calls", null, a);
      return;
    }

    if (action.kind === "call" || action.kind === "call_retry") {
      const script = callScriptFor(a, ctx);
      const outcome = await this.deps.phone.call(phone, script);
      this.patch({ ladders: { ...s.ladders, [a.key]: applyAction(ladder, action, nowMs) } });
      await this.record("call", { anomalyKey: a.key, rung: action.rung, kind: action.kind, script, answered: outcome.answered, transcript: outcome.transcript }, action.kind);
      if (outcome.answered && outcome.transcript) await this.onReply({ atMs: nowMs, channel: "call", rawText: outcome.transcript });
      return;
    }

    const text = questionFor(a, ctx);
    const channel = action.kind === "sms" ? "sms" : "chat";
    if (channel === "sms") await this.deps.messenger.sendSms(phone, text);
    else await this.deps.messenger.sendChat(phone, text);
    this.patch({ ladders: { ...s.ladders, [a.key]: applyAction(ladder, action, nowMs) }, openQuestionKey: a.key });
    await this.record("action", { anomalyKey: a.key, rung: action.rung, kind: action.kind, channel, text }, action.kind);
  }

  private async escalate(reason: string, reply: DriverReply | null, anomaly: Anomaly | null): Promise<void> {
    const s = this.state;
    const nowMs = this.deps.clock.nowMs();
    const last = s.pings[s.pings.length - 1];
    const eta = s.plan && last ? liveEtaMs(s.plan, last, nowMs, s.breakTakenAt !== null, this.breakCreditMin()) : null;
    const deadlineAtRisk = eta !== null && s.plan !== null && eta > s.plan.deadlineAtMs;
    const draft = deadlineAtRisk && s.brief.customerEmail && eta !== null ? customerDraft(s.brief, eta, this.deps.tz) : null;
    this.patch({ customerDraft: draft });
    const events = await this.deps.events.all();
    const body = escalationBody(s.brief, reason, events, reply, draft !== null, this.deps.tz);
    await this.deps.mailer.send(this.deps.dispatcherEmail, escalationSubject(s.brief, reason), body, draft ? [{ name: "customer-draft.txt", body: draft.body }] : undefined);
    await this.record("escalation", { reason, deadlineAtRisk, draftAttached: draft !== null, anomalyKey: anomaly?.key ?? null });
    await this.writeSheet(true, nowMs);
  }

  private async arrive(arrivedAtMs: number, nowMs: number): Promise<void> {
    this.patch({ status: "arrived", arrivedAt: arrivedAtMs });
    const lateMin = Math.round((arrivedAtMs - this.state.brief.deadlineAtMs) / MIN_MS);
    await this.record("action", { kind: "arrived", arrivedAtMs, lateMin }, "arrived");
    await this.writeSheet(true, nowMs);
    const { brief } = this.state;
    if (brief.customerEmail) {
      const m = customerArrival(brief, arrivedAtMs, this.deps.tz);
      await this.deps.mailer.send(brief.customerEmail, m.subject, m.body);
      await this.record("email", { to: brief.customerEmail, kind: "customer_arrival" }, "customer told of arrival");
    }
  }

  // ------------------------------------------------------------- output

  private statusCells(nowMs: number): Record<string, string> {
    const s = this.state;
    const tz = this.deps.tz;
    const last = s.pings[s.pings.length - 1];
    const cells: Record<string, string> = { "Agent Status": STATUS_LABEL[s.status], "Last Update": clockLabel(nowMs, tz) };
    if (s.attentionReason) cells["Agent Status"] = STATUS_LABEL.attention + " — " + s.attentionReason;
    if (s.plan && last) {
      cells["Last Position"] = placeLabel(last, this.deps.landmarks, s.plan, s.brief.origin.name) + " · " + clockLabel(last.atMs, tz);
      const eta = liveEtaMs(s.plan, last, nowMs, s.breakTakenAt !== null, this.breakCreditMin());
      cells["ETA"] = clockLabel(eta, tz);
      const behind = Math.round(minutesBehindPlan(s.plan, last, nowMs));
      cells["On Time"] = (behind <= 0 ? "+" + -behind + " min" : "−" + behind + " min") + (eta > s.plan.deadlineAtMs ? ", deadline at risk" : "");
    }
    if (s.status === "arrived" && s.arrivedAt !== null) {
      const late = Math.round((s.arrivedAt - s.brief.deadlineAtMs) / MIN_MS);
      cells["On Time"] = late > 0 ? "arrived " + late + " min late" : "arrived on time";
    }
    return cells;
  }

  private async writeSheet(force: boolean, nowMs: number = this.deps.clock.nowMs()): Promise<void> {
    const s = this.state;
    if (!force && s.lastSheetWriteMs !== null && nowMs - s.lastSheetWriteMs < SHEET_WRITE_EVERY_MIN * MIN_MS) return;
    const cells = this.statusCells(nowMs);
    await this.deps.sheet.writeStatus(s.brief.loadRef, cells);
    this.patch({ lastSheetWriteMs: nowMs });
    await this.record("sheet_write", { cells });
  }

  private async record(kind: EventKind, evidence: Record<string, unknown>, actionTaken?: string): Promise<void> {
    const event: AgentEvent = { atMs: this.deps.clock.nowMs(), kind, evidence, ...(actionTaken ? { actionTaken } : {}) };
    await this.deps.events.append(event);
    if (kind !== "ping") await this.deps.sheet.appendLog(this.state.brief.loadRef, event);
  }
}
```

And the deps type, kept in its own file so `agent.ts` stays about the loop:

`night-shift/src/core/agentDeps.ts`:
```ts
import type { Place, RestStop } from "./types.js";
import type { Clock, ClassifierPort, EventStore, MailerPort, MessengerPort, PhonePort, RouterPort, SheetPort } from "../ports/index.js";

export interface AgentDeps {
  clock: Clock;
  router: RouterPort;
  sheet: SheetPort;
  messenger: MessengerPort;
  phone: PhonePort;
  mailer: MailerPort;
  classifier: ClassifierPort;
  events: EventStore;
  /** The registry the break planner and the stop rule read. */
  restStops: RestStop[];
  /** Named places used only to describe a position to a human. */
  landmarks: Place[];
  dispatcherEmail: string;
  /** IANA zone every clock label is rendered in, e.g. "America/Chicago". */
  tz: string;
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run tests/agent.test.ts && npm run typecheck`
Expected: 10 passed; tsc clean. If "asks ONE question" fails on the exact minute, check that `drive()` sets the clock before each ping — `record()` stamps events from the clock, not from the ping.

- [ ] **Step 9: Break it**

Remove the `if (this.state.openQuestionKey && this.state.openQuestionKey !== a.key) continue;` line → "keeps ONE open question" must fail. Restore. In `onReply`, drop the `stopLadder` patch → "records the driver's words verbatim … stops the ladder" must fail on the chat count. Restore. In `noteBreakCompliance`, remove the registered-stop check → "compliance" test still passes (the stop rule already exempts it) but the `plan` event's `at` becomes undefined; tighten the test to assert `evidence.at === "Love's Osceola"` and confirm it now fails. Restore.

- [ ] **Step 10: Commit (if lifted)**

```bash
git add night-shift/src/ports night-shift/src/fakes night-shift/src/core/phrases.ts night-shift/src/core/agent.ts night-shift/src/core/agentDeps.ts night-shift/src/core/constants.ts night-shift/tests/agent.test.ts
git commit -m "feat(night-shift): ports, fakes, phrases and the agent loop"
```

---

### Task 9: The Kansas City → Des Moines replay, end to end

**Files:**
- Create: `night-shift/src/replay/kcDesMoines.ts`, `night-shift/src/replay/run.ts`
- Test: `night-shift/tests/replay.test.ts`

**Interfaces:**
- Consumes: `Agent` and all fakes (Task 8).
- Produces:
  - `type ReplayStep = { atMin: number; kind: "accept" } | { atMin: number; kind: "ping"; mi: number } | { atMin: number; kind: "reply"; text: string } | { atMin: number; kind: "dispatcher"; text: string }`
  - `interface Scenario { t0Ms: number; brief: Brief; restStopsAtMi: Array<{ name: string; mi: number }>; landmarksAtMi: Array<{ name: string; mi: number }>; steps: ReplayStep[] }`
  - `kcDesMoines(): Scenario` — the spec §13 story as data. The mile function is the story: rolling at 60 mph; parked at Bethany (mile 62) minutes 62–81; rolling; parked at Love's Osceola (mile 90) minutes 110–140 for the mandatory break; traffic at 15 mph from 141 to 189; clear from 189; inside the arrival fence from minute 266.
  - `runReplay(scenario: Scenario): Promise<ReplayResult>` where `ReplayResult = { agent: Agent; events: AgentEvent[]; sheet: MemorySheet; messenger: MemoryMessenger; phone: MemoryPhone; mailer: MemoryMailer }`.

This is the demo (spec §13) and the integration test in one. The assertions below are the authority on the story's minutes; the spec's table is updated to match them (delay question at 08:44, arrival 10:36, 21 minutes late) — the rules produce these times, and the plan does not pretend otherwise.

- [ ] **Step 1: Write the failing test**

`night-shift/tests/replay.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { kcDesMoines } from "../src/replay/kcDesMoines.js";
import { runReplay, type ReplayResult } from "../src/replay/run.js";
import { clockLabel } from "../src/core/phrases.js";

// The whole story, asserted event by event. If this passes, the agent did
// what the spec says on the spec's clock, with nothing invented.
const TZ = "America/Chicago";
let r: ReplayResult;
const at = (kind: string, pred: (ev: Record<string, unknown>) => boolean = () => true) =>
  r.events.filter((e) => e.kind === kind && pred(e.evidence)).map((e) => clockLabel(e.atMs, TZ));

beforeAll(async () => {
  r = await runReplay(kcDesMoines());
});

describe("Kansas City → Des Moines replay", () => {
  it("invites by SMS at 06:10 and the driver accepts", () => {
    expect(r.messenger.sent[0].channel).toBe("sms");
    expect(at("action", (e) => e.kind === "accepted")).toEqual(["06:10"]);
  });

  it("asks about the Bethany stop at 07:27 — 15 minutes in, not sooner", () => {
    const questions = r.messenger.sent.filter((m) => m.channel === "chat" && /Bethany/.test(m.text));
    expect(questions).toHaveLength(1);
    expect(at("action", (e) => e.kind === "message" && /Bethany/.test(String(e.text)))).toEqual(["07:27"]);
  });

  it("records the reply verbatim at 07:31 as rest, answers, and tells nobody", () => {
    const reply = r.events.find((e) => e.kind === "reply");
    expect(clockLabel(reply!.atMs, TZ)).toBe("07:31");
    expect(reply!.evidence.rawText).toBe("had to use the bathroom, rolling now");
    expect(reply!.evidence.situationKey).toBe("rest");
    expect(r.mailer.sent.filter((m) => m.to === "boss@dispatch.example" && /rest/i.test(m.subject))).toHaveLength(0);
  });

  it("treats the mandatory break at Love's Osceola as compliance and sends nothing", () => {
    const compliance = r.events.filter((e) => e.kind === "plan" && e.evidence.breakTakenAtMs);
    expect(compliance).toHaveLength(1);
    expect(clockLabel(compliance[0].evidence.breakTakenAtMs as number, TZ)).toBe("08:00");
    expect(compliance[0].evidence.at).toBe("Love's Osceola");
    const between = r.events.filter((e) => e.kind === "action" && clockLabel(e.atMs, TZ) > "07:32" && clockLabel(e.atMs, TZ) < "08:44" && ["message", "message_again", "sms"].includes(String(e.evidence.kind)));
    expect(between).toHaveLength(0);
  });

  it("runs the delay ladder on the rules' clock: 08:44 · 08:54 · 09:09 · 09:14 · 09:19", () => {
    expect(at("anomaly", (e) => e.kind === "delay")).toEqual(["08:44"]);
    expect(at("action", (e) => e.anomalyKey === "delay" && e.kind === "message")).toEqual(["08:44"]);
    expect(at("action", (e) => e.anomalyKey === "delay" && e.kind === "message_again")).toEqual(["08:54"]);
    expect(at("call")).toEqual(["09:09", "09:14"]);
    expect(r.phone.calls.every((c) => /behind/.test(c.script))).toBe(true);
    expect(at("escalation")).toEqual(["09:19"]);
  });

  it("escalates with the whole ladder, the quote, the silence, and the customer draft attached", () => {
    const esc = r.mailer.sent.find((m) => m.to === "boss@dispatch.example" && /delay/i.test(m.subject));
    expect(esc).toBeDefined();
    expect(esc!.body).toContain("07:27");
    expect(esc!.body).toContain("\"had to use the bathroom, rolling now\"");
    expect(esc!.body).toMatch(/08:44 — chat: .* — no reply/);
    expect(esc!.body).toMatch(/09:09 — called: no answer/);
    expect(esc!.attachments[0].name).toBe("customer-draft.txt");
    expect(esc!.attachments[0].body).toMatch(/ETA 10:3\d/);
    const escEvent = r.events.find((e) => e.kind === "escalation");
    expect(escEvent!.evidence.deadlineAtRisk).toBe(true);
  });

  it("sends the customer email only on the dispatcher's word, at 09:22", () => {
    const toCustomer = r.mailer.sent.filter((m) => m.to === "ops@customer.example");
    expect(toCustomer[0].subject).toBe("Update on load W-19");
    expect(at("email", (e) => e.kind === "customer_delay")).toEqual(["09:22"]);
  });

  it("arrives at 10:36, 21 minutes late, and says so to the customer and the sheet", () => {
    expect(r.agent.state.status).toBe("arrived");
    expect(clockLabel(r.agent.state.arrivedAt!, TZ)).toBe("10:36");
    const arrival = r.mailer.sent.find((m) => m.to === "ops@customer.example" && /arrived/.test(m.subject));
    expect(arrival!.body).toMatch(/21 minutes after the 10:15 deadline/);
    expect(r.sheet.cells["W-19"]["Agent Status"]).toBe("Arrived");
    expect(r.sheet.cells["W-19"]["On Time"]).toBe("arrived 21 min late");
  });

  it("said exactly four things to the driver in chat, and never during his break", () => {
    const chats = r.messenger.sent.filter((m) => m.channel === "chat").map((m) => m.text);
    expect(chats).toHaveLength(4); // Bethany question, "Got it, thanks.", delay question, delay again
    expect(chats[1]).toBe("Got it, thanks.");
  });

  it("wrote the sheet on the 15-minute cadence and on every escalation, never a full-sheet overwrite", () => {
    const writes = at("sheet_write");
    expect(writes.length).toBeGreaterThan(15);
    expect(writes).toContain("09:19");
    expect(Object.keys(r.sheet.cells["W-19"]).sort()).toEqual(["Agent Status", "ETA", "Last Position", "Last Update", "On Time"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/replay.test.ts`
Expected: FAIL — cannot find module `../src/replay/kcDesMoines.js`.

- [ ] **Step 3: Write the scenario**

`night-shift/src/replay/kcDesMoines.ts`:
```ts
// The spec §13 story as data: one run, Kansas City to Des Moines, with the
// anomalies at the minutes the story needs. The mile function IS the story.
// Every other number the replay produces (07:27, 08:44, 10:36) is the rules
// reading this data — nothing below states an outcome.
import type { Brief } from "../core/types.js";

export type ReplayStep =
  | { atMin: number; kind: "accept" }
  | { atMin: number; kind: "ping"; mi: number }
  | { atMin: number; kind: "reply"; text: string }
  | { atMin: number; kind: "dispatcher"; text: string };

export interface Scenario {
  t0Ms: number;
  brief: Brief;
  restStopsAtMi: Array<{ name: string; mi: number }>;
  landmarksAtMi: Array<{ name: string; mi: number }>;
  steps: ReplayStep[];
}

const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
/** 06:10 America/Chicago on Sat Sep 6 2026. */
const T0 = Date.UTC(2026, 8, 6, 11, 10);
const MIN = 60_000;
/** StraightRouter's length for this pair; the destination sits at this mile. */
const END_MI = 179.5;

/** Where the truck is at minute `m`. Piecewise, deliberately. */
export function mileAt(m: number): number {
  if (m <= 61) return m;                                  // 60 mph out of KC
  if (m <= 81) return 62;                                 // Bethany, MO: 20 minutes, not on the plan
  if (m <= 109) return 62 + (m - 82);                     // rolling again; reaches mile 90 at 110
  if (m <= 140) return 90;                                // Love's Osceola: the mandatory 30, in its window
  if (m <= 189) return 90 + 0.25 * (m - 140);             // traffic north of Osceola, 15 mph
  return Math.min(END_MI, 102.25 + (m - 189));            // clears; inside the arrival fence from minute 266
}

export function kcDesMoines(): Scenario {
  const brief: Brief = {
    loadRef: "W-19",
    origin: { name: "Kansas City, MO", ...KC },
    destination: { name: "Des Moines, IA", ...DSM },
    equipment: "DryVan",
    departAtMs: T0,
    deadlineAtMs: T0 + 245 * MIN, // 10:15
    driverName: "Jake Morrow",
    driverPhone: "+15550001",
    customerEmail: "ops@customer.example",
    // 6h10 already driven on an earlier load: the 8-hour mark lands 110 min in.
    minutesSinceBreakAtDepart: 370,
  };
  const steps: ReplayStep[] = [{ atMin: 0, kind: "accept" }];
  for (let m = 0; m <= 280; m += 1) {
    steps.push({ atMin: m, kind: "ping", mi: mileAt(m) });
    if (m === 81) steps.push({ atMin: 81, kind: "reply", text: "had to use the bathroom, rolling now" });
    if (m === 192) steps.push({ atMin: 192, kind: "dispatcher", text: "send the customer email" });
  }
  return {
    t0Ms: T0,
    brief,
    restStopsAtMi: [{ name: "Love's Osceola", mi: 90 }],
    landmarksAtMi: [{ name: "Bethany, MO", mi: 62 }, { name: "Osceola, IA", mi: 95 }],
    steps,
  };
}
```

- [ ] **Step 4: Write the runner**

`night-shift/src/replay/run.ts`:
```ts
// Runs a scenario through the real Agent with the in-memory fakes. Time is
// the scenario's: the clock is set to each step's minute before the step is
// delivered, so every event is stamped on the story's clock.
import { Agent } from "../core/agent.js";
import { pointAlongRoute } from "../core/geo.js";
import type { AgentEvent, Place } from "../core/types.js";
import { FakeClock, KeywordClassifier, MemoryEvents, MemoryMailer, MemoryMessenger, MemoryPhone, MemorySheet, StraightRouter } from "../fakes/index.js";
import type { Scenario } from "./kcDesMoines.js";

export interface ReplayResult {
  agent: Agent;
  events: AgentEvent[];
  sheet: MemorySheet;
  messenger: MemoryMessenger;
  phone: MemoryPhone;
  mailer: MemoryMailer;
}

const MIN = 60_000;

export async function runReplay(scenario: Scenario): Promise<ReplayResult> {
  const clock = new FakeClock(scenario.t0Ms);
  const router = new StraightRouter(60);
  const sheet = new MemorySheet();
  const messenger = new MemoryMessenger();
  const phone = new MemoryPhone();
  const mailer = new MemoryMailer();
  const events = new MemoryEvents();

  const route = await router.route(scenario.brief.origin, scenario.brief.destination);
  const atMi = (mi: number): Place & { mi: number } => ({ name: "", mi, ...pointAlongRoute(route.geometry, mi / route.distanceMi) });
  const restStops = scenario.restStopsAtMi.map((r) => ({ ...atMi(r.mi), name: r.name }));
  const landmarks = scenario.landmarksAtMi.map((l) => ({ ...atMi(l.mi), name: l.name }));

  const agent = new Agent(
    { clock, router, sheet, messenger, phone, mailer, classifier: new KeywordClassifier(), events, restStops, landmarks, dispatcherEmail: "boss@dispatch.example", tz: "America/Chicago" },
    scenario.brief,
  );
  await agent.start();

  const steps = [...scenario.steps].sort((a, b) => a.atMin - b.atMin);
  for (const step of steps) {
    const nowMs = scenario.t0Ms + step.atMin * MIN;
    clock.set(nowMs);
    switch (step.kind) {
      case "accept":
        await agent.onAccept();
        break;
      case "ping": {
        const p = pointAlongRoute(route.geometry, step.mi / route.distanceMi);
        await agent.onPing({ atMs: nowMs, lat: p.lat, lng: p.lng });
        break;
      }
      case "reply":
        await agent.onReply({ atMs: nowMs, channel: "chat", rawText: step.text });
        break;
      case "dispatcher":
        await agent.onDispatcherReply(step.text);
        break;
    }
  }
  return { agent, events: events.events, sheet, messenger, phone, mailer };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/replay.test.ts && npm test && npm run typecheck`
Expected: 10 passed in the replay; the whole package green; tsc clean.

If a minute is off by one, the cause is almost always the step order at a shared minute (the ping at 81 must be delivered before the reply at 81; `sort` is stable and the scenario pushes the ping first) or the clock not being set before a step. Do not "fix" it by editing an expected time — find which rule fired when, from the event log.

- [ ] **Step 6: Break it, once, through the rules**

In `constants.ts`, set `STOP_MIN = 10` → the Bethany question moves to 07:22 and the replay's "07:27" assertion must fail, proving the replay is driven by the rules and not by the scenario. Restore.

- [ ] **Step 7: Update the spec's replay table to the rules' minutes**

In `docs/superpowers/specs/2026-09-06-night-shift-agent-design.md` §13, set the delay row to 08:44 / min 154, the rungs to 08:54 · 09:09 · 09:14 · 09:19, the dispatcher reply to 09:22, and arrival to 10:36 / min 266 / 21 min late. The replay is the authority; the spec's table describes it.

- [ ] **Step 8: Commit (if lifted)**

```bash
git add night-shift/src/replay night-shift/tests/replay.test.ts docs/superpowers/specs/2026-09-06-night-shift-agent-design.md
git commit -m "feat(night-shift): Kansas City to Des Moines replay, asserted event by event"
```

---

## Self-review

**Spec coverage.** §3 rules-decide → Tasks 4–7 are deterministic, no model. §4 lifecycle → `Agent` states and the accept-grace escalation (Task 8); the real SMS link and browser location are the Driver Link plan. §5 plan → Task 3. §6 rules and exemptions → Tasks 4–5, with the break exemption tested by name. §7 ladder and cooldowns → Task 7; one-open-question → Task 8. §8 sheet columns and cadence → `statusCells`/`writeSheet` (Task 8), five columns plus the log tab; the morning briefing and the reply-command vocabulary beyond `send the customer email` are the Briefing plan. §9 library and classification → Task 6; the supervised learning loop is the Library plan. §10 voice → `PhonePort` and the call rungs; Twilio is the Telephony plan. §11 honesty → `phrases.ts` writes silence as silence and quotes as quotes; asserted in Tasks 8–9. §12 data → `AgentEvent`/`TripState` in memory; Prisma persistence is the Adapters plan. §13 replay → Task 9.

**Placeholders.** None. Every step carries its code.

**Type consistency.** `RouteAnswer.geometry: LngLat[]` throughout; `Ping extends GeoPoint` so `dwellSegments(pings, center)` accepts it; `Anomaly.evidence` is `Record<string, unknown>` and `phrases.ts` narrows it at the one place it reads numbers; `LadderState` is returned new from every function; `AgentDeps` lives in its own file and both `agent.ts` and the tests import it by path.

## Follow-on plans (each its own file, in this order)

1. **Driver Link** — Twilio SMS invite, the accept page, browser geolocation, the ping endpoint; a real `MessengerPort` for chat.
2. **Sheet Adapter** — Microsoft Graph worksheet read (delta) and cell-range write; `AgentTrip` from a row; column mapping per org.
3. **Adapters and persistence** — Mapbox `RouterPort` via `fleet-backend`'s `resolveRoutes`; Prisma `EventStore`; the Agent* models and migration; the worker process that runs many trips.
4. **Briefing** — morning email from the event log; the full reply-command vocabulary; scheduled customer status.
5. **Telephony** — Twilio voice `PhonePort`, en-US TTS/STT, the two-turn script.
6. **Library** — LLM `ClassifierPort` behind the same floor; the supervised proposal loop.
7. **Stage replay** — the 60× harness against the real adapters and a demo inbox.
