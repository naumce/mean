import * as XLSX from "xlsx";

export const THEIR_HEADER = ["BOL#", "CUSTOMER /CARRIER", "TELEPHONE#", "CONTACT NAME", "PICK UP", "PU ZIP", "DEL ZIP", "DELIVERY", "RATE", "SOLD RATE", "PROFIT", "M.C. #", "LOAD#", "SHIP DATE", "****UPDATE****", "APPT SCHEDULE"];

// Two rows per load, a blank row between loads — exactly their file.
export const BROKER_ROWS: string[][] = [
  ["Dispatch board", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],     // a title row above the header, as sheets often have
  THEIR_HEADER,
  ["0500001", "ACME FOODS", "https://cloud.example.com/o/6006533/fleet/viewer/PGQx", "", "Henderson, NV", "89074", "75236", "Dallas, TX", "$4,000.00", "$3,600.00", "$400.00", "MC", "2026-34566-00", "7/13/2026", "DELIVERED 07/15/2026", "PU: 07/13 - 13:00"],
  ["", "BLUE ROAD LLC", "(555) 010-0104", "Contact A", "", "", "", "", "", "", "", "1000001", "145205", "", "", "DEL: 07/15 - 11:00"],
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
  ["0500002", "ACME FOODS", "https://share.example.com/en-US/#/share/v/a8aa", "", "Henderson, NV", "89074", "61104", "Rockford, IL", "$4,900.00", "$4,500.00", "$400.00", "MC", "2026-35082-00", "7/14/2026", "DELIVERED 07/17/2026", "PU: 07/14 - 11:00am"],
  ["", "FAST LANE INC", "(555) 010-1010", "Contact B", "", "", "", "", "", "", "", "1000002", "145219", "", "", "DEL: 7/17 - 10:00am"],
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
  ["0500003", "ACME FOODS", "https://share.example.com/en-US/#/share/v/ab3f", "", "Rockford, IL", "61109", "92154", "San Diego, CA", "$4,600.00", "$4,350.00", "$250.00", "MC", "RBMT61145", "7/14/2026", "DELIVERED 07/16/2026", "PU: 07/14 - 07-15 FCFS"],
  ["", "GLOBE FREIGHT", "(555) 010-8528", "Contact C", "", "", "", "", "", "", "", "1000003", "145197", "", "", "DEL: 07/17 - 08 - 14 FCFS"],
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
  ["0500004", "ACME FOODS", "https://track.example.com/followme?uuid=788d", "", "Neenah, WI", "54956", "14220", "Buffalo, NY", "$2,890.00", "$2,600.00", "$290.00", "MC", "931599400", "7/14/2026", "DELIVERED 07/16/2026", "PU: 07/14 - 13:00 working"],
  ["", "NORTHSTAR HAULING", "(555) 010-2858", "Contact D", "", "", "", "", "", "", "", "1000004", "145963", "", "", "DEL: 07/16 - 08-15:00 fcfs"],
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
  // An unassigned load: top row only, no carrier yet, appointment not decided.
  ["0500005", "ACME FOODS", "", "", "Henderson, NV", "89074", "80216", "Denver, CO", "$3,100.00", "", "", "MC", "2026-35100-00", "7/15/2026", "", "PU: 07/15 - tbd"],
];

export function brokerWorkbook(rows: string[][] = BROKER_ROWS): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Board");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** A real broker's file is multi-tab: a summary, a month per tab, an archive.
 *  Sheets are given as [name, rows] in the order the workbook holds them. */
export function multiSheetWorkbook(sheets: Array<[string, string[][]]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
