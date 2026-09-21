import axios from 'axios'
import { API_BASE_URL } from '../../lib/api'
import type { AgentCommandKind, AgentForLoad, NightShiftApi } from '../../stores/nightShift'

// Task 10 (the deep link): the phone-side transport for AgentDrawer, built
// from the org token in the route (/n/:orgToken/:loadId) instead of a
// dispatcher's bearer session. A dedicated axios instance — never the shared
// `api` client from lib/api.ts — because that client's interceptors attach
// an Authorization header from localStorage and, on a 401, try to refresh
// and log out a dispatcher session that does not exist here. This client
// sends no auth header at all; the org token travels in the URL path, the
// same way it arrived off the status cell's note.
export function linkApi(orgToken: string): NightShiftApi {
  const client = axios.create({ baseURL: API_BASE_URL })

  return {
    async timeline(loadId: string): Promise<AgentForLoad> {
      const { data } = await client.get<AgentForLoad>(`/n/${orgToken}/loads/${loadId}/agent`)
      return data
    },
    async command(loadId: string, kind: AgentCommandKind, payload?: unknown): Promise<{ command: unknown }> {
      const body: { kind: AgentCommandKind; payload?: unknown } = { kind }
      if (payload !== undefined) body.payload = payload
      const { data } = await client.post<{ command: unknown }>(`/n/${orgToken}/loads/${loadId}/agent/commands`, body)
      return data
    },
  }
}
