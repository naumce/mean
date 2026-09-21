// The event log on Postgres, through fleet-backend's own Prisma client so the
// agent's rows live beside the platform's. One store per trip; `all()` is
// that trip's events in time order and nothing else.
import { prisma } from "../../../fleet-backend/src/db.js";
import type { AgentEvent } from "../core/types.js";
import type { EventStore } from "../ports/index.js";

export class PrismaEvents implements EventStore {
  constructor(private readonly tripId: string) {}

  static async createTrip(args: { tripId: string; loadRef: string; driverToken: string; brief: unknown }): Promise<void> {
    await prisma.agentTrip.create({
      data: { id: args.tripId, loadRef: args.loadRef, driverToken: args.driverToken, brief: args.brief as object },
    });
  }

  static async setStatus(tripId: string, status: string): Promise<void> {
    await prisma.agentTrip.update({ where: { id: tripId }, data: { status } });
  }

  async append(event: AgentEvent): Promise<void> {
    await prisma.agentEvent.create({
      data: {
        tripId: this.tripId,
        atMs: BigInt(event.atMs),
        kind: event.kind,
        evidence: event.evidence as object,
        actionTaken: event.actionTaken ?? null,
      },
    });
  }

  async all(): Promise<AgentEvent[]> {
    const rows = await prisma.agentEvent.findMany({ where: { tripId: this.tripId }, orderBy: [{ atMs: "asc" }, { id: "asc" }] });
    return rows.map((r) => ({
      atMs: Number(r.atMs),
      kind: r.kind as AgentEvent["kind"],
      evidence: r.evidence as Record<string, unknown>,
      ...(r.actionTaken ? { actionTaken: r.actionTaken } : {}),
    }));
  }
}
