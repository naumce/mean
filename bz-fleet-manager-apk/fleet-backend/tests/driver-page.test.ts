import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { createApp } from "../src/app.js";
import * as realtime from "../src/realtime.js";
import { jsStringLiteral, renderDriverPage } from "../src/routes/driverAvailabilityPage.js";

// AI Dispatch Foundation (Task 10): the driver-facing availability page.
// Unauthenticated by session on purpose — every route here is keyed off
// DriverAvailability.shareToken, a link, not a login (same family as
// night-shift's driverLink.ts). No dispatcher bearer token appears anywhere
// in this file.

beforeEach(resetDb);

async function seedDriver(overrides: Partial<{ name: string; firstName: string | null }> = {}) {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const driver = await prisma.driver.create({
    data: {
      email: "jake@x.com",
      passwordHash: "x",
      name: overrides.name ?? "Jake Morrow",
      firstName: "firstName" in overrides ? overrides.firstName : "Jake",
      orgId: org.id,
    },
  });
  return { org, driver };
}

async function seedAvailability(
  driverId: string,
  data: Partial<{ acceptingLoads: boolean; locationSharingEnabled: boolean; source: string; availabilityStatus: string }> = {},
) {
  return prisma.driverAvailability.create({ data: { driverId, ...data } });
}

const UNKNOWN_TOKEN = "not-a-real-token";

// A request-level test of a hostile token is moot — rowByToken's 404 path
// means an unknown token never reaches renderDriverPage at all — so the
// escaping is unit-tested directly against the exported helpers instead.
describe("jsStringLiteral / renderDriverPage — a hostile shareToken cannot break out of <script>", () => {
  it("neutralises every '<' so no literal </script> sequence survives", () => {
    const hostile = "</script><img src=x onerror=alert(1)>";
    const literal = jsStringLiteral(hostile);
    expect(literal).not.toContain("<"); // every '<' became the 6-char < escape
    expect(literal.toLowerCase()).not.toContain("</script");
    // The escape is valid JS and round-trips to the exact original string —
    // the HTML parser's view changes; the JS engine's does not.
    // eslint-disable-next-line no-eval
    expect(eval(literal)).toBe(hostile);
  });

  it("renderDriverPage's output never contains an unescaped </script from the token", () => {
    const hostile = "</script><script>alert(1)</script>";
    const html = renderDriverPage({ firstName: "Jake", name: "Jake Morrow" }, hostile);
    // Every "</script" in the page must be the ONE real closing tag this
    // template itself owns — none may originate from the token.
    const scriptCloses = html.toLowerCase().split("</script").length - 1;
    expect(scriptCloses).toBe(1);
    // eslint-disable-next-line no-eval
    expect(eval(jsStringLiteral(hostile))).toBe(hostile);
  });

  it("still renders the exact token for a normal uuid-shaped value", () => {
    const html = renderDriverPage({ firstName: "Jake", name: "Jake Morrow" }, "abc-123-def");
    expect(html).toContain('"abc-123-def"');
  });

  it("a name containing a $-pattern (e.g. \"$'\") is spliced in literally, not reinterpreted", () => {
    // String.replace's STRING form would treat `$'` as "everything after the
    // match" and splice the rest of the template (including the <script>
    // block) into the <title>/<h1> — a function replacement never does this.
    const html = renderDriverPage({ firstName: "Bob $'", name: "Bob $' Jones" }, "tok-1");
    expect(html).toContain("Hi Bob $&#39;");
    expect(html).toContain("Bob $&#39; — Availability");
    // The template must still be intact: exactly one real </script> tag,
    // never one spliced in from the name.
    expect(html.toLowerCase().split("</script").length - 1).toBe(1);
    expect(html).toContain('"tok-1"');
  });
});

