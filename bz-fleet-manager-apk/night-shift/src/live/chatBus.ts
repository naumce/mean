// The agent's outbox toward the driver's page. The page polls `since(lastId)`;
// the agent's MessengerPort `sendChat` lands here. In memory: a restart
// loses undelivered chat, which the event log still records as sent —
// acceptable for the first live run and noted in the runbook.
export interface ChatMessage {
  id: number;
  atMs: number;
  text: string;
}

export class ChatBus {
  private outbox: Record<string, readonly ChatMessage[]> = {};
  private opened: Record<string, number> = {};
  private nextId = 1;

  push(tripId: string, text: string, atMs: number): ChatMessage {
    const msg: ChatMessage = { id: this.nextId++, atMs, text };
    this.outbox = { ...this.outbox, [tripId]: [...(this.outbox[tripId] ?? []), msg] };
    return msg;
  }

  since(tripId: string, afterId: number): ChatMessage[] {
    return (this.outbox[tripId] ?? []).filter((m) => m.id > afterId);
  }

  markOpened(tripId: string, atMs: number): void {
    if (this.opened[tripId] === undefined) this.opened = { ...this.opened, [tripId]: atMs };
  }

  openedAt(tripId: string): number | null {
    return this.opened[tripId] ?? null;
  }
}
