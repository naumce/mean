import { canStartSession, canToggleBreak, canEndSession } from "../src/domain/sessionState.js";

it("allows starting a session when none is open", () => {
  expect(canStartSession(null)).toEqual({ ok: true });
});
it("blocks starting a session when one is already active", () => {
  expect(canStartSession({ status: "active" }).ok).toBe(false);
});
it("blocks starting a session when one is on break", () => {
  expect(canStartSession({ status: "on_break" }).ok).toBe(false);
});
it("allows starting a session when the previous one has ended", () => {
  expect(canStartSession({ status: "ended" })).toEqual({ ok: true });
});

it("allows toggling break on an active session", () => {
  expect(canToggleBreak({ status: "active" })).toEqual({ ok: true });
});
it("allows toggling break on a session already on break", () => {
  expect(canToggleBreak({ status: "on_break" })).toEqual({ ok: true });
});
it("blocks toggling break on an ended session", () => {
  expect(canToggleBreak({ status: "ended" }).ok).toBe(false);
});

it("allows ending an active session", () => {
  expect(canEndSession({ status: "active" })).toEqual({ ok: true });
});
it("allows ending a session on break", () => {
  expect(canEndSession({ status: "on_break" })).toEqual({ ok: true });
});
it("blocks ending an already-ended session", () => {
  expect(canEndSession({ status: "ended" }).ok).toBe(false);
});
