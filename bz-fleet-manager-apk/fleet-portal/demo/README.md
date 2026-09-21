# "The 6 A.M. Problem" — the directed sales film

Playwright drives the live app through a six-act script (plan:
`docs/DEMO-PITCH-PLAN.md`) with a camera that points — spotlight, zoom,
ghost cursor, act title cards, stat cards, and a REAL on-screen stopwatch —
and records the whole run as a video. Every number in the narration is read
live off the screen.

## The acts

- **I · The 6 A.M. Problem** — cold open on the pain
- **II · One Screen** — KPI bar (+ tooltip on camera), the STALE-HOS honesty
  beat, the cockpit sweep (search/filters/zoom/week — operated live), the
  brick decoded (deadhead hatch, lifecycle buttons), the Yard, the burning backlog
- **III · Seconds to Dispatch** — Jake's message → reply → ⚡Suggest (Dale
  blocked) → priced commit → stopwatch stops (~21s, real) → stat card → the
  drag beat (which the engine may honestly BLOCK on camera — even better)
- **IV · Problems Find You** — the WILL-MISS late-risk verdict, zoomed; the
  fleet-compliance digest (expired paperwork, 30 days ahead); and the live
  block: a Flatbed load where ⚡Suggest refuses EVERY driver because the only
  Flatbed's registration is expired — root cause on camera
- **V · Where the Money Goes** — diesel price edited live, the −$140 loser
  row, brokers/settlements, and the ROI stat card computed from the live
  Empty-mi-saved figure
- **VI · The Close**

## Run it

Stack must be up on :8080 (`docker compose up -d` from the repo root).

```bash
# 1. Seed the demo story (rerunnable — cleans up after previous runs)
JWT_ACCESS_SECRET=compose-access JWT_REFRESH_SECRET=compose-refresh \
  docker compose exec backend sh -c "node seed-control-tower.mjs && node seed-demo.mjs"

# 2. Play the pitch (from fleet-portal/)
node demo/pitch.mjs                  # watch it live in a browser window
DEMO_HEADLESS=1 node demo/pitch.mjs  # silent run, just produce the video
DEMO_PACE=1.5 node demo/pitch.mjs    # slower narration for a live audience
```

Output: `demo/video/*.webm` (the full recording), `demo/shots/NN-*.png`
(an 18-frame storyboard), and `demo/narration.md` (the voiceover script,
auto-exported with the exact live numbers). All git-ignored except narration.

Point it at another deployment with `DEMO_URL=https://... node demo/pitch.mjs`.
Driver login for a two-screen live demo: jake@heartland.demo / demo123.
