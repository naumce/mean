import request from "supertest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { app, resetDb } from "./helpers.js";
import {
  getCustomer,
  getCustomerHistory,
  findFeasibleDrivers,
  getDispatchCandidateDetails,
  tools,
  TOOL_NAMES,
  TOOL_MANIFEST,
  toolManifestJson,
} from "../src/lib/dispatchTools/index.js";
import { seedDispatchToolsFixture } from "./dispatch-tools-fixture.js";

// AI Dispatch Foundation, Task 5 — customers, dispatch (suggestForLoad-backed)
// tools, the manifest/function parity test, the GET /tools route, and the
// static "no writes under dispatchTools/" scan. See dispatch-tools-fixture.ts
// for the shared org A / org B scenario.

beforeEach(resetDb);

describe("getCustomer", () => {
  it("returns the customer plus its load count", async () => {
    const { orgA, customer } = await seedDispatchToolsFixture();
    const row = await getCustomer(orgA.id, customer.id);
    expect(row).toMatchObject({ id: customer.id, name: "Acme Foods", priority: "high", _count: { loads: 1 } });
  });

  it("returns null for a missing id or one belonging to another org", async () => {
    const { orgA, customerB } = await seedDispatchToolsFixture();
    expect(await getCustomer(orgA.id, customerB.id)).toBeNull();
    expect(await getCustomer(orgA.id, "does-not-exist")).toBeNull();
  });
});

describe("getCustomerHistory", () => {
  it("returns the customer's track record", async () => {
    const { orgA, customer } = await seedDispatchToolsFixture();
    const history = await getCustomerHistory(orgA.id, customer.id);
    expect(history).toMatchObject({ totalLoads: 1, completedLoads: 1 });
  });

  it("returns null for a customer belonging to another org", async () => {
    const { orgA, customerB } = await seedDispatchToolsFixture();
    expect(await getCustomerHistory(orgA.id, customerB.id)).toBeNull();
  });
});

describe("findFeasibleDrivers", () => {
  it("ranks the org's drivers against the pool's tractor/trailer", async () => {
    const { orgA, l1, d1, d2, d3, tractorA, trailerA } = await seedDispatchToolsFixture();
    const result = await findFeasibleDrivers(orgA.id, l1.id);

    expect(result).toMatchObject({ loadId: l1.id, requiredEquip: "DryVan", tractorId: tractorA.id, trailerId: trailerA.id });
    const ids = result!.candidates.map((c) => c.driverId).sort();
    expect(ids).toEqual([d1.id, d2.id, d3.id].sort());
  });

  it("returns null for a load belonging to another org", async () => {
    const { orgA, lB1 } = await seedDispatchToolsFixture();
    expect(await findFeasibleDrivers(orgA.id, lB1.id)).toBeNull();
  });
});

describe("getDispatchCandidateDetails", () => {
  it("returns one candidate's row", async () => {
    const { orgA, l1, d1 } = await seedDispatchToolsFixture();
    const details = await getDispatchCandidateDetails(orgA.id, l1.id, d1.id);
    expect(details).toMatchObject({ loadId: l1.id, driverId: d1.id, candidate: { driverId: d1.id } });
  });

  it("returns null when the driver is not among the load's candidates (a different org's driver)", async () => {
    const { orgA, l1, dB1 } = await seedDispatchToolsFixture();
    expect(await getDispatchCandidateDetails(orgA.id, l1.id, dB1.id)).toBeNull();
  });

  it("returns null for a load belonging to another org", async () => {
    const { orgA, lB1, d1 } = await seedDispatchToolsFixture();
    expect(await getDispatchCandidateDetails(orgA.id, lB1.id, d1.id)).toBeNull();
  });
});

