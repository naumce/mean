import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth.js";
import { driverRouter } from "./routes/driver.js";
import { tripsRouter } from "./routes/trips.js";
import { signsProofRouter } from "./routes/signsProof.js";
import { messagesRouter } from "./routes/messages.js";
import { notificationsRouter } from "./routes/notifications.js";
import { sessionsRouter } from "./routes/sessions.js";
import { safetyRouter } from "./routes/safety.js";
import { vehicleRouter } from "./routes/vehicle.js";
import { navigationRouter } from "./routes/navigation.js";
import { dispatcherAuthRouter, dispatcherMeRouter } from "./routes/dispatcherAuth.js";
import { dispatcherDriversRouter } from "./routes/dispatcherDrivers.js";
import { dispatcherCarriersRouter } from "./routes/dispatcherCarriers.js";
import { dispatcherCarrierStatementsRouter } from "./routes/dispatcherCarrierStatements.js";
import { dispatcherRestStopsRouter } from "./routes/dispatcherRestStops.js";
import { dispatcherRoutePoisRouter } from "./routes/dispatcherRoutePois.js";
import { dispatcherLocationRequestsRouter } from "./routes/dispatcherLocationRequests.js";
import { dispatcherFuelPricesRouter } from "./routes/dispatcherFuelPrices.js";
import { dispatcherDetentionRouter } from "./routes/dispatcherDetention.js";
import { dispatcherDemoRouter } from "./routes/dispatcherDemo.js";
import { dispatcherTripsRouter } from "./routes/dispatcherTrips.js";
import { dispatcherBoardRouter } from "./routes/dispatcherBoard.js";
import { dispatcherAssignmentsRouter } from "./routes/dispatcherAssignments.js";
import { dispatcherSuggestRouter } from "./routes/dispatcherSuggest.js";
import { dispatcherLoadboardRouter } from "./routes/dispatcherLoadboard.js";
import { dispatcherNightShiftRouter } from "./routes/dispatcherNightShift.js";
import { nightShiftLinkRouter } from "./routes/nightShiftLink.js";
import { dispatcherSheetRouter, sheetOauthCallback } from "./routes/dispatcherSheet.js";
import { dispatcherAlertsRouter } from "./routes/dispatcherAlerts.js";
import { dispatcherImportRouter } from "./routes/dispatcherImport.js";
import { dispatcherKpisRouter } from "./routes/dispatcherKpis.js";
import { dispatcherLoadsRouter } from "./routes/dispatcherLoads.js";
import { dispatcherDriverNextRouter } from "./routes/dispatcherDriverNext.js";
import { dispatcherIntegrationsRouter } from "./routes/dispatcherIntegrations.js";
import { dispatcherAnalyticsRouter } from "./routes/dispatcherAnalytics.js";
import { dispatcherYardRouter } from "./routes/dispatcherYard.js";
import { dispatcherEconomicsRouter } from "./routes/dispatcherEconomics.js";
import { dispatcherSettingsRouter } from "./routes/dispatcherSettings.js";
import { dispatcherRiskRouter } from "./routes/dispatcherRisk.js";
import { dispatcherSettlementsRouter } from "./routes/dispatcherSettlements.js";
import { dispatcherFleetRouter } from "./routes/dispatcherFleet.js";
import { dispatcherLocksRouter } from "./routes/dispatcherLocks.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { attachOrgScope } from "./middleware/orgScope.js";
import { dispatcherApprovalsRouter } from "./routes/dispatcherApprovals.js";
import { dispatcherCommsRouter } from "./routes/dispatcherComms.js";
import { dispatcherBrokerBoardRouter } from "./routes/dispatcherBrokerBoard.js";
import { dispatcherLoadLocksRouter } from "./routes/dispatcherLoadLocks.js";
import { dispatcherLoadTruthRouter } from "./routes/dispatcherLoadTruth.js";
import { requireAuth, requireDispatcher } from "./middleware/auth.js";
import { uploadsDir } from "./lib/upload.js";
import { rejectNulBytes } from "./middleware/rejectNulBytes.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { settleDeadline } from "./middleware/settleDeadline.js";

