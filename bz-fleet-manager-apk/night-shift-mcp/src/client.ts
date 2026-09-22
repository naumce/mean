// A thin HTTP client over the Night Shift dispatcher API, authenticated by
// an OrgApiKey (fleet-backend/src/lib/apiKeys.ts) — the same key a
// dispatcher issues from the Night Shift page's Settings tab (Task 5).
// Every tool in tools.ts goes through this one client so "one tool call ==
// one HTTP call" (spec §14: "each tool calls exactly one route with the
// org's key") stays true by construction rather than by discipline.

export interface NightShiftClientConfig {
  /** e.g. "https://api.example.com/api" — no trailing slash. */
  baseUrl: string;
  apiKey: string;
}

export class NightShiftApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "NightShiftApiError";
  }
}

export interface Load {
  id: string;
  boardLoadNo: string | null;
  orderRef: string | null;
}

export interface AgentPolicy {
  id: string;
  orgId: string;
  name: string;
  stopMin: number;
  delayMin: number;
  darkMin: number;
  darkAtStopMin: number;
  offRouteMi: number;
  offRouteMin: number;
  rungGapMin: number;
  maxCalls: number;
  dispatcherEmail: string;
  dispatcherPhone: string | null;
  customerEmailOn: boolean;
  shadow: boolean;
  bossCallOn: boolean;
  quietFrom: string | null;
  quietTo: string | null;
  [key: string]: unknown;
}

export interface WatchedLoad {
  id: string;
  boardLoadNo: string | null;
  orderRef: string | null;
  agentPill: string;
  agentLine: string | null;
  policyName: string | null;
}

export class NightShiftClient {
  constructor(private readonly config: NightShiftClientConfig) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.apiKey,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    // Every route this client calls answers JSON, success or failure
    // (fleet-backend's error handler always does) — a body that fails to
    // parse as JSON is itself the error worth surfacing.
    const data = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (!res.ok) {
      const message = typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message
        : typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : `HTTP ${res.status}`;
      throw new NightShiftApiError(res.status, message);
    }
    return data as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  /** Fix round 1: `set_policy` now sends a partial body here instead of
   *  GET-merging a whole policy locally and PUTting it back — the merge
   *  happens server-side (fleet-backend's PATCH /night-shift/policies/:id),
   *  against a fresh read, so a field changed between this tool's own read
   *  and write can never be silently reverted. */
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  /** Resolves a human-typed reference (the board's LOAD# or a TMS order
   *  ref) to a load id — every tool that takes `loadRef` goes through this
   *  first (fleet-backend GET /dispatcher/loads/lookup, added for this). */
  async lookupLoadId(loadRef: string): Promise<string> {
    const { load } = await this.get<{ load: Load }>(`/dispatcher/loads/lookup?ref=${encodeURIComponent(loadRef)}`);
    return load.id;
  }

  async listPolicies(): Promise<AgentPolicy[]> {
    const { policies } = await this.get<{ policies: AgentPolicy[] }>("/dispatcher/night-shift/policies");
    return policies;
  }

  /** Resolves a policy by name (case-sensitive, matching the dropdown's own
   *  identity — spec: a policy's name IS the reserved concept, there is no
   *  separate id a dispatcher would ever type). Throws when it does not
   *  exist rather than silently falling back, since both watch_load and
   *  set_policy need to tell "no such policy" apart from "the call failed". */
  async policyByName(name: string): Promise<AgentPolicy> {
    const policies = await this.listPolicies();
    const found = policies.find((p) => p.name === name);
    if (!found) throw new Error(`No policy named "${name}" — see list_policies for what exists`);
    return found;
  }
}
