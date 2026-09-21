import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { DISPATCHER_STORAGE_KEY, ORG_STORAGE_KEY, PLAN_STORAGE_KEY, REFRESH_STORAGE_KEY, TOKEN_STORAGE_KEY } from '../lib/constants'
import { extractApiErrorMessage } from '../lib/errors'
import type { Dispatcher, Org } from '../types/dispatcher'

/** The subscription tier carried on the session (Task 1, backend). "sheet"
 *  is the Night-Shift-only, Google-Sheet-plugin tier; "tower" is today's
 *  full dispatch product. Absent on a session persisted before this field
 *  existed, so `tier` always defaults to "tower" (see the getter below). */
export interface SessionPlan {
  tier: 'sheet' | 'tower'
}

interface LoginResponse {
  dispatcher: Dispatcher
  token: string
  refreshToken: string
  org?: Org | null
  plan?: SessionPlan | null
}

/** What this store actually keeps for the signed-in dispatcher. Deliberately
 *  narrower than `Dispatcher` (src/types/dispatcher.ts) in exactly one field
 *  — `createdAt` — because nothing here reads it. `orgId` stays: login,
 *  signup, and `/auth/me` all return it (fix round 3 — `/auth/me` used to
 *  strip it, which was the one real divergence between the three payloads
 *  and the reason a cast used to sit here bridging them). `Dispatcher` stays
 *  as-is for callers that legitimately want the full row; `login`/`signup`
 *  fetch that fuller shape and it's structurally assignable down to this
 *  one, so they need no special handling. */
interface StoredDispatcher {
  id: string
  email: string
  name: string
  orgId?: string | null
}

/** GET /dispatcher/auth/me's response, minus the token pair (no new token
 *  is issued). The route (fleet-backend routes/dispatcherAuth.ts) selects
 *  exactly this trimmed field list, so `StoredDispatcher` is also this
 *  response's real shape, not just the store's. */
interface MeResponse {
  dispatcher: StoredDispatcher
  org?: Org | null
  plan?: SessionPlan | null
}

interface SignupResponse extends LoginResponse {
  org: Org
}

export interface SignupPayload {
  orgName: string
  name: string
  email: string
  password: string
  timezone?: string
  /** Which product this signup is for (Task 1, backend). Omit for the
   *  default (tower); pass "nightshift" only when the signup link says so
   *  (SignupView reads it from ?product=). */
  product?: 'nightshift' | 'tower'
}

/** Rehydrate the stored org. The token survives a refresh, so the org must
 *  too: without it the cockpit falls back to a default timezone and silently
 *  redraws the whole board two hours off. Anything unreadable or malformed in
 *  storage degrades to "no org known" rather than throwing at store creation. */
function readStoredOrg(): Org | null {
  try {
    const raw = localStorage.getItem(ORG_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Org) : null
  } catch {
    return null
  }
}

function persistOrg(org: Org | null): void {
  if (org) localStorage.setItem(ORG_STORAGE_KEY, JSON.stringify(org))
  else localStorage.removeItem(ORG_STORAGE_KEY)
}

/** Rehydrate the stored dispatcher. The token survives a refresh, so the
 *  dispatcher identity must too: `loadLocks`' `theirs` getter reads
 *  `dispatcher?.id` and, by design, treats a null id as "nobody is signed
 *  in" — so without this every lock badge and read-only guard silently
 *  disappears after a reload. Anything unreadable or malformed in storage
 *  degrades to "no dispatcher known" rather than throwing at store creation. */
function readStoredDispatcher(): StoredDispatcher | null {
  try {
    const raw = localStorage.getItem(DISPATCHER_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as StoredDispatcher) : null
  } catch {
    return null
  }
}

function persistDispatcher(dispatcher: StoredDispatcher | null): void {
  if (dispatcher) localStorage.setItem(DISPATCHER_STORAGE_KEY, JSON.stringify(dispatcher))
  else localStorage.removeItem(DISPATCHER_STORAGE_KEY)
}

/** Rehydrate the stored plan tier. Same "degrade to unknown rather than
 *  throw" contract as the org/dispatcher readers above; the `tier` getter
 *  treats a null plan as "tower", so malformed storage is harmless. */
function readStoredPlan(): SessionPlan | null {
  try {
    const raw = localStorage.getItem(PLAN_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as SessionPlan) : null
  } catch {
    return null
  }
}

function persistPlan(plan: SessionPlan | null): void {
  if (plan) localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plan))
  else localStorage.removeItem(PLAN_STORAGE_KEY)
}

interface AuthState {
  token: string | null
  dispatcher: StoredDispatcher | null
  org: Org | null
  plan: SessionPlan | null
  error: string | null
}