export function createApp() {
  const app = express();
  // TRUST_PROXY = number of reverse-proxy hops in front of this process
  // (1 for the docker-compose nginx). Without it, req.ip behind a proxy is
  // the proxy's address and every client shares one rate-limit bucket.
  const trustProxy = Number(process.env.TRUST_PROXY ?? 0);
  if (trustProxy > 0) app.set("trust proxy", trustProxy);
  // FIRST, ahead of cors/json/every route: bounds the whole request —
  // middleware included — to HANDLER_DEADLINE_MS, so a hang anywhere
  // downstream (attachOrgScope awaiting a dead database, say) still gets an
  // answer instead of leaving the client with nothing. See
  // src/middleware/settleDeadline.ts for why position is the entire point
  // (plan A5 task 7, fix round 1).
  app.use(settleDeadline);
  // CORS_ORIGIN (comma-separated) restricts cross-origin callers in
  // production; unset = dev-permissive so the Vite portal on :5173 works.
  // Same-origin reverse-proxy deploys never hit CORS at all.
  const corsOrigin = process.env.CORS_ORIGIN;
  app.use(cors(corsOrigin ? { origin: corsOrigin.split(",").map((o) => o.trim()) } : undefined));
  app.use(express.json({ limit: "1mb" }));
  // Ahead of every route (and of the static mount): a NUL byte anywhere in
  // the URL or the JSON body is a 400 here rather than a Postgres 22021 that
  // rejects inside an un-awaited async handler and kills the process. See
  // src/middleware/rejectNulBytes.ts.
  app.use(rejectNulBytes);
  // Uploaded filenames keep their client-supplied extension, so never let the
  // static server infer an executable Content-Type from it (stored-XSS via a
  // .html/.svg upload). Known-inert image types render inline; everything
  // else downloads as an attachment.
  const INLINE_UPLOAD_TYPES: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp",
  };
  app.use("/uploads", express.static(uploadsDir, {
    setHeaders: (res, filePath) => {
      const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
      res.setHeader("X-Content-Type-Options", "nosniff");
      const inline = INLINE_UPLOAD_TYPES[ext];
      if (inline) {
        res.setHeader("Content-Type", inline);
      } else {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", "attachment");
      }
    },
  }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api/auth", authRouter);
  // dispatcherAuthRouter's /dispatcher/login must be public — it has to be
  // mounted before signsProofRouter/messagesRouter/notificationsRouter/
  // vehicleRouter below: those are mounted broadly at "/api" and each does
  // `router.use(requireAuth)` with no path filter, so once a request enters
  // one of them it applies to every path that reaches that router, not just
  // its own routes. Placed after authRouter, before any of the broad ones.
  app.use("/api/auth", dispatcherAuthRouter);
  // Google redirects a bare browser here with no Authorization header, so
  // this one handler cannot sit behind the /api/dispatcher gate below —
  // same reasoning as dispatcherAuthRouter just above. It authenticates
  // itself via the sealed OAuth `state` instead (src/routes/dispatcherSheet.ts).
  app.get("/api/dispatcher/sheet/oauth/callback", sheetOauthCallback);
  // The deep link (Task 10, spec §6.2/§17.5): a status cell's note URL opens
  // on a phone with no dispatcher session — nightShiftLinkRouter
  // authenticates itself by the org token in the path (constant-time,
  // lib/nightShiftLink.ts's verifyOrgToken), so it sits OUTSIDE the
  // /api/dispatcher gate below, same reasoning as the two mounts just above.
  // Mounted at its own "/api/n" prefix (not the broad "/api" the driver
  // routers use) so it never overlaps "/api/dispatcher/..." —
  // tests/dispatcher-mount-order.test.ts's structural check would otherwise
  // require this public, tokenless router to sit after the auth gate too.
  app.use("/api/n", nightShiftLinkRouter);
  // ONE structural gate for the whole /api/dispatcher surface.
  //
  // Every feature router below used to repeat
  // `requireAuth, requireDispatcher, attachOrgScope` on its own mount. That
  // read as defence in depth but was the opposite. Express runs a mount's
  // WHOLE middleware chain for every path-matching request, including the
  // mounts whose router then falls through without handling it — so
  // `req.orgScope` was populated by whichever scoped mount came FIRST, never
  // by the router that actually served the request. Tenancy therefore
  // depended on mount order: deleting attachOrgScope from any single mount
  // broke nothing (no mount was load-bearing on its own), and reordering the
  // mounts would have silently disabled scoping without failing a test. It
  // also cost one redundant Dispatcher lookup per fall-through mount — ~19
  // wasted queries for a request a late router serves.
  //
  // Mounted once, ahead of every feature router, the guarantee becomes
  // structural: nothing reachable under /api/dispatcher can run without
  // auth + role + tenant scope, whatever order the mounts below are in.
  // Nothing under this prefix is public or driver-authenticated — dispatcher
  // signup/login live on dispatcherAuthRouter under /api/auth, and the
  // x-api-key push ingest lives under /api/webhooks — so the collapse loses
  // no per-router distinction.
  //
  // A router mounted ABOVE this line would still bypass the gate;
  // tests/dispatcher-mount-order.test.ts asserts the gate precedes every
  // router that can serve an /api/dispatcher request, so that mistake fails
  // a test instead of leaking tenant data.
  app.use("/api/dispatcher", requireAuth, requireDispatcher, attachOrgScope);
  // The legacy Trip/Conversation routers (drivers, trips, board, approvals,
  // comms) need req.orgScope for the same reason the Control Tower ones do:
  // their rows are tenant data, and without it every handler in them queried
  // across all orgs. Those five reach their tenant through Driver.orgId
  // rather than an orgId column of their own — see src/lib/tripScope.ts.
  // A4-R12: GET /api/dispatcher/auth/me — "who am I", behind the same gate
  // as every router below. See the comment on dispatcherMeRouter itself
  // (routes/dispatcherAuth.ts) for why this is a separate router rather than
  // a second mount of dispatcherAuthRouter (which must stay public, above).
  app.use("/api/dispatcher", dispatcherMeRouter);
  app.use("/api/dispatcher", dispatcherDriversRouter);
  app.use("/api/dispatcher", dispatcherCarriersRouter);
  app.use("/api/dispatcher", dispatcherCarrierStatementsRouter);
  app.use("/api/dispatcher", dispatcherRestStopsRouter);
  app.use("/api/dispatcher", dispatcherRoutePoisRouter);
  app.use("/api/dispatcher", dispatcherLocationRequestsRouter);
  app.use("/api/dispatcher", dispatcherFuelPricesRouter);
  app.use("/api/dispatcher", dispatcherDetentionRouter);
  app.use("/api/dispatcher", dispatcherDemoRouter);
  app.use("/api/dispatcher", dispatcherTripsRouter);
  app.use("/api/dispatcher", dispatcherBoardRouter);
  app.use("/api/dispatcher", dispatcherAssignmentsRouter);
  app.use("/api/dispatcher", dispatcherSuggestRouter);
  app.use("/api/dispatcher", dispatcherLoadboardRouter);
  app.use("/api/dispatcher", dispatcherNightShiftRouter);
  app.use("/api/dispatcher", dispatcherSheetRouter);
  app.use("/api/dispatcher", dispatcherAlertsRouter);
  app.use("/api/dispatcher", dispatcherImportRouter);
  app.use("/api/dispatcher", dispatcherKpisRouter);
  app.use("/api/dispatcher", dispatcherLoadsRouter);
  app.use("/api/dispatcher", dispatcherDriverNextRouter);
  app.use("/api/dispatcher", dispatcherIntegrationsRouter);
  app.use("/api/dispatcher", dispatcherAnalyticsRouter);
  app.use("/api/dispatcher", dispatcherYardRouter);
  app.use("/api/dispatcher", dispatcherEconomicsRouter);
  app.use("/api/dispatcher", dispatcherSettingsRouter);
  app.use("/api/dispatcher", dispatcherRiskRouter);
  app.use("/api/dispatcher", dispatcherSettlementsRouter);
  app.use("/api/dispatcher", dispatcherFleetRouter);
  app.use("/api/dispatcher", dispatcherLocksRouter);
  app.use("/api/dispatcher", dispatcherApprovalsRouter);
  app.use("/api/dispatcher", dispatcherCommsRouter);
  app.use("/api/dispatcher", dispatcherBrokerBoardRouter);
  app.use("/api/dispatcher", dispatcherLoadLocksRouter);
  app.use("/api/dispatcher", dispatcherLoadTruthRouter);
  // Public push ingest — authenticated by x-api-key, not a Bearer token, so
  // it sits outside the /api/dispatcher middleware stack. Mounted before the
  // broad "/api" routers for the same reason dispatcherAuthRouter is.
  app.use("/api/webhooks", webhooksRouter);
  app.use("/api/driver", driverRouter);
  app.use("/api/trips", tripsRouter);
  app.use("/api", signsProofRouter);
  app.use("/api", messagesRouter);
  app.use("/api", notificationsRouter);
  app.use("/api/driver/session", sessionsRouter);
  app.use("/api/driver", safetyRouter);
  app.use("/api", vehicleRouter);
  app.use("/api/navigation", navigationRouter);
  // LAST. Express picks error handlers by arity and only reaches the ones
  // mounted below the failing layer, so this must stay at the bottom of
  // createApp(). It replaces Express's built-in handler, which serialises
  // err.stack — file paths, SQL, row data — into the response body.
  app.use(errorHandler);
  return app;
}
