import { US_CITIES } from "./usCities.js";

// Pluggable geocoder for address-only imports (loads arrive from TMS exports
// as "Kansas City, MO" with no coordinates; the dispatch engine refuses
// ungeocoded stops). Resolution order:
//   1. offline US gazetteer — deterministic, no network, covers "City, ST"
//   2. a Nominatim-compatible HTTP provider when GEOCODER_URL is set
// A miss returns null and the stop stays geocodeStatus="pending" — never a
// guess.

export interface GeocodeHit {
  lat: number;
  lng: number;
  source: "gazetteer" | "provider";
}

const STATE_CODES = new Set([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia","ks","ky","la","me","md",
  "ma","mi","mn","ms","mo","mt","ne","nv","nh","nj","nm","ny","nc","nd","oh","ok","or","pa","ri","sc",
  "sd","tn","tx","ut","vt","va","wa","wv","wi","wy","dc",
]);

/** Pull the trailing "City, ST" out of a free-form US address ("123 Dock Rd,
 *  Kansas City, MO 64101" -> {city:"kansas city", state:"mo"}). */
export function parseCityState(address: string): { city: string; state: string } | null {
  // Scan comma-separated parts right-to-left for "<ST>[ zip]" preceded by a city part.
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) {
    const stateToken = parts[i].split(/\s+/)[0]?.toLowerCase() ?? "";
    if (STATE_CODES.has(stateToken)) {
      const city = parts[i - 1].toLowerCase().replace(/\s+/g, " ").trim();
      if (city) return { city, state: stateToken };
    }
  }
  return null;
}

/** The offline half, on its own: synchronous, no network, no timeout. The
 *  one writer (`lib/loadWriter.ts`) runs inside the caller's transaction and
 *  may only ever consult THIS — a provider call there would hold a Postgres
 *  transaction open for up to 4 s per stop, and a paste holds one for every
 *  load in the block. A gazetteer miss stays `pending` and the provider is
 *  asked afterwards, outside the transaction (`lib/geocodeSettle.ts`). */
export function gazetteerLookup(address: string): GeocodeHit | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  const parsed = parseCityState(trimmed);
  if (!parsed) return null;
  const hit = US_CITIES[`${parsed.city}|${parsed.state}`];
  return hit ? { ...hit, source: "gazetteer" } : null;
}

/** True when a Nominatim-compatible provider is configured. With none, the
 *  gazetteer IS the whole geocoder and there is nothing to settle later. */
export const providerConfigured = (): boolean => Boolean(process.env.GEOCODER_URL);

const PROVIDER_TIMEOUT_MS = 4000;

/** Nominatim-compatible search: GET {GEOCODER_URL}?q=...&format=json&limit=1.
 *  Any failure (timeout, non-200, empty result) degrades to null. */
async function fromProvider(address: string): Promise<GeocodeHit | null> {
  const base = process.env.GEOCODER_URL;
  if (!base) return null;
  try {
    const url = new URL(base);
    url.searchParams.set("q", address);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: { "user-agent": "fleet-control-tower/1.0" },
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as { lat?: string; lon?: string }[];
    const first = rows?.[0];
    const lat = Number(first?.lat);
    const lng = Number(first?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, source: "provider" };
  } catch {
    return null;
  }
}

export async function geocodeAddress(address: string): Promise<GeocodeHit | null> {
  const trimmed = address.trim();
  if (!trimmed) return null;
  return gazetteerLookup(trimmed) ?? (await fromProvider(trimmed));
}
