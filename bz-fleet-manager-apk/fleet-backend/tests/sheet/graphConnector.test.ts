import { describe, it, expect } from "vitest";
import { GraphExcelConnector } from "../../src/lib/sheet/graphConnector.js";
import { NotImplemented } from "../../src/lib/sheet/connector.js";
import type { TabRef } from "../../src/lib/sheet/connector.js";

const ref: TabRef = { spreadsheetId: "s1", tabId: "t1" };

describe("GraphExcelConnector", () => {
  it("spreadsheetInfo rejects with NotImplemented", async () => {
    const c = new GraphExcelConnector();
    await expect(c.spreadsheetInfo("s1")).rejects.toBeInstanceOf(NotImplemented);
  });

  it("readHeader rejects with NotImplemented", async () => {
    const c = new GraphExcelConnector();
    await expect(c.readHeader(ref, 1)).rejects.toBeInstanceOf(NotImplemented);
  });

  it("readRows rejects with NotImplemented", async () => {
    const c = new GraphExcelConnector();
    await expect(c.readRows(ref, 1)).rejects.toBeInstanceOf(NotImplemented);
  });

  it("writeCells rejects with NotImplemented", async () => {
    const c = new GraphExcelConnector();
    await expect(c.writeCells(ref, [])).rejects.toBeInstanceOf(NotImplemented);
  });

  it("ensureAgentColumns rejects with NotImplemented", async () => {
    const c = new GraphExcelConnector();
    await expect(
      c.ensureAgentColumns(ref, 1, { switch: "Night Shift", status: "Night Shift status" }, ["Standard"])
    ).rejects.toBeInstanceOf(NotImplemented);
  });
});
