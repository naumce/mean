import { describe, it, expect } from "vitest";
import { FakeConnector } from "../../src/lib/sheet/fakeConnector.js";
import type { TabRef } from "../../src/lib/sheet/connector.js";
import { connectorSuite, partialAgentColumnsSuite } from "./connector.suite.js";

const ref: TabRef = { spreadsheetId: "s1", tabId: "t1" };

function seed() {
  return new FakeConnector({
    s1: {
      title: "Loads",
      tabs: {
        t1: {
          title: "Sheet1",
          grid: [
            ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "DEL APPT"],
            ["145219", "+15551234567", "Dallas, TX", "Reno, NV", "09/22 08:00"],
            ["145220", "+15557654321", "Tulsa, OK", "Boise, ID", "09/23 14:00"],
          ],
        },
      },
    },
  });
}

/** Header already carries the switch column but not the status column. */
function seedWithPartialAgentColumns() {
  return new FakeConnector({
    s1: {
      title: "Loads",
      tabs: {
        t1: {
          title: "Sheet1",
          grid: [
            ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "DEL APPT", "Night Shift"],
            ["145219", "+15551234567", "Dallas, TX", "Reno, NV", "09/22 08:00", "OFF"],
            ["145220", "+15557654321", "Tulsa, OK", "Boise, ID", "09/23 14:00", "OFF"],
          ],
        },
      },
    },
  });
}

describe("FakeConnector", () => {
  connectorSuite(async () => ({ c: seed(), ref }));
  partialAgentColumnsSuite(async () => ({ c: seedWithPartialAgentColumns(), ref }));

  it("grid(ref) reflects writes", async () => {
    const c = seed();
    expect(c.grid(ref)[1][0]).toBe("145219");
    await c.writeCells(ref, [{ rowIndex: 2, col: 0, value: "999999" }]);
    expect(c.grid(ref)[1][0]).toBe("999999");
  });

  it("records dropdown values from ensureAgentColumns", async () => {
    const c = seed();
    const { switch: switchCol } = await c.ensureAgentColumns(
      ref,
      1,
      { switch: "Night Shift", status: "Night Shift status" },
      ["Standard"]
    );
    expect(c.validation(ref, switchCol)).toEqual(["OFF", "Standard"]);
  });

  it("records notes from writeCells and exposes them via notes(ref)", async () => {
    const c = seed();
    await c.writeCells(ref, [{ rowIndex: 2, col: 4, value: "● SHADOW", note: "https://x/n/t/l1" }]);
    expect(c.notes(ref)).toEqual({ "2:4": "https://x/n/t/l1" });
  });
});
