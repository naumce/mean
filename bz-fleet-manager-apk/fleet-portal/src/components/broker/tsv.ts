// Copy and paste, in the format every spreadsheet speaks: tab between cells,
// newline between rows. Pure text in, pure text out — the grid decides which
// cells a paste lands on.

/** A cell's own tab or newline would silently become a new column or row on
 *  the way out, so both are flattened to a space. Their sheet's UPDATE cell
 *  is the one that really does contain newlines. */
const flatten = (v: string): string => v.replace(/[\t\r\n]+/g, ' ')

export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(flatten).join('\t')).join('\n')
}

/** Excel and Google Sheets both end a copy with a trailing newline; a paste
 *  of "a\tb\n" is one row, not two. */
export function fromTsv(text: string): string[][] {
  const body = text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  if (body === '') return []
  return body.split('\n').map((line) => line.split('\t'))
}

export interface PasteTarget { r: number; c: number; value: string }
export interface PastePlan {
  targets: PasteTarget[]
  /** true when the pasted block was wider or taller than the board had room
   *  for. The grid says so rather than growing the board behind their back. */
  clipped: boolean
}

/** Lay a pasted block down from the anchor, stopping at the last row and the
 *  last column instead of wrapping or inventing rows. */
export function planPaste(matrix: readonly (readonly string[])[], at: { r: number; c: number }, bounds: { rows: number; cols: number }): PastePlan {
  const targets: PasteTarget[] = []
  let clipped = false
  matrix.forEach((line, dr) => {
    line.forEach((value, dc) => {
      const r = at.r + dr
      const c = at.c + dc
      if (r >= bounds.rows || c >= bounds.cols) { clipped = true; return }
      targets.push({ r, c, value })
    })
  })
  return { targets, clipped }
}
