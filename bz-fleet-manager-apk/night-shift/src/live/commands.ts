// Supervision commands from the drawer (spec §17.3), applied to the trips
// this worker is running. `AgentCommand` rows are read in the order they
// were written and stamped `appliedAt` once handled, so a command is never
// re-applied and a second click just queues a second, later row.
import { z } from "zod";
import { prisma } from "../../../fleet-backend/src/db.js";
import type { ChatBus } from "./chatBus.js";
import { log } from "./log.js";
import { PrismaEvents } from "./prismaEvents.js";
import type { Registry } from "./registry.js";

const replyPayload = z.object({ text: z.string().min(1).max(2000) });
const correctPayload = z.object({ correctedKey: z.string().min(1).max(80).optional(), note: z.string().max(2000).optional() });

export interface CommandDeps {
  registry: Registry;
  bus: ChatBus;
  nowMs: () => number;
}

interface CommandRow {
  id: string;
  loadId: string;
  kind: string;
  payload: unknown;
  actorName: string;
}

/** Reads every unapplied `AgentCommand` and applies it. A command whose
 *  handler throws (a transient DB hiccup, say) is left unapplied so the next
 *  poll retries it — everything else, including a load with no live trip to
 *  act on, is logged and marked applied so it does not retry forever on a
 *  situation that will never resolve itself. */
