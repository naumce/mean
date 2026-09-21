import { it, expect } from "vitest";
import type { SheetConnector, TabRef } from "../../src/lib/sheet/connector.js";

/** Every connector passes the same suite. `make` returns a connector whose
 *  spreadsheet "s1" has tab "t1" with the header on row 1 and two data rows. */
export function connectorSuite(make: () => Promise<{ c: SheetConnector; ref: TabRef }>) {
  it("reads the header row", async () => {
    const { c, ref } = await make();
    expect(await c.readHeader(ref, 1)).toEqual(["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "DEL APPT"]);
  });
  it("reads the header and data rows with their sheet row index, and reports changed=false on a second read with the same version", async () => {
    const { c, ref } = await make();
    const first = await c.readRows(ref, 1);
    expect(first.header).toEqual(["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "DEL APPT"]);
    expect(first.rows.map((r) => r.rowIndex)).toEqual([2, 3]);
    expect(first.rows[0].cells[0]).toBe("145219");
    // Unchanged: same version, changed=false — but the rows are still
    // handed back (they were read anyway, and the status pass compares its
    // intended cells against them on every tick).
    const second = await c.readRows(ref, 1, first.version);
    expect(second.changed).toBe(false);
    expect(second.version).toBe(first.version);
    expect(second.rows).toEqual(first.rows);
  });
  it("writes cells and notes, and the next read sees them with a new version", async () => {
    const { c, ref } = await make();
    const v0 = (await c.readRows(ref, 1)).version;
    await c.writeCells(ref, [{ rowIndex: 2, col: 4, value: "● SHADOW — would say: hi", note: "https://x/n/t/l1" }]);
    const after = await c.readRows(ref, 1);
    expect(after.version).not.toBe(v0);
    expect(after.rows[0].cells[4]).toBe("● SHADOW — would say: hi");
  });
  it("ensureAgentColumns adds the two headers at the right edge once, and is idempotent", async () => {
    const { c, ref } = await make();
    const a = await c.ensureAgentColumns(ref, 1, { switch: "Night Shift", status: "Night Shift status" }, ["Standard"]);
    expect(a).toEqual({ switch: 5, status: 6 });
    const b = await c.ensureAgentColumns(ref, 1, { switch: "Night Shift", status: "Night Shift status" }, ["Standard", "Hazmat"]);
    expect(b).toEqual(a);
    expect(await c.readHeader(ref, 1)).toEqual(["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "DEL APPT", "Night Shift", "Night Shift status"]);
  });
}

/** Every connector passes this suite too. `make` returns a connector whose
 *  spreadsheet "s1" has tab "t1" with the header on row 1 already carrying
 *  the switch column ("Night Shift") but not the status column — the state
 *  a sheet is in if a dispatcher (or an earlier, interrupted call) added the
 *  switch column by hand or a prior run before failing. */
export function partialAgentColumnsSuite(make: () => Promise<{ c: SheetConnector; ref: TabRef }>) {
  it("ensureAgentColumns reuses an existing switch column and appends only the missing status column", async () => {
    const { c, ref } = await make();
    const before = await c.readHeader(ref, 1);
    const existingSwitchCol = before.indexOf("Night Shift");
    expect(existingSwitchCol).not.toBe(-1);

    const result = await c.ensureAgentColumns(
      ref,
      1,
      { switch: "Night Shift", status: "Night Shift status" },
      ["Standard"]
    );
    expect(result).toEqual({ switch: existingSwitchCol, status: before.length });

    const after = await c.readHeader(ref, 1);
    expect(after.filter((h) => h === "Night Shift")).toHaveLength(1);
    expect(after[before.length]).toBe("Night Shift status");
  });
}
