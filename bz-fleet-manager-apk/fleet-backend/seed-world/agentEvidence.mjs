import { stableId } from "./prng.mjs";

// Night Shift AgentTrip/AgentEvent builders — evidence shapes copied by hand
// from night-shift/src/core/agent.ts's own `record(...)` call sites (never
// imported: this package's hard rule, restated in driverResponseMetrics.ts's
// own header comment, is that fleet-backend never imports night-shift/).
// Every shape below is exactly what a real trip would have written, so
// src/lib/driverResponseMetrics.ts and driverMetrics.ts read this seeded
// evidence exactly as they would a live trip's.

/** `AgentTrip.id` has NO @default in the schema — every trip needs an
 *  explicit id. Keyed off the load's own externalId so it is stable across
 *  reruns without depending on call order. */
export function tripId(loadRef) {
  return stableId(`agentTrip:${loadRef}`);
}

/** Minimal-but-shaped Brief (night-shift/src/core/types.ts) — only what a
 *  reader of AgentTrip.brief might reasonably display; nothing here is read
 *  by driverMetrics/driverResponseMetrics (they only ever read AgentEvent
 *  rows), so this stays intentionally small. */
export function buildBrief({ loadRef, origin, destination, equipment, departAtMs, deadlineAtMs, driverName, driverPhone, customerEmail, minutesSinceBreakAtDepart }) {
  return {
    loadRef,
    origin: { name: origin.name, lat: origin.lat, lng: origin.lng },
    destination: { name: destination.name, lat: destination.lat, lng: destination.lng },
    equipment,
    departAtMs,
    deadlineAtMs,
    driverName,
    driverPhone,
    customerEmail: customerEmail ?? null,
    minutesSinceBreakAtDepart: minutesSinceBreakAtDepart ?? null,
  };
}

export function buildTrip({ loadRef, loadId, brief, status = "tracking" }) {
  const id = tripId(loadRef);
  return {
    id,
    loadRef,
    loadId,
    driverToken: stableId(`driverToken:${loadRef}`),
    brief,
    status,
  };
}

/** ASK — driverResponseMetrics.ts's `isTextAsk`: kind "action", evidence.kind
 *  one of message|message_again|sms. Fields verbatim from agent.ts line 498
 *  (`this.record("action", { anomalyKey, rung, kind, channel, text }, ...)`). */
export function askEvent(tripId_, atMs, { kind = "message", anomalyKey, rung = 1, channel = "sms", text }) {
  return { tripId: tripId_, atMs: BigInt(atMs), kind: "action", evidence: { kind, anomalyKey, rung, channel, text } };
}

/** REPLY — evidence shape verbatim from agent.ts line 191. `situationKey`
 *  null for an ordinary "yep, on my way"; "breakdown"/"accident" are the two
 *  values driverResponseMetrics.ts counts into breakdownIncidents/
 *  accidentIncidents. */
export function replyEvent(tripId_, atMs, { channel = "sms", rawText, situationKey = null, confidence = 0.9, answersKey }) {
  return { tripId: tripId_, atMs: BigInt(atMs), kind: "reply", evidence: { channel, rawText, situationKey, confidence, answersKey } };
}

/** ESCALATION — driverResponseMetrics.ts's `isNoResponseEscalation` matches
 *  on evidence.reason containing "unresolved" or "could not reach". Shape
 *  verbatim from agent.ts line 566. `reason` here always uses the
 *  "<kind> unresolved after N calls" template real escalations use
 *  (agent.ts line 466). */
export function escalationEvent(tripId_, atMs, { reason, anomalyKey = null, deadlineAtRisk = false, draftAttached = false, messageId = null }) {
  return {
    tripId: tripId_,
    atMs: BigInt(atMs),
    kind: "escalation",
    evidence: { reason, deadlineAtRisk, draftAttached, anomalyKey, messageId },
  };
}

/** ANOMALY — shape verbatim from agent.ts line 397
 *  (`record("anomaly", { ...a.evidence, kind: a.kind, key: a.key })`), for an
 *  unplanned_stop specifically mirroring detect.ts's own evidence fields
 *  (firstSeenMs/lastSeenMs/observedMin/pingCount/at/thresholdMin/
 *  inBreakWindow). Leaving it with no later "resolved: true" row (agent.ts
 *  line 389) is what makes it read as still OPEN — scenario J's exact ask. */
export function unplannedStopAnomalyEvent(tripId_, atMs, { firstSeenMs, lastSeenMs, observedMin, pingCount, at, thresholdMin }) {
  const key = `unplanned_stop@${firstSeenMs}`;
  return {
    tripId: tripId_,
    atMs: BigInt(atMs),
    kind: "anomaly",
    evidence: { firstSeenMs, lastSeenMs, observedMin, pingCount, at, thresholdMin, inBreakWindow: false, kind: "unplanned_stop", key },
  };
}

/** PLAN — shape verbatim from agent.ts line 82. Optional flavor (only
 *  scenario J uses it, for a trip that otherwise reads as suspiciously
 *  event-free); never read by driverMetrics/driverResponseMetrics. */
export function planEvent(tripId_, atMs, { distanceMi, driveMin, etaAtMs }) {
  return {
    tripId: tripId_,
    atMs: BigInt(atMs),
    kind: "plan",
    evidence: { distanceMi: Math.round(distanceMi), driveMin: Math.round(driveMin), etaAtMs, breakWindow: null, itinerary: {} },
  };
}
