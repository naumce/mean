import { spawn, type ChildProcess } from "node:child_process";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { resetDb } from "./helpers.js";

// One malformed request used to kill the whole API.
//
// A NUL byte in a route parameter reaches Prisma, Postgres raises 22021
// (`invalid byte sequence for encoding "UTF8": 0x00`), the promise rejects
// inside an `async (req, res)` handler that Express 4 never awaits, and — with
// no error middleware and no `unhandledRejection` listener anywhere — Node 22
// terminates the process. Measured against the unfixed server: exit code 1, no
// HTTP response, and every tenant's in-memory lane lock (src/lib/locks.ts)
// gone with it. About eleven routes take a parameter straight into a Prisma
// `where`.
//
// Supertest cannot show any of this. It drives the Express app inside the
// vitest process, and vitest registers its own `unhandledRejection` listener,
// so the crash is silently absorbed and attributed to whichever test was
// running — which is exactly why a green suite coexisted with a
// remotely-triggerable process kill. So this suite boots the REAL entry point,
// src/server.ts, as a child `node` process and drives it over a real socket.
// "The process is still alive" is then a claim about a process that can
// actually die.

const TSX_CLI = "node_modules/tsx/dist/cli.mjs";
const BOOT_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

interface Booted {
  readonly child: ChildProcess;
  readonly port: number;
  /** Everything the child has written to stdout/stderr, for failure messages. */
  readonly log: () => string;
}

function bootServer(): Promise<Booted> {
  // PORT=0 lets the OS pick a free port — no fixed port to collide with the
  // dev server, and no bind race. src/server.ts logs the port it actually got.
  const child = spawn(process.execPath, [TSX_CLI, "src/server.ts"], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const collect = (chunk: Buffer): void => {
    log += chunk.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  return new Promise<Booted>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not start within ${BOOT_TIMEOUT_MS}ms. Output:\n${log}`)),
      BOOT_TIMEOUT_MS,
    );
    const settle = (): void => {
      const match = /api on :(\d+)/.exec(log);
      if (!match) return;
      clearTimeout(timer);
      resolve({ child, port: Number(match[1]), log: () => log });
    };
    child.stdout?.on("data", settle);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (code ${code}) during boot. Output:\n${log}`));
    });
  });
}

describe("a malformed request cannot kill the API process", () => {
  let server: Booted;
  let auth: string;

  beforeAll(async () => {
    await resetDb();
    // A real dispatcher: these routes reach Prisma only after requireAuth, so
    // an unauthenticated probe would prove nothing about the query path.
    const dispatcher = await prisma.dispatcher.create({
      data: { email: "crash-probe@x.com", passwordHash: "x", name: "Probe" },
    });
    auth = `Bearer ${signDispatcherAccess(dispatcher.id)}`;
    server = await bootServer();
  }, BOOT_TIMEOUT_MS + 15_000);

  afterAll(async () => {
    server?.child.kill();
    await resetDb();
  });

  /** Fails with the actual finding — no response, and whether the process is
   *  gone — rather than an opaque fetch TypeError. */
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`http://127.0.0.1:${server.port}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `no HTTP response for ${path} — child exitCode=${String(server.child.exitCode)}, ` +
          `signal=${String(server.child.signalCode)}: ${String(err)}\nOutput:\n${server.log()}`,
      );
    }
  }

  function expectStillServing(): void {
    // exitCode/signalCode are null for as long as the child is running; either
    // being set is the crash this suite exists to catch.
    expect(server.child.exitCode).toBeNull();
    expect(server.child.signalCode).toBeNull();
  }

  it("refuses a NUL byte in a route parameter with 400, and keeps serving", async () => {
    // Sanity: the child really is answering before the malformed request.
    expect((await call("/health")).status).toBe(200);

    const res = await call("/api/dispatcher/loads/%00", { headers: { authorization: auth } });
    const text = await res.text();

    // It answered at all — the unfixed server sent nothing and exited 1.
    expect(res.status).toBe(400);
    // ...and the answer is a bare refusal, not Express's default handler
    // spilling err.stack (absolute paths, the failing Prisma call, row data).
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain("prisma.");
    expect(text).not.toContain("22021");

    expectStillServing();
    // Still serving other traffic, not merely un-exited.
    expect((await call("/health")).status).toBe(200);
  }, 30_000);

  it("refuses a NUL byte in a JSON body with 400, and keeps serving", async () => {
    // The same Postgres fault by the other route in: POST /locks puts
    // body.laneId straight into a Prisma `where`. A URL-only guard would let
    // this one through and the process would still die.
    const res = await call("/api/dispatcher/locks", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ laneId: "\u0000" }),
    });

    expect(res.status).toBe(400);
    expectStillServing();
    expect((await call("/health")).status).toBe(200);
  }, 30_000);
});

describe("the process guard", () => {
  it("keeps the process alive through an unhandled rejection", async () => {
    // Not routed through the app: this is the guard's own contract, and the
    // one thing supertest can never test, because vitest's own
    // `unhandledRejection` listener would absorb the rejection first.
    const probe = spawn(process.execPath, [TSX_CLI, "tests/unhandled-rejection-probe.ts"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const collect = (chunk: Buffer): void => {
      log += chunk.toString();
    };
    probe.stdout?.on("data", collect);
    probe.stderr?.on("data", collect);

    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        probe.kill();
        reject(new Error(`probe did not exit within 45s. Output:\n${log}`));
      }, 45_000);
      probe.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });

    // Without the guard Node prints the rejection and exits 1 before the
    // probe's timer fires, so neither of these can be true by accident.
    expect(log).toContain("STILL ALIVE");
    expect(code).toBe(0);
    // The rejection is not swallowed silently — it is logged for whoever has
    // to go and fix the handler that produced it.
    expect(log).toContain("[unhandledRejection]");
  }, 60_000);
});
