// Offline US city gazetteer for the built-in geocoder: the major freight
// markets, hubs, and state capitals. Keys are normalized "city|st". This is
// the always-available fallback — a configured GEOCODER_URL provider handles
// street-level precision; this handles "City, ST" TMS exports with no coords.
import { haversineMi } from "../domain/dispatch/distance.js";

export const US_CITIES: Record<string, { lat: number; lng: number }> = {
  // Midwest / Plains freight corridors
  "kansas city|mo": { lat: 39.0997, lng: -94.5786 },
  "kansas city|ks": { lat: 39.1141, lng: -94.6275 },
  "st. louis|mo": { lat: 38.627, lng: -90.1994 },
  "st louis|mo": { lat: 38.627, lng: -90.1994 },
  "saint louis|mo": { lat: 38.627, lng: -90.1994 },
  "springfield|mo": { lat: 37.2089, lng: -93.2923 },
  "chicago|il": { lat: 41.8781, lng: -87.6298 },
  "joliet|il": { lat: 41.525, lng: -88.0817 },
  "rockford|il": { lat: 42.2711, lng: -89.0937 },
  "springfield|il": { lat: 39.7817, lng: -89.6501 },
  "indianapolis|in": { lat: 39.7684, lng: -86.1581 },
  "fort wayne|in": { lat: 41.0793, lng: -85.1394 },
  "columbus|oh": { lat: 39.9612, lng: -82.9988 },
  "cincinnati|oh": { lat: 39.1031, lng: -84.512 },
  "cleveland|oh": { lat: 41.4993, lng: -81.6944 },
  "toledo|oh": { lat: 41.6528, lng: -83.5379 },
  "detroit|mi": { lat: 42.3314, lng: -83.0458 },
  "grand rapids|mi": { lat: 42.9634, lng: -85.6681 },
  "milwaukee|wi": { lat: 43.0389, lng: -87.9065 },
  "madison|wi": { lat: 43.0731, lng: -89.4012 },
  "green bay|wi": { lat: 44.5133, lng: -88.0133 },
  "neenah|wi": { lat: 44.1858, lng: -88.4626 },
  "minneapolis|mn": { lat: 44.9778, lng: -93.265 },
  "st. paul|mn": { lat: 44.9537, lng: -93.09 },
  "duluth|mn": { lat: 46.7867, lng: -92.1005 },
  "des moines|ia": { lat: 41.5868, lng: -93.625 },
  "cedar rapids|ia": { lat: 41.9779, lng: -91.6656 },
  "davenport|ia": { lat: 41.5236, lng: -90.5776 },
  "omaha|ne": { lat: 41.2565, lng: -95.9345 },
  "lincoln|ne": { lat: 40.8136, lng: -96.7026 },
  "north platte|ne": { lat: 41.1239, lng: -100.7654 },
  "wichita|ks": { lat: 37.6872, lng: -97.3301 },
  "topeka|ks": { lat: 39.0473, lng: -95.6752 },
  "salina|ks": { lat: 38.8403, lng: -97.6114 },
  "fargo|nd": { lat: 46.8772, lng: -96.7898 },
  "bismarck|nd": { lat: 46.8083, lng: -100.7837 },
  "sioux falls|sd": { lat: 43.5446, lng: -96.7311 },
  "rapid city|sd": { lat: 44.0805, lng: -103.231 },
  "oklahoma city|ok": { lat: 35.4676, lng: -97.5164 },
  "tulsa|ok": { lat: 36.154, lng: -95.9928 },

  // South
  "dallas|tx": { lat: 32.7767, lng: -96.797 },
  "fort worth|tx": { lat: 32.7555, lng: -97.3308 },
  "houston|tx": { lat: 29.7604, lng: -95.3698 },
  "san antonio|tx": { lat: 29.4241, lng: -98.4936 },
  "austin|tx": { lat: 30.2672, lng: -97.7431 },
  "el paso|tx": { lat: 31.7619, lng: -106.485 },
  "laredo|tx": { lat: 27.5306, lng: -99.4803 },
  "amarillo|tx": { lat: 35.1991, lng: -101.8313 },
  "lubbock|tx": { lat: 33.5779, lng: -101.8552 },
  "corpus christi|tx": { lat: 27.8006, lng: -97.3964 },
  "memphis|tn": { lat: 35.1495, lng: -90.049 },
  "nashville|tn": { lat: 36.1627, lng: -86.7816 },
  "knoxville|tn": { lat: 35.9606, lng: -83.9207 },
  "chattanooga|tn": { lat: 35.0456, lng: -85.3097 },
  "little rock|ar": { lat: 34.7465, lng: -92.2896 },
  "fort smith|ar": { lat: 35.3859, lng: -94.3985 },
  "new orleans|la": { lat: 29.9511, lng: -90.0715 },
  "baton rouge|la": { lat: 30.4515, lng: -91.1871 },
  "shreveport|la": { lat: 32.5252, lng: -93.7502 },
  "jackson|ms": { lat: 32.2988, lng: -90.1848 },
  "birmingham|al": { lat: 33.5186, lng: -86.8104 },
  "montgomery|al": { lat: 32.3792, lng: -86.3077 },
  "mobile|al": { lat: 30.6954, lng: -88.0399 },
  "huntsville|al": { lat: 34.7304, lng: -86.5861 },
  "atlanta|ga": { lat: 33.749, lng: -84.388 },
  "savannah|ga": { lat: 32.0809, lng: -81.0912 },
  "macon|ga": { lat: 32.8407, lng: -83.6324 },
  "jacksonville|fl": { lat: 30.3322, lng: -81.6557 },
  "orlando|fl": { lat: 28.5383, lng: -81.3792 },
  "tampa|fl": { lat: 27.9506, lng: -82.4572 },
  "miami|fl": { lat: 25.7617, lng: -80.1918 },
  "lakeland|fl": { lat: 28.0395, lng: -81.9498 },
  "charlotte|nc": { lat: 35.2271, lng: -80.8431 },
  "raleigh|nc": { lat: 35.7796, lng: -78.6382 },
  "greensboro|nc": { lat: 36.0726, lng: -79.792 },
  "columbia|sc": { lat: 34.0007, lng: -81.0348 },
  "charleston|sc": { lat: 32.7765, lng: -79.9311 },
  "greenville|sc": { lat: 34.8526, lng: -82.394 },
  "richmond|va": { lat: 37.5407, lng: -77.436 },
  "norfolk|va": { lat: 36.8508, lng: -76.2859 },
  "roanoke|va": { lat: 37.271, lng: -79.9414 },
  "louisville|ky": { lat: 38.2527, lng: -85.7585 },
  "lexington|ky": { lat: 38.0406, lng: -84.5037 },
  "bowling green|ky": { lat: 36.9685, lng: -86.4808 },

  // Northeast
  "new york|ny": { lat: 40.7128, lng: -74.006 },
  "buffalo|ny": { lat: 42.8864, lng: -78.8784 },
  "albany|ny": { lat: 42.6526, lng: -73.7562 },
  "syracuse|ny": { lat: 43.0481, lng: -76.1474 },
  "rochester|ny": { lat: 43.1566, lng: -77.6088 },
  "newark|nj": { lat: 40.7357, lng: -74.1724 },
  "elizabeth|nj": { lat: 40.6639, lng: -74.2107 },
  "philadelphia|pa": { lat: 39.9526, lng: -75.1652 },
  "pittsburgh|pa": { lat: 40.4406, lng: -79.9959 },
  "harrisburg|pa": { lat: 40.2732, lng: -76.8867 },
  "allentown|pa": { lat: 40.6084, lng: -75.4902 },
  "scranton|pa": { lat: 41.4089, lng: -75.6624 },
  "baltimore|md": { lat: 39.2904, lng: -76.6122 },
  "boston|ma": { lat: 42.3601, lng: -71.0589 },
  "springfield|ma": { lat: 42.1015, lng: -72.5898 },
  "worcester|ma": { lat: 42.2626, lng: -71.8023 },
  "hartford|ct": { lat: 41.7658, lng: -72.6734 },
  "providence|ri": { lat: 41.824, lng: -71.4128 },
  "portland|me": { lat: 43.6591, lng: -70.2568 },
  "manchester|nh": { lat: 42.9956, lng: -71.4548 },
  "burlington|vt": { lat: 44.4759, lng: -73.2121 },
  "wilmington|de": { lat: 39.7391, lng: -75.5398 },
  "washington|dc": { lat: 38.9072, lng: -77.0369 },

  // Mountain / West
  "denver|co": { lat: 39.7392, lng: -104.9903 },
  "colorado springs|co": { lat: 38.8339, lng: -104.8214 },
  "pueblo|co": { lat: 38.2544, lng: -104.6091 },
  "salt lake city|ut": { lat: 40.7608, lng: -111.891 },
  "ogden|ut": { lat: 41.223, lng: -111.9738 },
  "phoenix|az": { lat: 33.4484, lng: -112.074 },
  "tucson|az": { lat: 32.2226, lng: -110.9747 },
  "flagstaff|az": { lat: 35.1983, lng: -111.6513 },
  "albuquerque|nm": { lat: 35.0844, lng: -106.6504 },
  "el paso|nm": { lat: 31.7619, lng: -106.485 },
  "las vegas|nv": { lat: 36.1699, lng: -115.1398 },
  "henderson|nv": { lat: 36.0397, lng: -114.9819 },
  "reno|nv": { lat: 39.5296, lng: -119.8138 },
  "boise|id": { lat: 43.615, lng: -116.2023 },
  "billings|mt": { lat: 45.7833, lng: -108.5007 },
  "missoula|mt": { lat: 46.8721, lng: -113.994 },
  "cheyenne|wy": { lat: 41.14, lng: -104.8202 },
  "casper|wy": { lat: 42.8501, lng: -106.3252 },

  // Pacific
  "los angeles|ca": { lat: 34.0522, lng: -118.2437 },
  "long beach|ca": { lat: 33.7701, lng: -118.1937 },
  "ontario|ca": { lat: 34.0633, lng: -117.6509 },
  "san diego|ca": { lat: 32.7157, lng: -117.1611 },
  "san francisco|ca": { lat: 37.7749, lng: -122.4194 },
  "oakland|ca": { lat: 37.8044, lng: -122.2712 },
  "san jose|ca": { lat: 37.3382, lng: -121.8863 },
  "sacramento|ca": { lat: 38.5816, lng: -121.4944 },
  "fresno|ca": { lat: 36.7378, lng: -119.7871 },
  "bakersfield|ca": { lat: 35.3733, lng: -119.0187 },
  "stockton|ca": { lat: 37.9577, lng: -121.2908 },
  "portland|or": { lat: 45.5152, lng: -122.6784 },
  "eugene|or": { lat: 44.0521, lng: -123.0868 },
  "seattle|wa": { lat: 47.6062, lng: -122.3321 },
  "tacoma|wa": { lat: 47.2529, lng: -122.4443 },
  "spokane|wa": { lat: 47.6588, lng: -117.426 },
};

function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Nearest gazetteer city to a coordinate, formatted "Kansas City, MO" —
 *  the cockpit's 📍 lane label for a driver's last-known position. Returns
 *  null beyond `maxMi` (no guessing). Duplicate spellings share coordinates,
 *  so the first key in insertion order wins on ties. */
export function nearestCity(lat: number, lng: number, maxMi = 150): { label: string; miles: number } | null {
  let best: { label: string; miles: number } | null = null;
  for (const [key, c] of Object.entries(US_CITIES)) {
    const miles = haversineMi({ lat, lng }, c);
    if (miles > maxMi || (best && miles >= best.miles)) continue;
    const [city, st] = key.split("|");
    best = { label: `${titleCase(city)}, ${st.toUpperCase()}`, miles };
  }
  return best;
}
