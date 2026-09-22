// The night shift, running. One process: the HTTP server the driver's page
// and Twilio talk to, and a one-minute tick over every live trip.
//
// MODE=platform (default): every 60 s, bring the registry in line with the
// board — start a trip for every load a dispatcher has switched on, stop
// one whose load was switched off or delivered, apply any supervision
// commands from the drawer — then tick every running trip.
// MODE=file: today's original path, unchanged — one JSON file on the
// command line, one driver, one dispatcher, no board and no commands.
import nodemailer from "nodemailer";
import twilio from "twilio";
import { Agent } from "../core/agent.js";
import { TIME_SCALE } from "../core/constants.js";
import { STANDARD } from "../core/policy.js";
import type { Policy } from "../core/policy.js";
import { KeywordClassifier } from "../fakes/index.js";
import type { SheetPort } from "../ports/index.js";
import { ChatBus } from "./chatBus.js";
import { applyPendingCommands } from "./commands.js";
import { PlatformPings } from "./platformPings.js";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeConversation, CLAUDE_MODEL } from "./claudeConversation.js";
import { loadConfig } from "./config.js";
import { LogSheet } from "./logSheet.js";
import { readLoad } from "./loadFile.js";
import { log } from "./log.js";
import { MapboxRouter } from "./mapboxRouter.js";
import { telephonyFor } from "./orgTelephony.js";
import { PendingCalls } from "./pendingCalls.js";
import { PlatformSheet } from "./platformSheet.js";
import { syncPlatformLoads } from "./platformLoads.js";
import { syncAllSheets } from "../../../fleet-backend/src/lib/sheet/sync.js";
import { alertSheetFailures } from "./sheetAlerts.js";
import { PrismaEvents } from "./prismaEvents.js";
import { restStopsNear } from "./prismaRestStops.js";
import { Registry } from "./registry.js";
import { createServer } from "./server.js";
import { SmtpMailer } from "./smtpMailer.js";
import { newDriverToken, newTripId } from "./tokens.js";
import { TwilioMessenger } from "./twilioMessenger.js";
import { TwilioPhone } from "./twilioPhone.js";

const TICK_MS = 60_000;

async function main(): Promise<void> {
  const config = loadConfig();

  const clock = { nowMs: () => Date.now() };
  const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
  const transport = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465, auth: { user: config.smtp.user, pass: config.smtp.pass } });
  const router = new MapboxRouter();
  // Slice 4, Task 4: one mailer for the sheet-failure alert, org-scoped (not
  // trip-scoped) — `dispatcherEmail: ""` in its opts can never equal a real
  // "to" address, so `SmtpMailer`'s one-click "send the customer email" link
  // (a trip's own escalation feature) never gets appended to this mail.
  const sheetAlertMailer = new SmtpMailer(transport, config.smtp.from, {
    dispatcherEmail: "", publicUrl: config.publicUrl, linkSecret: config.linkSecret, tripId: "sheet-alerts", clock: clock.nowMs,
  });
  // One pending-call map for the whole process — every trip's TwilioPhone
  // registers into it, and the voice webhook router resolves against it.
  const pending = new PendingCalls(config.publicUrl);
  const bus = new ChatBus();
  // Slice 3: one model client for every trip, or none. Which one is in
  // force is logged at boot so a night with no follow-up questions is
  // never a mystery.
  const brain = config.anthropicApiKey ? new ClaudeConversation(new Anthropic({ apiKey: config.anthropicApiKey }), config.tz) : null;
  log("info", brain ? "driver calls are conversations; replies read by " + CLAUDE_MODEL : "no ANTHROPIC_API_KEY — one-question calls, keyword classifier", {});
  const validate = (sig: string, url: string, params: Record<string, string>): boolean => twilio.validateRequest(config.twilio.authToken, sig, url, params);

  const registry = new Registry((trip) => {
    const events = new PrismaEvents(trip.tripId);
    // File mode has no Load row to scope a PlatformSheet to; it keeps
    // logging to the console exactly as it always has. Platform mode's
    // sheet is scoped to the load and knows whether its policy is shadow.
    const sheet: SheetPort = config.mode === "platform" && trip.loadId ? new PlatformSheet(trip.loadId, trip.policy.shadow) : new LogSheet();
    const phone = new TwilioPhone(twilioClient, trip.callerId, config.publicUrl, pending);
    return new Agent(
      {
        clock, router, sheet, phone, events, classifier: brain ?? new KeywordClassifier(), conversation: brain,
        messenger: new TwilioMessenger(twilioClient, trip.sender, bus, trip, config.publicUrl, clock.nowMs),
        mailer: new SmtpMailer(transport, config.smtp.from, { dispatcherEmail: trip.policy.dispatcherEmail, publicUrl: config.publicUrl, linkSecret: config.linkSecret, tripId: trip.tripId, clock: clock.nowMs }),
        restStops: trip.restStops, landmarks: [], dispatcherEmail: trip.policy.dispatcherEmail, dispatcherPhone: trip.policy.dispatcherPhone, tz: config.tz,
        policy: trip.policy,
      },
      trip.brief,
    );
  });

  const app = createServer({ registry, bus, pending, validate, publicUrl: config.publicUrl, linkSecret: config.linkSecret, clock: clock.nowMs });
  await new Promise<void>((resolve) => app.listen(config.port, resolve));
  log("info", "night-shift worker listening", { port: config.port, publicUrl: config.publicUrl, mode: config.mode, timeScale: TIME_SCALE, ...(TIME_SCALE !== 1 ? { note: "DEMO SPEED — stop rule and cooldowns scaled; not the road" } : {}) });

  if (config.mode === "file") {
    await runFileMode(config, registry, router);
  } else {
    log("info", "night-shift worker polling the board", { pollMs: TICK_MS });
    const platformPings = new PlatformPings();
    const poll = async (): Promise<void> => {
      try {
        await syncAllSheets();
        if (config.portalUrl) await alertSheetFailures({ mailer: sheetAlertMailer, portalUrl: config.portalUrl });
        await syncPlatformLoads(registry, {
          router, restStopsNear,
          telephonyFor: (orgId) => telephonyFor(orgId, { fromNumber: config.twilio.fromNumber, callerId: config.twilio.callerId }),
        });
        await applyPendingCommands({ registry, bus, nowMs: clock.nowMs });
        await platformPings.feed(registry);
      } catch (e) {
        log("error", "platform poll failed", { error: e instanceof Error ? e.message : String(e) });
      }
      await registry.tickAll();
    };
    await poll();
    setInterval(() => { void poll(); }, TICK_MS);
  }

  process.on("SIGINT", () => { log("info", "night-shift worker stopping"); process.exit(0); });
}

