// The 14 named scenarios (A-N), pure metadata only — no Prisma, no PRNG, no
// dates. seed-world/scenarioLoads.mjs (the LOGIC that builds each scenario's
// load/stops/assignment/pings/agent evidence) and this table both key off
// `code`; this file is also read directly by anything that just wants to
// LIST the scenarios (a future UI, the doc task) without pulling in the
// generator itself.
//
// `title` for "A" is verbatim; the rest follow its shape (a short label +
// one sentence telling the dispatcher where to look) without a mandated
// exact wording. `externalId` is verbatim for every letter.
export const SCENARIOS = [
  {
    code: "A",
    externalId: "W-A-RELIABLE",
    title: "Reliable driver near an uncovered load",
    hint: "Milan Petrovski is available about 40 miles from this Toledo pickup with a 96% on-time record on 50 completed loads.",
  },
  {
    code: "B",
    externalId: "W-B-CLOSER",
    title: "A closer driver with a spotty response history",
    hint: "Dwayne Okafor is only 15 miles away, but 3 unanswered check-ins and a 61% response rate are worth weighing against the shorter deadhead.",
  },
  {
    code: "C",
    externalId: "W-C-SOON",
    title: "Covered soon by a driver finishing nearby",
    hint: "Ana Kovacs is assigned a Detroit run that has not departed yet (Night Shift has invited her); she is projected to finish it and be free well before this same-city noon pickup.",
  },
  {
    code: "D",
    externalId: "W-D-HOS",
    title: "Nearby driver is short on drive time",
    hint: "Ray Delgado is close to this load but has only 90 minutes of drive time left on his clock.",
  },
  {
    code: "E",
    externalId: "W-E-EQUIP",
    title: "Equipment mismatch on the closest driver",
    hint: "Tomasz Nowak is the nearest driver, but this load needs a Reefer and he only runs Flatbed.",
  },
  {
    code: "F",
    externalId: "W-F-LANE",
    title: "A driver who already knows this lane",
    hint: "Marcus Webb has run the Chicago to Nashville lane 14 times — deep lane experience worth surfacing.",
  },
  {
    code: "G",
    externalId: "W-G-HOME",
    title: "A load that gets a driver home for the weekend",
    hint: "Lena Fischer is based in Grand Rapids and wants to be home on weekends — this load delivers there on Friday.",
  },
  {
    code: "H",
    externalId: "W-H-PRIORITY",
    title: "High-priority customer needs delay notice",
    hint: "Meridian Foods is a high-priority account that requires a delay notification the moment this load is at risk.",
  },
  {
    code: "I",
    externalId: "W-I-LATE",
    title: "A load waiting on driver acceptance",
    hint: "Hassan Farah has been invited to this load but has not accepted or departed yet; Night Shift is waiting on him, with the pickup window still a few hours out.",
  },
  {
    code: "J",
    externalId: "W-J-ANOMALY",
    title: "An open anomaly the agent already flagged",
    hint: "The agent logged an unplanned-stop anomaly on this in-progress load and is waiting on the driver.",
  },
  {
    code: "K",
    externalId: "W-K-STOP",
    title: "Truck stopped somewhere unplanned",
    hint: "The last four pings sit in the same spot for 25 minutes, at a location that isn't a planned stop.",
  },
  {
    code: "L",
    externalId: "W-L-DARK",
    title: "No signal from the truck in over an hour",
    hint: "This driver's last ping is 70 minutes old — worth a check-in.",
  },
  {
    code: "M",
    externalId: "W-M-DETENTION",
    title: "A completed load with billable detention",
    hint: "Dwell pings at the delivery stop show well over 200 minutes billable past the 120-minute free window.",
  },
  {
    code: "N",
    externalId: "W-N-OFFROUTE",
    title: "Off the planned route",
    hint: "The last three pings sit about 6 miles off the great-circle line between pickup and delivery.",
  },
];

export function scenarioByCode(code) {
  const found = SCENARIOS.find((s) => s.code === code);
  if (!found) throw new Error(`no scenario with code ${code}`);
  return found;
}
