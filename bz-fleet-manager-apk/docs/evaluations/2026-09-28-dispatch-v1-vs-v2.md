# dispatch-v1 vs dispatch-v2 — 2026-09-28

Both prompt versions ran against the same model and the same harness configuration (verified below); only the prompt text, terminal schema, and protocol validation differ between them. The tables and figures below are behavioural data recorded from each run — what each prompt version actually did — not a verdict on which one is right for this fleet's own dispatch decisions.

- dispatch-v1 experiment(s): dc1a31c7-b546-49ff-acc3-ae9b70a2e392, acec4e38-97cc-4149-879b-d1182ec0d7de
- dispatch-v2 experiment(s): d6b5fb8c-ab35-4909-9595-bb49e921d90c, fa56c09f-1eb2-48c2-8c82-a56e73451e39
- Shared harness config:

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

## Per-scenario runs

One row per run, grouped by prompt version.

### dispatch-v1

| Scenario | Load ref | Pick | Deterministic top | Confidence | Turns | Tool calls | Unique tools | Investigated | Invalid calls | Termination | Duration (s) | Tokens (prompt+completion) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | W-A-RELIABLE | Dwayne Okafor | Charlotte Petrovski | 0.95 | 4 | 3 | 3 | 0 | 0 | proposed | 52.1 | 17335+4169 |
| A | W-A-RELIABLE | Dwayne Okafor | Charlotte Petrovski | 0.95 | 5 | 4 | 4 | 1 | 0 | proposed | 46.6 | 23934+4442 |
| B | W-B-CLOSER | Dwayne Okafor | Eric Davis | 0.95 | 4 | 3 | 3 | 0 | 0 | proposed | 36.6 | 16655+3552 |
| B | W-B-CLOSER | Dwayne Okafor | Eric Davis | 0.95 | 4 | 3 | 3 | 0 | 0 | proposed | 37.6 | 16655+3662 |
| C | W-C-SOON | — | — | 1.00 | 3 | 2 | 2 | 0 | 0 | proposed | 18.6 | 9550+1702 |
| C | W-C-SOON | — | — | 1.00 | 3 | 2 | 2 | 0 | 0 | proposed | 19.3 | 9550+1672 |
| D | W-D-HOS | Dwayne Okafor | Dwayne Okafor | 0.95 | 5 | 4 | 4 | 0 | 0 | proposed | 41.4 | 25146+3623 |
| D | W-D-HOS | Dwayne Okafor | Dwayne Okafor | 1.00 | 6 | 4 | 4 | 0 | 1 | proposed | 43.8 | 31591+4321 |
| E | W-E-EQUIP | — | Femi Okafor | 1.00 | 6 | 5 | 3 | 0 | 0 | proposed | 78.9 | 29819+7539 |
| E | W-E-EQUIP | — | Femi Okafor | 1.00 | 6 | 5 | 4 | 0 | 0 | proposed | 67.2 | 28734+6846 |
| F | W-F-LANE | — | — | 1.00 | 3 | 2 | 2 | 0 | 0 | proposed | 25.4 | 9401+2288 |
| F | W-F-LANE | — | — | 1.00 | 3 | 2 | 2 | 0 | 0 | proposed | 20.9 | 9401+1965 |
| G | W-G-HOME | — | — | 1.00 | 2 | 1 | 1 | 0 | 0 | proposed | 13.4 | 5250+1080 |
| G | W-G-HOME | — | — | 1.00 | 2 | 1 | 1 | 0 | 0 | proposed | 13.7 | 5250+1214 |
| H | W-H-PRIORITY | Marcus Webb | Ava Li | 1.00 | 6 | 4 | 4 | 1 | 1 | proposed | 39.5 | 30583+3782 |
| H | W-H-PRIORITY | Marcus Webb | Ava Li | 1.00 | 5 | 4 | 4 | 0 | 0 | proposed | 35.5 | 24266+3173 |

### dispatch-v2

