# Scenarios A–H evaluation — 2026-09-25

- Model: qwen3:8b
- Prompt version: dispatch-v1
- Experiment: Scenarios A–H · dispatch-v1 · qwen3:8b (a9502e13-8d8e-4155-b2bc-8506bc1b0734)
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
| A | W-A-RELIABLE | Charlotte Petrovski | Dwayne Okafor | 0.95 | 4 | — | 4 | 3 | 3/0/0 | 30.8 | 18866+2850 | proposed |
| B | W-B-CLOSER | Eric Davis | Dwayne Okafor | 0.95 | 4 | — | 4 | 3 | 3/0/0 | 35.9 | 18007+3399 | proposed |
| C | W-C-SOON | Ana Kovacs | Dwayne Okafor | 0.95 | 3 | — | 5 | 4 | 4/0/0 | 38.1 | 22074+3752 | proposed |
| D | W-D-HOS | Dwayne Okafor | Dwayne Okafor | 0.95 | 1 | — | 5 | 4 | 4/0/0 | 36.0 | 25040+3472 | proposed |
| E | W-E-EQUIP | Femi Okafor | — | — | — | — | 9 | 6 | 4/1/3 | 129.5 | 59536+12879 | consecutive_invalid |
| F | W-F-LANE | — | — | 1.00 | — | — | 3 | 2 | 2/0/0 | 23.0 | 9487+2162 | proposed |
| G | W-G-HOME | Ava Li | Marcus Webb | 0.95 | 5 | — | 4 | 3 | 3/0/0 | 35.9 | 18040+3477 | proposed |
| H | W-H-PRIORITY | Ava Li | Marcus Webb | 0.95 | 6 | — | 5 | 4 | 4/0/0 | 57.1 | 24659+5567 | proposed |

8 runs (proposed=7, consecutive_invalid=1) — 1/8 matched the deterministic top — mean turns 4.3, mean latency 36.7s
