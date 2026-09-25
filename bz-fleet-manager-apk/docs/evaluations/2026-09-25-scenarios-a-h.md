# Scenarios A–H evaluation — 2026-09-25

- Model: qwen3:8b
- Prompt version: dispatch-v1
- Experiment: Scenarios A–H · dispatch-v1 · qwen3:8b (7302086a-a881-4e63-b435-8192dfe372b7)
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

| Scenario | Load ref | Deterministic top | Pick | Confidence | Rank of pick | Human verdict | Turns | Tool calls | Unique/Repeated/Invalid | Latency (s) | Tokens (prompt+completion) | Termination |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | W-A-RELIABLE | Charlotte Petrovski | Dwayne Okafor | 0.95 | 4 | — | 4 | 3 | 3/0/0 | 46.5 | 28468+3266 | proposed |
| B | W-B-CLOSER | Eric Davis | Dwayne Okafor | 0.85 | 4 | — | 5 | 4 | 4/0/0 | 43.8 | 36905+3807 | proposed |
| C | W-C-SOON | Ana Kovacs | Dwayne Okafor | 0.95 | 3 | — | 4 | 3 | 3/0/0 | 41.5 | 24257+3715 | proposed |
| D | W-D-HOS | Dwayne Okafor | Dwayne Okafor | 0.95 | 1 | — | 5 | 4 | 4/0/0 | 42.5 | 34746+3641 | proposed |
| E | W-E-EQUIP | Femi Okafor | — | 0.95 | — | — | 4 | 3 | 3/0/0 | 36.4 | 23659+3197 | proposed |
| F | W-F-LANE | — | — | 1.00 | — | — | 4 | 2 | 2/0/1 | 50.5 | 23259+3001 | proposed |
| G | W-G-HOME | Ava Li | Marcus Webb | 1.00 | 5 | — | 5 | 4 | 4/0/0 | 23.2 | 31813+1949 | proposed |
| H | W-H-PRIORITY | Ava Li | Katerina Walsh | 0.95 | 2 | — | 4 | 3 | 3/0/0 | 42.3 | 24000+3871 | proposed |

8 runs (proposed=8) — 1/8 matched the deterministic top — mean turns 4.4, mean latency 40.8s
