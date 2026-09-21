// Shared localStorage keys for the dispatcher tokens. Used by both the
// auth store (writer) and the api client (reader), kept in one place so the
// two never drift apart.
export const TOKEN_STORAGE_KEY = 'fleet_token'
export const REFRESH_STORAGE_KEY = 'fleet_refresh_token'
/** The signed-in org (id/name/timezone). Persisted beside the token because a
 *  refresh keeps the session but used to lose the org — and with it the
 *  timezone the cockpit draws its entire time axis in. */
export const ORG_STORAGE_KEY = 'fleet_org'
/** The signed-in dispatcher (id/email/name/...). Persisted beside the token
 *  for the same reason as the org: a refresh keeps the session but used to
 *  lose the dispatcher identity — and with it every load-lock badge, since
 *  `theirs` treats a null dispatcher id as "nobody is signed in". */
export const DISPATCHER_STORAGE_KEY = 'fleet_dispatcher'
/** The signed-in org's plan tier ("sheet" | "tower"). Persisted alongside the
 *  org (same call sites: login, signup, restoreIdentity, setSession) so a
 *  refresh keeps the tier the nav was built from — without it every reload
 *  would silently fall back to the tower nav for a sheet-tier session. */
export const PLAN_STORAGE_KEY = 'fleet_plan'
