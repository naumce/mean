import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
const prisma = new PrismaClient();
const BASE = "http://localhost:3001/api";
const results = [];
const ok = (name, cond, detail = "") => results.push([cond ? "PASS" : "FAIL", name, detail]);

// wait for server readiness
for (let i = 0; i < 40; i++) { try { const h = await fetch("http://localhost:3001/health"); if (h.ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }

// seed a dispatcher directly (chicken-and-egg: first dispatcher can't be created via a dispatcher-only route)
const passwordHash = await bcrypt.hash("pass123", 12);
await prisma.dispatcher.upsert({ where: { email: "dispatch@fleet.com" }, update: {}, create: { email: "dispatch@fleet.com", passwordHash, name: "Smoke Dispatcher" } });

async function j(method, path, token, body) {
  const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

let r = await j("POST", "/auth/dispatcher/login", null, { email: "dispatch@fleet.com", password: "pass123" });
ok("dispatcher login", r.status === 200 && !!r.data.token, "status " + r.status);
const dToken = r.data.token;

const driverEmail = "smokedriver+" + Date.now() + "@fleet.com";
r = await j("POST", "/dispatcher/drivers", dToken, { email: driverEmail, name: "Smoke Driver", password: "drv12345" });
ok("dispatcher creates driver", r.status === 200 || r.status === 201, "status " + r.status);
const driverId = r.data.id || r.data.driver?.id;

r = await j("POST", "/dispatcher/trips", dToken, { identifier: "SMOKE-" + Date.now(), stops: [{ sequence: 1, address: "1 A St" }, { sequence: 2, address: "2 B St" }], checklistItems: [{ label: "Tires", required: true }] });
ok("dispatcher creates trip (stops+checklist)", r.status === 200 || r.status === 201, "status " + r.status);
const tripId = r.data.id;

r = await j("POST", `/dispatcher/trips/${tripId}/assign`, dToken, { driverId });
ok("dispatcher assigns trip to driver", r.status === 200, "status " + r.status);

r = await j("POST", "/auth/driver/login", null, { email: driverEmail, password: "drv12345" });
ok("driver login", r.status === 200 && !!r.data.token, "status " + r.status);
const drvToken = r.data.token;

r = await j("GET", "/driver/trips/active", drvToken);
ok("driver sees the assigned trip", r.status === 200 && Array.isArray(r.data) && r.data.some(t => t.id === tripId), "count " + (r.data?.length));

r = await j("POST", `/trips/${tripId}/checklist/complete`, drvToken, {});
ok("driver completes pre-trip checklist", r.status === 200, "status " + r.status);

r = await j("POST", `/trips/${tripId}/start`, drvToken);
ok("driver starts trip -> in_progress", r.status === 200 && r.data.status === "in_progress", "status " + r.status + " tripStatus " + r.data?.status);

// cross-driver isolation: a second driver must NOT be able to start the first driver's trip
const d2Email = "smoke2+" + Date.now() + "@fleet.com";
await j("POST", "/dispatcher/drivers", dToken, { email: d2Email, name: "D2", password: "drv22345" });
r = await j("POST", "/auth/driver/login", null, { email: d2Email, password: "drv22345" });
const d2Token = r.data.token;
r = await j("POST", `/trips/${tripId}/start`, d2Token);
ok("other driver blocked from that trip (404)", r.status === 404, "status " + r.status);

// role isolation: a driver token must be rejected by a dispatcher route
r = await j("GET", "/dispatcher/drivers", drvToken);
ok("driver token rejected by dispatcher route (403)", r.status === 403, "status " + r.status);

console.log("\n=== SMOKE RESULTS ===");
for (const [s, n, d] of results) console.log(`${s}  ${n}  (${d})`);
const fails = results.filter(x => x[0] === "FAIL").length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
await prisma.$disconnect();
process.exit(fails ? 1 : 0);
