import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import WebSocket from "ws";
const prisma = new PrismaClient();
const BASE = "http://localhost:3001/api";
const results = [];
const ok = (name, cond, detail = "") => { results.push([cond ? "PASS" : "FAIL", name, detail]); };

for (let i = 0; i < 40; i++) { try { const h = await fetch("http://localhost:3001/health"); if (h.ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
await prisma.dispatcher.upsert({ where: { email: "d@fleet.com" }, update: {}, create: { email: "d@fleet.com", passwordHash: await bcrypt.hash("pass123", 12), name: "Disp" } });

async function j(method, path, token, body) {
  const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data; const t = await res.text(); try { data = JSON.parse(t); } catch { data = t; } return { status: res.status, data };
}
async function upload(path, token, field, filename, fields = {}) {
  const fd = new FormData();
  fd.append(field, new Blob([Buffer.from("filedata")], { type: "image/jpeg" }), filename);
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const res = await fetch(BASE + path, { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
  let data; const t = await res.text(); try { data = JSON.parse(t); } catch { data = t; } return { status: res.status, data };
}

// --- setup: dispatcher, driver, trip, assign ---
let r = await j("POST", "/auth/dispatcher/login", null, { email: "d@fleet.com", password: "pass123" });
const dToken = r.data.token; ok("dispatcher login", !!dToken);
const dEmail = "drv+" + Date.now() + "@fleet.com";
r = await j("POST", "/dispatcher/drivers", dToken, { email: dEmail, name: "Drv", password: "drv12345" });
const driverId = r.data.id || r.data.driver?.id; ok("create driver", !!driverId);
r = await j("POST", "/dispatcher/trips", dToken, { identifier: "EXT-" + Date.now(), stops: [{ sequence: 1, address: "1 A St" }], checklistItems: [{ label: "Tires", required: true }] });
const tripId = r.data.id; ok("create trip", !!tripId);
await j("POST", `/dispatcher/trips/${tripId}/assign`, dToken, { driverId });
r = await j("GET", `/dispatcher/trips/${tripId}`, dToken);
const stopId = r.data.stops?.[0]?.id; ok("trip detail has stop", !!stopId);

r = await j("POST", "/auth/driver/login", null, { email: dEmail, password: "drv12345" });
const drvToken = r.data.token; ok("driver login", !!drvToken);

// --- realtime: connect socket, listen for events ---
const ws = new WebSocket("ws://localhost:3001/?token=" + drvToken);
const received = [];
await new Promise((res2, rej) => { ws.on("open", res2); ws.on("error", rej); setTimeout(res2, 3000); });
ws.on("message", (m) => { try { received.push(JSON.parse(m.toString())); } catch {} });
ok("websocket connected", ws.readyState === WebSocket.OPEN);

// --- trip execution flow ---
await j("POST", `/trips/${tripId}/checklist/complete`, drvToken, {});
r = await j("POST", `/trips/${tripId}/start`, drvToken); ok("start trip", r.data.status === "in_progress");
r = await j("POST", `/trips/${tripId}/stops/${stopId}/arrive`, drvToken); ok("arrive at stop", r.status === 200);
r = await upload(`/trips/${tripId}/stops/${stopId}/photos`, drvToken, "file", "pod.jpg");
ok("upload stop photo -> url", r.status === 200 && String(r.data.url || "").includes("/uploads/"), "url " + (r.data?.url));
r = await upload(`/signs-proof/${stopId}/upload`, drvToken, "file", "sign.jpg", { proofType: "signature", hasLocation: "true" });
const proofId = r.data.id; ok("upload signs-proof", r.status === 200 && !!proofId);
r = await j("GET", "/dispatcher/approvals/signs-proof", dToken);
ok("dispatcher sees pending proof", Array.isArray(r.data) && r.data.some(p => p.id === proofId));
r = await j("POST", `/dispatcher/signs-proof/${proofId}/approve`, dToken, {});
ok("dispatcher approves proof -> approved", r.status === 200 && (r.data.status === "approved"));
r = await j("GET", `/trips/${tripId}/can-proceed?currentStopSequence=1`, drvToken);
ok("can-proceed gate returns", r.status === 200 && typeof r.data.canProceed !== "undefined", "canProceed " + r.data?.canProceed);
r = await j("POST", `/trips/${tripId}/stops/${stopId}/complete`, drvToken); ok("complete stop", r.status === 200);
r = await j("POST", `/trips/${tripId}/complete`, drvToken); ok("complete trip -> completed", r.status === 200 && r.data.status === "completed");

// --- messaging round-trip ---
r = await j("POST", `/dispatcher/drivers/${driverId}/conversations`, dToken, {});
const convId = r.data.id; ok("dispatcher get-or-create conversation", !!convId);
await j("POST", `/dispatcher/conversations/${convId}/messages`, dToken, { text: "Head to depot" });
r = await j("GET", `/driver/messages?conversation=${convId}`, drvToken);
const msgs = Array.isArray(r.data) ? r.data : (r.data.messages || []);
ok("driver sees dispatcher message", msgs.some(m => m.text === "Head to depot" && m.senderType === "dispatcher"));

// --- notifications + realtime delivery ---
await j("POST", `/dispatcher/drivers/${driverId}/notify`, dToken, { type: "alert", title: "Check tires", body: "before next trip" });
r = await j("GET", "/driver/notifications", drvToken);
ok("driver sees notification", Array.isArray(r.data) && r.data.some(n => n.title === "Check tires"));
await new Promise(res2 => setTimeout(res2, 800)); // let WS deliver
ok("websocket delivered general_notification", received.some(m => m.type === "general_notification"), "events: " + received.map(m => m.type).join(","));

// --- role guard ---
r = await j("GET", "/dispatcher/drivers", drvToken); ok("driver token blocked on dispatcher route (403)", r.status === 403);

ws.close();
console.log("\n=== EXTENDED SMOKE ===");
for (const [s, n, d] of results) console.log(`${s}  ${n}${d ? "  (" + d + ")" : ""}`);
const fails = results.filter(x => x[0] === "FAIL").length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
await prisma.$disconnect();
process.exit(fails ? 1 : 0);
