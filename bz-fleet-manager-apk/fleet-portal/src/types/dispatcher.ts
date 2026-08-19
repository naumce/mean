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
