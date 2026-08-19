// A driver may have at most one open (active or on_break) duty session at a
// time; starting a new one while one is already open is blocked.
export function canStartSession(existing: { status: string } | null) {
  if (existing && (existing.status === "active" || existing.status === "on_break"))
    return { ok: false as const, reason: "a duty session is already active" };
  return { ok: true as const };
}

// Break can only be toggled on a session that is still open (not ended).
export function canToggleBreak(session: { status: string }) {
  if (session.status === "ended") return { ok: false as const, reason: "session has already ended" };
  return { ok: true as const };
}

// A session can only be ended once, while it is still open.
export function canEndSession(session: { status: string }) {
  if (session.status === "ended") return { ok: false as const, reason: "session has already ended" };
  return { ok: true as const };
}
