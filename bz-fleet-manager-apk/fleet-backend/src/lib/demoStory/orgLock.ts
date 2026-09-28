// A per-org in-process mutex around observeStory and the actions: two
// requests for the same org's story (two presenter tabs, a poll racing a
// click) must never both read the same row and both decide the same
// transition — one duplicated "Truck stopped"/"Delivered" log line, or two
// stray `tick` calls, either way. Same promise-chaining shape as
// aiHarness/runner.ts's own `drainChains`, scoped to DemoStory instead of the
// harness queue. A different org's call is never blocked by this one.

const chains = new Map<string, Promise<unknown>>();

export function withOrgLock<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(orgId) ?? Promise.resolve();
  // Run `fn` once whatever came before has settled, success or failure —
  // one caller's error must never wedge every later caller for this org.
  const run = previous.then(fn, fn);
  // The chain link stored for the NEXT caller must itself never reject, or
  // it would poison every future `.then` on this org's chain the same way
  // an unguarded promise chain always does.
  chains.set(orgId, run.then(() => undefined, () => undefined));
  return run;
}
