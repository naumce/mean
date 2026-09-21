import { describe, expect, it, vi } from "vitest";
import { Registry } from "../../src/live/registry.js";
import type { Brief } from "../../src/core/types.js";

const brief: Brief = {
  loadRef: "T-01", origin: { name: "A", lat: 41.99, lng: 21.43 }, destination: { name: "B", lat: 42.0, lng: 21.5 },
  equipment: "DryVan", departAtMs: 1, deadlineAtMs: 2, driverName: "Trajce", driverPhone: "+38970000000",
  customerEmail: null, minutesSinceBreakAtDepart: null,
};
const fakeAgent = () => ({ start: vi.fn(async () => {}), tick: vi.fn(async () => {}), state: { status: "tracking" } });
// Every real trip start knows its own org and numbers — orgId/sender/callerId
// are required on `extras` precisely so a call site cannot forget them and
// silently fall back to "" (which a webhook with an empty `To` would then
// match). Every test call site below says so explicitly.
const telephony = { orgId: "org-test", sender: "+15550001111", callerId: "+15550001111" };

describe("Registry", () => {
  it("starts a trip, calls the agent's start, and finds it by id and by token", async () => {
    const built: ReturnType<typeof fakeAgent>[] = [];
    const reg = new Registry(() => { const a = fakeAgent(); built.push(a); return a as never; });
    const trip = await reg.start(brief, {}, telephony);
    expect(built[0].start).toHaveBeenCalledTimes(1);
    expect(reg.byId(trip.tripId)).toBe(trip);
    expect(reg.byToken(trip.driverToken)).toBe(trip);
    expect(reg.byToken("nope")).toBeNull();
  });

  it("ticks every trip, and one trip's failure does not stop the others", async () => {
    const good = fakeAgent();
    const bad = { ...fakeAgent(), tick: vi.fn(async () => { throw new Error("boom"); }) };
    let n = 0;
    const reg = new Registry(() => (n++ === 0 ? bad : good) as never);
    await reg.start(brief, {}, telephony); await reg.start({ ...brief, loadRef: "T-02" }, {}, telephony);
    await reg.tickAll();
    expect(bad.tick).toHaveBeenCalledTimes(1);
    expect(good.tick).toHaveBeenCalledTimes(1);
  });

  it("stops a trip and forgets its token", async () => {
    const reg = new Registry(() => fakeAgent() as never);
    const trip = await reg.start(brief, {}, telephony);
    await reg.stop(trip.tripId);
    expect(reg.byToken(trip.driverToken)).toBeNull();
    expect(reg.all()).toEqual([]);
  });

  it("type-checks: orgId, sender and callerId are required on extras", async () => {
    const reg = new Registry(() => fakeAgent() as never);
    // @ts-expect-error orgId, sender and callerId are required
    await reg.start(brief, {}, {});
  });
});
