import request from "supertest";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { app, resetDb } from "../helpers.js";
import { prisma } from "../../src/db.js";
import { signDispatcherAccess } from "../../src/lib/tokens.js";
import { seal, open } from "../../src/lib/secretBox.js";
import * as boardLayoutModule from "../../src/lib/boardLayout.js";
import { STANDARD_POLICY } from "../../src/lib/agentPolicies.js";

// Vitest does not load .env.test into process.env (confirmed against this
// suite: only vitest.config.ts's own explicit assignments — DATABASE_URL,
// JWT_ACCESS_SECRET/JWT_REFRESH_SECRET — reach process.env; SECRET_BOX_KEY
// and PORTAL_URL do not, exactly like tests/secretBox.test.ts already has to
// set SECRET_BOX_KEY itself rather than rely on the file). Set here, once,
// for the whole suite; PORTAL_URL matches the value task 7 adds to
// .env.test for real (non-test) runs.
process.env.SECRET_BOX_KEY ||= "aa68484a95bf369cba0e60e75ff919322a0b6d99d43082887a5f7b503b04d77a";
process.env.PORTAL_URL ||= "http://localhost:5173";

// Task 7: OAuth, spreadsheets, tabs, header, mapping, binding —
// src/routes/dispatcherSheet.ts. `googleAuth.js` and `connectorFor.js` are
// mocked at the module level so nothing here touches `googleapis` or the
// network: `googleAuth.js`'s three exports are simple spies, and
// `connectorFor.js` is replaced with a factory that always hands back one
// shared `FakeConnector` (task 4) seeded with a fixture header/tab, however
// the route resolves the binding.

const FIXTURE_HEADER = ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT", "CUSTOM COL"];

vi.mock("../../src/lib/sheet/googleAuth.js", () => ({
  consentUrl: vi.fn((state: string) => `https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&state=${encodeURIComponent(state)}`),
  exchangeCode: vi.fn(async (_code: string) => ({ refreshToken: "rt-1", accountEmail: "ops@acme.com" })),
  clientFor: vi.fn(() => ({ revokeToken: vi.fn(async () => undefined) })),
}));

vi.mock("../../src/lib/sheet/connectorFor.js", async () => {
  const { FakeConnector } = await import("../../src/lib/sheet/fakeConnector.js");
  const connector = new FakeConnector({
    s1: {
      title: "Loads",
      tabs: {
        // Inlined (not FIXTURE_HEADER/FIXTURE_ROW): vi.mock is hoisted above
        // those consts, so the factory cannot read them.
        "0": {
          title: "Sheet1",
          grid: [
            ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT", "CUSTOM COL"],
            ["145219", "+15551234567", "Dallas, TX", "Reno, NV", "09/21 08:00", "09/22 08:00", "x"],
          ],
        },
        // A second tab, for the "mapping moved to another tab" test (C4).
        "1": {
          title: "Sheet2",
          grid: [
            ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "PU APPT", "DEL APPT", "CUSTOM COL"],
            ["145219", "+15551234567", "Dallas, TX", "Reno, NV", "09/21 08:00", "09/22 08:00", "x"],
          ],
        },
      },
    },
  });
  return { connectorFor: vi.fn(() => connector) };
});

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
});

let seq = 0;

async function seedOrg() {
  seq += 1;
  const org = await prisma.org.create({ data: { name: `SheetOrg-${seq}` } });
  const disp = await prisma.dispatcher.create({
    data: { email: `sheet-${seq}@x.com`, passwordHash: "x", name: "Dana Ops", orgId: org.id },
  });
  const auth = `Bearer ${signDispatcherAccess(disp.id)}`;
  return { org, disp, auth };
}

/** The row oauth/callback itself would leave behind: a paused, id-less
 *  placeholder holding a sealed token. */
async function seedPendingBinding(orgId: string) {
  return prisma.sheetBinding.create({
    data: {
      orgId, provider: "google", spreadsheetId: "", tabId: "", tabTitle: "",
      headerRow: 1, columns: {}, refreshToken: seal("rt-x"), accountEmail: "ops@acme.com", status: "paused",
    },
  });
}

