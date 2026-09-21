import { TOKEN_STORAGE_KEY } from './constants'
import { boardWsUrl } from './wsUrl'

// One socket per tab (spec §9). Stores subscribe by frame type; the socket
// opens with the first subscriber and closes with the last. Plan A4 moved
// `loadboard` and `tracking` onto this singleton — this is the only place
// in src/ that constructs a WebSocket now.
export type Frame = { type: string } & Record<string, unknown>
type Handler = (frame: Frame) => void

const RETRY_MS = 5_000
/** The connect frame's type (F7). `$`-prefixed so it can never collide with
 *  a server frame type. */
export const OPEN = '$open'
const handlers = new Map<string, Set<Handler>>()
let socket: WebSocket | null = null
let retry: number | null = null

function open(): void {
  if (socket) return
  const token = localStorage.getItem(TOKEN_STORAGE_KEY)
  if (!token) return
  let ws: WebSocket
  try { ws = new WebSocket(boardWsUrl(token)) } catch { return }
  socket = ws
  // F7: a synthetic frame on every successful (re)connect. A socket that
  // dropped and came back missed whatever happened while it was down, so a
  // subscriber whose state is a live projection of frames (the lock badges)
  // has to go and re-read the snapshot. Nothing about the wire says this —
  // it is the client's own event, which is why it is named `$open`.
  ws.onopen = () => { for (const h of handlers.get(OPEN) ?? []) h({ type: OPEN }) }
  ws.onmessage = (event) => {
    let frame: Frame
    try { frame = JSON.parse(String(event.data)) as Frame } catch { return }
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return
    for (const h of handlers.get(frame.type) ?? []) h(frame)
  }
  ws.onclose = () => {
    if (socket === ws) socket = null
    // Realtime is an enhancement: retry quietly while anyone still listens.
    if (handlers.size > 0 && retry == null) retry = window.setTimeout(() => { retry = null; open() }, RETRY_MS)
  }
  ws.onerror = () => { ws.close() }
}

export function subscribe(type: string, handler: Handler): () => void {
  let set = handlers.get(type)
  if (!set) { set = new Set(); handlers.set(type, set) }
  set.add(handler)
  open()
  return () => {
    set!.delete(handler)
    if (set!.size === 0) handlers.delete(type)
    if (handlers.size === 0) close()
  }
}

export function close(): void {
  if (retry != null) { window.clearTimeout(retry); retry = null }
  const ws = socket
  socket = null
  // Detach before closing: this is a deliberate, terminal close (e.g.
  // logout) — the socket's own onclose must not see it and schedule a
  // reconnect out from under us. subscribe() still opens a fresh socket
  // (with fresh handlers) the next time someone calls it.
  if (ws) { ws.onclose = null; ws.onmessage = null; ws.onerror = null; ws.onopen = null }
  ws?.close()
}

export const __state = (): { open: boolean; types: string[] } => ({ open: socket !== null, types: [...handlers.keys()] })
