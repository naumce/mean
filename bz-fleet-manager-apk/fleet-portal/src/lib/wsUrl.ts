import { API_BASE_URL } from './api'

/** The dispatcher WebSocket URL. Lives here, not on a store: `lib/realtime.ts`
 *  needs it, and every store that subscribes needs `lib/realtime.ts` — with
 *  the function on a store those two imports form a cycle whose symptom is an
 *  undefined import at module-eval time, not a build error.
 *
 *  ws://host:port/ws?token=… derived from the API base. Resolves against the
 *  page origin so a relative VITE_API_URL (same-origin reverse-proxy deploys,
 *  e.g. "/api" behind nginx) works too. */
export function boardWsUrl(token: string): string {
  const url = new URL(API_BASE_URL, window.location.origin)
  const proto = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${url.host}/ws?token=${encodeURIComponent(token)}`
}
