import type { Itinerary } from "./itinerary.js";
import type { TripMemory } from "./memory.js";

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
  /** Everything else the platform knows about the load and the driver
   *  (slice "platform GPS + rich brief", 2026-09-19). Optional so a
   *  file-mode brief and the replay fixtures — which have none of it —
   *  keep working; every reader treats a missing context as "not known",
   *  never as empty facts. */
  context?: BriefContext;
}

export interface BriefStop extends Place {
  type: "pickup" | "delivery" | "intermediate";
  /** Appointment window in ms, either side null when the platform has none. */
  windowStartMs: number | null;
  windowEndMs: number | null;
  /** Planned dwell at this stop, null when the dispatcher never set one. */
  dwellMin: number | null;
}

export interface DriverHos {
  driveRemainingMin: number;
  windowRemainingMin: number;
  cycleRemainingMin: number;
  minutesSinceBreak: number;
}

export interface BriefContext {
  /** The platform driver, so the worker can read the fleet's own GPS for
   *  him (`DriverLocation`). Null when the load runs on a carrier contact
   *  with no driver row. */
  driverId: string | null;
  /** Every geocoded stop in sequence — pickup, intermediates, delivery —
   *  so the stop rule treats a planned intermediate as planned. */
  stops: BriefStop[];
  hazmatClass: string | null;
  commodity: string | null;
  customerName: string | null;
  brokerName: string | null;
  /** The dispatcher's own words on the load, verbatim: the notes field,
   *  the APPT SCHEDULE cell and the UPDATE cell. Null when empty. */
  notes: string | null;
  apptText: string | null;
  updateText: string | null;
  /** The driver's full clock at start, null when the platform has none. */
  hos: DriverHos | null;
  /** Slice 4: what past runs say about these places, this driver and this
   *  lane. Absent when nothing was looked up (file mode, tests). */
  memory?: TripMemory;
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
  /** Slice 2 (2026-09-19): the whole run laid out in time — every stop,
   *  break, rest and fuel stop with its planned clock, the HOS verdict and
   *  the slack against the deadline. What the drawer shows; the plan line
   *  below still does the measuring. */
  itinerary: Itinerary;
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
  /** How sure the speech engine is of `rawText`, when the reply came off a
   *  call. Absent or null for typed channels, where the words are the words.
   *  Below CLASSIFY_FLOOR the transcript is not evidence and the reply is
   *  handled as unknown — the dispatcher gets the words, not a guess. */
  confidence?: number | null;
  /** Slice 3: a call the conversation port settled carries its verdict, so
   *  the reply is recorded with it instead of a second, keyword guess. */
  verdict?: { key: string | null; confidence: number };
}

export type EventKind = "ping" | "plan" | "anomaly" | "action" | "reply" | "escalation" | "sheet_write" | "email" | "call" | "dispatcher_call" | "would_say";

export interface AgentEvent {
  atMs: number;
  kind: EventKind;
  evidence: Record<string, unknown>;
  actionTaken?: string;
}

export type TripStatus = "assigned" | "invited" | "accepted" | "tracking" | "arrived" | "closed" | "attention";