describe("GET /driver/:shareToken (the HTML page)", () => {
  it("404s plain text for an unknown token", async () => {
    const res = await request(app).get(`/driver/${UNKNOWN_TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.type).toBe("text/plain");
  });

  it("renders the driver's first name, both toggle labels, and the test-position form", async () => {
    const { driver } = await seedDriver({ name: "Jake Morrow", firstName: "Jake" });
    const avail = await seedAvailability(driver.id);

    const res = await request(app).get(`/driver/${avail.shareToken}`);
    expect(res.status).toBe(200);
    expect(res.type).toBe("text/html");
    expect(res.text).toContain("Jake");
    expect(res.text).toContain("LOCATION SHARING");
    expect(res.text).toContain("AVAILABLE FOR LOADS");
    expect(res.text).toContain("Test position");
    expect(res.text).toContain("citySelect");
    // The token is JSON-encoded into the script, not HTML-escaped into text.
    expect(res.text).toContain(JSON.stringify(avail.shareToken));
  });

  it("falls back to the first word of `name` when firstName is unset", async () => {
    const { driver } = await seedDriver({ name: "Dana Diaz", firstName: null });
    const avail = await seedAvailability(driver.id);
    const res = await request(app).get(`/driver/${avail.shareToken}`);
    expect(res.text).toContain("Dana");
  });

  it("sends Cache-Control: no-store and Referrer-Policy: no-referrer, on both a hit and a 404", async () => {
    const { driver } = await seedDriver();
    const avail = await seedAvailability(driver.id);

    const hit = await request(app).get(`/driver/${avail.shareToken}`);
    expect(hit.headers["cache-control"]).toBe("no-store");
    expect(hit.headers["referrer-policy"]).toBe("no-referrer");

    const miss = await request(app).get(`/driver/${UNKNOWN_TOKEN}`);
    expect(miss.headers["cache-control"]).toBe("no-store");
    expect(miss.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("is reachable with PORTAL_DIST unset (no hosting configured)", async () => {
    expect(process.env.PORTAL_DIST).toBeFalsy();
    const { driver } = await seedDriver();
    const avail = await seedAvailability(driver.id);
    const res = await request(app).get(`/driver/${avail.shareToken}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("LOCATION SHARING");
  });

  describe("with the portal's SPA hosting mounted", () => {
    let dist: string;
    const ORIGINAL_PORTAL_DIST = process.env.PORTAL_DIST;

    beforeAll(() => {
      dist = fs.mkdtempSync(path.join(os.tmpdir(), "portal-driver-page-"));
      fs.writeFileSync(path.join(dist, "index.html"), "<html>SPA shell</html>");
    });
    afterAll(() => {
      fs.rmSync(dist, { recursive: true, force: true });
      if (ORIGINAL_PORTAL_DIST === undefined) delete process.env.PORTAL_DIST;
      else process.env.PORTAL_DIST = ORIGINAL_PORTAL_DIST;
    });

    it("the SPA fallback does not swallow the driver page", async () => {
      process.env.PORTAL_DIST = dist;
      const hostedApp = createApp();
      const { driver } = await seedDriver();
      const avail = await seedAvailability(driver.id);

      const page = await request(hostedApp).get(`/driver/${avail.shareToken}`);
      expect(page.status).toBe(200);
      expect(page.text).toContain("LOCATION SHARING");
      expect(page.text).not.toContain("SPA shell");

      // The fallback still works for an actual unknown SPA route.
      const spa = await request(hostedApp).get("/some/portal/route");
      expect(spa.text).toContain("SPA shell");
    });
  });
});

describe("GET /api/driver-page/:shareToken/availability", () => {
  it("404s an unknown token", async () => {
    const res = await request(app).get(`/api/driver-page/${UNKNOWN_TOKEN}/availability`);
    expect(res.status).toBe(404);
  });

  it("answers the documented shape, built from availabilityFor", async () => {
    const { driver } = await seedDriver({ name: "Jake Morrow", firstName: "Jake" });
    // source: "derived" — a "manual" row (the schema's own default) at the
    // default availabilityStatus ("UNAVAILABLE") is deriveStatus's rule-1
    // override and would read as UNAVAILABLE regardless of acceptingLoads;
    // that rule is driverAvailability.spec's own concern, not this route's.
    const avail = await seedAvailability(driver.id, { acceptingLoads: true, locationSharingEnabled: true, source: "derived" });

    const res = await request(app).get(`/api/driver-page/${avail.shareToken}/availability`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      driver: { firstName: "Jake", name: "Jake Morrow" },
      status: "AVAILABLE",
      acceptingLoads: true,
      locationSharingEnabled: true,
      locationSharingUpdatedAt: null,
      availableAt: expect.any(Number),
      available: { city: null, state: null },
    });
  });
});

