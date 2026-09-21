import { NotImplemented } from "./connector.js";
import type { AgentColumnNames, CellWrite, SheetConnector, SheetRead, SpreadsheetInfo, TabRef } from "./connector.js";

const NOT_BUILT = "Excel/Graph connector is not built yet — spec §2";

/** Placeholder for Microsoft Graph / Excel Online. Every method rejects until
 *  this connector is actually built. */
export class GraphExcelConnector implements SheetConnector {
  async spreadsheetInfo(_spreadsheetId: string): Promise<SpreadsheetInfo> {
    throw new NotImplemented(NOT_BUILT);
  }

  async readHeader(_ref: TabRef, _headerRow: number): Promise<string[]> {
    throw new NotImplemented(NOT_BUILT);
  }

  async readRows(_ref: TabRef, _headerRow: number, _sinceVersion?: string): Promise<SheetRead> {
    throw new NotImplemented(NOT_BUILT);
  }

  async writeCells(_ref: TabRef, _writes: CellWrite[]): Promise<void> {
    throw new NotImplemented(NOT_BUILT);
  }

  async ensureAgentColumns(
    _ref: TabRef,
    _headerRow: number,
    _names: AgentColumnNames,
    _policyNames: string[]
  ): Promise<{ switch: number; status: number }> {
    throw new NotImplemented(NOT_BUILT);
  }
}
