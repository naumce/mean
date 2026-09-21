// CSV of what is on screen: the filtered, sorted rows and the visible columns,
// in their order. RFC 4180 — a comma, a quote or a newline inside a cell is
// quoted and its quotes doubled, because their UPDATE column really does
// contain all three.

const needsQuote = (v: string): boolean => /[",\r\n]/.test(v)
const quote = (v: string): string => (needsQuote(v) ? `"${v.replace(/"/g, '""')}"` : v)

export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header, ...rows].map((r) => r.map(quote).join(',')).join('\r\n')
}

/** A load is two lines on the board; a CSV row is one line. The carrier line
 *  follows its customer line, exactly as the sheet reads top to bottom, so a
 *  file opened in Excel looks like the board it came from. */
export function boardCsv(
  columns: readonly { label: string }[],
  loads: readonly { top: string[]; bottom: string[] | null }[],
): string {
  const rows: string[][] = []
  for (const l of loads) {
    rows.push(l.top)
    if (l.bottom) rows.push(l.bottom)
  }
  return toCsv(columns.map((c) => c.label), rows)
}
