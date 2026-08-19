import express from "express";
import { authRouter } from "./routes/auth.js";
import { driverRouter } from "./routes/driver.js";
import { tripsRouter } from "./routes/trips.js";
import { signsProofRouter } from "./routes/signsProof.js";
import { messagesRouter } from "./routes/messages.js";
import { uploadsDir } from "./lib/upload.js";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/uploads", express.static(uploadsDir));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api/auth", authRouter);
  app.use("/api/driver", driverRouter);
  app.use("/api/trips", tripsRouter);
  app.use("/api", signsProofRouter);
  app.use("/api", messagesRouter);
  return app;
}
