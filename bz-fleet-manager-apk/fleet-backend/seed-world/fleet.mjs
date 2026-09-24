import { pickWeighted, randInt, stableId } from "./prng.mjs";
import { EQUIPMENT_MIX } from "./targets.mjs";

// The org's own tractors/trailers — flavor for the "2 carriers + own fleet"
// requirement, never asserted by any test. Trailer types follow the same
// DryVan/Reefer/Flatbed/Tanker mix as driver equipmentTypes, split across
// the two carriers and the org's own (carrierId: null) fleet.
export function buildFleet(rand, { orgId, count, carrierAId, carrierBId }) {
  const tractors = []; const trailers = [];
  for (let i = 0; i < count; i++) {
    const unit = `GL-${String(1000 + i)}`;
    const carrierId = i % 3 === 0 ? carrierAId : i % 3 === 1 ? carrierBId : null;
    tractors.push({
      id: stableId(`tractor:${unit}`), orgId, unit, status: randInt(rand, 0, 9) === 0 ? "in_shop" : "active", carrierId,
    });
    trailers.push({
      id: stableId(`trailer:${unit}`), orgId, unit: `TR-${String(1000 + i)}`,
      type: pickWeighted(rand, EQUIPMENT_MIX), status: randInt(rand, 0, 9) === 0 ? "in_shop" : "active", carrierId,
    });
  }
  return { tractors, trailers };
}
