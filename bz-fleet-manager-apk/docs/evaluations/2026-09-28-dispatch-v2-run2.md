# Scenarios A–H evaluation — 2026-09-28

- Model: qwen3:8b
- Prompt version: dispatch-v2
- Run label: 2
- Experiment: Scenarios A–H · dispatch-v2 · qwen3:8b · run 2 (fa56c09f-1eb2-48c2-8c82-a56e73451e39)
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
| A | W-A-RELIABLE | dispatch-v2 | Charlotte Petrovski | Dwayne Okafor | 0.92 | 5 | 3 | — | 5 | 4 | 2/0/0 | 70.0 | 28779+6158 | proposed |
| B | W-B-CLOSER | dispatch-v2 | Eric Davis | Dwayne Okafor | 0.85 | 4 | 3 | — | 5 | 4 | 2/0/0 | 66.8 | 28097+6086 | proposed |
| C | W-C-SOON | dispatch-v2 | — | — | 0.95 | — | 0 | — | 2 | 1 | 1/0/0 | 13.9 | 6633+1197 | proposed |
| D | W-D-HOS | dispatch-v2 | Dwayne Okafor | Dwayne Okafor | 0.90 | 1 | 3 | — | 9 | 7 | 4/0/1 | 123.7 | 65100+11676 | proposed |
| E | W-E-EQUIP | dispatch-v2 | Femi Okafor | — | — | — | 4 | — | 7 | 5 | 2/1/1 | 235.9 | 33778+10085 | timeout |
| F | W-F-LANE | dispatch-v2 | — | — | 0.50 | — | 0 | — | 2 | 1 | 1/0/0 | 14.5 | 6537+1075 | proposed |
| G | W-G-HOME | dispatch-v2 | — | — | 0.50 | — | 0 | — | 2 | 1 | 1/0/0 | 11.1 | 6471+793 | proposed |
| H | W-H-PRIORITY | dispatch-v2 | Ava Li | Marcus Webb | 0.85 | 4 | 2 | — | 5 | 3 | 2/0/0 | 79.1 | 28859+7457 | proposed |

8 runs (proposed=7, timeout=1) — 1/8 matched the deterministic top — mean turns 4.3, mean latency 54.2s
