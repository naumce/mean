// Driver Supply (AI Dispatch Foundation, Task 9). Every interface here
// mirrors a fleet-backend wire shape field-for-field — see the source files
// named in each comment — rather than a portal-invented approximation.

/** lib/driverAvailability.ts's AvailabilityStatus. */
export type AvailabilityStatus = 'AVAILABLE' | 'AVAILABLE_SOON' | 'ON_LOAD' | 'OFF_DUTY' | 'UNAVAILABLE'

/** geocode.ts's NearestKnownPlace. */
export interface NearPlace {
  city: string
  state: string
  distanceMi: number
}

export interface CurrentPing {
  lat: number
  lng: number
  at: number
  near: NearPlace | null
}

export interface CurrentAssignment {
  loadId: string
  loadRef: string
  deliveryEtaMs: number
  deliveryCity: string | null
}

export interface AvailableProjection {
  lat: number | null
  lng: number | null
  city: string | null
  state: string | null
}

/** lib/driverAvailability.ts's DriverAvailabilityView — GET
 *  /dispatcher/drivers/availability and GET/PATCH .../:id/availability. */
export interface DriverAvailabilityView {
  driverId: string
  acceptingLoads: boolean
  locationSharingEnabled: boolean
  locationSharingUpdatedAt: string | null
  shareToken: string | null
  status: AvailabilityStatus
  availableAt: number
  available: AvailableProjection
  current: CurrentPing | null
  currentAssignment: CurrentAssignment | null
  source: 'manual' | 'derived' | 'simulation' | 'none'
}

/** PATCH /dispatcher/drivers/:id/availability body — every field optional,
 *  at least one required (enforced server-side). */
export interface PatchAvailabilityBody {
  acceptingLoads?: boolean
  availabilityStatus?: 'AVAILABLE' | 'OFF_DUTY' | 'UNAVAILABLE'
  availableAt?: string
  availableCity?: string
  availableState?: string
  availableLat?: number
  availableLng?: number
}

/** HosState, as returned nested on a Driver row (dispatcherDrivers.ts's
 *  `include: { hos: true }`) — null when the driver has no HosState row. */
export interface DriverHos {
  driveRemainingMin: number
  windowRemainingMin: number
  cycleRemainingMin: number
  minutesSinceBreak: number
  lastResetAt: string | null
  updatedAt: string
  importedAt: string | null
}

/** The Task 1 enrichment fields (+ base identity) GET /dispatcher/drivers
 *  already returns — dispatchTools/drivers.ts's DRIVER_PROFILE_SELECT lists
 *  the identical field set server-side. Deliberately omits the wire
 *  payload's own `status` (the driver's account/app status — active,
 *  offline, ...): Driver Supply has no use for it, and declaring it here
 *  would collide with DriverAvailabilityView's differently-typed `status`
 *  (the AvailabilityStatus this feature actually renders) once the two are
 *  intersected into SupplyDriver below. */
export interface DriverProfile {
  id: string
  name: string
  firstName: string | null
  lastName: string | null
  phone: string | null
  cdlClass: string
  hazmatEndorsed: boolean
  endorsements: string[]
  equipmentTypes: string[]
  languages: string[]
  preferredLanguage: string
  homeBaseCity: string | null
  homeBaseState: string | null
  yearsExperience: number | null
  hos: DriverHos | null
}

/** A driver row as Driver Supply renders it: profile fields alongside that
 *  driver's current availability, flattened into one object (`id` from the
 *  profile half, `driverId` from the availability half — the same driver,
 *  kept under both names rather than dropping either caller's field). */
export type SupplyDriver = DriverProfile & DriverAvailabilityView

export interface LaneExperience {
  laneKey: string
  originCity: string | null
  destCity: string | null
  runs: number
  lastRunAt: string | null
}

/** lib/driverMetrics.ts's DriverMetrics — GET .../:id/metrics. Every number
 *  is evidence-derived; null means "no evidence", never rendered as 0/—. */
export interface DriverMetrics {
  driverId: string
  asOf: string
  completedLoads: number
  onTimeLoads: number
  lateLoads: number
  onTimeRate: number | null
  averageDelayMinutes: number | null
  averageDetentionMinutes: number | null
  averageResponseMinutes: number | null
  responseRate: number | null
  noResponseIncidents: number
  breakdownIncidents: number
  accidentIncidents: number
  loadsLast30Days: number
  nightLoads: number
  laneExperience: LaneExperience[]
  evidence: { assignments: number; agentTrips: number; agentEvents: number }
}

/** lib/driverHistory.ts's DriverHistoryRow — GET .../:id/history. */
export interface DriverHistoryRow {
  assignmentId: string
  loadId: string
  loadRef: string
  customerName: string | null
  customerId: string | null
  originCity: string | null
  destCity: string | null
  laneKey: string | null
  plannedStart: string
  plannedEnd: string
  completedAt: string | null
  deliveryWindowEnd: string | null
  late: boolean | null
  lateMinutes: number | null
}

/** dispatcherDriverSupply.ts's DriverPreferenceView — GET/PATCH
 *  .../:id/preference. GET answers this exact shape whether or not a
 *  DriverPreference row exists yet (server-side defaults). */
export interface DriverPreference {
  maxTripMiles: number | null
  preferredRegions: string[]
  preferredLanes: string[]
  avoidRegions: string[]
  avoidLanes: string[]
  homeTimeTarget: string | null
  willingToDriveNight: boolean
  willingToRelocateMiles: number | null
  preferredEquipment: string[]
}

/** PATCH /dispatcher/drivers/:id/preference body — every field optional, at
 *  least one required (enforced server-side). */
export type PatchPreferenceBody = Partial<DriverPreference>

export interface DriverSupplyFilters {
  statuses: AvailabilityStatus[]
  equipment: string | null
  language: string | null
  state: string | null
  acceptingOnly: boolean
}
