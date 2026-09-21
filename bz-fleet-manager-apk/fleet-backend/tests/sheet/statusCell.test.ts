import { describe, it, expect } from "vitest";
import { statusCellText } from "../../src/lib/sheet/statusCell.js";

describe("statusCellText", () => {
  it.each([
    ["watching", "40 mi out, ETA 10:20", "● WATCHING — 40 mi out, ETA 10:20"],
    ["shadow", "would say: Hi Milan, this is the dispatch assistant for load 145219…", "● SHADOW — would say: Hi Milan, this is the dispatch assistant for load 145219…"],
    ["attention", `can't read DEL appointment: "08-15:00 fcfs?"`, `● ATTENTION — can't read DEL appointment: "08-15:00 fcfs?"`],
    ["delivered", "07/15/2026", "● DELIVERED 07/15/2026"],
    ["held", null, "● HELD"],
    ["off", null, "● OFF"],
    // Final fix wave, I10: the ladder's own three pills render as themselves,
    // never as "unknown state".
    ["asked", "asked Milan where he is", "● ASKED — asked Milan where he is"],
    ["calling", "calling Milan", "● CALLING — calling Milan"],
    ["escalated", "escalated to Dana", "● ESCALATED — escalated to Dana"],
  ])("%s", (pill, line, expected) => expect(statusCellText(pill, line)).toBe(expected));

  it("every pill Load.agentPill can hold has a word (final fix wave, I10)", () => {
    for (const pill of ["off", "watching", "asked", "calling", "escalated", "delivered", "attention", "shadow", "held"]) {
      expect(statusCellText(pill, null)).not.toContain("unknown state");
    }
  });

  it("an unknown pill word is rendered as ATTENTION so a vocabulary drift is visible, not silent", () => {
    expect(statusCellText("bogus", "x")).toBe("● ATTENTION — unknown state 'bogus': x");
  });

  it("delivered with a null line has no trailing space and no literal 'null'", () => {
    expect(statusCellText("delivered", null)).toBe("● DELIVERED");
  });

  it("delivered with a blank line has no trailing space", () => {
    expect(statusCellText("delivered", "")).toBe("● DELIVERED");
  });

  it("an unknown pill with a null line has no trailing ': null'", () => {
    expect(statusCellText("bogus", null)).toBe("● ATTENTION — unknown state 'bogus'");
  });
});
