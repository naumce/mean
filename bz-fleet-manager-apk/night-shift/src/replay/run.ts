// Runs a scenario through the real Agent with the in-memory fakes. Time is
// the scenario's: the clock is set to each step's minute before the step is
// delivered, so every event is stamped on the story's clock.
import { Agent } from "../core/agent.js";
import { pointAlongRoute } from "../core/geo.js";
import { STANDARD } from "../core/policy.js";
import type { AgentEvent, Place } from "../core/types.js";
import { FakeClock, KeywordClassifier, MemoryEvents, MemoryMailer, MemoryMessenger, MemoryPhone, MemorySheet, StraightRouter } from "../fakes/index.js";
import type { Scenario } from "./kcDesMoines.js";

export interface ReplayResult {
  agent: Agent;
  events: AgentEvent[];
  sheet: MemorySheet;
  messenger: MemoryMessenger;
  phone: MemoryPhone;
  mailer: MemoryMailer;
}

const MIN = 60_000;

export async function runReplay(scenario: Scenario): Promise<ReplayResult> {
  const clock = new FakeClock(scenario.t0Ms);
  const router = new StraightRouter(60);
  const sheet = new MemorySheet();
  const messenger = new MemoryMessenger();
  const phone = new MemoryPhone();
  const mailer = new MemoryMailer();
  const events = new MemoryEvents();

  const route = await router.route(scenario.brief.origin, scenario.brief.destination, {
    equipment: scenario.brief.equipment,
    departAtMs: scenario.brief.departAtMs,
  });
  const atMi = (mi: number): Place & { mi: number } => ({ name: "", mi, ...pointAlongRoute(route.geometry, mi / route.distanceMi) });
  const restStops = scenario.restStopsAtMi.map((r) => ({ ...atMi(r.mi), name: r.name }));
  const landmarks = scenario.landmarksAtMi.map((l) => ({ ...atMi(l.mi), name: l.name }));

  const agent = new Agent(
    {
      clock, router, sheet, messenger, phone, mailer, classifier: new KeywordClassifier(), events, restStops, landmarks,
      dispatcherEmail: "boss@dispatch.example", tz: "America/Chicago",
      // The replay is the spec's story, played live — not a dry run — so
      // shadow (STANDARD's own default) is off here.
      policy: { ...STANDARD, shadow: false },
    },
    scenario.brief,
  );
  await agent.start();

  const steps = [...scenario.steps].sort((a, b) => a.atMin - b.atMin);
  for (const step of steps) {
    const nowMs = scenario.t0Ms + step.atMin * MIN;
    clock.set(nowMs);
    switch (step.kind) {
      case "accept":
        await agent.onAccept();
        break;
      case "ping": {
        const p = pointAlongRoute(route.geometry, step.mi / route.distanceMi);
        await agent.onPing({ atMs: nowMs, lat: p.lat, lng: p.lng });
        break;
      }
      case "reply":
        await agent.onReply({ atMs: nowMs, channel: "chat", rawText: step.text });
        break;
      case "dispatcher":
        await agent.onDispatcherReply(step.text);
        break;
    }
  }
  return { agent, events: events.events, sheet, messenger, phone, mailer };
}
