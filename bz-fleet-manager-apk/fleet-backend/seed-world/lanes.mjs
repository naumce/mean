import { HUBS } from "./cities.mjs";
import { shuffle } from "./prng.mjs";

// ~60 fixed origin -> destination hub pairs that the historical world's
// loads run on: ~3,000 historical loads over the past 180 days across ~60
// lanes between the hubs. Built once per generator run from a
// deterministic shuffle of every ordered hub pair, so the SAME 60 lanes
// appear on every rerun with the same PRNG seed.
export function buildLanes(rand, count) {
  const pairs = [];
  for (const origin of HUBS) {
    for (const destination of HUBS) {
      if (origin.city !== destination.city) pairs.push({ origin, destination });
    }
  }
  return shuffle(rand, pairs).slice(0, Math.min(count, pairs.length));
}
