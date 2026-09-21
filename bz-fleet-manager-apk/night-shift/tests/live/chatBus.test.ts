import { describe, expect, it } from "vitest";
import { ChatBus } from "../../src/live/chatBus.js";

describe("ChatBus", () => {
  it("hands the page only what it has not seen, in order", () => {
    const bus = new ChatBus();
    const a = bus.push("t1", "first", 1000);
    const b = bus.push("t1", "second", 2000);
    expect(bus.since("t1", 0).map((m) => m.text)).toEqual(["first", "second"]);
    expect(bus.since("t1", a.id).map((m) => m.text)).toEqual(["second"]);
    expect(bus.since("t1", b.id)).toEqual([]);
    expect(bus.since("other", 0)).toEqual([]);
  });

  it("records when the link was first opened, and only the first time", () => {
    const bus = new ChatBus();
    expect(bus.openedAt("t1")).toBeNull();
    bus.markOpened("t1", 5000);
    bus.markOpened("t1", 9000);
    expect(bus.openedAt("t1")).toBe(5000);
  });
});
