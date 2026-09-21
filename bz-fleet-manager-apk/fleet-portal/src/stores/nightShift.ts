import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'

// Night Shift on the Board (spec §17): the setup screen's store. Mirrors
// fleet-backend's lib/agentPolicies.ts `agentPolicySchema` field-for-field —
// this IS that object, JSON round-tripped over /dispatcher/night-shift/policies
// (same "wire twin" convention lib/api.ts uses for Lock, BoardLoad, etc.).
export interface AgentPolicy {
  id: string
  name: string
  stopMin: number
  delayMin: number
  darkMin: number
  darkAtStopMin: number
  offRouteMi: number
  offRouteMin: number
  rungGapMin: number
  maxCalls: number
  dispatcherEmail: string
  dispatcherPhone: string | null
  customerEmailOn: boolean
  shadow: boolean
  bossCallOn: boolean
  quietFrom: string | null
  quietTo: string | null
}

/** What the setup screen posts/puts — every field `agentPolicySchema`
 *  validates, plus an optional `id`: present means "PUT this policy",
 *  absent means "POST a new one" (savePolicy branches on it). */
export type AgentPolicyInput = Omit<AgentPolicy, 'id'> & { id?: string }

/** One line of a load's supervision timeline — merges `AgentUpdate` rows and
 *  `AgentEvent`s newest-first, mirroring GET /loads/:id/agent's `timeline`
 *  entries field-for-field. `evidence` only ever arrives on an event row. */
export interface AgentTimelineEntry {
  atMs: number
  kind: string
  text: string
  evidence?: unknown
}

/** GET /loads/:id/agent's full body — the load's agent state plus its
 *  timeline in one response (there is no separate timeline endpoint). */
export interface AgentForLoad {
  enabled: boolean
  /** The board's LOAD#, when the load carries one (final fix wave, minor):
   *  the deep-link page has no board row to take it from, so the timeline
   *  answers it. Optional so older fixtures still type-check. */
  boardLoadNo?: string | null
  policy: AgentPolicy
  pill: string
  line: string | null
  timeline: AgentTimelineEntry[]
}

/** The drawer's supervision actions (spec §17.3), same vocabulary as the
 *  server's `COMMAND_KINDS`. */
export type AgentCommandKind = 'stop' | 'call' | 'reply' | 'correct' | 'takeover' | 'handback' | 'send_customer_email'

/** AgentDrawer.vue's injectable transport (Task 10, the deep link): the
 *  drawer is mounted both by an authenticated dispatcher session (via this
 *  store) and by a session-less phone view (nightshift/views/
 *  NightShiftLinkView.vue, opened from a status cell's URL token). Defined
 *  here — not in the .vue file — so nightshift/api/linkApi.ts can implement
 *  it without importing a Vue SFC. */
export interface NightShiftApi {
  timeline(loadId: string): Promise<AgentForLoad>
  command(loadId: string, kind: AgentCommandKind, payload?: unknown): Promise<{ command: unknown }>
}

interface NightShiftState {
  policies: AgentPolicy[]
  /** policyId -> count of loads that explicitly name it (never a fallback
   *  count — a load running Standard by fallback is not counted against it,
   *  per the server's own comment on GET /night-shift/policies). */
  loadsByPolicy: Record<string, number>
  loading: boolean
  error: string | null
}

export const useNightShiftStore = defineStore('nightShift', {
  state: (): NightShiftState => ({
    policies: [],
    loadsByPolicy: {},
    loading: false,
    error: null,
  }),

  actions: {
    async loadPolicies(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { data } = await api.get<{ policies: AgentPolicy[]; loadsByPolicy: Record<string, number> }>(
          '/dispatcher/night-shift/policies',
        )
        this.policies = data.policies
        this.loadsByPolicy = data.loadsByPolicy
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load night-shift policies right now.')
      } finally {
        this.loading = false
      }
    },

    /** `input.id` present -> PUT (the whole policy, per the server's PUT
     *  contract — there is no partial-patch route); absent -> POST a new one. */
    async savePolicy(input: AgentPolicyInput): Promise<AgentPolicy> {
      this.loading = true
      this.error = null
      const { id, ...body } = input
      try {
        const { data } = id
          ? await api.put<{ policy: AgentPolicy }>(`/dispatcher/night-shift/policies/${id}`, body)
          : await api.post<{ policy: AgentPolicy }>('/dispatcher/night-shift/policies', body)
        await this.loadPolicies()
        return data.policy
      } catch (error) {
        this.error = extractApiErrorMessage(
          error,
          id ? 'Unable to update the policy right now.' : 'Unable to create the policy right now.',
        )
        this.loading = false
        throw error
      }
    },

    async deletePolicy(id: string): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await api.delete(`/dispatcher/night-shift/policies/${id}`)
        await this.loadPolicies()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to delete the policy right now.')
        this.loading = false
        throw error
      }
    },

    // --- Per-load agent state (Tasks 6 and 7 build the UI on these) --------

    /** GET /loads/:id/agent — the load's current agent state (policy, pill,
     *  board line) and its full supervision timeline in one call. */
    async agentFor(loadId: string): Promise<AgentForLoad> {
      const { data } = await api.get<AgentForLoad>(`/dispatcher/loads/${loadId}/agent`)
      return data
    },

    /** POST /loads/:id/agent — the switch. `policyId` omitted leaves the
     *  load's current policy untouched (server-side default: Standard).
     *  `baseVersion` is the version backstop (spec §7.4): the route rejects
     *  with 409 `{ error: "STALE_VERSION", current }` when the row moved
     *  under the caller, the same shape brokerBoard.ts's `editCell` already
     *  reads off a stale write — callers (AgentSwitch.vue) read it the same
     *  way rather than inventing a second shape, then reload the row and say
     *  so; there is no keep-mine/take-theirs choice here (unlike a cell
     *  edit's `conflicts`), just a switch flip that needs to be retried on
     *  the fresh version. Omitted when the caller has not rendered a row at
     *  all (a script, a test). */
    async setSwitch(loadId: string, enabled: boolean, policyId?: string, baseVersion?: number): Promise<{ load: unknown; version: number }> {
      const body: { enabled: boolean; policyId?: string; baseVersion?: number } = { enabled }
      if (policyId !== undefined) body.policyId = policyId
      if (baseVersion !== undefined) body.baseVersion = baseVersion
      const { data } = await api.post<{ load: unknown; version: number }>(`/dispatcher/loads/${loadId}/agent`, body)
      return data
    },

    /** Sugar over `agentFor` for callers that only want the timeline — there
     *  is no separate timeline route on the server. */
    async timeline(loadId: string): Promise<AgentTimelineEntry[]> {
      const { timeline } = await this.agentFor(loadId)
      return timeline
    },

    /** POST /loads/:id/agent/commands — a supervision action from the drawer. */
    async command(loadId: string, kind: AgentCommandKind, payload?: unknown): Promise<{ command: unknown }> {
      const body: { kind: AgentCommandKind; payload?: unknown } = { kind }
      if (payload !== undefined) body.payload = payload
      const { data } = await api.post<{ command: unknown }>(`/dispatcher/loads/${loadId}/agent/commands`, body)
      return data
    },
  },
})
