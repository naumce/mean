import request from "supertest";
import type { Request, Response } from "express";
import { app } from "./helpers.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

// Until this middleware existed, every failure that reached the end of the
// chain was rendered by Express's built-in handler, which outside production
// writes `err.stack` into the response body — absolute file paths, the failing
// Prisma call, and whatever row data ended up in the message. These tests pin
// the two things that must hold: the client learns nothing, and a fault that
// was the CALLER's keeps its own 4xx instead of being flattened to 500.

/** Minimal Response double. Typing it as Express's Response needs one cast at
 *  the boundary — everything the handler touches is captured explicitly, so
 *  the assertions below are about real recorded values, not a mock's defaults. */
function fakeRes(headersSent = false) {
  const recorded = { status: 0, body: null as unknown, headersSent };
  const res = {
    headersSent,
    status(code: number) {
      recorded.status = code;
      return this;
    },
    json(payload: unknown) {
      recorded.body = payload;
      return this;
    },
  };
  return { recorded, res: res as unknown as Response };
}

const fakeReq = { method: "GET", originalUrl: "/api/dispatcher/loads/x" } as Request;

describe("errorHandler", () => {
  it("reports an unlabelled fault as a bare 500 and never echoes the error", () => {
    const { recorded, res } = fakeRes();
    const leaky = new Error("column drivers.ssn does not exist at /srv/app/src/routes/x.ts:12");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    errorHandler(leaky, fakeReq, res, () => undefined);
    // Read the call count before restoring: mockRestore() also clears history.
    const logCalls = logged.mock.calls.length;
    logged.mockRestore();

    expect(recorded.status).toBe(500);
    // Plan A5: the same `{ error: "INTERNAL", message }` shape every route's
    // own catch block already answers with — one body shape for a 500
    // everywhere in the API.
    expect(recorded.body).toEqual({ error: "INTERNAL", message: "That did not go through — try again" });
    // The whole point: the message and stack stay server-side.
    expect(JSON.stringify(recorded.body)).not.toContain("ssn");
    expect(JSON.stringify(recorded.body)).not.toContain("src/routes");
    // ...but they are not thrown away either — a 500 nobody can see is a 500
    // nobody can fix.
    expect(logCalls).toBeGreaterThan(0);
  });

  it("keeps a caller-side 4xx rather than flattening it to 500", () => {
    const { recorded, res } = fakeRes();
    const parseFailure = Object.assign(new Error("Unexpected token }"), { status: 400 });

    errorHandler(parseFailure, fakeReq, res, () => undefined);

    expect(recorded.status).toBe(400);
    expect(recorded.body).toEqual({ error: "Invalid request" });
  });

  it("hands a mid-response failure back to Express instead of writing twice", () => {
    const { recorded, res } = fakeRes(true);
    let forwarded: unknown = null;

    errorHandler(new Error("late"), fakeReq, res, (err?: unknown) => {
      forwarded = err;
    });

    // Nothing written — a second status()/json() on a flushed response throws
    // ERR_HTTP_HEADERS_SENT and loses the socket.
    expect(recorded.status).toBe(0);
    expect(recorded.body).toBeNull();
    expect(forwarded).toBeInstanceOf(Error);
  });
});

describe("the mounted error chain", () => {
  it("answers a malformed JSON body with a 400 that carries no stack trace", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("content-type", "application/json")
      .send('{"email": "a@b.c", ');

    // The leak assertion first: Express's built-in handler answers this one
    // with an HTML page carrying the SyntaxError and a full stack of absolute
    // paths, so THAT is what must fail if this middleware is ever unmounted.
    expect(res.text).not.toContain("SyntaxError");
    expect(res.text).not.toContain("node_modules");
    expect(res.text).not.toContain("<pre>");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid request" });
  });
});
