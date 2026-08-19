import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

async function runningTripWithStop(driverId: string, ident = "TR-UP-1") {
  const trip = await prisma.trip.create({ data: { identifier: ident, status: "in_progress", driverId } });
  const stop = await prisma.stop.create({ data: { tripId: trip.id, sequence: 1, address: "A" } });
  return { trip, stop };
}

it("uploads a proof-of-delivery photo and returns a /uploads url", async () => {
  const d = await createDriver();
  const { trip, stop } = await runningTripWithStop(d.id);
  const res = await request(app).post(`/api/trips/${trip.id}/stops/${stop.id}/photos`)
    .set("authorization", `Bearer ${signAccess(d.id)}`)
    .attach("file", Buffer.from("x"), "photo.jpg");
  expect(res.status).toBe(200);
  expect(res.body.url).toMatch(/^\/uploads\//);

  const uploads = await prisma.upload.findMany({ where: { stopId: stop.id } });
  expect(uploads).toHaveLength(1);
  expect(uploads[0].kind).toBe("photo");
  expect(uploads[0].url).toBe(res.body.url);
});

it("uploads a document and persists it with kind 'document'", async () => {
  const d = await createDriver();
  const { trip, stop } = await runningTripWithStop(d.id, "TR-UP-2");
  const res = await request(app).post(`/api/trips/${trip.id}/stops/${stop.id}/documents`)
    .set("authorization", `Bearer ${signAccess(d.id)}`)
    .attach("file", Buffer.from("%PDF-1.4"), "doc.pdf");
  expect(res.status).toBe(200);
  expect(res.body.url).toMatch(/^\/uploads\//);

  const uploads = await prisma.upload.findMany({ where: { stopId: stop.id } });
  expect(uploads).toHaveLength(1);
  expect(uploads[0].kind).toBe("document");
});

it("returns 400 when no file is attached", async () => {
  const d = await createDriver();
  const { trip, stop } = await runningTripWithStop(d.id, "TR-UP-3");
  const res = await request(app).post(`/api/trips/${trip.id}/stops/${stop.id}/photos`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(400);
});

it("returns 404 uploading a photo to another driver's trip", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  const { trip, stop } = await runningTripWithStop(other.id, "TR-UP-OTHER");
  const res = await request(app).post(`/api/trips/${trip.id}/stops/${stop.id}/photos`)
    .set("authorization", `Bearer ${signAccess(me.id)}`)
    .attach("file", Buffer.from("x"), "photo.jpg");
  expect(res.status).toBe(404);
});
