// Money display helpers. The API always speaks integer cents; the UI always
// renders dollars. Keep the conversion in one place.

export function formatUsd(cents: number): string {
  const dollars = cents / 100
  return dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

export function formatPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

export function formatMiles(mi: number): string {
  return `${Math.round(mi)} mi`
}