describe("PATCH /api/driver-page/:shareToken/availability", () => {
  it("404s an unknown token", async () => {
    const res = await request(app).patch(`/api/driver-page/${UNKNOWN_TOKEN}/availability`).send({ acceptingLoads: true });
    expect(res.status).toBe(404);
  });

  it("flips acceptingLoads and stamps nothing on locationSharingUpdatedAt", async () => {
    const { driver } = await seedDriver();
    const avail = await seedAvailability(driver.id);

    const res = await request(app)
      .patch(`/api/driver-page/${avail.shareToken}/availability`)
      .send({ acceptingLoads: true });
    expect(res.status).toBe(200);
    expect(res.body.acceptingLoads).toBe(true);
    expect(res.body.locationSharingUpdatedAt).toBeNull();

    const row = await prisma.driverAvailability.findUnique({ where: { driverId: driver.id } });
    expect(row?.locationSharingUpdatedAt).toBeNull();
  });

  it("flips locationSharingEnabled and stamps locationSharingUpdatedAt only on that change", async () => {
    const { driver } = await seedDriver();
    const avail = await seedAvailability(driver.id, { locationSharingEnabled: false });

    const on = await request(app)
      .patch(`/api/driver-page/${avail.shareToken}/availability`)
      .send({ locationSharingEnabled: true });
    expect(on.status).toBe(200);
    expect(on.body.locationSharingEnabled).toBe(true);
    expect(on.body.locationSharingUpdatedAt).not.toBeNull();
    const firstStamp = on.body.locationSharingUpdatedAt as string;

    // A later PATCH that resends the SAME value (or touches only
    // acceptingLoads) must not move the clock again.
    await new Promise((r) => setTimeout(r, 5));
    const again = await request(app)
      .patch(`/api/driver-page/${avail.shareToken}/availability`)
      .send({ locationSharingEnabled: true });
    expect(again.body.locationSharingUpdatedAt).toBe(firstStamp);

    const onlyAccepting = await request(app)
      .patch(`/api/driver-page/${avail.shareToken}/availability`)
      .send({ acceptingLoads: true });
    expect(onlyAccepting.body.locationSharingUpdatedAt).toBe(firstStamp);
  });

  it("an existing manual override (source/availabilityStatus) survives a driver-page toggle untouched", async () => {
    const { driver } = await seedDriver();
    const avail = await seedAvailability(driver.id, { source: "manual", availabilityStatus: "OFF_DUTY" });

    const res = await request(app)
      .patch(`/api/driver-page/${avail.shareToken}/availability`)
      .send({ acceptingLoads: true });
    expect(res.status).toBe(200);

    const row = await prisma.driverAvailability.findUnique({ where: { driverId: driver.id } });
    expect(row?.source).toBe("manual");
    expect(row?.availabilityStatus).toBe("OFF_DUTY");
    expect(row?.acceptingLoads).toBe(true);
  });

  it("a 'derived' row's source/availabilityStatus are likewise unaffected by a toggle", async () => {
    const { driver } = await seedDriver();
    const avail = await seedAvailability(driver.id, { source: "derived" });

    await request(app).patch(`/api/driver-page/${avail.shareToken}/availability`).send({ locationSharingEnabled: true });

    const row = await prisma.driverAvailability.findUnique({ where: { driverId: driver.id } });
    expect(row?.source).toBe("derived");
    expect(row?.availabilityStatus).toBe("UNAVAILABLE"); // schema default, never promoted to "manual" here
  });

  describe("validation", () => {
    it("400s an empty body", async () => {
      const { driver } = await seedDriver();
      const avail = await seedAvailability(driver.id);
      const res = await request(app).patch(`/api/driver-page/${avail.shareToken}/availability`).send({});
      expect(res.status).toBe(400);
    });

    it("400s a non-boolean field", async () => {
      const { driver } = await seedDriver();
      const avail = await seedAvailability(driver.id);
      const res = await request(app)
        .patch(`/api/driver-page/${avail.shareToken}/availability`)
        .send({ acceptingLoads: "yes" });
      expect(res.status).toBe(400);
    });
  });
});

