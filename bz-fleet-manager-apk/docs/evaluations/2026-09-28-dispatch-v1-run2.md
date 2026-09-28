# Scenarios A–H evaluation — 2026-09-28

- Model: qwen3:8b
- Prompt version: dispatch-v1
- Run label: 2
- Experiment: Scenarios A–H · dispatch-v1 · qwen3:8b · run 2 (acec4e38-97cc-4149-879b-d1182ec0d7de)
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
| A | W-A-RELIABLE | dispatch-v1 | Charlotte Petrovski | Dwayne Okafor | 0.95 | 5 | 1 | — | 5 | 4 | 4/0/0 | 46.6 | 23934+4442 | proposed |
| B | W-B-CLOSER | dispatch-v1 | Eric Davis | Dwayne Okafor | 0.95 | 4 | 0 | — | 4 | 3 | 3/0/0 | 37.6 | 16655+3662 | proposed |
| C | W-C-SOON | dispatch-v1 | — | — | 1.00 | — | 0 | — | 3 | 2 | 2/0/0 | 19.3 | 9550+1672 | proposed |
| D | W-D-HOS | dispatch-v1 | Dwayne Okafor | Dwayne Okafor | 1.00 | 1 | 0 | — | 6 | 4 | 4/0/1 | 43.8 | 31591+4321 | proposed |
| E | W-E-EQUIP | dispatch-v1 | Femi Okafor | — | 1.00 | — | 0 | — | 6 | 5 | 4/0/0 | 67.2 | 28734+6846 | proposed |
| F | W-F-LANE | dispatch-v1 | — | — | 1.00 | — | 0 | — | 3 | 2 | 2/0/0 | 20.9 | 9401+1965 | proposed |
| G | W-G-HOME | dispatch-v1 | — | — | 1.00 | — | 0 | — | 2 | 1 | 1/0/0 | 13.7 | 5250+1214 | proposed |
| H | W-H-PRIORITY | dispatch-v1 | Ava Li | Marcus Webb | 1.00 | 4 | 0 | — | 5 | 4 | 4/0/0 | 35.5 | 24266+3173 | proposed |

8 runs (proposed=8) — 1/8 matched the deterministic top — mean turns 4.3, mean latency 35.6s
