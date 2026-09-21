import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { geocodeAddress, parseCityState } from "../src/lib/geocode.js";
beforeEach(resetDb);

describe("parseCityState", () => {
  it("extracts the trailing City, ST from street addresses", () => {
    expect(parseCityState("123 Dock Rd, Kansas City, MO 64101")).toEqual({ city: "kansas city", state: "mo" });
    expect(parseCityState("Wichita, KS")).toEqual({ city: "wichita", state: "ks" });
    expect(parseCityState("Gate 4, 900 Port Blvd, Savannah, GA")).toEqual({ city: "savannah", state: "ga" });
  });

  it("returns null when no state code is present", () => {
    expect(parseCityState("Main Warehouse")).toBeNull();
    expect(parseCityState("Skopje, Macedonia")).toBeNull();
  });
});

describe("geocodeAddress (gazetteer)", () => {
  it("resolves known freight cities offline", async () => {
    const hit = await geocodeAddress("St. Louis, MO");
    expect(hit?.source).toBe("gazetteer");
    expect(hit?.lat).toBeCloseTo(38.627, 2);
  });

  it("misses politely: unknown town stays null (no provider configured)", async () => {
    expect(await geocodeAddress("Nowhereville, MO")).toBeNull();
  });
});

// --- ingestion + retry -------------------------------------------------------

async function orgScopedDispatcher() {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  await prisma.dispatcher.create({ data: {
    email: "d@x.com", passwordHash: await hashPassword("secret123"), name: "D", orgId: org.id,
  } });
  const login = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "d@x.com", password: "secret123" });
  return { org, token: login.body.token as string };
}

it("import geocodes address-only rows so they become dispatchable", async () => {
  const { token } = await orgScopedDispatcher();
  const res = await request(app).post("/api/dispatcher/import/loads")
    .set("authorization", `Bearer ${token}`)
    .send({ rows: [{
      externalId: "L-GEO-1", requiredEquip: "DryVan",
      pickupAddress: "1500 Freight Ln, Memphis, TN 38118",
      deliveryAddress: "Little Rock, AR",
    }] });
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(1);

  const load = await prisma.load.findFirst({ where: { externalId: "L-GEO-1" }, include: { stops: true } });
  const [pickup, delivery] = load!.stops;
  expect(pickup.geocodeStatus).toBe("ok");
  expect(pickup.lat).toBeCloseTo(35.1495, 2);
  expect(delivery.geocodeStatus).toBe("ok");
  expect(delivery.lng).toBeCloseTo(-92.2896, 2);
});

it("unresolvable addresses stay pending; the retry endpoint reports them", async () => {
  const { token } = await orgScopedDispatcher();
  await request(app).post("/api/dispatcher/import/loads")
    .set("authorization", `Bearer ${token}`)
    .send({ rows: [{
      externalId: "L-GEO-2", requiredEquip: "Reefer",
      pickupAddress: "Chicago, IL",
      deliveryAddress: "The Old Barn",
    }] });

  const load = await prisma.load.findFirst({ where: { externalId: "L-GEO-2" }, include: { stops: true } });
  expect(load!.stops[0].geocodeStatus).toBe("ok");
  expect(load!.stops[1].geocodeStatus).toBe("pending");

  const retry = await request(app).post(`/api/dispatcher/loads/${load!.id}/geocode`)
    .set("authorization", `Bearer ${token}`);
  expect(retry.status).toBe(200);
  expect(retry.body.resolved).toBe(0);
  expect(retry.body.pending).toBe(1);
});

it("the retry endpoint resolves a stop after its address is corrected", async () => {
  const { org, token } = await orgScopedDispatcher();
  const load = await prisma.load.create({ data: {
    orgId: org.id, externalId: "L-GEO-3", requiredEquip: "DryVan", status: "open",
    stops: { create: [
      { sequence: 1, type: "pickup", address: "Omaha, NE", lat: 41.2565, lng: -95.9345, geocodeStatus: "ok" },
      { sequence: 2, type: "delivery", address: "Des Moines, IA", geocodeStatus: "pending" },
    ] },
  } });

  const retry = await request(app).post(`/api/dispatcher/loads/${load.id}/geocode`)
    .set("authorization", `Bearer ${token}`);
  expect(retry.body.resolved).toBe(1);
  expect(retry.body.pending).toBe(0);

  const fresh = await prisma.loadStop.findFirst({ where: { loadId: load.id, sequence: 2 } });
  expect(fresh?.lat).toBeCloseTo(41.5868, 2);
  expect(fresh?.geocodeStatus).toBe("ok");
});

it("cross-org geocode retry reads as 404", async () => {
  const { token } = await orgScopedDispatcher();
  const other = await prisma.org.create({ data: { name: "Rival" } });
  const load = await prisma.load.create({ data: {
    orgId: other.id, externalId: "L-RIVAL", requiredEquip: "DryVan", status: "open",
    stops: { create: [{ sequence: 1, type: "pickup", address: "Chicago, IL", geocodeStatus: "pending" }] },
  } });
  const res = await request(app).post(`/api/dispatcher/loads/${load.id}/geocode`)
    .set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(404);
});
