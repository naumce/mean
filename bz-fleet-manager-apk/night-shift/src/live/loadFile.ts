// A load from a JSON file, for the runs before the sheet exists. "now" and
// "+45m" are conveniences for a test drive; a real load carries ISO times.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Brief } from "../core/types.js";

const place = z.object({ name: z.string().min(1), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const when = z.union([z.literal("now"), z.string().regex(/^\+\d+m$/), z.string().datetime({ offset: true })]);
const schema = z.object({
  loadRef: z.string().min(1),
  origin: place,
  destination: place,
  equipment: z.string().min(1),
  departAt: when,
  deadlineAt: when,
  customerEmail: z.string().email().nullable().optional(),
  minutesSinceBreakAtDepart: z.number().int().min(0).nullable().optional(),
});

function resolve(v: string, nowMs: number): number {
  if (v === "now") return nowMs;
  const rel = /^\+(\d+)m$/.exec(v);
  if (rel) return nowMs + Number(rel[1]) * 60_000;
  return Date.parse(v);
}

export function readLoad(path: string, driver: { name: string; phone: string }, nowMs: number): Brief {
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error("load file is invalid — " + parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; "));
  const l = parsed.data;
  const departAtMs = resolve(l.departAt, nowMs);
  const deadlineAtMs = resolve(l.deadlineAt, nowMs);
  if (!(deadlineAtMs > departAtMs)) throw new Error("load file is invalid — deadlineAt must be after departAt");
  return {
    loadRef: l.loadRef, origin: l.origin, destination: l.destination, equipment: l.equipment,
    departAtMs, deadlineAtMs, driverName: driver.name, driverPhone: driver.phone,
    customerEmail: l.customerEmail ?? null, minutesSinceBreakAtDepart: l.minutesSinceBreakAtDepart ?? null,
  };
}
