import { describe, it, expect } from "vitest";
import { rowToPatch, SHEET_ATTENTION_ASPECTS } from "../../src/lib/sheet/rowToPatch.js";
import { attentionAspect } from "../../src/lib/loadWriter.js";

const header = ["LOAD#", "DRIVER PHONE", "DRIVER", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT", "CUSTOMER EMAIL", "RATE", "BROKER"];
const mapping = { loadRef: "LOAD#", driverPhone: "DRIVER PHONE", driverName: "DRIVER", pickup: "PICK UP", delivery: "DELIVERY", pickupAppt: "PU APPT", deliveryAppt: "DEL APPT", customerEmail: "CUSTOMER EMAIL", rate: "RATE" };
const ctx = { tz: "America/Chicago", year: 2026 };

it("maps a full row to a LoadPatch and keeps unmapped columns as extras", () => {
  const r = rowToPatch({ rowIndex: 2, cells: ["145219", "+15551234567", "Milan", "Dallas, TX", "Tulsa, OK", "PU: 07/14 - 12:00pm", "DEL: 07/15 - 10:00am", "ops@acme.com", "$4,000.00", "Acme"] }, header, mapping, ctx);
  expect(r.loadRef).toBe("145219");
  expect(r.patch).toMatchObject({ boardLoadNo: "145219", driverCell: "+15551234567", carrierContactName: "Milan", customerEmail: "ops@acme.com", revenueCents: 400000, sheetRowIndex: 2,
    stops: { pickup: { address: "Dallas, TX" }, delivery: { address: "Tulsa, OK" } }, apptText: "PU: 07/14 - 12:00pm\nDEL: 07/15 - 10:00am", extras: { BROKER: "Acme" } });
  expect(r.attention).toEqual([]);
});

it("a row with no load number has loadRef null and one attention line", () => {
  const r = rowToPatch({ rowIndex: 3, cells: ["", "+15551234567", "", "Dallas, TX", "Tulsa, OK", "PU: 07/14 - 12:00pm", "DEL: 07/15 - 10:00am", "", "", ""] }, header, mapping, ctx);
  expect(r.loadRef).toBeNull();
  expect(r.attention).toEqual(["needs a load number"]);
});

it("a phone that is not E.164 and an unreadable appointment are attention, not guesses", () => {
  const r = rowToPatch({ rowIndex: 4, cells: ["1", "555-1234", "", "Dallas, TX", "Tulsa, OK", "PU: 07/14 - 12:00pm", "sometime tuesday", "", "", ""] }, header, mapping, ctx);
  expect(r.attention).toEqual(expect.arrayContaining([expect.stringMatching(/driver phone "555-1234"/), expect.stringMatching(/can't read DEL appointment/)]));
  expect(r.patch.driverCell).toBeUndefined();
});

it("a blank rate is not attention (rate is optional on the sheet)", () => {
  const r = rowToPatch({ rowIndex: 5, cells: ["2", "+15551234567", "", "Dallas, TX", "Tulsa, OK", "PU: 07/14 - 12:00pm", "DEL: 07/15 - 10:00am", "", "", ""] }, header, mapping, ctx);
  expect(r.attention).toEqual([]);
  expect(r.patch.revenueCents).toBeUndefined();
});

it("a bare 10-digit US phone number is silently normalised to +1..., no attention", () => {
  const r = rowToPatch({ rowIndex: 6, cells: ["3", "5551234567", "", "Dallas, TX", "Tulsa, OK", "PU: 07/14 - 12:00pm", "DEL: 07/15 - 10:00am", "", "", ""] }, header, mapping, ctx);
  expect(r.patch.driverCell).toBe("+15551234567");
  expect(r.attention).toEqual([]);
});

it("an unparsable rate is attention, quoting the raw cell", () => {
  const r = rowToPatch({ rowIndex: 7, cells: ["4", "+15551234567", "", "Dallas, TX", "Tulsa, OK", "PU: 07/14 - 12:00pm", "DEL: 07/15 - 10:00am", "", "lots of money", ""] }, header, mapping, ctx);
  expect(r.attention).toEqual(expect.arrayContaining([expect.stringMatching(/can't read RATE "lots of money"/)]));
  expect(r.patch.revenueCents).toBeUndefined();
});

// Final fix wave, I7: pickupAppt is required, so a blank PU cell is its own
// "missing" refusal — the same shape DEL always had.
it("a blank PU appointment is attention: missing", () => {
  const r = rowToPatch({ rowIndex: 8, cells: ["5", "+15551234567", "", "Dallas, TX", "Tulsa, OK", "", "DEL: 07/15 - 10:00am", "", "", ""] }, header, mapping, ctx);
  expect(r.attention).toEqual(["can't read PU appointment: missing"]);
  expect(r.patch.apptText).toBe("DEL: 07/15 - 10:00am");
});

describe("SHEET_ATTENTION_ASPECTS", () => {
  const smallHeader = ["LOAD#", "DRIVER PHONE", "DEL APPT", "PU APPT"];
  const smallMapping = { loadRef: "LOAD#", driverPhone: "DRIVER PHONE", deliveryAppt: "DEL APPT", pickupAppt: "PU APPT" };
  const KNOWN_ASPECTS = SHEET_ATTENTION_ASPECTS.map(attentionAspect);

  // The controller's ruling: every attention line has the grammar
  // `<aspect>: <detail>`, and every `<aspect>` this folder ever emits is one
  // of the representatives rowToPatch itself can raise (the sixth,
  // "unknown policy", is sync.ts's own — rowToPatch has no switch-column key
  // to read and so can never produce it; see the standalone test below). One
  // row per situation this file can raise attention for; every line that row
  // produces must land on a known aspect — nothing falls through as its own
  // one-off aspect.
  const smallHeaderWithRate = [...smallHeader, "RATE"];
  const smallMappingWithRate = { ...smallMapping, rate: "RATE" };
  it.each([
    ["missing load number", ["", "+15551234567", "DEL: 07/15 - 10:00am", "PU: 07/14 - 12:00pm"]],
    ["missing driver phone", ["1", "", "DEL: 07/15 - 10:00am", "PU: 07/14 - 12:00pm"]],
    ["malformed driver phone", ["1", "555-1234", "DEL: 07/15 - 10:00am", "PU: 07/14 - 12:00pm"]],
    ["missing DEL appointment", ["1", "+15551234567", "", "PU: 07/14 - 12:00pm"]],
    ["missing PU appointment", ["1", "+15551234567", "DEL: 07/15 - 10:00am", ""]],
    ["missing both appointments", ["1", "+15551234567", "", ""]],
    ["unreadable DEL appointment", ["1", "+15551234567", "sometime tuesday", "PU: 07/14 - 12:00pm"]],
    ["unreadable PU appointment", ["1", "+15551234567", "DEL: 07/15 - 10:00am", "sometime tuesday"]],
    ["DEL appointment before PU (conflict)", ["1", "+15551234567", "DEL: 07/14 - 10:00am", "PU: 07/15 - 12:00pm"]],
    ["a DEL appointment with an ignored trailing scrap", ["1", "+15551234567", "DEL: 07/15 - 10:00am extra stuff", "PU: 07/14 - 12:00pm"]],
    // Final fix wave, I9a: the RATE refusal has an owned aspect too — without
    // one, attentionDiffers saw a "new" line every tick and rewrote the load.
    ["unparsable rate", ["1", "+15551234567", "DEL: 07/15 - 10:00am", "PU: 07/14 - 12:00pm", "lots of money"]],
  ])("%s: every attention line derives to a known aspect", (_label, cells) => {
    const r = rowToPatch({ rowIndex: 1, cells }, smallHeaderWithRate, smallMappingWithRate, ctx);
    expect(r.attention.length).toBeGreaterThan(0);
    for (const line of r.attention) {
      expect(KNOWN_ASPECTS).toContain(attentionAspect(line));
    }
  });

  it("an unparsable rate shares its aspect with the seventh representative (final fix wave, I9a)", () => {
    const r = rowToPatch({ rowIndex: 1, cells: ["1", "+15551234567", "DEL: 07/15 - 10:00am", "PU: 07/14 - 12:00pm", "lots of money"] }, smallHeaderWithRate, smallMappingWithRate, ctx);
    expect(r.attention).toEqual([`can't read RATE "lots of money"`]);
    expect(attentionAspect(r.attention[0])).toBe(attentionAspect(SHEET_ATTENTION_ASPECTS[6]));
  });

  it("a malformed driver phone shares its aspect with the representative", () => {
    const r = rowToPatch({ rowIndex: 1, cells: ["1", "555-1234", "DEL: 07/15 - 10:00am", "PU: 07/14 - 12:00pm"] }, smallHeader, smallMapping, ctx);
    const line = r.attention.find((a) => a.startsWith("driver phone"))!;
    expect(attentionAspect(line)).toBe(attentionAspect(SHEET_ATTENTION_ASPECTS[0]));
  });

  it("a missing driver phone shares its aspect with the representative too", () => {
    const r = rowToPatch({ rowIndex: 2, cells: ["1", "", "DEL: 07/15 - 10:00am", "PU: 07/14 - 12:00pm"] }, smallHeader, smallMapping, ctx);
    const line = r.attention.find((a) => a.startsWith("driver phone"))!;
    expect(attentionAspect(line)).toBe(attentionAspect(SHEET_ATTENTION_ASPECTS[0]));
  });

  // sync.ts's own attention line (Task 9) — not producible via rowToPatch
  // (its `mapping` has no switch-column key at all) — still has to share the
  // array's sixth representative's aspect, so a corrected switch cell clears
  // a stale "unknown policy" line exactly the way every other sheet refusal
  // clears.
  it("sync.ts's own 'unknown policy' line shares its aspect with the sixth representative", () => {
    const line = `unknown policy: "Bogus"`;
    expect(attentionAspect(line)).toBe(attentionAspect(SHEET_ATTENTION_ASPECTS[5]));
    expect(SHEET_ATTENTION_ASPECTS).toHaveLength(8);
  });

  // sync.ts's own line too (Slice 4, Task 3) — a new row bearing an ARCHIVED
  // load's number, which rowToPatch cannot see (no DB access).
  it("sync.ts's own 'archived load' line shares its aspect with the eighth representative", () => {
    const line = `archived load: "145219"`;
    expect(attentionAspect(line)).toBe(attentionAspect(SHEET_ATTENTION_ASPECTS[7]));
  });

  it("a missing DEL appointment shares its aspect with the representative (CRITICAL fix)", () => {
    const r = rowToPatch({ rowIndex: 6, cells: ["1", "+15551234567", "", "PU: 07/14 - 12:00pm"] }, smallHeader, smallMapping, ctx);
    expect(r.attention).toEqual(["can't read DEL appointment: missing"]);
    expect(attentionAspect(r.attention[0])).toBe(attentionAspect(SHEET_ATTENTION_ASPECTS[1]));
  });

  it("a missing PU appointment shares its aspect with the representative (final fix wave, I7)", () => {
    const r = rowToPatch({ rowIndex: 6, cells: ["1", "+15551234567", "DEL: 07/15 - 10:00am", ""] }, smallHeader, smallMapping, ctx);
    expect(r.attention).toEqual(["can't read PU appointment: missing"]);
    expect(attentionAspect(r.attention[0])).toBe(attentionAspect(SHEET_ATTENTION_ASPECTS[2]));
  });

  it("an unreadable DEL appointment shares its aspect with the representative", () => {
    const r = rowToPatch({ rowIndex: 3, cells: ["1", "+15551234567", "sometime tuesday", "PU: 07/14 - 12:00pm"] }, smallHeader, smallMapping, ctx);
    const line = r.attention.find((a) => a.startsWith("can't read DEL"))!;
    expect(attentionAspect(line)).toBe(attentionAspect(SHEET_ATTENTION_ASPECTS[1]));
  });

  it("an unreadable PU appointment shares its aspect with the representative", () => {
    const r = rowToPatch({ rowIndex: 4, cells: ["1", "+15551234567", "DEL: 07/15 - 10:00am", "sometime tuesday"] }, smallHeader, smallMapping, ctx);
    const line = r.attention.find((a) => a.startsWith("can't read PU"))!;
    expect(attentionAspect(line)).toBe(attentionAspect(SHEET_ATTENTION_ASPECTS[2]));
  });

  it("a missing load number shares its aspect with the representative", () => {
    const r = rowToPatch({ rowIndex: 5, cells: ["", "+15551234567", "DEL: 07/15 - 10:00am", "PU: 07/14 - 12:00pm"] }, smallHeader, smallMapping, ctx);
    const line = r.attention.find((a) => a.startsWith("needs a load"))!;
    expect(attentionAspect(line)).toBe(attentionAspect(SHEET_ATTENTION_ASPECTS[3]));
  });

  it("a DEL-before-PU conflict surfaces the parser's real reason, not a generic message", () => {
    // apptText.ts's own wording for this conflict (parseApptText): "DEL: before pickup".
    const r = rowToPatch({ rowIndex: 7, cells: ["1", "+15551234567", "DEL: 07/14 - 10:00am", "PU: 07/15 - 12:00pm"] }, smallHeader, smallMapping, ctx);
    expect(r.attention).toContain("can't read DEL appointment: before pickup");
  });

  it("a note that did not null a window (an ignored trailing scrap) lands on the appointment aspect", () => {
    const r = rowToPatch({ rowIndex: 8, cells: ["1", "+15551234567", "DEL: 07/15 - 10:00am extra stuff", "PU: 07/14 - 12:00pm"] }, smallHeader, smallMapping, ctx);
    const line = r.attention.find((a) => a.startsWith("appointment:"))!;
    expect(line).toBeDefined();
    expect(line).toContain("ignored");
    expect(attentionAspect(line)).toBe(attentionAspect(SHEET_ATTENTION_ASPECTS[4]));
  });
});

describe("agent columns are excluded from extras", () => {
  it("a header containing the Night Shift status column does not put its value into patch.extras", () => {
    const h = [...header, "Night Shift", "Night Shift status"];
    const r = rowToPatch(
      { rowIndex: 7, cells: ["145219", "+15551234567", "Milan", "Dallas, TX", "Tulsa, OK", "PU: 07/14 - 12:00pm", "DEL: 07/15 - 10:00am", "", "", "", "Standard", "● WATCHING"] },
      h, mapping, ctx,
    );
    expect(r.patch.extras).toBeUndefined();
  });
});

describe("edge cases", () => {
  it("a duplicate header name: the mapped value resolves to the FIRST matching column (known limitation)", () => {
    const header = ["LOAD#", "RATE", "RATE"];
    const mapping = { loadRef: "LOAD#", rate: "RATE" };
    const r = rowToPatch({ rowIndex: 1, cells: ["1", "$10.00", "$20.00"] }, header, mapping, ctx);
    expect(r.patch.revenueCents).toBe(1000);
    // The second "RATE" column is invisible to rowToPatch: it shares the
    // mapped header's name, so it's excluded from `extras` too, not just
    // from the mapped field. Its data is silently dropped.
    expect(r.patch.extras).toBeUndefined();
  });

  it("a mapping value absent from the header at rowToPatch time (a renamed column) is treated as blank", () => {
    // Simulates drift between a saved mapping and the sheet's current header
    // row (e.g. a dispatcher renamed a column after the mapping was
    // confirmed). Task 7's validateMapping would refuse this up front; this
    // pins what rowToPatch itself does if it's ever handed one anyway.
    const header = ["LOAD#", "DRIVER PHONE", "DEL APPT"];
    const mapping = { loadRef: "LOAD#", driverPhone: "DRIVER PHONE", deliveryAppt: "DEL APPT", pickup: "ORIGIN (renamed away)" };
    const r = rowToPatch({ rowIndex: 1, cells: ["1", "+15551234567", "DEL: 07/15 - 10:00am"] }, header, mapping, ctx);
    expect(r.patch.stops).toBeUndefined();
    // pickupAppt is unmapped here too (it is required — I7), so the PU
    // refusal is the one line this drifted mapping raises.
    expect(r.attention).toEqual(["can't read PU appointment: missing"]);
  });

  it("a row shorter than the header treats the missing trailing cells as blank", () => {
    const header = ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "DEL APPT"];
    const mapping = { loadRef: "LOAD#", driverPhone: "DRIVER PHONE", pickup: "PICK UP", delivery: "DELIVERY", deliveryAppt: "DEL APPT" };
    const r = rowToPatch({ rowIndex: 1, cells: ["1", "+15551234567"] }, header, mapping, ctx);
    expect(r.patch.stops).toBeUndefined();
    expect(r.attention).toEqual(["can't read PU appointment: missing", "can't read DEL appointment: missing"]);
  });

  it("an 11-digit number starting with 1 is attention, not silently prefixed with +", () => {
    const r = rowToPatch({ rowIndex: 1, cells: ["1", "15551234567", "", "Dallas, TX", "Tulsa, OK", "", "DEL: 07/15 - 10:00am", "", "", ""] }, header, mapping, ctx);
    expect(r.patch.driverCell).toBeUndefined();
    expect(r.attention).toEqual(expect.arrayContaining([expect.stringMatching(/driver phone "15551234567"/)]));
  });

  it("cells with surrounding whitespace are trimmed before use", () => {
    const r = rowToPatch({ rowIndex: 1, cells: ["  145219  ", "  +15551234567  ", "  Milan  ", "  Dallas, TX  ", "  Tulsa, OK  ", "  PU: 07/14 - 12:00pm  ", "  DEL: 07/15 - 10:00am  ", "  ops@acme.com  ", "  $4,000.00  ", "  Acme  "] }, header, mapping, ctx);
    expect(r.loadRef).toBe("145219");
    expect(r.patch).toMatchObject({ boardLoadNo: "145219", driverCell: "+15551234567", carrierContactName: "Milan", customerEmail: "ops@acme.com", revenueCents: 400000,
      stops: { pickup: { address: "Dallas, TX" }, delivery: { address: "Tulsa, OK" } }, extras: { BROKER: "Acme" } });
    expect(r.attention).toEqual([]);
  });
});

// Two-rows-per-load sheets: the broker layout keeps both appointments in ONE
// column ("APPT SCHEDULE" — `PU:` on the customer row, `DEL:` on the carrier
// row, folded into one multi-line cell by foldPairs.ts). When pickupAppt and
// deliveryAppt map to the same header, that cell is a ready-made appointment
// block: its lines go to parseApptText as-is.
describe("a shared appointment column", () => {
  const sharedHeader = ["LOAD#", "DRIVER PHONE", "APPT SCHEDULE", "RATE"];
  const sharedMapping = { loadRef: "LOAD#", driverPhone: "DRIVER PHONE", pickupAppt: "APPT SCHEDULE", deliveryAppt: "APPT SCHEDULE", rate: "RATE" };

  it("a two-line cell yields apptText with both lines and no attention", () => {
    const r = rowToPatch({ rowIndex: 3, cells: ["145205", "+15551234567", "PU: 07/13 - 13:00\nDEL: 07/15 - 11:00", "$4,000.00"] }, sharedHeader, sharedMapping, ctx);
    expect(r.patch.apptText).toBe("PU: 07/13 - 13:00\nDEL: 07/15 - 11:00");
    expect(r.attention).toEqual([]);
  });

  it("a cell with only a PU line is attention: DEL missing", () => {
    const r = rowToPatch({ rowIndex: 3, cells: ["145205", "+15551234567", "PU: 07/15 - 13:00", ""] }, sharedHeader, sharedMapping, ctx);
    expect(r.attention).toEqual(["can't read DEL appointment: missing"]);
    expect(r.patch.apptText).toBe("PU: 07/15 - 13:00");
  });

  it("the fixture's unassigned load — `PU: 07/15 - tbd` alone — is unreadable PU plus missing DEL", () => {
    const r = rowToPatch({ rowIndex: 15, cells: ["2026-35100-00", "", "PU: 07/15 - tbd", ""] }, sharedHeader, sharedMapping, ctx);
    expect(r.attention).toEqual(["driver phone: missing", `can't read PU appointment: no time in "PU: 07/15 - tbd"`, "can't read DEL appointment: missing"]);
  });

  it("a blank shared cell is attention: both missing", () => {
    const r = rowToPatch({ rowIndex: 3, cells: ["145205", "+15551234567", "", ""] }, sharedHeader, sharedMapping, ctx);
    expect(r.attention).toEqual(["can't read PU appointment: missing", "can't read DEL appointment: missing"]);
    expect(r.patch.apptText).toBeUndefined();
  });

  it("an unreadable line surfaces the parser's note, on the known aspect", () => {
    const r = rowToPatch({ rowIndex: 3, cells: ["145205", "+15551234567", "PU: 07/13 - 13:00\nDEL: sometime tuesday", ""] }, sharedHeader, sharedMapping, ctx);
    expect(r.attention).toHaveLength(1);
    expect(r.attention[0]).toMatch(/^can't read DEL appointment: /);
    const known = SHEET_ATTENTION_ASPECTS.map(attentionAspect);
    for (const line of r.attention) expect(known).toContain(attentionAspect(line));
  });

  it("the shared column's cell is not duplicated into extras", () => {
    const r = rowToPatch({ rowIndex: 3, cells: ["145205", "+15551234567", "PU: 07/13 - 13:00\nDEL: 07/15 - 11:00", ""] }, sharedHeader, sharedMapping, ctx);
    expect(r.patch.extras).toBeUndefined();
  });
});
