// Type declarations for seed-world.mjs — a plain JS/ESM module (seeds run
// under `node`, which cannot execute TypeScript) — so tests/seed-world.test.ts
// can import it without `any`. Kept in sync BY HAND with seed-world.mjs's
// actual exports; there is no build step that would catch drift here, so
// keep this file's shape narrow (only what a caller actually needs) rather
// than mirroring every internal field.
//
// TypeScript's extension-mapping rule for an import ending ".mjs" resolves it
// to a co-located ".d.mts" — this is the one declaration file that resolution
// actually finds, so it is the only one committed.
import type { PrismaClient } from "@prisma/client";

export interface SeedWorldOptions {
  /** Multiplies only the BULK counts (drivers beyond the scenario cast,
   *  historical loads beyond the named drivers' dedicated history, current
   *  loads beyond the 14 scenario ones). Defaults to 1 (full scale). */
  scale?: number;
  /** Epoch ms; rounded down to the top of the hour internally. Defaults to
   *  the real clock. */
  now?: number;
}

export interface SeedWorldCounts {
  customers: number;
  drivers: number;
  historicalLoads: number;
  currentLoads: number;
  loads: number;
}

export interface SeedWorldResult {
  orgId: string;
  counts: SeedWorldCounts;
}

export function seedWorld(prisma: PrismaClient, options?: SeedWorldOptions): Promise<SeedWorldResult>;

export interface ScenarioMeta {
  code: string;
  externalId: string;
  title: string;
  hint: string;
}
export const SCENARIOS: ScenarioMeta[];

export const ORG_NAME: string;
/** Identical to ORG_NAME — the name a caller outside seed-world.mjs's own
 *  seeding flow (e.g. `POST /sim/reset`) looks the demo org up by. */
export const WORLD_ORG_NAME: string;
export const ORG_TIMEZONE: string;
export const DISPATCHER_EMAIL: string;
export const DISPATCHER_PASSWORD: string;
export const WORLD_LOAD_TAG: string;
export const WORLD_DRIVER_TAG: string;
export const AGENT_POLICY_NAME: string;

/** E.164 phones for the 4 cast drivers the Night Shift agent mix
 *  (seed-mix-brief.md) gives a `Driver.phone` — keyed by cast.mjs's own
 *  `key`. Every other driver (cast or bulk) stays phoneless. */
export const CAST_PHONES: Record<string, string>;

/** Dwayne's three most recent delivered loads — the only historical loads
 *  that keep `agentEnabled: true`/`agentPill: "delivered"` once history
 *  otherwise goes dark (seed-mix-brief.md rule 3). */
export const DWAYNE_DELIVERED_EXTERNAL_IDS: string[];

export interface CastHos {
  driveRemainingMin: number;
  windowRemainingMin: number;
  cycleRemainingMin: number;
  minutesSinceBreak: number;
}

export interface CastMember {
  key: string;
  scenarioCode: string | null;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  externalId: string;
  id: string;
  homeBaseCity: string;
  homeBaseState: string;
  homeBaseLat: number;
  homeBaseLng: number;
  equipmentTypes: string[];
  yearsExperience: number;
  homeTimeTarget: string | null;
  hos: CastHos;
}
export const CAST: CastMember[];
