// The platform's status sink (spec §7.4). `writeStatus` maps the agent's
// coarse state to the board's pill vocabulary (§6.1) and appends the line
// under UPDATE as an `AgentUpdate` row; `appendLog` needs no new persistence
// of its own — every event is already durable via the trip's `PrismaEvents`
// — but it DOES refine the pill in real time for states `writeStatus`'s
// cells cannot see on their own: a question open, a call in progress, an
// escalation sent. One instance per trip, scoped to its load, exactly like
// `PrismaEvents` is scoped to its trip.
import { prisma } from "../../../fleet-backend/src/db.js";
import type { AgentEvent } from "../core/types.js";
import type { SheetPort } from "../ports/index.js";
import { log } from "./log.js";

/** The board's pill vocabulary (spec §6.1) plus `held` (§17.3). This adapter
 *  never writes `off` — that is the switch's own write (Task 3's route, and
 *  this package's `stop` command handler). */
type Pill = "watching" | "asked" | "calling" | "escalated" | "delivered" | "attention" | "shadow" | "held";

/** Once a ladder event promotes the pill to one of these, a routine resting
 *  write (watching/shadow) must not stomp it back down in the same tick —
 *  see `resolvePill`. */
const ACTIVE_LADDER_PILLS: ReadonlySet<string> = new Set(["asked", "calling", "escalated"]);

function restingPill(statusLabel: string, shadow: boolean): Pill {
  if (statusLabel.startsWith("Attention")) return "attention";
  if (statusLabel === "Arrived" || statusLabel === "Closed") return "delivered";
  return shadow ? "shadow" : "watching";
}

/** A plain, readable line built from the same cells the sheet always wrote —
 *  not a verbatim reproduction of spec §6.2's illustrative wording (that
 *  belongs in a phrase library, out of this task's scope; see the report). */
function lineFor(cells: Record<string, string>): string {
  const status = (cells["Agent Status"] ?? "").toUpperCase();
  const parts = [status, cells["Last Position"], cells["ETA"] ? "ETA " + cells["ETA"] : "", cells["On Time"]].filter((p): p is string => Boolean(p));
  return parts.join(" — ");
}

function kindFor(pill: Pill, shadow: boolean): string {
  if (pill === "attention") return "attention";
  if (pill === "delivered") return "delivered";
  return shadow ? "would_say" : "status";
}

/** What `appendLog` promotes the pill to for an event that means the ladder
 *  just did something visible. `"resolved"` is a downgrade signal, not a
 *  pill value — see its use below. Null: this event carries no pill news. */
function ladderPillFor(event: AgentEvent): Pill | "resolved" | null {
  if (event.kind === "call") return "calling";
  if (event.kind === "escalation") return "escalated";
  if (event.kind === "action") {
    const detail = (event.evidence as Record<string, unknown>).kind;
    if (detail === "message" || detail === "message_again" || detail === "sms") return "asked";
  }
  if (event.kind === "anomaly" && (event.evidence as Record<string, unknown>).resolved === true) return "resolved";
  return null;
}

export class PlatformSheet implements SheetPort {
  constructor(
    private readonly loadId: string,
    private readonly shadow: boolean,
  ) {}

  async writeStatus(_loadRef: string, cells: Record<string, string>): Promise<void> {
    const candidate = restingPill(cells["Agent Status"] ?? "", this.shadow);
    const pill = await this.resolvePill(candidate);
    const text = this.shadow ? "would say: " + lineFor(cells) : lineFor(cells);
    const kind = kindFor(pill, this.shadow);
    // NS-D1: a status that has not changed is not news. The agent re-writes
    // its cells on every cadence tick and on every state change, and an
    // attention line ("route unusable") used to land once a minute until the
    // load was switched off. The pill still moves; the line is only
    // appended when it differs from the newest one on record.
    const last = await prisma.agentUpdate.findFirst({ where: { loadId: this.loadId }, orderBy: { atMs: "desc" }, select: { kind: true, text: true } });
    const same = last !== null && last.kind === kind && last.text === text;
    await prisma.$transaction([
      prisma.load.update({ where: { id: this.loadId }, data: { agentPill: pill, version: { increment: 1 } } }),
      ...(same ? [] : [prisma.agentUpdate.create({ data: { loadId: this.loadId, atMs: BigInt(Date.now()), kind, text } })]),
    ]);
  }

  async appendLog(_loadRef: string, event: AgentEvent): Promise<void> {
    // Shadow never leaves the "shadow" pill on a ladder event — nothing
    // reached a driver or a dispatcher to justify asked/calling/escalated.
    // writeStatus still moves it to attention/delivered when the cells say
    // so, since those are facts about the truck, not about outbound comms.
    if (this.shadow) return;
    const next = ladderPillFor(event);
    if (next === null) return;
    const pill: Pill = next === "resolved" ? "watching" : next;
    await prisma.load.update({ where: { id: this.loadId }, data: { agentPill: pill, version: { increment: 1 } } });
    log("info", "platform sheet: ladder pill", { loadId: this.loadId, pill });
  }

  /** Refuses to let a routine resting write (watching/shadow) overwrite an
   *  active ladder pill `appendLog` set moments earlier in the same
   *  `evaluateNow()` cycle: the stop rule's threshold and the sheet's
   *  15-minute cadence are close enough in practice that a rung-1 question
   *  and a due cadence write can land on the very same tick. Any other
   *  candidate (attention, delivered) always wins outright — those are
   *  terminal facts, never something a ladder pill should outrank. */
  private async resolvePill(candidate: Pill): Promise<Pill> {
    if (candidate !== "watching" && candidate !== "shadow") return candidate;
    const current = await prisma.load.findUnique({ where: { id: this.loadId }, select: { agentPill: true } });
    return current && ACTIVE_LADDER_PILLS.has(current.agentPill) ? (current.agentPill as Pill) : candidate;
  }
}
