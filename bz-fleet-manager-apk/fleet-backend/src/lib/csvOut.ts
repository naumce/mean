// CSV serializer for the export endpoints — the write-side twin of csv.ts.
// RFC-4180: quote a field only when it contains a comma, quote, or newline;
// escape quotes by doubling. CRLF line endings so Excel opens it cleanly.

export type CsvCell = string | number | null | undefined;

function encodeCell(cell: CsvCell): string {
  if (cell == null) return "";
  const text = String(cell);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  const lines = [header, ...rows].map((row) => row.map(encodeCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** Integer cents -> "1234.56" dollars (plain decimal — spreadsheet-friendly). */
export function centsToUsd(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** 0..1 fraction -> "12.3" percent with one decimal. */
export function fractionToPct(fraction: number): string {
  return (fraction * 100).toFixed(1);
}

export function sendCsv(
  res: { setHeader: (k: string, v: string) => void; send: (body: string) => void },
  filename: string,
  csv: string,
): void {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}
