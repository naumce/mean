import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/live/config.js";

// A worker that starts with a missing secret and finds out at 3 a.m. is the
// failure this file exists to prevent. Every variable is named in the error.
const full = {
  TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM_NUMBER: "+15550001",
  SMTP_HOST: "smtp.example.com", SMTP_PORT: "465", SMTP_USER: "u@example.com", SMTP_PASS: "p", MAIL_FROM: "agent@example.com",
  DISPATCHER_EMAIL: "boss@example.com", DRIVER_PHONE: "+38970000000", DRIVER_NAME: "Trajce",
  MAPBOX_TOKEN: "pk.test", DATABASE_URL: "postgresql://x", PUBLIC_URL: "https://demo.trycloudflare.com",
  PORT: "3010", TZ: "Europe/Skopje", LINK_SECRET: "s3cret-s3cret-s3cret",
  // Platform mode's sheet-sync half (final fix wave, I13): the same values
  // fleet-backend runs with, since the worker imports its sync code.
  SECRET_BOX_KEY: "aa68484a95bf369cba0e60e75ff919322a0b6d99d43082887a5f7b503b04d77a",
  GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "csecret",
  GOOGLE_REDIRECT_URI: "http://localhost:3001/api/dispatcher/sheet/oauth/callback",
  PORTAL_URL: "http://localhost:5173",
};

const PLATFORM_SHEET_VARS = ["SECRET_BOX_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "PORTAL_URL"] as const;

describe("loadConfig", () => {
  it("parses a complete environment into typed config", () => {
    const c = loadConfig(full);
    expect(c.smtp.port).toBe(465);
    expect(c.port).toBe(3010);
    expect(c.publicUrl).toBe("https://demo.trycloudflare.com");
    expect(c.driver?.phone).toBe("+38970000000");
  });

  it("names every missing variable and refuses to start", () => {
    const { TWILIO_AUTH_TOKEN: _a, SMTP_PASS: _b, ...partial } = full;
    expect(() => loadConfig(partial)).toThrow(/TWILIO_AUTH_TOKEN/);
    expect(() => loadConfig(partial)).toThrow(/SMTP_PASS/);
  });

  it("rejects a public URL that is not https, and a port that is not a number", () => {
    expect(() => loadConfig({ ...full, PUBLIC_URL: "http://demo.trycloudflare.com" })).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ ...full, PORT: "abc" })).toThrow(/PORT/);
  });

  it("strips a trailing slash from PUBLIC_URL so links never get a double slash", () => {
    expect(loadConfig({ ...full, PUBLIC_URL: "https://demo.trycloudflare.com/" }).publicUrl).toBe("https://demo.trycloudflare.com");
  });

  it("rejects a driver phone that is not E.164", () => {
    expect(() => loadConfig({ ...full, DRIVER_PHONE: "070 000 000" })).toThrow(/DRIVER_PHONE/);
  });

  // Macedonian carriers do not deliver from international long codes; Twilio's
  // guidance there is an alphanumeric sender. Letters cannot place a call, so
  // an alpha sender needs a verified caller ID for the voice rung.
  it("accepts an alphanumeric SMS sender when a verified caller ID is given for voice", () => {
    const c = loadConfig({ ...full, TWILIO_FROM_NUMBER: "NIGHTSHIFT", TWILIO_CALLER_ID: "+38970000001" });
    expect(c.twilio.fromNumber).toBe("NIGHTSHIFT");
    expect(c.twilio.callerId).toBe("+38970000001");
  });

  it("an alphanumeric sender without a caller ID refuses to start, naming TWILIO_CALLER_ID", () => {
    expect(() => loadConfig({ ...full, TWILIO_FROM_NUMBER: "NIGHTSHIFT" })).toThrow(/TWILIO_CALLER_ID/);
  });

  it("a real Twilio number is its own caller ID", () => {
    expect(loadConfig(full).twilio.callerId).toBe("+15550001");
  });

  it("rejects a sender that is neither E.164 nor a valid alphanumeric ID", () => {
    expect(() => loadConfig({ ...full, TWILIO_FROM_NUMBER: "night shift!!" })).toThrow(/TWILIO_FROM_NUMBER/);
    expect(() => loadConfig({ ...full, TWILIO_FROM_NUMBER: "12345", TWILIO_CALLER_ID: "+38970000001" })).toThrow(/TWILIO_FROM_NUMBER/);
  });

  // Final fix wave, I13: platform mode syncs Google Sheets through
  // fleet-backend's own code, which reads these five at call time — a
  // worker missing one would find out at 3 a.m., on the first sync.
  describe("platform mode's sheet-sync variables", () => {
    it.each(PLATFORM_SHEET_VARS)("refuses to start without %s, naming it", (name) => {
      const { [name]: _dropped, ...partial } = full;
      expect(() => loadConfig(partial)).toThrow(new RegExp(name));
    });

    it("SECRET_BOX_KEY must be 64 hex characters (a 32-byte key)", () => {
      expect(() => loadConfig({ ...full, SECRET_BOX_KEY: "short" })).toThrow(/SECRET_BOX_KEY/);
      expect(() => loadConfig({ ...full, SECRET_BOX_KEY: "zz".repeat(32) })).toThrow(/SECRET_BOX_KEY/);
    });

    it("PORTAL_URL must be an http(s) url, and is carried on the config without a trailing slash", () => {
      expect(() => loadConfig({ ...full, PORTAL_URL: "localhost:5173" })).toThrow(/PORTAL_URL/);
      expect(loadConfig({ ...full, PORTAL_URL: "https://app.example.com/" }).portalUrl).toBe("https://app.example.com");
    });

    it("file mode does not need any of them — one load, one driver, no sheet", () => {
      const { SECRET_BOX_KEY: _a, GOOGLE_CLIENT_ID: _b, GOOGLE_CLIENT_SECRET: _c, GOOGLE_REDIRECT_URI: _d, PORTAL_URL: _e, ...fileOnly } = full;
      const c = loadConfig({ ...fileOnly, MODE: "file" });
      expect(c.mode).toBe("file");
      expect(c.portalUrl).toBeNull();
    });
  });

  it("takes an optional dispatcher phone for the escalation call, E.164 when present", () => {
    expect(loadConfig(full).dispatcherPhone).toBeNull();
    expect(loadConfig({ ...full, DISPATCHER_PHONE: "+38978000000" }).dispatcherPhone).toBe("+38978000000");
    expect(() => loadConfig({ ...full, DISPATCHER_PHONE: "078 000 000" })).toThrow(/DISPATCHER_PHONE/);
  });
});
