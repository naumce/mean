// The driver's side of the agent: one link, one page, no install. Everything
// the page sends is validated here and handed to the trip's Agent; nothing
// the page sends is trusted for time — the server's clock stamps the event.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ChatBus } from "./chatBus.js";
import { log } from "./log.js";
import type { Registry } from "./registry.js";

const PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "driverPage.html"), "utf8");

const pingSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const replySchema = z.object({ text: z.string().trim().min(1).max(500) });

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function driverLinkRouter(registry: Registry, bus: ChatBus, clock: () => number): Router {
  const r = Router();

  const withTrip = (handler: (req: Request, res: Response, trip: NonNullable<ReturnType<Registry["byToken"]>>) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      const trip = registry.byToken(String(req.params.token));
      if (!trip) { res.status(404).json({ error: "This link is not valid." }); return; }
      try {
        await handler(req, res, trip);
      } catch (e) {
        log("error", "driver link handler failed", { tripId: trip.tripId, path: req.path, error: e instanceof Error ? e.message : String(e) });
        res.status(500).json({ error: "Could not record that — please try again." });
      }
    };

  r.get("/d/:token", withTrip(async (_req, res, trip) => {
    bus.markOpened(trip.tripId, clock());
    const b = trip.brief;
    const html = PAGE
      .replace(/__TOKEN__/g, escapeHtml(trip.driverToken))
      .replace(/__LOAD__/g, escapeHtml(`${b.loadRef}: ${b.origin.name} to ${b.destination.name}`))
      .replace(/__NAME__/g, escapeHtml(b.driverName));
    res.type("html").send(html);
  }));

  r.post("/d/:token/accept", withTrip(async (_req, res, trip) => {
    await trip.agent.onAccept();
    res.json({ ok: true });
  }));

  r.post("/d/:token/ping", withTrip(async (req, res, trip) => {
    const parsed = pingSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ") }); return; }
    await trip.agent.onPing({ atMs: clock(), lat: parsed.data.lat, lng: parsed.data.lng });
    res.json({ ok: true });
  }));

  r.post("/d/:token/reply", withTrip(async (req, res, trip) => {
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ") }); return; }
    await trip.agent.onReply({ atMs: clock(), channel: "chat", rawText: parsed.data.text });
    res.json({ ok: true });
  }));

  r.get("/d/:token/messages", withTrip(async (req, res, trip) => {
    const after = Number(req.query.after ?? 0);
    res.json({ messages: bus.since(trip.tripId, Number.isFinite(after) ? after : 0) });
  }));

  return r;
}
