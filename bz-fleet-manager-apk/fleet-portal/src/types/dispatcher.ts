export interface Dispatcher {
  id: string
  email: string
  name: string
  createdAt: string
}

// GET /dispatcher/overview returns a map of trip status -> count, e.g.
// { pending: 3, in_progress: 2, completed: 10 }. Keys are dynamic (driven by
// whatever trip statuses exist), so this is intentionally a loose record.
export type OverviewCounts = Record<string, number>

export interface TripStop {
  id: string
  sequence: number
  address: string
  status?: string
}

export interface ChecklistItem {
  id: string
  label: string
  required: boolean
  completed?: boolean
}

export interface SignsProof {
  id: string
  tripId: string
  stopId?: string | null
  proofType: string
  fileUrl: string
  status: string
  createdAt: string
}

export interface Trip {
  id: string
  identifier: string
  status: string
  driverId: string | null
  stops: TripStop[]
  checklistItems?: ChecklistItem[]
  proofs?: SignsProof[]
  createdAt: string
}

export interface TripStopInput {
  sequence: number
  address: string
}

export interface ChecklistItemInput {
  label: string
  required: boolean
}

export interface TripCreatePayload {
  identifier: string
  stops: TripStopInput[]
  checklistItems?: ChecklistItemInput[]
}

export interface TripListFilters {
  status?: string
  driverId?: string
}

export interface Message {
  id: string
  senderType: string
  text: string
  createdAt: string
}

// GET /dispatcher/conversations returns lastMessage as the full message row
// (or null when the conversation has no messages yet) — always read
// `lastMessage?.text`, never assume it's present.
export interface Conversation {
  id: string
  driverId: string
  driverName: string
  lastMessage: Message | null
  unread: number
}

export interface DriverLocation {
  driverId: string
  driverName?: string
  latitude: number
  longitude: number
  speed?: number
  createdAt: string
}
