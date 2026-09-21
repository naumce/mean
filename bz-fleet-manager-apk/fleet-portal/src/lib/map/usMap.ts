// Minimal lower-48 map core for the fleet map: an equirectangular projection
// over the continental bounds and a low-fidelity outline polygon (real
// geography, ~35 points — a recognizable silhouette, not a GIS layer).
// Pure functions: the canvas component stays a thin painter.

export const US_BOUNDS = {
  latMin: 24,
  latMax: 50,
  lngMin: -125,
  lngMax: -66,
}

export interface Point {
  x: number
  y: number
}

/** Project lat/lng into a w×h canvas (with padding); y grows downward. */
export function project(lat: number, lng: number, w: number, h: number, pad = 16): Point {
  const iw = w - pad * 2
  const ih = h - pad * 2
  const x = pad + ((lng - US_BOUNDS.lngMin) / (US_BOUNDS.lngMax - US_BOUNDS.lngMin)) * iw
  const y = pad + ((US_BOUNDS.latMax - lat) / (US_BOUNDS.latMax - US_BOUNDS.latMin)) * ih
  return { x, y }
}

export function inBounds(lat: number, lng: number): boolean {
  return lat >= US_BOUNDS.latMin && lat <= US_BOUNDS.latMax && lng >= US_BOUNDS.lngMin && lng <= US_BOUNDS.lngMax
}

/** Rough continental outline, clockwise from the Olympic Peninsula. */
export const US_OUTLINE: [number, number][] = [
  [48.4, -124.7], [46.2, -124.0], [42.0, -124.4], [40.4, -124.4], [38.3, -123.0],
  [36.6, -121.9], [34.4, -120.5], [32.5, -117.1], // Pacific coast
  [32.7, -114.7], [31.3, -111.0], [31.8, -106.5], [29.5, -104.3], [29.8, -101.4],
  [25.9, -97.1], // southern border to Brownsville
  [27.8, -97.0], [29.3, -94.8], [29.2, -90.1], [30.4, -87.2], [29.0, -82.7],
  [25.1, -81.1], [25.2, -80.3], // Gulf + Florida tip
  [26.7, -80.0], [28.5, -80.5], [31.0, -81.4], [32.8, -79.9], [35.2, -75.5],
  [36.9, -76.0], [38.9, -75.0], [40.5, -74.0], [41.6, -70.2], [43.1, -70.7],
  [44.8, -66.9], // Atlantic coast to Maine
  [47.3, -68.2], [45.0, -71.5], [45.0, -74.8], [43.6, -78.7], [42.9, -79.0],
  [42.3, -83.1], [46.0, -84.6], [47.3, -89.5], [48.0, -92.0], [49.0, -95.2],
  [49.0, -110.0], [49.0, -123.1], // northern border back west
]
