// The live trips this worker is watching. One Agent per load; the worker
// ticks them all once a minute. A throw inside one trip's tick is logged and
// contained — the other trucks are still on the road.
import type { Agent } from "../core/agent.js";
import { STANDARD } from "../core/policy.js";
import type { Policy } from "../core/policy.js";
import type { Brief, RestStop } from "../core/types.js";
import { log } from "./log.js";
import { newDriverToken, newTripId } from "./tokens.js";

export interface LiveTrip {
  tripId: string;
  driverToken: string;
  brief: Brief;
  agent: Agent;
  startedAtMs: number;
  policy: Policy;
  /** The board load this trip watches (MODE=platform). Null for a file-mode
   *  trip, which has no `Load` row to link. */
  loadId: string | null;
  /** The org this trip belongs to — "file" outside platform mode. Task 8's
   *  sync loop and Task 10's link both key off this. */
  orgId: string;
  /** The number this trip's texts come from — the org's own sender once it
   *  has one (orgTelephony.ts), else the env fallback. What `byPhone`
   *  matches a webhook's `To` against, so two orgs sharing a driver phone
   *  never cross-deliver a text into the wrong trip. */
  sender: string;
  /** The number this trip's calls come from. Usually the same as `sender`;
   *  differs when the sender is an alphanumeric ID (letters cannot place a
   *  call — see config.ts). */
  callerId: string;
}

/** What `build` gets: the ids, the brief, the registered stops near the
 *  road — resolved by the worker before the trip starts, because the agent
 *  needs them to plan the break and the stop rule needs them on every ping —
 *  the policy that trip's thresholds and shadow/live toggle come from, and
 *  (MODE=platform) the load it watches, so a platform adapter (PlatformSheet)
 *  can be built scoped to that load. */
export type BuildAgent = (trip: { tripId: string; driverToken: string; brief: Brief; restStops: RestStop[]; policy: Policy; loadId: string | null; orgId: string; sender: string; callerId: string }) => Agent;

export class Registry {
  private trips: Record<string, LiveTrip> = {};
  // A second index, kept beside `trips` rather than folded into it: a trip's
  // own identity (tripId/driverToken) never changes, but "which load is
  // this" is the one lookup the platform poll and the command worker need
  // that byId/byToken cannot answer — a load switched on before the previous
  // poll's trip finished starting must find the SAME trip, not start a
  // second one, and a supervision command addressed to a load must find its
  // trip without the caller tracking trip ids itself.
  private byLoad: Record<string, string> = {};

  constructor(private readonly build: BuildAgent) {}

  async start(
    brief: Brief,
    ids: { tripId?: string; driverToken?: string } = {},
    // No policy given: STANDARD, which runs in shadow until a dispatcher
    // reviews it — never a silent live launch on an unconfigured default.
    // orgId/sender/callerId are REQUIRED, deliberately not defaulted: a
    // silent "" fallback here would let a future call site that forgets
    // them compile a trip with sender:"" — and an inbound webhook with an
    // empty `To` would then match it, exactly the cross-tenant misdelivery
    // `byPhone(from, to)` exists to prevent. Every real and test call site
    // must say what org/number this trip is.
    extras: { restStops?: RestStop[]; policy?: Policy; loadId?: string; orgId: string; sender: string; callerId: string },
  ): Promise<LiveTrip> {
    const tripId = ids.tripId ?? newTripId();
    const driverToken = ids.driverToken ?? newDriverToken();
    const policy = extras.policy ?? STANDARD;
    const loadId = extras.loadId ?? null;
    const { orgId, sender, callerId } = extras;
    const agent = this.build({ tripId, driverToken, brief, restStops: extras.restStops ?? [], policy, loadId, orgId, sender, callerId });
    const trip: LiveTrip = { tripId, driverToken, brief, agent, startedAtMs: Date.now(), policy, loadId, orgId, sender, callerId };
    this.trips = { ...this.trips, [tripId]: trip };
    if (loadId) this.byLoad = { ...this.byLoad, [loadId]: tripId };
    await agent.start();
    log("info", "trip started", { tripId, loadRef: brief.loadRef, loadId, status: agent.state.status });
    return trip;
  }

  byId(tripId: string): LiveTrip | null {
    return this.trips[tripId] ?? null;
  }

  byToken(token: string): LiveTrip | null {
    return Object.values(this.trips).find((t) => t.driverToken === token) ?? null;
  }

  /** Matches a live trip by driver phone AND by that trip's own org sender
   *  — a driver phone reused across two orgs (or a stale row) must never
   *  cross-deliver a text into the wrong trip. */
  byPhone(from: string, to: string): LiveTrip | null {
    return Object.values(this.trips).find((t) => t.brief.driverPhone === from && t.sender === to) ?? null;
  }

  /** The running trip watching a given load, or null when none is (MODE=platform). */
  byLoadId(loadId: string): LiveTrip | null {
    const tripId = this.byLoad[loadId];
    return tripId ? this.byId(tripId) : null;
  }

  /** Every load currently watched. What the platform poll diffs its fresh
   *  read of the board against, to find trips whose load was switched off
   *  or delivered since the last poll. */
  watchedLoadIds(): string[] {
    return Object.keys(this.byLoad);
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
    const loadEntry = Object.entries(this.byLoad).find(([, v]) => v === tripId);
    if (loadEntry) {
      const { [loadEntry[0]]: _loadGone, ...restLoad } = this.byLoad;
      void _loadGone;
      this.byLoad = restLoad;
    }
    log("info", "trip stopped", { tripId });
  }
}
