// `npm run loads:rederive [--org <id>]` — the backfill (spec §11.2). Every
// load is handed to the writer with an empty patch and `force`, so
// appointments, coordinates, status and Attention are derived from what is
// already stored. Idempotent; run once per org after deploy, and again after
// a human adds a rule to the vocabulary.
import { SYSTEM_ACTOR } from "../lib/actor.js";
import { settlePendingStops } from "../lib/geocodeSettle.js";
import { applyLoadChange } from "../lib/loadWriter.js";
import { prisma } from "../db.js";

export async function rederiveOrg(orgId: string, say: (line: string) => void): Promise<{ loads: number; statusChanged: number; placed: number; failed: number }> {
  const loads = await prisma.load.findMany({ where: { orgId }, select: { id: true, status: true, stops: { select: { lat: true } } }, orderBy: { createdAt: "asc" } });
  let statusChanged = 0, placed = 0, failed = 0;
  for (const l of loads) {
    const unplacedBefore = l.stops.filter((s) => s.lat === null).length;
    try {
      const r = await prisma.$transaction(
        (tx) => applyLoadChange(tx, { loadId: l.id, orgId, actor: SYSTEM_ACTOR("backfill"), source: "backfill", patch: {}, force: true }),
        { timeout: 30_000 },
      );
      // The writer only ever consults the gazetteer (it runs in a
      // transaction); whatever it left `pending` is asked of the configured
      // provider here, awaited, outside that transaction. A no-op — and no
      // query at all — when no provider is configured.
      await settlePendingStops(orgId, [l.id]);
      const unplacedAfter = (await prisma.loadStop.count({ where: { loadId: l.id, lat: null } }));
      placed += Math.max(0, unplacedBefore - unplacedAfter);
      if (r.status !== l.status) { statusChanged += 1; say(`${l.id}: ${l.status} → ${r.status}`); }
      if (r.statusRefused) say(`${l.id}: ${r.statusRefused}`);
    } catch (err) {
      // One load's write failing (e.g. it was deleted mid-run, LoadNotFound)
      // must not abort the org or, without --org, silently skip every later
      // org — count it and keep going.
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      say(`load ${l.id}: failed — ${message}`);
    }
  }
  return { loads: loads.length, statusChanged, placed, failed };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("src/cli/rederive.ts");
if (isMain) {
  const say = (line: string): void => void process.stdout.write(line + "\n");
  const orgArg = process.argv.indexOf("--org");
  // `--org` with nothing after it is a usage error, not "every org".
  const orgArgMissingValue = orgArg !== -1 && process.argv[orgArg + 1] === undefined;
  if (orgArgMissingValue) {
    process.stderr.write("usage: npm run loads:rederive [--org <id>]\n");
    process.exitCode = 2;
  } else {
    const only = orgArg === -1 ? null : process.argv[orgArg + 1];
    try {
      const orgs = only ? [{ id: only }] : await prisma.org.findMany({ select: { id: true } });
      for (const org of orgs) {
        const r = await rederiveOrg(org.id, say);
        say(`org ${org.id}: ${r.loads} loads, ${r.statusChanged} status changes, ${r.placed} stops placed, ${r.failed} failed`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`rederive: ${message}\n`);
      process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  }
}
