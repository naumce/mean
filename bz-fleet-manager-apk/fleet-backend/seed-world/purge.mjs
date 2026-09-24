// Idempotent purge: before regenerating, delete EVERYTHING under the "Great
// Lakes Freight Co" org, in FK-safe order, and nothing outside it. `Plan`/
// `AgentPolicy` are deliberately NOT deleted here — seed-world.mjs upserts
// both in place, keeping their row (and the Plan's DB-trigger-assigned id)
// stable across reruns.
//
// LoadLock/AgentCommand/AgentUpdate/LoadChange all cascade automatically
// with their Load (`onDelete: Cascade` in schema.prisma) — deleting Load
// would clear them for free. They are still deleted explicitly and BEFORE
// Load below anyway, both for a clear, literal ordering and because an
// explicit delete costs nothing extra when nothing exists yet to cascade.
//
// SimulationState is a per-org singleton with no FK to any load/driver row,
// so it is never cleared by a cascade from anything else this function
// deletes — it is deleted directly, alongside the driver-scoped rows below,
// so a reseed never inherits the previous session's simulated clock.
export async function purgeOrgWorld(prisma, orgId) {
  const [loads, drivers] = await Promise.all([
    prisma.load.findMany({ where: { orgId }, select: { id: true } }),
    prisma.driver.findMany({ where: { orgId }, select: { id: true } }),
  ]);
  const loadIds = loads.map((l) => l.id);
  const driverIds = drivers.map((d) => d.id);

  const trips = loadIds.length
    ? await prisma.agentTrip.findMany({ where: { loadId: { in: loadIds } }, select: { id: true } })
    : [];
  const tripIds = trips.map((t) => t.id);

  await prisma.agentEvent.deleteMany({ where: { tripId: { in: tripIds } } });
  await prisma.agentTrip.deleteMany({ where: { id: { in: tripIds } } });
  await prisma.driverLocation.deleteMany({ where: { driverId: { in: driverIds } } });
  await prisma.appointment.deleteMany({ where: { stop: { loadId: { in: loadIds } } } });
  await prisma.loadStop.deleteMany({ where: { loadId: { in: loadIds } } });

  await Promise.all([
    prisma.loadChange.deleteMany({ where: { loadId: { in: loadIds } } }),
    prisma.agentUpdate.deleteMany({ where: { loadId: { in: loadIds } } }),
    prisma.agentCommand.deleteMany({ where: { loadId: { in: loadIds } } }),
    prisma.dispatchConflict.deleteMany({ where: { loadId: { in: loadIds } } }),
    prisma.rate.deleteMany({ where: { loadId: { in: loadIds } } }),
  ]);

  await prisma.deadheadLeg.deleteMany({ where: { assignment: { loadId: { in: loadIds } } } });
  await prisma.assignment.deleteMany({ where: { loadId: { in: loadIds } } });
  await prisma.load.deleteMany({ where: { id: { in: loadIds } } });
  await prisma.customer.deleteMany({ where: { orgId } });

  await Promise.all([
    prisma.simDriverState.deleteMany({ where: { driverId: { in: driverIds } } }),
    prisma.driverAvailability.deleteMany({ where: { driverId: { in: driverIds } } }),
    prisma.driverPreference.deleteMany({ where: { driverId: { in: driverIds } } }),
    prisma.hosState.deleteMany({ where: { driverId: { in: driverIds } } }),
    prisma.simulationState.deleteMany({ where: { orgId } }),
  ]);
  await prisma.driver.deleteMany({ where: { id: { in: driverIds } } });

  await Promise.all([
    prisma.tractor.deleteMany({ where: { orgId } }),
    prisma.trailer.deleteMany({ where: { orgId } }),
  ]);
  await prisma.carrier.deleteMany({ where: { orgId } });

  return { purgedLoads: loadIds.length, purgedDrivers: driverIds.length, purgedTrips: tripIds.length };
}