describe("POST /api/driver-page/:shareToken/ping", () => {
  it("404s an unknown token", async () => {
    const res = await request(app).post(`/api/driver-page/${UNKNOWN_TOKEN}/ping`).send({ lat: 1, lng: 1 });
    expect(res.status).toBe(404);
  });

  it("writes a DriverLocation, updates Driver.lastLat/lastLng, and emits driver_location when sharing is ON", async () => {
    const { driver } = await seedDriver({ name: "Jake Morrow" });
    const avail = await seedAvailability(driver.id, { locationSharingEnabled: true });
    const spy = vi.spyOn(realtime, "emitToDispatchers");

    const res = await request(app)
      .post(`/api/driver-page/${avail.shareToken}/ping`)
      .send({ lat: 41.8781, lng: -87.6298 });
    expect(res.status).toBe(204);

    const locations = await prisma.driverLocation.findMany({ where: { driverId: driver.id } });
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({ latitude: 41.8781, longitude: -87.6298 });

    const updated = await prisma.driver.findUnique({ where: { id: driver.id } });
    expect(updated?.lastLat).toBe(41.8781);
    expect(updated?.lastLng).toBe(-87.6298);
    expect(updated?.lastLocationAt).not.toBeNull();

    expect(spy).toHaveBeenCalledWith(driver.orgId, "driver_location", {
      driverId: driver.id,
      driverName: "Jake Morrow",
      latitude: 41.8781,
      longitude: -87.6298,
      at: locations[0]!.createdAt.toISOString(),
    });
  });

  it("202s and writes nothing when sharing is OFF (the default)", async () => {
    const { driver } = await seedDriver();
    const avail = await seedAvailability(driver.id); // locationSharingEnabled defaults false
    const spy = vi.spyOn(realtime, "emitToDispatchers");

    const res = await request(app).post(`/api/driver-page/${avail.shareToken}/ping`).send({ lat: 1, lng: 1 });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ignored: true, reason: "location sharing is off" });

    expect(await prisma.driverLocation.findMany({ where: { driverId: driver.id } })).toHaveLength(0);
    const untouched = await prisma.driver.findUnique({ where: { id: driver.id } });
    expect(untouched?.lastLat).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  describe("validation", () => {
    it("400s an out-of-range latitude/longitude", async () => {
      const { driver } = await seedDriver();
      const avail = await seedAvailability(driver.id, { locationSharingEnabled: true });
      const bad = await Promise.all([
        request(app).post(`/api/driver-page/${avail.shareToken}/ping`).send({ lat: 91, lng: 0 }),
        request(app).post(`/api/driver-page/${avail.shareToken}/ping`).send({ lat: 0, lng: -200 }),
        request(app).post(`/api/driver-page/${avail.shareToken}/ping`).send({ lat: 0 }),
      ]);
      for (const r of bad) expect(r.status).toBe(400);
    });
  });
});
