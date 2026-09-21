import { emitToDispatchers } from "../realtime.js";

/** What one Load write is worth telling the room about. `version` is the
 *  load's value AFTER the write, so a client can compare it against what it
 *  has rendered and ignore its own echo. */
export type LoadChange = { loadId: string; version: number; fields: string[] };

/**
 * The one place `load_changed` is emitted (spec §9).
 *
 * A write that changed nothing sends nothing: an empty `fields` is not a
 * quiet event, it is the absence of an event, and a board that re-reads on
 * every no-op write is exactly the traffic this slice exists to remove.
 * Row removal is `fields: ["deleted"]` and creation `fields: ["created"]` —
 * one event type carries the whole lifecycle so a subscriber needs one
 * handler, not three.
 */
export function emitLoadChanged(orgId: string | null, change: LoadChange): void {
  if (change.fields.length === 0) return;
  emitToDispatchers(orgId, "load_changed", {
    orgId,
    loadId: change.loadId,
    version: change.version,
    fields: change.fields,
  });
}

/** One frame per load. Deliberately not one frame carrying many ids: the
 *  client coalesces ids itself (plan A4 Task 6), and a per-load frame keeps
 *  the payload shape identical whether one row or a whole import moved. */
export function emitLoadsChanged(orgId: string | null, changes: LoadChange[]): void {
  for (const change of changes) emitLoadChanged(orgId, change);
}
