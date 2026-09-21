// Memory across trips (slice 4, 2026-09-19): what the platform already
// knows about this driver, these places and this lane from every run that
// came before, folded into numbers the agent can use tonight. Pure over
// rows the worker fetches (live/memoryLoader.ts); nothing here reads a
// database. Every figure carries its sample size — three visits is a hint,
// thirty is a habit — and a screen or a prompt that quotes one quotes the
// count with it.
import { dwellSegments } from "../domain.js";
import type { GeoPoint } from "./types.js";

/** One past visit to a place: the pings of the driver who ran it, around
 *  the stop's planned window. */
export interface PlaceVisitRows {
  address: string;
  at: GeoPoint;
  pings: Array<{ atMs: number; lat: number; lng: number }>;
}

export interface PlaceMemory {
  address: string;
  visits: number;
  /** Median observed dwell across visits, minutes. Null with no visit that
   *  produced a dwell (pings never sat inside the radius). */
  medianDwellMin: number | null;
  maxDwellMin: number | null;
}

export interface DriverTripRows {
  /** The trip's events, in order, as the worker recorded them. */
  events: Array<{ kind: string; evidence: Record<string, unknown> }>;
}

export interface DriverMemory {
  trips: number;
  callsPlaced: number;
  callsAnswered: number;
  textsAsked: number;
  textsAnswered: number;
  /** Newest last; the situation keys the driver's replies were classified into. */
  recentSituations: string[];
}

export interface LaneRunRows {
  /** Delivery deadline vs when the run actually completed; null when never completed. */
  deadlineMs: number;
  completedMs: number | null;
  anomalyKinds: string[];
}

export interface LaneMemory {
  from: string;
  to: string;
  runs: number;
  lateArrivals: number;
  /** Anomaly kinds seen on this lane, most frequent first. */
  commonAnomalies: Array<{ kind: string; count: number }>;
}

export interface TripMemory {
  /** Keyed by the stop's address exactly as the brief carries it. */
  places: Record<string, PlaceMemory>;
  driver: DriverMemory | null;
  lane: LaneMemory | null;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

/** The longest dwell each visit produced inside the stop's radius — a driver
 *  who left and came back is one visit with two segments, and the longer
 *  one is the one the shipper cost him. */
export function placeMemory(address: string, visits: PlaceVisitRows[]): PlaceMemory {
  const dwells = visits
    .map((v) => dwellSegments(v.pings, v.at).reduce((best, seg) => Math.max(best, seg.observedMin), 0))
    .filter((d) => d > 0)
    .map((d) => Math.round(d));
  return { address, visits: visits.length, medianDwellMin: median(dwells), maxDwellMin: dwells.length ? Math.max(...dwells) : null };
}

const isTextAsk = (e: { kind: string; evidence: Record<string, unknown> }): boolean =>
  e.kind === "action" && (e.evidence.kind === "message" || e.evidence.kind === "message_again" || e.evidence.kind === "sms");

export function driverMemory(trips: DriverTripRows[]): DriverMemory | null {
  if (trips.length === 0) return null;
  let callsPlaced = 0, callsAnswered = 0, textsAsked = 0, textsAnswered = 0;
  const situations: string[] = [];
  for (const trip of trips) {
    for (const e of trip.events) {
      if (e.kind === "call" && !e.evidence.failed) {
        callsPlaced += 1;
        if (e.evidence.answered === true) callsAnswered += 1;
      } else if (isTextAsk(e)) {
        textsAsked += 1;
      } else if (e.kind === "reply") {
        if (e.evidence.channel === "chat" || e.evidence.channel === "sms") textsAnswered += 1;
        if (typeof e.evidence.situationKey === "string") situations.push(e.evidence.situationKey);
      }
    }
  }
  return { trips: trips.length, callsPlaced, callsAnswered, textsAsked, textsAnswered: Math.min(textsAnswered, textsAsked), recentSituations: situations.slice(-5) };
}

export function laneMemory(from: string, to: string, runs: LaneRunRows[]): LaneMemory | null {
  if (runs.length === 0) return null;
  const counts = new Map<string, number>();
  let late = 0;
  for (const r of runs) {
    if (r.completedMs !== null && r.completedMs > r.deadlineMs) late += 1;
    for (const k of r.anomalyKinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const commonAnomalies = [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
  return { from, to, runs: runs.length, lateArrivals: late, commonAnomalies };
}

/** Plain sentences for a prompt or a drawer — facts with their counts,
 *  nothing when there is nothing. */
export function memoryLines(m: TripMemory): string[] {
  const out: string[] = [];
  for (const p of Object.values(m.places)) {
    if (p.visits > 0 && p.medianDwellMin !== null) out.push(`${p.address}: median dwell ${p.medianDwellMin} min over ${p.visits} past visit${p.visits === 1 ? "" : "s"} (longest ${p.maxDwellMin}).`);
  }
  const d = m.driver;
  if (d) {
    const parts = [`${d.trips} past run${d.trips === 1 ? "" : "s"} with this agent`];
    if (d.callsPlaced) parts.push(`answered ${d.callsAnswered} of ${d.callsPlaced} calls`);
    if (d.textsAsked) parts.push(`replied to ${d.textsAnswered} of ${d.textsAsked} texts`);
    out.push("Driver: " + parts.join(", ") + ".");
    if (d.recentSituations.length) out.push("Driver's recent situations: " + d.recentSituations.join(", ") + ".");
  }
  const l = m.lane;
  if (l) {
    const anomalies = l.commonAnomalies.slice(0, 3).map((a) => `${a.kind} ×${a.count}`).join(", ");
    out.push(`Lane ${l.from} → ${l.to}: ${l.runs} past run${l.runs === 1 ? "" : "s"}, ${l.lateArrivals} late${anomalies ? "; seen: " + anomalies : ""}.`);
  }
  return out;
}
