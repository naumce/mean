import { describe, expect, it } from "vitest";
import { parseApptLine, parseApptText, zonedToUtcMs } from "../src/lib/apptText.js";

// Every form seen on the customer's board, and the refusals. The year comes
// from SHIP DATE; the zone is the org's. A cell the parser cannot read is a
// note, never a guess (spec §5.3).
const ctx = { year: 2026, tz: "America/Los_Angeles" };
const la = (m: number, d: number, h: number, mi = 0) => zonedToUtcMs(2026, m, d, h, mi, ctx.tz);

describe("zonedToUtcMs", () => {
  it("turns a wall-clock time in a zone into the instant", () => {
    expect(zonedToUtcMs(2026, 7, 13, 13, 0, "America/Los_Angeles")).toBe(Date.parse("2026-07-13T13:00:00-07:00"));
    expect(zonedToUtcMs(2026, 1, 13, 13, 0, "America/Los_Angeles")).toBe(Date.parse("2026-01-13T13:00:00-08:00"));
    expect(zonedToUtcMs(2026, 7, 13, 13, 0, "Europe/Skopje")).toBe(Date.parse("2026-07-13T13:00:00+02:00"));
  });
});

describe("parseApptLine", () => {
  it("reads a fixed appointment, 24-hour", () => {
    expect(parseApptLine("PU: 07/13 - 13:00", ctx)).toEqual({ role: "PU", window: { startMs: la(7, 13, 13), endMs: la(7, 13, 13), kind: "appointment" }, note: null });
    expect(parseApptLine("DEL: 07/15 - 11:00", ctx)).toEqual({ role: "DEL", window: { startMs: la(7, 15, 11), endMs: la(7, 15, 11), kind: "appointment" }, note: null });
  });

  it("reads am/pm and a one-digit month", () => {
    expect(parseApptLine("PU: 07/14 - 11:00am", ctx).window).toEqual({ startMs: la(7, 14, 11), endMs: la(7, 14, 11), kind: "appointment" });
    expect(parseApptLine("DEL: 7/17 - 10:00am", ctx).window).toEqual({ startMs: la(7, 17, 10), endMs: la(7, 17, 10), kind: "appointment" });
    expect(parseApptLine("DEL: 07/17 - 12:00pm", ctx).window).toEqual({ startMs: la(7, 17, 12), endMs: la(7, 17, 12), kind: "appointment" });
    expect(parseApptLine("PU: 07/14 - 12:00am", ctx).window?.startMs).toBe(la(7, 14, 0));
  });

  it("reads first-come-first-served windows in every spelling on the board", () => {
    expect(parseApptLine("PU: 07/14 - 07-15 FCFS", ctx).window).toEqual({ startMs: la(7, 14, 7), endMs: la(7, 14, 15), kind: "fcfs" });
    expect(parseApptLine("DEL: 07/17 - 08 - 14 FCFS", ctx).window).toEqual({ startMs: la(7, 17, 8), endMs: la(7, 17, 14), kind: "fcfs" });
    expect(parseApptLine("DEL: 07/16 - 08-15:00 fcfs", ctx).window).toEqual({ startMs: la(7, 16, 8), endMs: la(7, 16, 15), kind: "fcfs" });
    expect(parseApptLine("PU: 07/14 - 7am-3pm", ctx).window).toEqual({ startMs: la(7, 14, 7), endMs: la(7, 14, 15), kind: "fcfs" });
  });

  it("keeps a trailing word as a note and still reads the time", () => {
    const r = parseApptLine("PU: 07/14 - 13:00 working", ctx);
    expect(r.window?.startMs).toBe(la(7, 14, 13));
    expect(r.note).toBe('ignored "working"');
  });

  it("takes an explicit year when the cell has one", () => {
    expect(parseApptLine("DEL: 07/15/2027 - 11:00", ctx).window?.startMs).toBe(zonedToUtcMs(2027, 7, 15, 11, 0, ctx.tz));
  });

  it("refuses what it cannot read, and says why", () => {
    expect(parseApptLine("asap", ctx)).toEqual({ role: null, window: null, note: 'no date in "asap"' });
    expect(parseApptLine("DEL: 07/17", ctx)).toEqual({ role: "DEL", window: null, note: 'no time in "DEL: 07/17"' });
    expect(parseApptLine("PU: 07/14 - 25:00", ctx).window).toBeNull();
    expect(parseApptLine("PU: 07/14 - 15-07 FCFS", ctx).note).toMatch(/ends before it starts/);
    expect(parseApptLine("PU: 13/40 - 10:00", ctx).window).toBeNull();
    expect(parseApptLine("", ctx)).toEqual({ role: null, window: null, note: "empty" });
    expect(parseApptLine("PU: 07/14 - 7:5", ctx)).toEqual({ role: "PU", window: null, note: 'bad time in "PU: 07/14 - 7:5"' });
  });

  it("refuses a calendar day that doesn't exist, leap years included", () => {
    expect(parseApptLine("PU: 2/29/2026 - 10:00", ctx).window).toBeNull();
    expect(parseApptLine("PU: 2/29/2026 - 10:00", ctx).note).toBe('bad date in "PU: 2/29/2026 - 10:00"');
    expect(parseApptLine("PU: 2/29/2028 - 10:00", ctx).window?.startMs).toBe(zonedToUtcMs(2028, 2, 29, 10, 0, ctx.tz));
    expect(parseApptLine("PU: 4/31 - 10:00", ctx).window).toBeNull();
  });

  it("reads four-digit military times, and refuses digits glued to a time", () => {
    const range = parseApptLine("PU: 07/14 - 0700-1500", ctx);
    expect(range.window).toEqual({ startMs: la(7, 14, 7), endMs: la(7, 14, 15), kind: "fcfs" });
    expect(range.note).toBeNull();
    expect(parseApptLine("DEL: 07/17 - 1130", ctx).window).toEqual({ startMs: la(7, 17, 11, 30), endMs: la(7, 17, 11, 30), kind: "appointment" });
    const glued = parseApptLine("PU: 07/14 - 13:005", ctx);
    expect(glued.window).toBeNull();
    expect(glued.note).toMatch(/bad time/);
  });
});

describe("parseApptText", () => {
  it("assigns roles by prefix, or by position when the prefix is missing", () => {
    const a = parseApptText(["PU: 07/13 - 13:00", "DEL: 07/15 - 11:00"], ctx);
    expect(a.pu?.startMs).toBe(la(7, 13, 13));
    expect(a.del?.endMs).toBe(la(7, 15, 11));
    expect(a.notes).toEqual([]);
    const b = parseApptText(["07/13 - 13:00", "07/15 - 08-15 FCFS"], ctx);
    expect(b.pu?.startMs).toBe(la(7, 13, 13));
    expect(b.del?.kind).toBe("fcfs");
  });

  it("reports a missing or unreadable side without inventing it", () => {
    const a = parseApptText(["PU: 07/13 - 13:00", "DEL: tbd"], ctx);
    expect(a.pu).not.toBeNull();
    expect(a.del).toBeNull();
    expect(a.notes).toEqual(['DEL: no date in "DEL: tbd"']);
    const b = parseApptText(["PU: 07/13 - 13:00"], ctx);
    expect(b.del).toBeNull();
    expect(b.notes).toEqual(["DEL: missing"]);
  });

  it("refuses a delivery that ends before the pickup starts", () => {
    const a = parseApptText(["PU: 07/15 - 13:00", "DEL: 07/13 - 11:00"], ctx);
    expect(a.del).toBeNull();
    expect(a.notes).toEqual(["DEL: before pickup"]);
  });
});
