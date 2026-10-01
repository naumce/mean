// AI Agents Surface (Task 4): wire types for GET /dispatcher/agents/overview.
// Mirrors fleet-backend/src/lib/agentsOverview.ts's `AgentsOverview`
// field-for-field (the plan's own "type consistency" self-review requires
// Tasks 3 and 4 to stay identical) — this IS that response, JSON
// round-tripped, same wire-twin convention lib/api.ts already uses for
// Lock/PlanResult/BreakPlanEntry etc.

export interface AgentsOverview {
  generatedAt: string
  dispatch: {
    rules: { available: true }
    model: {
      configured: boolean
      reachable: boolean | null
      modelPresent: boolean | null
      model: string | null
      error: string | null
    }
    activity: {
      running: { runId: string; loadId: string | null; loadNo: string | null; startedAt: string | null } | null
      queued: number
      lastRun: {
        runId: string
        loadId: string | null
        status: string
        driverId: string | null
        driverName: string | null
        confidence: number | null
        completedAt: string | null
        promptVersion: string | null
      } | null
    }
  }
  nightShift: {
    service: { configured: boolean; lastActivityAt: string | null }
    activity: {
      watching: number
      waitingReply: number
      invited: number
      escalated: number
      held: number
      attention: number
      delivered: number
      off: number
      total: number
      listed: number
    }
    mode: { shadowLoads: number; liveLoads: number; livePolicies: number }
    enforcement: { customerEmailOn: 'not_enforced'; quietHours: 'not_enforced' }
    loads: Array<{
      loadId: string
      boardLoadNo: string | null
      pill: string
      mode: 'shadow' | 'live' | 'off'
      activity: string
      next: string
      nextConfidence: 'known' | 'inferred' | 'unknown'
      lastEventAt: string | null
    }>
  }
}

export type AgentLoadRowData = AgentsOverview['nightShift']['loads'][number]
