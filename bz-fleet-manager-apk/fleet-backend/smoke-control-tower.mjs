// Live end-to-end smoke of the whole Control Tower surface, in demo order.
// Prereqs: server on :3001 against a dev.db seeded by seed-control-tower.mjs.
//   NODE_OPTIONS=--max-http-header-size=65536 DATABASE_URL="file:./dev.db" \
//     JWT_ACCESS_SECRET=smoke-access JWT_REFRESH_SECRET=smoke-refresh PORT=3001 npx tsx src/server.ts
// Run:  node smoke-control-tower.mjs
// Exits non-zero on the first failure. Mutates the seeded org (assign/edit/
// unassign L-51217) but returns it to its starting state.
const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001/api";

let passed = 0;
function ok(name, cond, detail = "") {
  if (!cond) {
    console.error(`✗ FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

const day = 24 * 3600 * 1000;
const utcMidnight = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const FROM = utcMidnight(new Date()).toISOString();
const TO = new Date(utcMidnight(new Date()).getTime() + day).toISOString();

// 1. Login (screen 1)
const login = await req("POST", "/auth/dispatcher/login", { body: { email: "d@fleet.com", password: "pass123" } });
ok("login", login.status === 200 && !!login.body?.token);
const token = login.body.token;

// 2. Loadboard (screens 2 + 7)
const board = await req("GET", `/dispatcher/loadboard?from=${FROM}&to=${TO}`, { token });
ok("loadboard", board.status === 200 && board.body.lanes.length >= 5 && board.body.loads.length >= 5,
  `${board.body?.lanes?.length} lanes, ${board.body?.loads?.length} loads`);
const l51217 = board.body.loads.find((l) => l.reference === "L-51217");
ok("L-51217 present + open", !!l51217 && l51217.status === "open" && !l51217.assignment);

// Cockpit read model: units, pairing, positions ride on the same payload.
const cockpit = await req("GET", `/dispatcher/loadboard?from=${FROM}&to=${new Date(utcMidnight(new Date()).getTime() + 3 * day).toISOString()}`, { token });
ok("cockpit: loadboard carries tractors + trailers", cockpit.status === 200 && cockpit.body.tractors.length >= 3 && cockpit.body.trailers.length >= 3,
  `${cockpit.body?.tractors?.length} tractors / ${cockpit.body?.trailers?.length} trailers`);
ok("cockpit: lanes carry pairing + position", cockpit.body.lanes.every((l) => "currentTractorId" in l && "lastCity" in l) && cockpit.body.lanes.some((l) => l.lastCity),
  cockpit.body.lanes.map((l) => `${l.name}@${l.lastCity ?? "?"}`).join(", "));

// 3. Suggest (screen 5)
const suggest = await req("GET", `/dispatcher/suggest?loadId=${l51217.id}`, { token });
ok("suggest", suggest.status === 200 && suggest.body.candidates.length === 5 && !!suggest.body.tractorId);
const best = suggest.body.candidates[0];
const blocked = suggest.body.candidates.filter((c) => !c.feasible);
ok("suggest ranking", best.feasible && typeof best.score === "number" && blocked.length >= 1
  && blocked.every((c) => typeof c.blockedReason === "string"),
  `best=${best.driverName} (${best.score}), ${blocked.length} blocked w/ reasons`);

// 4. Driver what's-next (screen 6)
const next = await req("GET", `/dispatcher/drivers/${best.driverId}/next`, { token });
ok("driver what's-next", next.status === 200 && next.body.driver.name === best.driverName
  && next.body.nextLoads.length >= 5 && next.body.nextLoads[0].feasible,
  `top pick ${next.body?.nextLoads?.[0]?.reference} (${next.body?.nextLoads?.[0]?.score})`);

// 5. Load detail + edit (screen 3)
const detail = await req("GET", `/dispatcher/loads/${l51217.id}`, { token });
ok("load detail", detail.status === 200 && detail.body.stops.length === 2 && !!detail.body.stops[0].appointment);
const origCommodity = detail.body.commodity;
const edit = await req("PATCH", `/dispatcher/loads/${l51217.id}`, { token, body: { commodity: "SMOKE-EDITED" } });
ok("load edit (open)", edit.status === 200 && edit.body.commodity === "SMOKE-EDITED");

// 6. Import (screen 9): one new load via CSV + HOS refresh for a driver
// Address-only on purpose: the server-side geocoder must resolve both stops.
const csvLoad = await req("POST", "/dispatcher/import/loads", { token, body: {
  csv: `externalId,requiredEquip,revenueCents,pickupAddress,deliveryAddress\nL-SMOKE,DryVan,25000,"St. Louis, MO","Wichita, KS"`,
} });
ok("import loads (csv, geocoded)", csvLoad.status === 200 && csvLoad.body.imported === 1 && csvLoad.body.errors.length === 0,
  `batch ${csvLoad.body?.batchId?.slice(0, 8)}`);
const badImport = await req("POST", "/dispatcher/import/loads", { token, body: {
  csv: "externalId,requiredEquip,pickupAddress,deliveryAddress\nL-BAD,Spaceship,A,B",
} });
ok("import rejects bad rows", badImport.status === 422 && badImport.body.errors.length === 1);

// 7. Dry-run + commit (screens 4 + 2)
const payload = { loadId: l51217.id, driverId: best.driverId, tractorId: suggest.body.tractorId, trailerId: suggest.body.trailerId };
const dry = await req("POST", "/dispatcher/assignments", { token, body: { ...payload, dryRun: true } });
ok("dry-run preview", dry.status === 200 && dry.body.feasible === true && typeof dry.body.economics.marginCents === "number",
  `margin $${(dry.body?.economics?.marginCents / 100).toFixed(0)}`);
const commit = await req("POST", "/dispatcher/assignments", { token, body: payload });
ok("commit", commit.status === 201 && commit.body.assignment.status === "assigned");
const dupe = await req("POST", "/dispatcher/assignments", { token, body: payload });
ok("duplicate commit blocked", dupe.status === 409);
const editAssigned = await req("PATCH", `/dispatcher/loads/${l51217.id}`, { token, body: { commodity: "X" } });
ok("assigned load is read-only", editAssigned.status === 409);

// 8. Alerts + KPIs after commit (screens 8 + 10)
const kpis = await req("GET", "/dispatcher/kpis", { token });
ok("kpis", kpis.status === 200 && kpis.body.loads.assigned >= 1 && kpis.body.economics.committedLoads >= 1
  && kpis.body.economics.revenueCents > 0,
  `revenue $${(kpis.body?.economics?.revenueCents / 100).toFixed(0)}, deadhead ${Math.round(kpis.body?.economics?.deadheadMi)}mi`);
const alerts = await req("GET", "/dispatcher/alerts", { token });
ok("alerts feed", alerts.status === 200 && Array.isArray(alerts.body.alerts));

// 9. Unassign + restore (reversibility)
const un = await req("DELETE", `/dispatcher/assignments/${commit.body.assignment.id}`, { token });
ok("unassign", un.status === 200);
const after = await req("GET", `/dispatcher/loads/${l51217.id}`, { token });
ok("load reopened + rate cleared", after.body.status === "open" && after.body.rate === null);
const nextAfter = await req("GET", `/dispatcher/drivers/${best.driverId}/next`, { token });
ok("driver hours restored", nextAfter.body.driver.hos.driveRemainingMin === 660);

// 10. Restore the edit; verify tenancy fail-closed with a bad token
await req("PATCH", `/dispatcher/loads/${l51217.id}`, { token, body: { commodity: origCommodity } });
const noAuth = await req("GET", "/dispatcher/kpis", {});
ok("auth required", noAuth.status === 401);

// 11. Self-serve onboarding: signup → empty board → import a driver → board lights up.
// Unique email per run so the smoke stays rerunnable.
const suffix = Date.now();
const su = await req("POST", "/auth/dispatcher/signup", { body: {
  orgName: `Smoke Carrier ${suffix}`, name: "Smoke Owner",
  email: `owner${suffix}@smoke.test`, password: "smokepass123",
} });
ok("signup creates org + auto-login", su.status === 201 && !!su.body.token
  && su.body.dispatcher.orgId === su.body.org.id);
const t2 = su.body.token;
const emptyBoard = await req("GET", `/dispatcher/loadboard?from=${FROM}&to=${TO}`, { token: t2 });
ok("new org starts with an empty board", emptyBoard.status === 200
  && emptyBoard.body.lanes.length === 0 && emptyBoard.body.loads.length === 0);
const onboardImport = await req("POST", "/dispatcher/import/drivers", { token: t2, body: {
  csv: `name,email,lat,lng\nSmoke Driver,driver${suffix}@smoke.test,39.0997,-94.5786`,
} });
ok("onboarding driver import", onboardImport.status === 200 && onboardImport.body.imported === 1);
const litBoard = await req("GET", `/dispatcher/loadboard?from=${FROM}&to=${TO}`, { token: t2 });
ok("board lights up with the imported lane", litBoard.status === 200 && litBoard.body.lanes.length === 1,
  litBoard.body?.lanes?.[0]?.name);

console.log(`\nALL ${passed} SMOKE CHECKS PASSED`);
