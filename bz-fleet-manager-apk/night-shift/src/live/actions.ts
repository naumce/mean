// The one-click links from dispatcher emails land here. A link is a signed
// statement of trip + action + expiry; anything else is refused before an
// agent is looked up.
import { Router, type Request, type Response } from "express";
import { log } from "./log.js";
import type { Registry } from "./registry.js";
import { verifyAction } from "./tokens.js";

const page = (title: string, line: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font:18px/1.5 system-ui;padding:32px;max-width:480px;margin:auto"><h1 style="font-size:22px">${title}</h1><p>${line}</p></body>`;

export function actionsRouter(registry: Registry, linkSecret: string, clock: () => number): Router {
  const r = Router();
  r.get("/act/:signed", async (req: Request, res: Response) => {
    const v = verifyAction(linkSecret, String(req.params.signed), clock());
    if (!v) { res.status(403).type("html").send(page("This link is not valid", "It may have expired. Reply to the agent's email instead.")); return; }
    const trip = registry.byId(v.tripId);
    if (!trip) { res.status(404).type("html").send(page("This load is no longer live", "The agent has finished with it.")); return; }
    if (v.action !== "send_customer_email") { res.status(400).type("html").send(page("Unknown action", v.action)); return; }
    try {
      await trip.agent.onDispatcherReply("send the customer email");
      res.type("html").send(page("Done", "The agent has acted on it — check your inbox for the confirmation."));
    } catch (e) {
      log("error", "action link failed", { tripId: trip.tripId, error: e instanceof Error ? e.message : String(e) });
      res.status(500).type("html").send(page("That did not work", "The agent could not act on it. Reply to the email instead."));
    }
  });
  return r;
}
