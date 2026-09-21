import type { BoardLoad } from '../../stores/loadboard'
import { haversineMi } from '../geo'
import { timeToX, type CockpitConfig } from './geometry'

// Empty repositioning between consecutive legs on one lane. The server's
// deadheadMi (measured from where the driver actually was at commit time) is
// preferred; otherwise a straight-line × road-factor estimate from the stop
// coordinates; otherwise the connector is drawn with unknown miles.
export interface DeadheadConnector {
  fromLoadId: string
  toLoadId: string
  x1: number
  x2: number
  miles: number | null
  fromCity: string
  toCity: string
}

const ROAD_FACTOR = 1.2

export function connectors(legs: BoardLoad[], cfg: CockpitConfig): DeadheadConnector[] {
  const sorted = legs
    .filter((l) => l.assignment)
    .slice()
    .sort((a, b) => Date.parse(a.assignment!.plannedStart) - Date.parse(b.assignment!.plannedStart))
  const out: DeadheadConnector[] = []
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1]
    const c = sorted[i]
    if (p.destination === c.origin) continue
    const x1 = timeToX(Date.parse(p.assignment!.plannedEnd), cfg)
    const x2 = timeToX(Date.parse(c.assignment!.plannedStart), cfg)
    if (x1 === null || x2 === null || x2 <= x1 + 2) continue
    let miles: number | null = c.assignment!.deadheadMi && c.assignment!.deadheadMi > 0 ? Math.round(c.assignment!.deadheadMi) : null
    if (miles === null) {
      const a = p.stops?.[p.stops.length - 1]
      const b = c.stops?.[0]
      if (a?.lat != null && a.lng != null && b?.lat != null && b.lng != null)
        miles = Math.round(haversineMi(a.lat, a.lng, b.lat, b.lng) * ROAD_FACTOR)
    }
    out.push({ fromLoadId: p.id, toLoadId: c.id, x1, x2, miles, fromCity: p.destination, toCity: c.origin })
  }
  return out
}