/** MODE=file, unchanged from before this task: one load, one driver, one
 *  dispatcher, all named by env — `loadConfig` already refused to start
 *  without them (see config.ts's superRefine), so `config.driver` and
 *  `config.dispatcherEmail` are known non-null here. */
async function runFileMode(config: ReturnType<typeof loadConfig>, registry: Registry, router: MapboxRouter): Promise<void> {
  const loadPath = process.argv[2];
  if (!loadPath) throw new Error("usage: npm run night:start -- loads/<load>.json");
  const driver = config.driver!;
  // File mode is always live — a demo drive on a real phone, never a
  // rehearsal — so it builds its own policy from config rather than reading
  // STANDARD's shadow:true default.
  const policy: Policy = { ...STANDARD, shadow: false, dispatcherEmail: config.dispatcherEmail!, dispatcherPhone: config.dispatcherPhone };

  const brief = readLoad(loadPath, driver, Date.now());
  // Registered stops near the road: route once here (cached in RouteDistance,
  // so the agent's own routing call inside start() costs nothing more).
  const route = await router.route(brief.origin, brief.destination, { equipment: brief.equipment, departAtMs: brief.departAtMs });
  const restStops = await restStopsNear(route.geometry, null);
  log("info", "route resolved", { loadRef: brief.loadRef, miles: Math.round(route.distanceMi), driveMin: Math.round(route.driveMin), registeredStopsNearby: restStops.length });

  // The trip row exists before the agent starts: its first event is written
  // during start(), and that event needs a trip to belong to.
  const ids = { tripId: newTripId(), driverToken: newDriverToken() };
  await PrismaEvents.createTrip({ tripId: ids.tripId, loadRef: brief.loadRef, driverToken: ids.driverToken, brief });
  const trip = await registry.start(brief, ids, { restStops, policy, orgId: "file", sender: config.twilio.fromNumber, callerId: config.twilio.callerId });
  log("info", "driver link", { url: config.publicUrl + "/d/" + trip.driverToken, status: trip.agent.state.status });

  setInterval(() => { void registry.tickAll(); }, TICK_MS);
}

main().catch((e) => {
  log("error", "night-shift worker failed to start", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
