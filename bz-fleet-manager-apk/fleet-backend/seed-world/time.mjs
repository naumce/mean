// Wall-clock-in-a-timezone helpers. Several scenarios are specified as a
// LOCAL clock time in the org's own timezone ("picking up in Detroit 12:00",
// "plannedEnd 10:20", "delivering to Grand Rapids Friday") rather than an
// offset from `now` — Node has no named-timezone arithmetic built in beyond
// Intl, so this file does the (small) two-pass correction by hand instead of
// adding a date-timezone dependency the rest of the backend doesn't have.
//
// None of this touches the PRNG — these are pure functions of their
// arguments, safe to call in any order without affecting seed-world's
// determinism guarantee.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Minutes to ADD to a local wall-clock time in `timeZone` to get UTC, at
 *  approximately `date` (i.e. the UTC offset, sign-flipped) — recomputed at
 *  each call rather than cached, since it varies across a DST boundary. */
function utcMinusLocalMinutes(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asUtc - date.getTime()) / 60_000;
}

/** The Date whose LOCAL representation in `timeZone` is `hour:minute` on the
 *  calendar day `dayOffset` days from `refDate`'s own local day in that zone.
 *  Two-pass: guess assuming refDate's offset, then correct against the
 *  offset AT that guess (handles the ordinary case in one correction; a
 *  guess landing exactly on a DST transition is a demo-data edge case this
 *  does not chase further). */
export function atLocalTime(refDate, timeZone, hour, minute, dayOffset = 0) {
  const refParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(refDate)
      .map((p) => [p.type, p.value]),
  );
  const naiveUtc = Date.UTC(+refParts.year, +refParts.month - 1, +refParts.day + dayOffset, hour, minute, 0);
  // utcMinusLocalMinutes(U) = asUtc(localRepr(U)) - U, which (by construction
  // of naiveUtc from the TARGET local reading) means solving
  // asUtc(localRepr(U)) = naiveUtc for U requires U = naiveUtc - offset(U) —
  // SUBTRACT, not add. Two-pass fixed-point: guess U0 = naiveUtc, refine once
  // against the offset AT that guess (handles the ordinary case; a guess
  // landing exactly on a DST transition is a demo-data edge case this does
  // not chase further).
  const offset1 = utcMinusLocalMinutes(new Date(naiveUtc), timeZone);
  const corrected = naiveUtc - offset1 * 60_000;
  const offset2 = utcMinusLocalMinutes(new Date(corrected), timeZone);
  return new Date(offset2 === offset1 ? corrected : naiveUtc - offset2 * 60_000);
}

/** The next occurrence (today counts if it's still `dayOffset` 0 and hasn't
 *  passed `hour:minute` yet — callers that need STRICTLY future pick their
 *  own dayOffset) of weekday `targetWeekday` (0=Sun..6=Sat) at `hour:minute`
 *  local time in `timeZone`, on/after refDate's own local day. Used for
 *  scenario G's "delivering to Grand Rapids Friday". */
export function nextWeekdayAtLocalTime(refDate, timeZone, targetWeekday, hour, minute) {
  const todayLabel = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(refDate);
  const todayIndex = WEEKDAYS.indexOf(todayLabel);
  const daysAhead = (targetWeekday - todayIndex + 7) % 7 || 7; // always strictly ahead, never "today"
  return atLocalTime(refDate, timeZone, hour, minute, daysAhead);
}

/** `now`, rounded DOWN to the top of the hour — a rerun inside the
 *  same clock hour is byte-identical because every downstream "days ago" /
 *  "hours from now" computation is anchored to this exact instant. */
export function roundDownToHour(ms) {
  return Math.floor(ms / (60 * 60 * 1000)) * (60 * 60 * 1000);
}

export function hoursFromNow(nowMs, hours) {
  return new Date(nowMs + hours * 60 * 60 * 1000);
}

export function minutesFromNow(nowMs, minutes) {
  return new Date(nowMs + minutes * 60_000);
}

export function daysAgo(nowMs, days) {
  return new Date(nowMs - days * DAY_MS);
}