export interface SetSessionPayload {
  token: string
  dispatcher: StoredDispatcher
  org?: Org | null
  plan?: SessionPlan | null
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    token: localStorage.getItem(TOKEN_STORAGE_KEY),
    dispatcher: readStoredDispatcher(),
    org: readStoredOrg(),
    plan: readStoredPlan(),
    error: null,
  }),

  getters: {
    isAuthenticated: (state): boolean => !!state.token,
    /** "sheet" (Night-Shift-only) or "tower" (today's full product).
     *  Defaults to "tower" when the session carries no plan at all — a
     *  session persisted before Task 1 shipped `plan`, or one whose plan
     *  came back null — so nothing existing changes. */
    tier: (state): 'sheet' | 'tower' => state.plan?.tier ?? 'tower',
  },

  actions: {
    async login(email: string, password: string): Promise<void> {
      this.error = null
      try {
        const { data } = await api.post<LoginResponse>('/auth/dispatcher/login', { email, password })
        this.token = data.token
        this.dispatcher = data.dispatcher
        this.org = data.org ?? null
        this.plan = data.plan ?? null
        localStorage.setItem(TOKEN_STORAGE_KEY, data.token)
        localStorage.setItem(REFRESH_STORAGE_KEY, data.refreshToken)
        persistDispatcher(this.dispatcher)
        persistOrg(this.org)
        persistPlan(this.plan)
      } catch (error) {
        this.token = null
        this.dispatcher = null
        this.error = extractApiErrorMessage(error, 'Invalid email or password')
        throw error
      }
    },

    async signup(payload: SignupPayload): Promise<void> {
      this.error = null
      try {
        const { data } = await api.post<SignupResponse>('/auth/dispatcher/signup', payload)
        this.token = data.token
        this.dispatcher = data.dispatcher
        this.org = data.org
        this.plan = data.plan ?? null
        localStorage.setItem(TOKEN_STORAGE_KEY, data.token)
        localStorage.setItem(REFRESH_STORAGE_KEY, data.refreshToken)
        persistDispatcher(this.dispatcher)
        persistOrg(this.org)
        persistPlan(this.plan)
      } catch (error) {
        this.token = null
        this.dispatcher = null
        this.error = extractApiErrorMessage(error, 'Could not create the account')
        throw error
      }
    },

    /** A4-R12: recover the dispatcher identity for a session that already
     *  has a token but no dispatcher — either a reload from before identity
     *  persistence shipped (nothing was ever stored), or a stored dispatcher
     *  that has gone stale against the server, which is authoritative.
     *  `loadLocks`' `theirs` getter reads `dispatcher?.id` and treats a null
     *  id as "nobody is signed in", so without this every lock badge and
     *  read-only guard stays silently off until the next login.
     *
     *  Call once at app startup (main.ts). No-ops when there is no token
     *  (nothing to recover) or a dispatcher is already known (nothing
     *  missing — also keeps this from clobbering a value login/signup just
     *  set). On failure, leaves `dispatcher` null and the token untouched:
     *  lock badges are an enhancement, and a failed identity fetch must
     *  never cost someone their session. */
    async restoreIdentity(): Promise<void> {
      if (!this.token || this.dispatcher) return
      try {
        const { data } = await api.get<MeResponse>('/dispatcher/auth/me')
        this.dispatcher = data.dispatcher
        this.org = data.org ?? null
        this.plan = data.plan ?? null
        persistDispatcher(this.dispatcher)
        persistOrg(this.org)
        persistPlan(this.plan)
      } catch {
        // Server unreachable, token expired, etc. — leave dispatcher null
        // and the token alone; the api client's own 401 handling (if any)
        // owns logout decisions, this action never does.
      }
    },

    logout(): void {
      this.token = null
      this.dispatcher = null
      this.org = null
      this.plan = null
      this.error = null
      localStorage.removeItem(TOKEN_STORAGE_KEY)
      localStorage.removeItem(REFRESH_STORAGE_KEY)
      localStorage.removeItem(ORG_STORAGE_KEY)
      localStorage.removeItem(DISPATCHER_STORAGE_KEY)
      localStorage.removeItem(PLAN_STORAGE_KEY)
    },

    /** Hydrate a full session directly (token + dispatcher + org + plan) in
     *  one call, persisting exactly as login/signup do. Exists for tests and
     *  any other caller (e.g. a future SSO callback) that already has the
     *  whole session payload in hand and shouldn't have to fake a network
     *  round-trip through `login`/`signup` to set it up. */
    setSession(payload: SetSessionPayload): void {
      this.token = payload.token
      this.dispatcher = payload.dispatcher
      this.org = payload.org ?? null
      this.plan = payload.plan ?? null
      localStorage.setItem(TOKEN_STORAGE_KEY, payload.token)
      persistDispatcher(this.dispatcher)
      persistOrg(this.org)
      persistPlan(this.plan)
    },
  },
})
