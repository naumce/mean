import express, { type Express } from "express";
import { actionsRouter } from "./actions.js";
import type { ChatBus } from "./chatBus.js";
import { driverLinkRouter } from "./driverLink.js";
import type { PendingCalls } from "./pendingCalls.js";
import type { Registry } from "./registry.js";
import { twilioSmsRouter, twilioVoiceRouter, type Validate } from "./twilioWebhooks.js";

export function createServer(args: { registry: Registry; bus: ChatBus; pending: PendingCalls; validate: Validate; publicUrl: string; linkSecret: string; clock: () => number }): Express {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.get("/health", (_req, res) => { res.json({ ok: true, trips: args.registry.all().length }); });
  app.use(driverLinkRouter(args.registry, args.bus, args.clock));
  app.use(actionsRouter(args.registry, args.linkSecret, args.clock));
  app.use(twilioSmsRouter(args.registry, args.validate, args.publicUrl, args.clock));
  app.use(twilioVoiceRouter(args.pending, args.validate, args.publicUrl));
  return app;
}
