# Cockpit S0+S1 — slice complete (2026-08-29)

Spec: `docs/superpowers/specs/2026-08-28-cockpit-control-tower-design.md`
Plan: `docs/superpowers/plans/2026-08-28-cockpit-s0-s1.md` (18 TDD tasks)
Full SDD record (ledger, 18 task reports, review packages, rulings):
`e:\meeting-copilot\.superpowers\sdd\2026-08-28-cockpit-s0-s1\` — KEPT, not deleted, because the
standing no-commits rule means git history is not the record for this work.

## What shipped
- **S0 theme**: semantic CSS-variable tokens + Tailwind `darkMode:'class'`, app-wide light/dark
  toggle in AppShell (`src/lib/theme.ts`, `src/stores/theme.ts`, `src/assets/main.css`).
- **S1 cockpit**: `/cockpit` route (`/loadboard` Control Tower untouched) — DST-safe org-timezone
  Gantt board, lane heads with specs/compliance/HOS clocks, leg bricks with lifecycle + conflict +
  equipment/hazmat/reg flags, deadhead connectors, KPI strip, backlog, yard, radar, master drawer,
  toolbar/filters/hotkeys. `src/lib/cockpit/*`, `src/components/cockpit/*`, `src/views/CockpitView.vue`.
- **Backend**: `Driver.defaultTractorId/defaultTrailerId` (migration `20260828120000_driver_pairing`),
  extended `/dispatcher/loadboard` read model (tractors, trailers, pairing, clocks, position, stops,
  freight, assignment + **nullable `economics`**), `nearestCity()`, `org` on dispatcher login.

## Gates at completion
backend 379 tests / 67 files + tsc clean · portal 344 tests / 64 files + vue-tsc + build clean ·
live smoke 26/26 · `/cockpit` in-browser with zero console errors (light and dark).

## Known-open, deliberately not fixed in this slice
1. **Light-mode contrast, whole cockpit accent palette** (equipment chips 1.70–2.84:1, status pills
   2.18–2.78:1, compliance chips incl. **REG EXPIRED at 2.97:1**). Theme defaults to `system`, so a
   light-mode OS lands on it. TOP of S5.
2. **Legacy `/loadboard` still renders an unpriced load as `$0` margin in emerald**
   (`src/components/board/LoadBrick.vue:20`) — same defect class as C1, one screen over. The wire
   now carries `economics`, so the fix is small.
3. Partly-priced lane shows revenue and margin-% over different denominators (`LaneHeadDriver.vue:151`).
4. `stopEtas.ts:25-26` doc comment describes the pre-fix algorithm.
5. Fleet Utilization is rest-of-org-day scoped but unlabelled (reads 0% late in the day).
6. Single-expiry-predicate rule is grep-enforced, not test-enforced.
7. Backend full-suite `vitest run` SIGSEGVs before the reporter flushes (pre-existing; verify in batches).

## Not started
S2 (drag-to-dispatch / move / resize / locks / tenders), S3 (fleet actions, grouping, checklists),
S4 (Market + Fuel views, Money tab returns), S5 (dark pass on legacy screens + the contrast sweep above).
Each needs its own plan.
