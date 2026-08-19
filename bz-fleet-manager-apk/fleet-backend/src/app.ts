import express from "express";
import { authRouter } from "./routes/auth.js";
import { driverRouter } from "./routes/driver.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api/auth", authRouter);
  app.use("/api/driver", driverRouter);
  return app;
}
