# Scenarios A–H evaluation — 2026-09-28

- Model: qwen3:8b
- Prompt version: dispatch-v2
- Run label: 1
- Experiment: Scenarios A–H · dispatch-v2 · qwen3:8b · run 1 (d6b5fb8c-ab35-4909-9595-bb49e921d90c)
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
| A | W-A-RELIABLE | dispatch-v2 | Charlotte Petrovski | Dwayne Okafor | 0.85 | 5 | 3 | — | 5 | 4 | 2/0/0 | 75.5 | 28779+6621 | proposed |
| B | W-B-CLOSER | dispatch-v2 | Eric Davis | — | — | — | 2 | — | 7 | 6 | 5/0/0 | 207.3 | 36423+7937 | timeout |
| C | W-C-SOON | dispatch-v2 | — | — | 0.50 | — | 0 | — | 3 | 2 | 2/0/0 | 23.6 | 11492+2146 | proposed |
| D | W-D-HOS | dispatch-v2 | Dwayne Okafor | Dwayne Okafor | 0.95 | 1 | 4 | — | 6 | 5 | 2/0/0 | 86.2 | 38287+7794 | proposed |
| E | W-E-EQUIP | dispatch-v2 | Femi Okafor | Tomasz Nowak | 0.75 | 2 | 3 | — | 7 | 6 | 4/0/0 | 102.2 | 43097+9775 | proposed |
| F | W-F-LANE | dispatch-v2 | — | — | 0.95 | — | 0 | — | 2 | 1 | 1/0/0 | 12.0 | 6524+975 | proposed |
| G | W-G-HOME | dispatch-v2 | — | — | 0.50 | — | 0 | — | 2 | 1 | 1/0/0 | 12.0 | 6458+1033 | proposed |
| H | W-H-PRIORITY | dispatch-v2 | Ava Li | Marcus Webb | 0.85 | 4 | 3 | — | 6 | 4 | 2/0/1 | 67.0 | 37967+6369 | proposed |

8 runs (proposed=7, timeout=1) — 1/8 matched the deterministic top — mean turns 4.4, mean latency 54.1s