describe("the tool manifest/function parity", () => {
  it("has exactly 17 tools, keyed identically between `tools` and TOOL_MANIFEST", () => {
    expect(TOOL_NAMES).toHaveLength(17);
    expect(Object.keys(tools).sort()).toEqual(TOOL_NAMES.slice().sort());
    expect(TOOL_MANIFEST.map((t) => t.name).sort()).toEqual(Object.keys(tools).sort());
  });

  it("every entry is readOnly with a JSON-schema object", () => {
    for (const spec of TOOL_MANIFEST) {
      expect(spec.readOnly).toBe(true);
    }
    for (const entry of toolManifestJson()) {
      expect(entry.params).toMatchObject({ type: "object" });
      expect(typeof entry.description).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});

describe("GET /api/dispatcher/tools", () => {
  it("returns the 17-tool manifest", async () => {
    const { auth } = await seedDispatchToolsFixture();
    const res = await request(app).get("/api/dispatcher/tools").set("authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body.tools).toHaveLength(17);
    for (const entry of res.body.tools) {
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("description");
      expect(entry.readOnly).toBe(true);
      expect(entry.params).toMatchObject({ type: "object" });
    }
  });
});

describe("no file under src/lib/dispatchTools/ writes to the database", () => {
  // The list must catch more than the singular mutation methods — none of
  // these substrings appears inside
  // `.createMany(`/`.updateMany(`/`.deleteMany(` (the character right after
  // "update" there is "M", not "("), so Prisma's batch-mutation methods
  // would have slipped past this scan undetected. `$queryRawUnsafe` is also
  // new: `$queryRaw`/`$queryRawUnsafe` are nominally "read" methods, but
  // nothing stops a raw SQL statement from smuggling a write in (e.g. a
  // Postgres `WITH x AS (UPDATE ... RETURNING ...) SELECT ...`), so a
  // read-only guard has to name it explicitly rather than trust the method
  // name. `$executeRawUnsafe` is already caught as a substring of the
  // existing `$executeRaw` entry, but is listed explicitly anyway so the
  // list is self-documenting rather than relying on that coincidence.
  const FORBIDDEN = [
    ".create(", ".createMany(",
    ".update(", ".updateMany(",
    ".upsert(",
    ".delete(", ".deleteMany(",
    "$transaction",
    "$executeRaw", "$executeRawUnsafe",
    "$queryRawUnsafe",
  ];
  // The exact set of files this scan is expected to cover today (AI Dispatch
  // Foundation, Task 5) — asserted below so an empty/misdirected directory
  // read (e.g. a typo'd path, or a future refactor that moves files out from
  // under `dispatchToolsDir`) fails loudly instead of vacuously passing an
  // empty `offenders` list.
  const EXPECTED_FILES = [
    "customers.ts", "dispatch.ts", "drivers.ts", "eta.ts", "events.ts",
    "index.ts", "invoke.ts", "limit.ts", "loads.ts", "manifest.ts",
  ];

  function tsFilesUnder(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) found.push(...tsFilesUnder(full));
      else if (entry.endsWith(".ts")) found.push(full);
    }
    return found;
  }

  it(`scans at least the ${EXPECTED_FILES.length} files it should`, () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const dispatchToolsDir = join(repoRoot, "src", "lib", "dispatchTools");
    const scanned = tsFilesUnder(dispatchToolsDir).map((f) => relative(dispatchToolsDir, f).split("\\").join("/"));
    for (const expected of EXPECTED_FILES) expect(scanned).toContain(expected);
    expect(scanned.length).toBeGreaterThanOrEqual(EXPECTED_FILES.length);
  });

  it("contains none of the forbidden mutation/raw-write patterns", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const dispatchToolsDir = join(repoRoot, "src", "lib", "dispatchTools");

    const offenders: string[] = [];
    for (const file of tsFilesUnder(dispatchToolsDir)) {
      const src = readFileSync(file, "utf8");
      for (const needle of FORBIDDEN) {
        if (src.includes(needle)) offenders.push(`${relative(repoRoot, file)}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
