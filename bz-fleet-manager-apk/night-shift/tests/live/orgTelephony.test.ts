import { describe, it, expect, vi } from "vitest";
import { makeTelephonyFor } from "../../src/live/orgTelephony.js";

describe("telephonyFor", () => {
  const fallback = { fromNumber: "+15550000000", callerId: "+15550000000" };
  it("uses the org's own sender and caller id when the row has them", async () => {
    const read = vi.fn().mockResolvedValue({ smsSender: "+15551112222", callerId: "+15551112222" });
    const telephonyFor = makeTelephonyFor(read, () => 0);
    expect(await telephonyFor("org-a", fallback)).toEqual({ fromNumber: "+15551112222", callerId: "+15551112222" });
  });
  it("falls back to the env number when the org has no row or null fields", async () => {
    const read = vi.fn().mockResolvedValue(null);
    expect(await makeTelephonyFor(read, () => 0)("org-b", fallback)).toEqual(fallback);
    const read2 = vi.fn().mockResolvedValue({ smsSender: null, callerId: null });
    expect(await makeTelephonyFor(read2, () => 0)("org-b", fallback)).toEqual(fallback);
  });
  it("caches per org for 60 s", async () => {
    let now = 0;
    const read = vi.fn().mockResolvedValue({ smsSender: "+1", callerId: "+1" });
    const t = makeTelephonyFor(read, () => now);
    await t("org-a", fallback); await t("org-a", fallback);
    expect(read).toHaveBeenCalledTimes(1);
    now = 61_000; await t("org-a", fallback);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