| Scenario | Load ref | Pick | Deterministic top | Confidence | Turns | Tool calls | Unique tools | Investigated | Invalid calls | Termination | Duration (s) | Tokens (prompt+completion) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | W-A-RELIABLE | Dwayne Okafor | Charlotte Petrovski | 0.85 | 5 | 4 | 2 | 3 | 0 | proposed | 75.5 | 28779+6621 |
| A | W-A-RELIABLE | Dwayne Okafor | Charlotte Petrovski | 0.92 | 5 | 4 | 2 | 3 | 0 | proposed | 70.0 | 28779+6158 |
| B | W-B-CLOSER | — | Eric Davis | — | 7 | 6 | 5 | 2 | 0 | timeout | 207.3 | 36423+7937 |
| B | W-B-CLOSER | Dwayne Okafor | Eric Davis | 0.85 | 5 | 4 | 2 | 3 | 0 | proposed | 66.8 | 28097+6086 |
| C | W-C-SOON | — | — | 0.50 | 3 | 2 | 2 | 0 | 0 | proposed | 23.6 | 11492+2146 |
| C | W-C-SOON | — | — | 0.95 | 2 | 1 | 1 | 0 | 0 | proposed | 13.9 | 6633+1197 |
| D | W-D-HOS | Dwayne Okafor | Dwayne Okafor | 0.95 | 6 | 5 | 2 | 4 | 0 | proposed | 86.2 | 38287+7794 |
| D | W-D-HOS | Dwayne Okafor | Dwayne Okafor | 0.90 | 9 | 7 | 4 | 3 | 1 | proposed | 123.7 | 65100+11676 |
| E | W-E-EQUIP | Tomasz Nowak | Femi Okafor | 0.75 | 7 | 6 | 4 | 3 | 0 | proposed | 102.2 | 43097+9775 |
| E | W-E-EQUIP | — | Femi Okafor | — | 7 | 5 | 2 | 4 | 1 | timeout | 235.9 | 33778+10085 |
| F | W-F-LANE | — | — | 0.95 | 2 | 1 | 1 | 0 | 0 | proposed | 12.0 | 6524+975 |
| F | W-F-LANE | — | — | 0.50 | 2 | 1 | 1 | 0 | 0 | proposed | 14.5 | 6537+1075 |
| G | W-G-HOME | — | — | 0.50 | 2 | 1 | 1 | 0 | 0 | proposed | 12.0 | 6458+1033 |
| G | W-G-HOME | — | — | 0.50 | 2 | 1 | 1 | 0 | 0 | proposed | 11.1 | 6471+793 |
| H | W-H-PRIORITY | Marcus Webb | Ava Li | 0.85 | 6 | 4 | 2 | 3 | 1 | proposed | 67.0 | 37967+6369 |
| H | W-H-PRIORITY | Marcus Webb | Ava Li | 0.85 | 5 | 3 | 2 | 2 | 0 | proposed | 79.1 | 28859+7457 |

## Aggregates

### dispatch-v1

- Runs: 16 (16 proposed)
- Completion rate (proposed / runs): 100%
- Engine agreement rate (matched deterministic top / proposed): 13%
- Mean candidates investigated: 0.13
- Mean turns: 4.2
- Mean tool calls: 3.1
- Mean confidence: 0.98
- Confidence distribution: ≥0.90: 16, 0.70–0.89: 0, 0.50–0.69: 0, <0.50: 0
- Repeated-driver-selection frequency: Dwayne Okafor — 38% of proposed runs

### dispatch-v2

- Runs: 16 (14 proposed)
- Completion rate (proposed / runs): 88%
- Engine agreement rate (matched deterministic top / proposed): 14%
- Mean candidates investigated: 1.71
- Mean turns: 4.4
- Mean tool calls: 3.1
- Mean confidence: 0.77
- Confidence distribution: ≥0.90: 5, 0.70–0.89: 5, 0.50–0.69: 4, <0.50: 0
- Repeated-driver-selection frequency: Dwayne Okafor — 36% of proposed runs
