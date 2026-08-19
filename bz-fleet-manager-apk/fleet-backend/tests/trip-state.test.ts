import { canStart } from "../src/domain/tripState.js";
it("allows start from assigned when checklist done", () => {
  expect(canStart({ status: "assigned", preTripCheckCompleted: true })).toEqual({ ok: true });
});
it("blocks start when checklist not complete", () => {
  expect(canStart({ status: "assigned", preTripCheckCompleted: false }).ok).toBe(false);
});
it("blocks start from a non-startable state", () => {
  expect(canStart({ status: "completed", preTripCheckCompleted: true }).ok).toBe(false);
});
