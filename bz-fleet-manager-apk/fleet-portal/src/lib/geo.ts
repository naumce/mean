// Great-circle distance — the portal twin of the engine's haversine, used to
// rank service shops by how far they are from a unit's last known position.

const EARTH_RADIUS_MI = 3958.7613
const toRad = (deg: number): number => (deg * Math.PI) / 180

export function haversineMi(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_MI * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}
