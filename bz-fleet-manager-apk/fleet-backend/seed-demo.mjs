// Seeds a realistic operating-day fleet + simulates driver activity so the
// portal's Approvals / Tracking / Messages screens are fully populated.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
const prisma = new PrismaClient();
const BASE = "http://localhost:3001/api";
const log = (...a) => console.log(...a);

for (let i = 0; i < 40; i++) { try { const h = await fetch("http://localhost:3001/health"); if (h.ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }

async function j(method, path, token, body) {
  const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let d; const t = await res.text(); try { d = JSON.parse(t); } catch { d = t; } return { status: res.status, data: d };
}
async function upload(path, token, fields = {}) {
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("proofimage")], { type: "image/jpeg" }), "proof.jpg");
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const res = await fetch(BASE + path, { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
  let d; const t = await res.text(); try { d = JSON.parse(t); } catch { d = t; } return { status: res.status, data: d };
}

// dispatcher
await prisma.dispatcher.upsert({ where: { email: "d@fleet.com" }, update: {}, create: { email: "d@fleet.com", passwordHash: await bcrypt.hash("pass123", 12), name: "Dispatch Control" } });
const dToken = (await j("POST", "/auth/dispatcher/login", null, { email: "d@fleet.com", password: "pass123" })).data.token;

const stamp = Date.now();
const drivers = [
  { name: "Marko Ilievski", city: [41.9981, 21.4254] },
  { name: "Ana Petrova",    city: [42.0041, 21.4090] },
  { name: "Goran Stojanov", city: [41.9860, 21.4600] },
  { name: "Elena Ristova",  city: [42.0120, 21.4380] },
  { name: "Bojan Nikolov",  city: [41.9760, 21.4010] },
];
const made = [];
for (const [i, d] of drivers.entries()) {
  const email = `driver${i + 1}.${stamp}@fleet.com`;
  const r = await j("POST", "/dispatcher/drivers", dToken, { email, name: d.name, phone: "070-000-00" + i, password: "drv12345" });
  const id = r.data.id || r.data.driver?.id;
  const v = await j("POST", "/dispatcher/vehicles", dToken, { plate: `SK-${1000 + i}-AB`, model: ["Ford Transit", "MB Sprinter", "VW Crafter", "Iveco Daily", "Renault Master"][i] });
  await j("POST", `/dispatcher/vehicles/${v.data.id}/assign`, dToken, { driverId: id });
  const token = (await j("POST", "/auth/driver/login", null, { email, password: "drv12345" })).data.token;
  made.push({ ...d, id, email, token, plate: v.data.plate });
}
log(`✔ ${made.length} drivers + vehicles created & assigned`);

async function newTrip(seq = 2) {
  const stops = Array.from({ length: seq }, (_, k) => ({ sequence: k + 1, address: `${10 + k} ${["Partizanska", "Ilinden", "Vodnjanska", "Bulevar Kuzman"][k % 4]} St` }));
  const r = await j("POST", "/dispatcher/trips", dToken, { identifier: `TR-${stamp}-${Math.floor(Math.random() * 900 + 100)}`, stops, checklistItems: [{ label: "Tires", required: true }, { label: "Lights", required: true }, { label: "Fuel", required: false }] });
  const full = await j("GET", `/dispatcher/trips/${r.data.id}`, dToken);
  return full.data;
}

// Trip 1: unassigned (pending on the board)
await newTrip();
// Trip 2: assigned, not started
{ const t = await newTrip(); await j("POST", `/dispatcher/trips/${t.id}/assign`, dToken, { driverId: made[0].id }); }
// Trip 3: IN PROGRESS with a PENDING signs-proof (fills the Approvals queue)
{
  const drv = made[1]; const t = await newTrip();
  await j("POST", `/dispatcher/trips/${t.id}/assign`, dToken, { driverId: drv.id });
  await j("POST", `/trips/${t.id}/checklist/complete`, drv.token, {});
  await j("POST", `/trips/${t.id}/start`, drv.token);
  const stop = t.stops[0];
  await j("POST", `/trips/${t.id}/stops/${stop.id}/arrive`, drv.token);
  await upload(`/trips/${t.id}/stops/${stop.id}/photos`, drv.token);
  await upload(`/signs-proof/${stop.id}/upload`, drv.token, { proofType: "signature", hasLocation: "true" });
  log("✔ Trip 3 in-progress with a pending signs-proof to approve");
}
// Trip 4: another in-progress + pending proof from a second driver
{
  const drv = made[2]; const t = await newTrip();
  await j("POST", `/dispatcher/trips/${t.id}/assign`, dToken, { driverId: drv.id });
  await j("POST", `/trips/${t.id}/checklist/complete`, drv.token, {});
  await j("POST", `/trips/${t.id}/start`, drv.token);
  await upload(`/signs-proof/${t.stops[0].id}/upload`, drv.token, { proofType: "photo", hasLocation: "true" });
}
// Trip 5: fully completed (history)
{
  const drv = made[3]; const t = await newTrip(1);
  await j("POST", `/dispatcher/trips/${t.id}/assign`, dToken, { driverId: drv.id });
  await j("POST", `/trips/${t.id}/checklist/complete`, drv.token, {});
  await j("POST", `/trips/${t.id}/start`, drv.token);
  const s = t.stops[0];
  await j("POST", `/trips/${t.id}/stops/${s.id}/arrive`, drv.token);
  await upload(`/signs-proof/${s.id}/upload`, drv.token, { proofType: "signature" });
  await j("POST", `/trips/${t.id}/stops/${s.id}/complete`, drv.token);
  await j("POST", `/trips/${t.id}/complete`, drv.token);
  log("✔ Trip 5 completed (history)");
}

// Live locations for tracking (drivers scattered around Skopje)
for (const d of made.slice(0, 4)) {
  await j("POST", "/driver/location", d.token, { latitude: d.city[0], longitude: d.city[1], speed: Math.round(Math.random() * 60) });
}
log("✔ 4 drivers posted live locations (Tracking board)");

// Two-way messaging with unread from drivers
for (const d of made.slice(0, 3)) {
  const conv = (await j("POST", `/dispatcher/drivers/${d.id}/conversations`, dToken, {})).data;
  await j("POST", `/dispatcher/conversations/${conv.id}/messages`, dToken, { text: `Hi ${d.name.split(" ")[0]}, confirm your ETA to the depot.` });
  await j("POST", "/driver/messages", d.token, { conversationId: conv.id, text: "On my way, ~15 min." });
}
log("✔ 3 conversations seeded (two-way, unread from drivers)");

// A couple of driver notifications
for (const d of made.slice(0, 2)) await j("POST", `/dispatcher/drivers/${d.id}/notify`, dToken, { type: "info", title: "Route updated", body: "New stop added to your trip." });

// counts
const overview = await j("GET", "/dispatcher/overview", dToken);
const pendingProofs = (await j("GET", "/dispatcher/approvals/signs-proof", dToken)).data;
const locs = (await j("GET", "/dispatcher/locations", dToken)).data;

log("\n=== DEMO FLEET READY ===");
log("dispatcher:", "d@fleet.com / pass123");
log("drivers:", made.map(d => d.name).join(", "));
log("overview:", JSON.stringify(overview.data));
log("signs-proof pending approval:", Array.isArray(pendingProofs) ? pendingProofs.length : pendingProofs);
log("drivers on tracking board:", Array.isArray(locs) ? locs.length : locs);
log("\nClick-path: Dashboard → Tracking (4 drivers) → Approvals (approve/reject proofs) → Trips (board: pending/assigned/in-progress/completed) → Messages (unread) → Drivers/Vehicles.");
await prisma.$disconnect();
