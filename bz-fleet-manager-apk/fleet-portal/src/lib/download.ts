// Browser file download for authenticated API responses: the CSV arrives via
// axios (Bearer header attached), then leaves as a Blob click — a plain
// <a href> to the API could never carry the token.

export function triggerDownload(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

// Same click-and-revoke dance as triggerDownload above, but for a Blob the
// server already sent (the export endpoint answers `responseType: 'blob'`
// axios binary data directly) rather than text this module encodes itself.
export function triggerBlobDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.rel = 'noopener'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
