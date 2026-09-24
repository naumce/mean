import { Router } from "express";
import { toolManifestJson } from "../lib/dispatchTools/index.js";

// AI Dispatch Foundation (Task 5): publishes the read-only tool manifest for
// a future AI harness to discover. No invoke endpoint exists yet (a later
// task) — this route is read-only metadata, same as everything it
// describes. Mounted under the existing /api/dispatcher structural gate
// (app.ts) — a dispatcher session is all it needs, same as any other route
// in this family. Synchronous (no DB call — the manifest is built once, in
// memory, at import time), so no asyncRoute wrapper is needed here.
export const dispatcherToolsRouter = Router();

dispatcherToolsRouter.get("/tools", (_req, res) => {
  res.json({ tools: toolManifestJson() });
});