// --- GET /sheet/oauth/start --------------------------------------------------

describe("GET /sheet/oauth/start", () => {
  it("returns a Google URL with access_type=offline and a state that opens to the caller's org", async () => {
    const { org, auth } = await seedOrg();
    const res = await request(app).get("/api/dispatcher/sheet/oauth/start").set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("access_type=offline");
    const stateParam = new URL(res.body.url).searchParams.get("state");
    expect(stateParam).toBeTruthy();
    const decoded = JSON.parse(open(stateParam as string));
    expect(decoded.orgId).toBe(org.id);
  });

  it("401s with no bearer token — the dispatcher gate rejects before this route ever runs", async () => {
    const res = await request(app).get("/api/dispatcher/sheet/oauth/start");
    expect(res.status).toBe(401);
  });
});

// --- GET /sheet/oauth/callback -----------------------------------------------

describe("GET /sheet/oauth/callback", () => {
  it("400s on a tampered/foreign state that fails to open", async () => {
    const res = await request(app).get("/api/dispatcher/sheet/oauth/callback").query({ code: "c1", state: "not-a-real-sealed-value" });
    expect(res.status).toBe(400);
  });

  it("400s on a state older than 10 minutes", async () => {
    const { org } = await seedOrg();
    const staleState = seal(JSON.stringify({ orgId: org.id, dispatcherId: null, at: Date.now() - 11 * 60 * 1000 }));
    const res = await request(app).get("/api/dispatcher/sheet/oauth/callback").query({ code: "c1", state: staleState });
    expect(res.status).toBe(400);
  });

  it("a good state creates a paused binding holding a sealed token and redirects to the portal", async () => {
    const { org } = await seedOrg();
    const goodState = seal(JSON.stringify({ orgId: org.id, dispatcherId: null, at: Date.now() }));
    const res = await request(app).get("/api/dispatcher/sheet/oauth/callback").query({ code: "c1", state: goodState });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${process.env.PORTAL_URL}/night-shift?tab=connect&step=2`);

    const binding = await prisma.sheetBinding.findUniqueOrThrow({
      where: { orgId_spreadsheetId_tabId: { orgId: org.id, spreadsheetId: "", tabId: "" } },
    });
    expect(binding.status).toBe("paused");
    expect(binding.refreshToken).not.toBe("rt-1");
    expect(open(binding.refreshToken)).toBe("rt-1");
    expect(binding.accountEmail).toBe("ops@acme.com");
  });
});

// --- GET /sheet/tabs (final fix wave, C1: no Drive listing) ------------------

describe("GET /sheet/tabs", () => {
  it("answers the spreadsheet's title and tabs from spreadsheets.get, by id", async () => {
    const { org, auth } = await seedOrg();
    await seedPendingBinding(org.id);
    const res = await request(app).get("/api/dispatcher/sheet/tabs").set("Authorization", auth).query({ spreadsheetId: "s1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: "Loads", tabs: [{ id: "0", title: "Sheet1" }, { id: "1", title: "Sheet2" }] });
  });

  // Residual fix 3: the server tolerates a full Sheets URL where an id is
  // expected — the id is pulled out of it, a bare id passes through.
  it("accepts a full Google Sheets URL as spreadsheetId and pulls the id out of it", async () => {
    const { org, auth } = await seedOrg();
    await seedPendingBinding(org.id);
    const res = await request(app)
      .get("/api/dispatcher/sheet/tabs")
      .set("Authorization", auth)
      .query({ spreadsheetId: "https://docs.google.com/spreadsheets/d/s1/edit#gid=0" });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Loads");

    const header = await request(app)
      .get("/api/dispatcher/sheet/header")
      .set("Authorization", auth)
      .query({ spreadsheetId: "https://docs.google.com/spreadsheets/d/s1/edit", tabId: "0", headerRow: 1 });
    expect(header.status).toBe(200);
    expect(header.body.header).toEqual(FIXTURE_HEADER);

    const mapped = await request(app)
      .post("/api/dispatcher/sheet/mapping")
      .set("Authorization", auth)
      .send({ spreadsheetId: "https://docs.google.com/spreadsheets/d/s1/edit?usp=sharing", tabId: "0", tabTitle: "Sheet1", headerRow: 1, mapping: FULL_MAPPING });
    expect(mapped.status).toBe(200);
    expect(mapped.body.binding.spreadsheetId).toBe("s1");
  });

  it("GET /sheet/spreadsheets no longer exists — there is no account-wide listing", async () => {
    const { org, auth } = await seedOrg();
    await seedPendingBinding(org.id);
    const res = await request(app).get("/api/dispatcher/sheet/spreadsheets").set("Authorization", auth);
    expect(res.status).toBe(404);
  });
});

// --- GET /sheet/header --------------------------------------------------------

describe("GET /sheet/header", () => {
  it("proposes a mapping for the fixture header", async () => {
    const { org, auth } = await seedOrg();
    await seedPendingBinding(org.id);
    const res = await request(app)
      .get("/api/dispatcher/sheet/header")
      .set("Authorization", auth)
      .query({ spreadsheetId: "s1", tabId: "0", headerRow: 1 });
    expect(res.status).toBe(200);
    expect(res.body.header).toEqual(FIXTURE_HEADER);
    expect(res.body.proposal.mapping).toMatchObject({
      loadRef: "LOAD#", driverPhone: "DRIVER PHONE", pickup: "PICK UP", delivery: "DELIVERY", pickupAppt: "PU APPT", deliveryAppt: "DEL APPT",
    });
    expect(res.body.proposal.extras).toEqual(["CUSTOM COL"]);
    expect(res.body.proposal.missing).toEqual([]);
  });
});

// --- POST /sheet/mapping ------------------------------------------------------

const FULL_MAPPING = {
  loadRef: "LOAD#", driverPhone: "DRIVER PHONE", pickup: "PICK UP", delivery: "DELIVERY", pickupAppt: "PU APPT", deliveryAppt: "DEL APPT",
};

describe("POST /sheet/mapping", () => {
  it("400s naming the missing required key", async () => {
    const { org, auth } = await seedOrg();
    await seedPendingBinding(org.id);
    const incomplete = { loadRef: "LOAD#", driverPhone: "DRIVER PHONE", pickup: "PICK UP", delivery: "DELIVERY" };
    const res = await request(app)
      .post("/api/dispatcher/sheet/mapping")
      .set("Authorization", auth)
      .send({ spreadsheetId: "s1", tabId: "0", tabTitle: "Sheet1", headerRow: 1, mapping: incomplete });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("deliveryAppt");
  });

  it("a valid mapping connects the binding and seeds a BoardLayout with one extra per unmapped header", async () => {
    const { org, auth } = await seedOrg();
    await seedPendingBinding(org.id);
    const res = await request(app)
      .post("/api/dispatcher/sheet/mapping")
      .set("Authorization", auth)
      .send({ spreadsheetId: "s1", tabId: "0", tabTitle: "Sheet1", headerRow: 1, mapping: FULL_MAPPING });
    expect(res.status).toBe(200);
    expect(res.body.binding.status).toBe("connected");
    expect(res.body.binding.spreadsheetId).toBe("s1");
    expect(res.body.binding.tabId).toBe("0");
    // Final fix wave, C1: the spreadsheet's own title is recorded (from
    // spreadsheets.get, never trusted from the client) for the summary card.
    expect(res.body.binding.spreadsheetTitle).toBe("Loads");
    expect(res.body.binding.refreshToken).toBeUndefined();

    const layout = await prisma.boardLayout.findUniqueOrThrow({ where: { orgId: org.id } });
    const columns = layout.columns as unknown as { key: string; label: string; source?: string }[];
    const extraColumns = columns.filter((c) => c.key === "extra" && c.source === "CUSTOM COL");
    expect(extraColumns).toHaveLength(1);
    expect(columns[columns.length - 1]).toEqual({ key: "agent", label: "AGENT" });

    // the pending placeholder row is gone — moved onto the real spreadsheet/tab, not duplicated
    const rows = await prisma.sheetBinding.findMany({ where: { orgId: org.id } });
    expect(rows).toHaveLength(1);
  });

  it("400s on an unknown mapping key instead of silently accepting it", async () => {
    const { org, auth } = await seedOrg();
    await seedPendingBinding(org.id);
    const res = await request(app)
      .post("/api/dispatcher/sheet/mapping")
      .set("Authorization", auth)
      .send({
        spreadsheetId: "s1", tabId: "0", tabTitle: "Sheet1", headerRow: 1,
        mapping: { ...FULL_MAPPING, bogusKey: "CUSTOM COL" },
      });
    expect(res.status).toBe(400);
  });

  it("rolls back the binding write when saveLayout fails partway through — fix round 1: was two separate commits", async () => {
    const { org, auth } = await seedOrg();
    await seedPendingBinding(org.id);
    vi.spyOn(boardLayoutModule, "saveLayout").mockRejectedValueOnce(new Error("boom"));

    const res = await request(app)
      .post("/api/dispatcher/sheet/mapping")
      .set("Authorization", auth)
      .send({ spreadsheetId: "s1", tabId: "0", tabTitle: "Sheet1", headerRow: 1, mapping: FULL_MAPPING });
    expect(res.status).toBe(500);

    // The whole promotion (binding update + layout save) is one transaction:
    // saveLayout throwing must roll the binding write back too, not leave a
    // "connected" binding with no BoardLayout behind it.
    const binding = await prisma.sheetBinding.findUniqueOrThrow({
      where: { orgId_spreadsheetId_tabId: { orgId: org.id, spreadsheetId: "", tabId: "" } },
    });
    expect(binding.status).toBe("paused");
    expect(binding.spreadsheetId).toBe("");

    const layout = await prisma.boardLayout.findUnique({ where: { orgId: org.id } });
    expect(layout).toBeNull();
  });

  it("reconnecting the same tab after a disconnect updates the one existing row instead of erroring — fix round 2", async () => {
    const { org, auth } = await seedOrg();
    const original = await prisma.sheetBinding.create({
      data: {
        orgId: org.id, provider: "google", spreadsheetId: "s1", tabId: "0", tabTitle: "Sheet1",
        headerRow: 1, columns: FULL_MAPPING, refreshToken: seal("rt-old"), accountEmail: "ops@acme.com", status: "connected",
      },
    });

    const disconnectRes = await request(app).delete("/api/dispatcher/sheet").set("Authorization", auth);
    expect(disconnectRes.status).toBe(200);

    // A fresh OAuth round trip leaves a new pending row alongside the
    // now-paused original — the exact state POST /mapping's look-before-write
    // (fix round 2) has to reconcile without hitting the unique constraint.
    const goodState = seal(JSON.stringify({ orgId: org.id, dispatcherId: null, at: Date.now() }));
    const callbackRes = await request(app).get("/api/dispatcher/sheet/oauth/callback").query({ code: "c2", state: goodState });
    expect(callbackRes.status).toBe(302);

    const mappingRes = await request(app)
      .post("/api/dispatcher/sheet/mapping")
      .set("Authorization", auth)
      .send({ spreadsheetId: "s1", tabId: "0", tabTitle: "Sheet1", headerRow: 1, mapping: FULL_MAPPING });
    expect(mappingRes.status).toBe(200);
    expect(mappingRes.body.binding.status).toBe("connected");
    expect(mappingRes.body.binding.spreadsheetId).toBe("s1");
    expect(mappingRes.body.binding.tabId).toBe("0");

    const rows = await prisma.sheetBinding.findMany({ where: { orgId: org.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(original.id); // the original row survives, updated in place
    expect(rows[0].status).toBe("connected");
    expect(open(rows[0].refreshToken)).toBe("rt-1"); // this reconnect's fresh token, not the stale "rt-old"
  });
});

// Final fix wave, C4: a mapping that moves the binding to a different
// spreadsheet/tab forgets the agent column indexes and the last version —
// they described the OLD tab. A re-map of the same tab keeps them.
describe("POST /sheet/mapping — agent column indexes", () => {
  it("resets agentSwitchCol/agentStatusCol/lastVersion when the spreadsheet or tab changes, keeps them on a same-tab re-map", async () => {
    const { org, auth } = await seedOrg();
    const connected = await prisma.sheetBinding.create({
      data: {
        orgId: org.id, provider: "google", spreadsheetId: "s1", tabId: "0", tabTitle: "Sheet1",
        headerRow: 1, columns: FULL_MAPPING, refreshToken: seal("rt-1"), accountEmail: "ops@acme.com", status: "connected",
        agentSwitchCol: 6, agentStatusCol: 7, lastVersion: "v-old",
      },
    });

    // Same tab (a Re-map from the summary card): indexes survive.
    const same = await request(app)
      .post("/api/dispatcher/sheet/mapping")
      .set("Authorization", auth)
      .send({ spreadsheetId: "s1", tabId: "0", tabTitle: "Sheet1", headerRow: 1, mapping: FULL_MAPPING });
    expect(same.status).toBe(200);
    expect(same.body.binding.id).toBe(connected.id);
    expect(same.body.binding.agentSwitchCol).toBe(6);
    expect(same.body.binding.agentStatusCol).toBe(7);
    expect(same.body.binding.lastVersion).toBe("v-old");

    // A different tab of the same spreadsheet: the indexes and version are
    // about the old tab, so they go.
    const moved = await request(app)
      .post("/api/dispatcher/sheet/mapping")
      .set("Authorization", auth)
      .send({ spreadsheetId: "s1", tabId: "1", tabTitle: "Sheet2", headerRow: 1, mapping: FULL_MAPPING });
    expect(moved.status).toBe(200);
    expect(moved.body.binding.tabId).toBe("1");
    expect(moved.body.binding.agentSwitchCol).toBeNull();
    expect(moved.body.binding.agentStatusCol).toBeNull();
    expect(moved.body.binding.lastVersion).toBeNull();
  });
});

// --- GET /sheet, DELETE /sheet ------------------------------------------------

describe("GET /sheet", () => {
  it("never includes refreshToken, and another org's binding is invisible", async () => {
    const { org, auth } = await seedOrg();
    await prisma.sheetBinding.create({
      data: {
        orgId: org.id, provider: "google", spreadsheetId: "s1", tabId: "0", tabTitle: "Sheet1",
        headerRow: 1, columns: FULL_MAPPING, refreshToken: seal("rt-1"), accountEmail: "ops@acme.com", status: "connected",
      },
    });
    const other = await seedOrg();
    await prisma.sheetBinding.create({
      data: {
        orgId: other.org.id, provider: "google", spreadsheetId: "s2", tabId: "0", tabTitle: "Other",
        headerRow: 1, columns: {}, refreshToken: seal("rt-2"), accountEmail: "other@acme.com", status: "connected",
      },
    });

    const res = await request(app).get("/api/dispatcher/sheet").set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.binding).not.toBeNull();
    expect(res.body.binding.spreadsheetId).toBe("s1");
    expect(res.body.binding.refreshToken).toBeUndefined();
    expect(JSON.stringify(res.body.binding)).not.toContain("rt-1");
  });

  it("returns the connected binding when a pending one also exists for the same org", async () => {
    const { org, auth } = await seedOrg();
    await seedPendingBinding(org.id);
    await prisma.sheetBinding.create({
      data: {
        orgId: org.id, provider: "google", spreadsheetId: "s1", tabId: "0", tabTitle: "Sheet1",
        headerRow: 1, columns: FULL_MAPPING, refreshToken: seal("rt-1"), accountEmail: "ops@acme.com", status: "connected",
      },
    });
    const res = await request(app).get("/api/dispatcher/sheet").set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.binding.status).toBe("connected");
    expect(res.body.binding.spreadsheetId).toBe("s1");
  });

  it("returns null when the org has no binding at all", async () => {
    const { auth } = await seedOrg();
    const res = await request(app).get("/api/dispatcher/sheet").set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.binding).toBeNull();
  });
});

describe("DELETE /sheet", () => {
  it("pauses the binding and blanks the token", async () => {
    const { org, auth } = await seedOrg();
    const binding = await prisma.sheetBinding.create({
      data: {
        orgId: org.id, provider: "google", spreadsheetId: "s1", tabId: "0", tabTitle: "Sheet1",
        headerRow: 1, columns: FULL_MAPPING, refreshToken: seal("rt-1"), accountEmail: "ops@acme.com", status: "connected",
      },
    });
    const res = await request(app).delete("/api/dispatcher/sheet").set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.binding.status).toBe("paused");
    expect(res.body.binding.refreshToken).toBeUndefined();

    const fresh = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(fresh.status).toBe("paused");
    expect(fresh.refreshToken).toBe("");
  });

  it("404s when the org has no binding to disconnect", async () => {
    const { auth } = await seedOrg();
    const res = await request(app).delete("/api/dispatcher/sheet").set("Authorization", auth);
    expect(res.status).toBe(404);
  });
});

// --- POST /sheet/install, POST /sheet/sync-now (Task 9) ----------------------
//
// These two share the file's one mocked FakeConnector (spreadsheet "s1", tab
// "0") — placed last in the file, after every other describe block, because
// both mutate that shared connector's tab in ways a test earlier in the file
// (e.g. GET /sheet/header's FIXTURE_HEADER assertion) never expects to see.

describe("POST /sheet/install", () => {
  it("404s when the org has no connected binding", async () => {
    const { auth } = await seedOrg();
    const res = await request(app).post("/api/dispatcher/sheet/install").set("Authorization", auth);
    expect(res.status).toBe(404);
  });

  it("404s when the org only has a pending (not yet connected) binding", async () => {
    const { org, auth } = await seedOrg();
    await seedPendingBinding(org.id);
    const res = await request(app).post("/api/dispatcher/sheet/install").set("Authorization", auth);
    expect(res.status).toBe(404);
  });

  it("adds the two Night Shift columns, records their indexes, and returns the safe binding", async () => {
    const { org, auth } = await seedOrg();
    await prisma.agentPolicy.create({ data: { ...STANDARD_POLICY, orgId: org.id, dispatcherEmail: "ops@acme.com" } });
    await seedPendingBinding(org.id);
    await request(app)
      .post("/api/dispatcher/sheet/mapping")
      .set("Authorization", auth)
      .send({ spreadsheetId: "s1", tabId: "0", tabTitle: "Sheet1", headerRow: 1, mapping: FULL_MAPPING });

    const res = await request(app).post("/api/dispatcher/sheet/install").set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.binding.agentSwitchCol).not.toBeNull();
    expect(res.body.binding.agentStatusCol).not.toBeNull();
    expect(res.body.binding.refreshToken).toBeUndefined();

    const fresh = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: res.body.binding.id } });
    expect(fresh.agentSwitchCol).toBe(res.body.binding.agentSwitchCol);
    expect(fresh.agentStatusCol).toBe(res.body.binding.agentStatusCol);
  });
});

describe("POST /sheet/sync-now", () => {
  it("404s when the org has no connected binding", async () => {
    const { auth } = await seedOrg();
    const res = await request(app).post("/api/dispatcher/sheet/sync-now").set("Authorization", auth);
    expect(res.status).toBe(404);
  });

  it("runs a sync against the connected binding and returns the report", async () => {
    const { org, auth } = await seedOrg();
    await seedPendingBinding(org.id);
    await request(app)
      .post("/api/dispatcher/sheet/mapping")
      .set("Authorization", auth)
      .send({ spreadsheetId: "s1", tabId: "0", tabTitle: "Sheet1", headerRow: 1, mapping: FULL_MAPPING });

    const res = await request(app).post("/api/dispatcher/sheet/sync-now").set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.report.error).toBeNull();

    const load = await prisma.load.findFirst({ where: { orgId: org.id, boardLoadNo: "145219" } });
    expect(load).toBeTruthy();
  });
});
