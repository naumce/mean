import { STAGES } from "../src/lib/demoStory/index.js";

// Demo Mode — finding F9/M9: the backend's own static presenter copy, held
// against the same forbidden-word list fleet-portal/src/views/DemoView.
// spec.ts already runs over the VIEW's own copy. `STAGES` (src/lib/
// demoStory/types.ts) is the one static template a presenter ever reads
// literally — every OTHER string this module writes is a dynamic log line
// built at runtime (observe.ts/observeBreakdown.ts/observeDelivery.ts/
// actions.ts) and is exercised, word for word, by each of those suites'
// own assertions on the exact text; `log.ts` holds no narration text of its
// own, only the append/dedupe machinery the brief asked to double-check.
//
// List copied from fleet-portal/src/views/DemoView.spec.ts:275 — named
// there as the plan's own list, docs/superpowers/plans/2026-09-28-demo-
// mode.md, Task 2 ("presenter copy stays plain business language").
const FORBIDDEN = /\b(score|rank|ranking|engine|deterministic|scenario)\b/i;

describe("Demo Mode presenter copy — STAGES (types.ts)", () => {
  it("every stage's title and narration is plain business language", () => {
    expect(STAGES.length).toBeGreaterThan(0);
    for (const stage of STAGES) {
      expect(stage.title, `stage "${stage.id}" title`).not.toMatch(FORBIDDEN);
      expect(stage.narration, `stage "${stage.id}" narration`).not.toMatch(FORBIDDEN);
    }
  });
});
