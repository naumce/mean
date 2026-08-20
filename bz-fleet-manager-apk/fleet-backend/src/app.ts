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
import { dispatcherAuthRouter } from "./routes/dispatcherAuth.js";
import { dispatcherDriversRouter } from "./routes/dispatcherDrivers.js";
import { dispatcherTripsRouter } from "./routes/dispatcherTrips.js";
import { dispatcherApprovalsRouter } from "./routes/dispatcherApprovals.js";
import { dispatcherCommsRouter } from "./routes/dispatcherComms.js";
import { requireAuth, requireDispatcher } from "./middleware/auth.js";
import { uploadsDir } from "./lib/upload.js";

export function createApp() {
  const app = express();
  // Dev-permissive CORS so the Vue portal (separate origin, e.g. :5173) can
  // call the API. In production, restrict `origin` to the portal's host.
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use("/uploads", express.static(uploadsDir));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api/auth", authRouter);
  // dispatcherAuthRouter's /dispatcher/login must be public — it has to be
  // mounted before signsProofRouter/messagesRouter/notificationsRouter/
  // vehicleRouter below: those are mounted broadly at "/api" and each does
  // `router.use(requireAuth)` with no path filter, so once a request enters
  // one of them it applies to every path that reaches that router, not just
  // its own routes. Placed after authRouter, before any of the broad ones.
  app.use("/api/auth", dispatcherAuthRouter);
  // Each dispatcher feature router is mounted separately (rather than
  // composed into one) so a request cascades through requireAuth +
  // requireDispatcher once per router it reaches — harmless (idempotent
  // checks), and it keeps these additions independent of each other.
  app.use("/api/dispatcher", requireAuth, requireDispatcher, dispatcherDriversRouter);
  app.use("/api/dispatcher", requireAuth, requireDispatcher, dispatcherTripsRouter);
  app.use("/api/dispatcher", requireAuth, requireDispatcher, dispatcherApprovalsRouter);
  app.use("/api/dispatcher", requireAuth, requireDispatcher, dispatcherCommsRouter);
  app.use("/api/driver", driverRouter);
  app.use("/api/trips", tripsRouter);
  app.use("/api", signsProofRouter);
  app.use("/api", messagesRouter);
  app.use("/api", notificationsRouter);
  app.use("/api/driver/session", sessionsRouter);
  app.use("/api/driver", safetyRouter);
  app.use("/api", vehicleRouter);
  app.use("/api/navigation", navigationRouter);
  return app;
}
