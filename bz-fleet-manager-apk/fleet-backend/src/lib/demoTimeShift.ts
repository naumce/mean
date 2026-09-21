// Move the whole demo scenario forward in time so it lands under "now" again.
//
// A generated week goes stale by simply existing: three days later the trucks
// that were mid-run have finished, the board's future is empty, and the
// dashboard a pitch depends on has nothing live on it. Regenerating would fix
// that but throws away everything attached to the scenario — the rest-stop
// registry, carrier commission terms, anything demonstrated during a meeting.
//
// Shifting dates keeps all of it and just moves the clock. Every timestamp in
// the database advances by the same whole number of days, so a departure at
// 06:00 is still a departure at 06:00 and a two-hour dwell is still two hours.
//
// WHOLE days, deliberately: shifting by an arbitrary millisecond offset would
// slide every appointment window off the hour and make the board look subtly
// wrong in a way nobody can name.

import { prisma } from "../db.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Never shifted: Prisma's own migration ledger. Moving those timestamps
 *  rewrites the record of when this database was migrated, which is history,
 *  not scenario. */
const EXCLUDED_TABLES = new Set(["_prisma_migrations", "DemoAnchor"]);

/** Postgres identifiers this code is willing to interpolate. The names come
 *  from information_schema — they are already real identifiers — but the query
 *  is built by string concatenation, so the guard stays: anything outside this
 *  shape is refused rather than quoted and hoped for. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ShiftPlan {
  shifted: boolean;
  days: number;
  /** Why nothing moved. Null when the shift is going ahead. */
  reason: string | null;
}

/** Whole days the scenario must advance to sit under `nowMs` again.
 *
 *  Floor, not round: the anchor marks the moment the scenario was generated
 *  for, so advancing by the whole days elapsed puts it exactly where it was
 *  relative to the working day. Rounding up would push the story into the
 *  future by up to twelve hours and start the board with trips that have not
 *  begun. */
export function shiftDays(anchorMs: number | null, nowMs: number): ShiftPlan {
  if (anchorMs === null) {
    return { shifted: false, days: 0, reason: "No anchor recorded — seed the week first." };
  }
  const days = Math.floor((nowMs - anchorMs) / DAY_MS);
  if (days < 1) {
    // Includes an anchor in the future, which means someone already shifted
    // past today. Silently shifting backwards would quietly undo their work.
    return { shifted: false, days: 0, reason: "Already current — the scenario is less than a day old." };
  }
  return { shifted: true, days, reason: null };
}

export interface TimestampColumn {
  table: string;
  column: string;
}

/** Every timestamp column in the public schema, read from the catalogue rather
 *  than listed by hand. A hand-written list is one migration away from missing
 *  the column that matters, and a half-shifted scenario is worse than an
 *  unshifted one: the parts disagree. */
export async function timestampColumns(): Promise<TimestampColumn[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND data_type LIKE 'timestamp%'
      ORDER BY table_name, column_name`,
  );
  return rows
    .filter((r) => !EXCLUDED_TABLES.has(r.table_name))
    .filter((r) => SAFE_IDENT.test(r.table_name) && SAFE_IDENT.test(r.column_name))
    .map((r) => ({ table: r.table_name, column: r.column_name }));
}

export async function readAnchorMs(): Promise<number | null> {
  const row = await prisma.demoAnchor.findFirst();
  return row ? row.anchorAt.getTime() : null;
}

export async function writeAnchorMs(atMs: number): Promise<void> {
  await prisma.demoAnchor.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", anchorAt: new Date(atMs) },
    update: { anchorAt: new Date(atMs) },
  });
}

/** Advance the entire scenario by whole days. Returns what it did, including
 *  the cases where it deliberately did nothing. */
export async function shiftDemoTime(nowMs: number): Promise<ShiftPlan> {
  const anchorMs = await readAnchorMs();
  const plan = shiftDays(anchorMs, nowMs);
  if (!plan.shifted || anchorMs === null) return plan;

  const columns = await timestampColumns();
  const interval = `${plan.days} days`;

  // One transaction: a scenario shifted halfway is internally inconsistent —
  // assignments in next week against stops in last week — and there is no way
  // to tell by looking that it happened.
  await prisma.$transaction(async (tx) => {
    for (const { table, column } of columns) {
      await tx.$executeRawUnsafe(
        `UPDATE "${table}" SET "${column}" = "${column}" + $1::interval WHERE "${column}" IS NOT NULL`,
        interval,
      );
    }
    // Advance the anchor by exactly what the data moved — NOT to `nowMs`.
    //
    // Setting it to now throws away the sub-day remainder, and that remainder
    // is what makes consecutive presses add up. Shift on day 5 at 15:00 with
    // an anchor of day 0 at 09:00 and the data moves 5 days; re-anchoring to
    // 15:00 means the next press on day 6 at 10:00 computes 0.79 days, floors
    // to zero, and silently leaves the board a day stale. Carrying the
    // remainder keeps every press honest.
    await tx.demoAnchor.updateMany({ data: { anchorAt: new Date(anchorMs + plan.days * DAY_MS) } });
  });

  return plan;
}
