import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { settlePendingStops } from "../src/lib/geocodeSettle.js";
import { applyLoadChange, type Actor } from "../src/lib/loadWriter.js";
import { resetDb } from "./helpers.js";

// A4: the writer runs inside the caller's transaction, so it may only ever
// consult the in-memory gazetteer — a provider call in there holds a Postgres
// transaction open for up to 4 s per stop, and the paste route wraps a whole
// block of loads in ONE transaction. The provider is asked afterwards, out of
// the transaction, by settlePendingStops().
const maria: Actor = { dispatcherId: "d-maria", name: "Maria" };
const PROVIDER = "http://geocoder.test/search";

/** A Nominatim-compatible answer, from a `fetch` we control. */
const provider = (lat: string, lon: string) =>
  vi.fn(async () => new Response(JSON.stringify([{ lat, lon }]), { status: 200, headers: { "content-type": "application/json" } }));

async function setup() {
  const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
  const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 100000, customerName: "ACME" } });
  return { org, load };
}

const apply = (loadId: string, orgId: string, patch: Parameters<typeof applyLoadChange>[1]["patch"]) =>
  prisma.$transaction((tx) => applyLoadChange(tx, { loadId, orgId, actor: maria, source: "board", patch }));

describe("settlePendingStops", () => {
  const realFetch = globalThis.fetch;
  beforeEach(resetDb);
  afterEach(() => { delete process.env.GEOCODER_URL; globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it("does nothing at all — no provider call, no write — when none is configured", async () => {
    const { org, load } = await setup();
    const fetchSpy = provider("40.1", "-96.1");
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await apply(load.id, org.id, { stops: { delivery: { address: "Nowhere, ZZ 00000" } } });
    expect(await settlePendingStops(org.id, [load.id])).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const del = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "delivery" } });
    expect(del?.lat).toBeNull();
    expect(del?.geocodeStatus).toBe("pending");
  });

  it("never lets the writer itself wait on the provider", async () => {
    const { org, load } = await setup();
    process.env.GEOCODER_URL = PROVIDER;
    const fetchSpy = provider("40.1", "-96.1");
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const r = await apply(load.id, org.id, { stops: { delivery: { address: "Nowhere, ZZ 00000" } } });
    // The gazetteer does not know it, so it stays pending with its refusal —
    // and the provider was not asked from inside the transaction.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.attention).toEqual(['can\'t place delivery "Nowhere, ZZ 00000" on the map']);
  });

  it("places what the gazetteer missed, and clears only that stop's refusal", async () => {
    const { org, load } = await setup();
    await apply(load.id, org.id, { stops: { pickup: { address: "Elsewhere, ZZ" }, delivery: { address: "Nowhere, ZZ 00000" } } });
    expect((await prisma.agentUpdate.findMany({ where: { loadId: load.id } })).length).toBe(2);
    const before = await prisma.load.findUniqueOrThrow({ where: { id: load.id }, select: { version: true } });

    process.env.GEOCODER_URL = PROVIDER;
    // Only the delivery resolves: the first call answers, the second does not.
    const fetchSpy = vi.fn(async (url: unknown) =>
      String(url).includes("Nowhere")
        ? new Response(JSON.stringify([{ lat: "41.5", lon: "-93.6" }]), { status: 200 })
        : new Response("[]", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const settled = await settlePendingStops(org.id, [load.id]);
    const del = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "delivery" } });
    expect([del?.lat, del?.lng]).toEqual([41.5, -93.6]);
    expect(del?.geocodeStatus).toBe("ok");
    const pu = await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "pickup" } });
    expect(pu?.geocodeStatus).toBe("pending");
    // The delivery's refusal is gone; the pickup's — a different aspect —
    // stands, because that stop really is still unplaced.
    const rows = (await prisma.agentUpdate.findMany({ where: { loadId: load.id } })).map((a) => a.text);
    expect(rows).toEqual(['can\'t place pickup "Elsewhere, ZZ" on the map']);

    // M6: the return value is what a caller hands straight to
    // `emitLoadChanged` — the role it placed, and a version bumped in the
    // same transaction as the coordinate write (not left at its old value,
    // the defect this fix closes), with exactly one `LoadChange` row tracing
    // it, matching the shape `POST /loads/:id/geocode` uses for the same fact.
    const fresh = await prisma.load.findUniqueOrThrow({ where: { id: load.id }, select: { version: true } });
    expect(fresh.version).toBe(before.version + 1);
    expect(settled).toEqual([{ loadId: load.id, version: fresh.version, roles: ["delivery"] }]);
    const trace = await prisma.loadChange.findMany({ where: { loadId: load.id, field: "geocode" } });
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ orgId: org.id, source: "system", actorId: null, actorName: "geocoder", before: null, after: "placed delivery" });
  });

  it("never reaches a load outside the org", async () => {
    const { org, load } = await setup();
    await apply(load.id, org.id, { stops: { delivery: { address: "Nowhere, ZZ 00000" } } });
    const other = await prisma.org.create({ data: { name: "Other", timezone: "UTC" } });
    process.env.GEOCODER_URL = PROVIDER;
    const fetchSpy = provider("41.5", "-93.6");
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await settlePendingStops(other.id, [load.id])).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await prisma.loadStop.findFirst({ where: { loadId: load.id, type: "delivery" } }))?.lat).toBeNull();
  });
});