export async function applyPendingCommands(deps: CommandDeps): Promise<void> {
  const pending = await prisma.agentCommand.findMany({ where: { appliedAt: null }, orderBy: { createdAt: "asc" } });
  for (const cmd of pending) {
    try {
      await applyOne(deps, cmd);
    } catch (e) {
      log("error", "command failed — left unapplied, will retry", { commandId: cmd.id, kind: cmd.kind, loadId: cmd.loadId, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    await prisma.agentCommand.update({ where: { id: cmd.id }, data: { appliedAt: new Date() } });
  }
}

async function applyOne(deps: CommandDeps, cmd: CommandRow): Promise<void> {
  switch (cmd.kind) {
    case "stop": return applyStop(deps, cmd);
    case "takeover": return applyTakeover(deps, cmd);
    case "handback": return applyHandback(deps, cmd);
    case "reply": return applyReply(deps, cmd);
    case "correct": return applyCorrect(cmd);
    case "call": return applyCall(deps, cmd);
    case "send_customer_email": return applySendCustomerEmail(deps, cmd);
    default:
      log("warn", "command: unknown kind — marking applied so it does not retry forever", { commandId: cmd.id, kind: cmd.kind });
  }
}

async function applyStop(deps: CommandDeps, cmd: CommandRow): Promise<void> {
  const trip = deps.registry.byLoadId(cmd.loadId);
  if (trip) await deps.registry.stop(trip.tripId);
  // Two doors lead here: the switch endpoint (which already set
  // agentEnabled=false and agentPill=off through the traced writer before
  // writing this command) and the drawer's Stop button (which writes ONLY the
  // command). Spec §17.3 says they are the same act, so this write flips the
  // switch as well as the pill: after a drawer Stop the row must not keep
  // showing the switch on while the agent has gone. Harmless when the switch
  // endpoint already did it; a conditional update so an unchanged row is not
  // re-versioned for nothing.
  const row = await prisma.load.findUnique({ where: { id: cmd.loadId }, select: { agentEnabled: true, agentPill: true } });
  if (row && (row.agentEnabled || row.agentPill !== "off")) {
    await prisma.load.update({ where: { id: cmd.loadId }, data: { agentEnabled: false, agentPill: "off", version: { increment: 1 } } });
  }
}

async function applyTakeover(deps: CommandDeps, cmd: CommandRow): Promise<void> {
  const trip = deps.registry.byLoadId(cmd.loadId);
  if (!trip) { log("warn", "takeover: no live trip for this load — nothing to hold", { loadId: cmd.loadId }); return; }
  await trip.agent.takeover();
  await prisma.load.update({ where: { id: cmd.loadId }, data: { agentPill: "held", version: { increment: 1 } } });
}

async function applyHandback(deps: CommandDeps, cmd: CommandRow): Promise<void> {
  const trip = deps.registry.byLoadId(cmd.loadId);
  if (!trip) { log("warn", "handback: no live trip for this load", { loadId: cmd.loadId }); return; }
  await trip.agent.handback();
  const pill = trip.policy.shadow ? "shadow" : "watching";
  await prisma.load.update({ where: { id: cmd.loadId }, data: { agentPill: pill, version: { increment: 1 } } });
}

/** Posts the dispatcher's own words to the driver's page and closes
 *  whatever question is open, like a driver reply would (spec §6.4). The
 *  `ChatBus` message is prefixed to read as the dispatcher's, not the
 *  agent's — `ChatMessage` carries no author field to set instead; see the
 *  report. */
async function applyReply(deps: CommandDeps, cmd: CommandRow): Promise<void> {
  const parsed = replyPayload.safeParse(cmd.payload);
  if (!parsed.success) { log("warn", "reply: payload missing text — nothing to post", { commandId: cmd.id }); return; }
  const trip = deps.registry.byLoadId(cmd.loadId);
  if (!trip) { log("warn", "reply: no live trip for this load", { loadId: cmd.loadId }); return; }
  deps.bus.push(trip.tripId, "Dispatcher: " + parsed.data.text, deps.nowMs());
  await trip.agent.onDispatcherPost(parsed.data.text);
  const current = await prisma.load.findUnique({ where: { id: cmd.loadId }, select: { agentPill: true } });
  const untouchable = new Set(["escalated", "attention", "delivered", "held", "off"]);
  if (current && !untouchable.has(current.agentPill)) {
    const pill = trip.policy.shadow ? "shadow" : "watching";
    await prisma.load.update({ where: { id: cmd.loadId }, data: { agentPill: pill, version: { increment: 1 } } });
  }
}

/** Re-labels the trip's last classification (spec §17.3). Data-only: it does
 *  not touch the running agent's state, only the record — the correction is
 *  for the human-approved proposal cycle, not built yet, to read later. */
async function applyCorrect(cmd: CommandRow): Promise<void> {
  const parsed = correctPayload.safeParse(cmd.payload ?? {});
  const payload = parsed.success ? parsed.data : {};
  if (!parsed.success) log("warn", "correct: payload did not match the expected shape — recording the correction anyway", { commandId: cmd.id });

  const agentTrip = await prisma.agentTrip.findFirst({ where: { loadId: cmd.loadId }, orderBy: { createdAt: "desc" } });
  if (!agentTrip) { log("warn", "correct: no trip on record for this load", { loadId: cmd.loadId }); return; }
  const lastReply = await prisma.agentEvent.findFirst({ where: { tripId: agentTrip.id, kind: "reply" }, orderBy: { atMs: "desc" } });
  const originalSituationKey = lastReply ? ((lastReply.evidence as Record<string, unknown>).situationKey ?? null) : null;

  await new PrismaEvents(agentTrip.id).append({
    atMs: Date.now(),
    kind: "action",
    evidence: {
      kind: "correction", originalSituationKey, correctedKey: payload.correctedKey ?? null,
      note: payload.note ?? null, actorName: cmd.actorName,
    },
    actionTaken: "dispatcher corrected the last classification" + (payload.correctedKey ? " to " + payload.correctedKey : ""),
  });
}

async function applyCall(deps: CommandDeps, cmd: CommandRow): Promise<void> {
  const trip = deps.registry.byLoadId(cmd.loadId);
  if (!trip) { log("warn", "call: no live trip for this load", { loadId: cmd.loadId }); return; }
  await trip.agent.callDriverNow();
}

/** Reuses the agent's existing dispatcher-command vocabulary (spec §8):
 *  `onDispatcherReply("send the customer email")` already sends the draft
 *  when one exists and otherwise tells the dispatcher none is pending —
 *  exactly this command's job, so no new agent method was needed for it. */
async function applySendCustomerEmail(deps: CommandDeps, cmd: CommandRow): Promise<void> {
  const trip = deps.registry.byLoadId(cmd.loadId);
  if (!trip) { log("warn", "send_customer_email: no live trip for this load", { loadId: cmd.loadId }); return; }
  await trip.agent.onDispatcherReply("send the customer email");
}
