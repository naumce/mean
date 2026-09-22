import { api } from '../../lib/api'

// Task 5: the thin client for /api/dispatcher/night-shift/api-keys
// (fleet-backend routes/dispatcherApiKeys.ts) — session-only, org-scoped.
// Portal isolation: lives here, not in lib/api.ts, same discipline sheetApi.ts
// follows for the sheet endpoints.

export interface ApiKeySummary {
  id: string
  name: string
  prefix: string
  createdAt: string
  revokedAt: string | null
}

export async function fetchKeys(): Promise<ApiKeySummary[]> {
  const { data } = await api.get<{ keys: ApiKeySummary[] }>('/dispatcher/night-shift/api-keys')
  return data.keys
}

export interface IssuedApiKey {
  key: string
  id: string
  prefix: string
}

export async function createKey(name: string): Promise<IssuedApiKey> {
  const { data } = await api.post<IssuedApiKey>('/dispatcher/night-shift/api-keys', { name })
  return data
}

export async function revokeKey(id: string): Promise<void> {
  await api.delete(`/dispatcher/night-shift/api-keys/${id}`)
}
