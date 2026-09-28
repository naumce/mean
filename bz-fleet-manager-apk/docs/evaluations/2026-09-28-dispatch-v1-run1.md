# Scenarios A–H evaluation — 2026-09-28

- Model: qwen3:8b
- Prompt version: dispatch-v1
- Run label: 1
- Experiment: Scenarios A–H · dispatch-v1 · qwen3:8b · run 1 (dc1a31c7-b546-49ff-acc3-ae9b70a2e392)
- Config:

```json
{
  "adapter": "ollama",
  "model": "qwen3:8b",
  "think": true,
  "temperature": 0.2,
  "numCtx": 16384,
  "maxTurns": 12,
  "maxToolCalls": 30,
  "maxConsecutiveInvalid": 3,
  "maxToolResultBytes": 65536,
  "maxRunMs": 600000,
  "modelCallTimeoutMs": 120000
}
```

Matching the deterministic ⚡Suggest top candidate, or a scenario's own seeded expectation, is shown below as reference data — it is not a definition of correctness. A different pick can be the right call for reasons the deterministic engine does not weigh, and a match does not by itself prove the model reasoned well.

| Scenario | Load ref | Prompt | Deterministic top | Pick | Confidence | Rank of pick | Investigated | Human verdict | Turns | Tool calls | Unique/Repeated/Invalid | Latency (s) | Tokens (prompt+completion) | Termination |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | W-A-RELIABLE | dispatch-v1 | Charlotte Petrovski | Dwayne Okafor | 0.95 | 5 | 0 | — | 4 | 3 | 3/0/0 | 52.1 | 17335+4169 | proposed |
| B | W-B-CLOSER | dispatch-v1 | Eric Davis | Dwayne Okafor | 0.95 | 4 | 0 | — | 4 | 3 | 3/0/0 | 36.6 | 16655+3552 | proposed |
| C | W-C-SOON | dispatch-v1 | — | — | 1.00 | — | 0 | — | 3 | 2 | 2/0/0 | 18.6 | 9550+1702 | proposed |
| D | W-D-HOS | dispatch-v1 | Dwayne Okafor | Dwayne Okafor | 0.95 | 1 | 0 | — | 5 | 4 | 4/0/0 | 41.4 | 25146+3623 | proposed |
| E | W-E-EQUIP | dispatch-v1 | Femi Okafor | — | 1.00 | — | 0 | — | 6 | 5 | 3/0/0 | 78.9 | 29819+7539 | proposed |
| F | W-F-LANE | dispatch-v1 | — | — | 1.00 | — | 0 | — | 3 | 2 | 2/0/0 | 25.4 | 9401+2288 | proposed |
| G | W-G-HOME | dispatch-v1 | — | — | 1.00 | — | 0 | — | 2 | 1 | 1/0/0 | 13.4 | 5250+1080 | proposed |
| H | W-H-PRIORITY | dispatch-v1 | Ava Li | Marcus Webb | 1.00 | 4 | 1 | — | 6 | 4 | 4/0/1 | 39.5 | 30583+3782 | proposed |

8 runs (proposed=8) — 1/8 matched the deterministic top — mean turns 4.1, mean latency 38.2s
