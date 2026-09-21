// APPT SCHEDULE cells are free text typed by a dispatcher: "PU: 07/14 -
// 12:00pm", "07-15 FCFS", "08-15:00 fcfs". This reads the forms seen on real
// boards into UTC windows in the org's zone, and refuses — with a reason —
// anything it cannot read. Nothing here rewrites the cell (spec §5.3).

export interface ApptWindow {
  startMs: number;
  endMs: number;
  kind: "appointment" | "fcfs";
}

export interface ApptCtx {
  /** The year the cells belong to — SHIP DATE's year. */
  year: number;
  /** IANA zone the times are written in — the org's. */
  tz: string;
}

export interface ApptLineResult {
  role: "PU" | "DEL" | null;
  window: ApptWindow | null;
  note: string | null;
}

/** Offset of `tz` from UTC at the instant `atMs`, in ms. */
function tzOffsetMs(atMs: number, tz: string): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(atMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(atMs / 1000) * 1000;
}

/** A wall-clock time in `tz` → the UTC instant. Two passes so a DST edge lands right. */
export function zonedToUtcMs(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

const ROLE_RE = /^\s*(PU|DEL)\s*:\s*/i;
const DATE_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*/;
// "13:00", "11:00am", "7am", "07"
const TIME = String.raw`(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?`;
const RANGE_RE = new RegExp(String.raw`^${TIME}\s*-\s*${TIME}\s*(fcfs)?\s*`, "i");
const SINGLE_RE = new RegExp(String.raw`^${TIME}\s*(fcfs)?\s*`, "i");

function toHour(h: string, ampm: string | undefined): number | null {
  let hour = Number(h);
  if (!Number.isInteger(hour) || hour < 0 || hour > 24) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm.toLowerCase() === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  }
  return hour > 23 ? null : hour;
}

function toMinute(mi: string | undefined): number | null {
  if (mi === undefined) return 0;
  const n = Number(mi);
  return Number.isInteger(n) && n >= 0 && n < 60 ? n : null;
}

function fullYear(y: string | undefined, fallback: number): number {
  if (y === undefined) return fallback;
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

/** Days in `month` (1-12) of `year`, leap years included. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseApptLine(raw: string, ctx: ApptCtx): ApptLineResult {
  const trimmed = raw.trim();
  if (!trimmed) return { role: null, window: null, note: "empty" };
  const roleMatch = trimmed.match(ROLE_RE);
  const role = roleMatch ? (roleMatch[1].toUpperCase() as "PU" | "DEL") : null;
  let rest = roleMatch ? trimmed.slice(roleMatch[0].length) : trimmed;

  const date = rest.match(DATE_RE);
  if (!date) return { role, window: null, note: `no date in "${trimmed}"` };
  const month = Number(date[1]), day = Number(date[2]), year = fullYear(date[3], ctx.year);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return { role, window: null, note: `bad date in "${trimmed}"` };
  rest = rest.slice(date[0].length).replace(/^-\s*/, "");
  if (!rest) return { role, window: null, note: `no time in "${trimmed}"` };

  let startH: number | null, startM: number | null, endH: number | null, endM: number | null, kind: ApptWindow["kind"], consumed: string;
  const range = rest.match(RANGE_RE);
  if (range) {
    // A range with one am/pm at the end applies it to both sides ("7-3pm" is rare; "7am-3pm" is common).
    const ampmStart = range[3] ?? undefined, ampmEnd = range[6] ?? undefined;
    startH = toHour(range[1], ampmStart ?? (ampmEnd && Number(range[1]) <= 12 && Number(range[1]) > Number(range[4]) ? "am" : undefined));
    startM = toMinute(range[2]);
    endH = toHour(range[4], ampmEnd);
    endM = toMinute(range[5]);
    kind = "fcfs";
    consumed = range[0];
  } else {
    const single = rest.match(SINGLE_RE);
    if (!single) return { role, window: null, note: `no time in "${trimmed}"` };
    startH = endH = toHour(single[1], single[3] ?? undefined);
    startM = endM = toMinute(single[2]);
    kind = single[4] ? "fcfs" : "appointment";
    consumed = single[0];
  }
  if (startH === null || startM === null || endH === null || endM === null) return { role, window: null, note: `bad time in "${trimmed}"` };
  // Digits glued to a time (e.g. "13:005", a truncated range like "0700-1500"
  // whose second token wasn't matched as a range) are never prose — refuse
  // rather than silently dropping part of a time.
  const leftover = rest.slice(consumed.length).trim();
  // Digits or a colon glued to a time ("13:005", "7:5") are a malformed time, never prose.
  if (/^[\d:]/.test(leftover)) return { role, window: null, note: `bad time in "${trimmed}"` };

  const startMs = zonedToUtcMs(year, month, day, startH, startM, ctx.tz);
  const endMs = zonedToUtcMs(year, month, day, endH, endM, ctx.tz);
  if (endMs < startMs) return { role, window: null, note: `window ends before it starts in "${trimmed}"` };
  return { role, window: { startMs, endMs, kind }, note: leftover ? `ignored "${leftover}"` : null };
}

export function parseApptText(lines: readonly string[], ctx: ApptCtx): { pu: ApptWindow | null; del: ApptWindow | null; notes: string[] } {
  const parsed = lines.map((l) => parseApptLine(l, ctx));
  const byRole = (role: "PU" | "DEL", position: number): ApptLineResult | undefined =>
    parsed.find((p) => p.role === role) ?? parsed.filter((p) => p.role === null)[position];
  const pu = byRole("PU", 0);
  const del = byRole("DEL", 1);
  const notes: string[] = [];
  const noteFor = (label: "PU" | "DEL", r: ApptLineResult | undefined): void => {
    if (!r) { notes.push(`${label}: missing`); return; }
    if (r.note) notes.push(`${label}: ${r.note}`);
  };
  noteFor("PU", pu);
  noteFor("DEL", del);
  let delWindow = del?.window ?? null;
  if (pu?.window && delWindow && delWindow.endMs < pu.window.startMs) { delWindow = null; notes.push("DEL: before pickup"); }
  return { pu: pu?.window ?? null, del: delWindow, notes };
}
