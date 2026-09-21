# Broker Board — Slice 2B: the Excel-like grid, in full

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The broker board becomes the grid in `Vue 3 Excel-like table/design_handoff_load_board_table/` — their colors and geometry, range selection, inline editing, clipboard, merge/unmerge, fills, grouping with totals, value filters, frozen columns — with every edit written back to the real `Load` record.

**Design source:** `Vue 3 Excel-like table/design_handoff_load_board_table/README.md` (high-fidelity handoff) and its two `.dc.html` prototypes. The prototypes are a React runtime: read them for algorithms (filter pipeline, grouping walk, virtualization offsets, merge/split model), never for code to copy.

**Spec:** `docs/superpowers/specs/2026-09-07-broker-board-night-shift-design.md` §4 (layout, behaviour), §5 (data model), §11 (API). Slices 1 and 2A are complete; this is the slice their ledgers call 2B, widened to the whole handoff.

## Architectural rulings (decided before any task starts)

1. **TanStack stays.** `useBoardTable.ts` already owns sorting, filtering, selection, visibility, sizing and prefs, proven by ~860 portal tests. The handoff's prototype is a hand-rolled engine; we take its *behaviours and tokens*, not its architecture. We port its algorithms only where TanStack has nothing: the two-line merge model, range selection, TSV clipboard, fills, group totals, variable-height offsets.
2. **The schema stays explicit.** Slice 1's promise is one truth — the board is a view over `Load`/`Carrier`/`Appointment`. The handoff's generic `Load` bag is a rendering model, not a storage model. `Load.extras` (Json) holds only cells with no home: unmapped columns, and line-2 values for a column whose bottom row has no field.
3. **Fills and merges are data; grouping and density are preferences.** A dispatcher's yellow cell and unmerged line come from their sheet and must survive a different browser → server, per org. Group-by, collapsed groups and column prefs stay in `localStorage` next to today's `columnPrefs.ts`.
4. **Every write is org-scoped and refuses verbatim.** Same pattern as 2A: `req.orgScope`, `outsideOrg`, the server's own sentence surfaced to the dispatcher.
5. **Money is integer cents, typed text is stored verbatim.** `PROFIT` is never typed — it is `rate − soldRate`, recomputed server-side on every write that touches either.

## Task list

### Backend

- [x] **Task 1 — `boardLoadNo`, `Load.extras`, `BoardView`**
  DONE (886 green). Schema + migration `20260908155938_broker_board_2b`. `boardLoadNo String?` retires slice 1's `board:` prefix trick. `extras Json?` for homeless cells. New `BoardView { id, orgId unique, fills Json, merges Json, updatedAt }`. `resetDb()` covers them.

- [x] **Task 2 — Write one cell**
  DONE (914 green). `PATCH /dispatcher/broker-board/loads/:id/cell` — `{ row: 'top'|'bottom', key: BoardColumnKey, source?: string, value: string }`. Maps a board cell back to its field (or `extras`), parses money to cents, recomputes profit, stores free text verbatim, refuses an unknown column and a load outside the org. Creating the carrier row on first write to a `bottom` cell.

- [x] **Task 3 — Write many cells (paste)**
  `POST /dispatcher/broker-board/cells` — up to 500 `{loadId,row,key,source?,value}` in one transaction, all-or-nothing, with the same mapping and the same refusals. This is the endpoint a paste lands on.

- [x] **Task 4 — Rows: add, duplicate**
  `POST /dispatcher/broker-board/loads` (blank load, `boardLoadNo` assigned, appears at the end of `boardLine`) and `POST /dispatcher/broker-board/loads/duplicate` (`{ids}` → copies with new ids, `(copy)` nowhere in the data — the copy is a real load).

- [x] **Task 5 — Board view state**
  `GET`/`PUT /dispatcher/broker-board/view` — `{ fills: {row,col,cell}, merges: {loadId: string[]} }`. Merges are the set of column keys that are unmerged for that load (the handoff's `sub` keys). Validated with zod, capped, org-scoped.

### The grid

- [x] **Task 6 — Their look: tokens and geometry**
  Header `#1c2026`, load rows `#f3a967`, gridlines `#c98a4f`, customer `#ffe95c`, appt `#e2efda`, profit `#1e6b2a`, link `#1a56c4`; Work Sans + Source Code Pro; header 40px, line 36px, 6px white gap between loads; toolbar, bulk bar (`oklch(0.45 0.13 250)`), status bar; `grid` and `board` variants. Density stays, expressed in the new geometry.

- [x] **Task 7 — Range selection and the status bar**
  Anchor + range (`{r1,c1,r2,c2}`, anchor knows its line), mousedown/drag/shift-click, arrows and shift+arrows skipping group rows, Tab/Shift+Tab, Ctrl+A, Esc, scroll-follows-anchor. Status bar: anchor label, `N cells · Sum · Avg` over numeric cells, shortcut hints.

- [x] **Task 8 — Inline editing**
  Double-click, Enter, F2 or a printable key opens an absolutely-positioned input (typing seeds it). Enter commits and moves down, Tab commits and moves right, Esc cancels, blur commits. Numeric columns strip `[^0-9.-]`; profit recomputes locally and is confirmed by the server's response. Optimistic write, revert on refusal with the server's sentence.

- [x] **Task 9 — Clipboard**
  Ctrl/Cmd+C writes the range as TSV; Ctrl/Cmd+V reads TSV and patches from the anchor through Task 3's bulk endpoint; Delete/Backspace clears the range. Paste that overruns the board's rows stops at the last row and says so.

- [x] **Task 10 — Merge / unmerge**
  A load is expanded iff it has any unmerged column. Merged cells `rowspan=2`; unmerged render line 1 and line 2. Toolbar button reads Merge or Unmerge from the anchor's column; applies across the range; merging moves a line-2 value up when line 1 is empty. Persisted through Task 5.

- [x] **Task 11 — Fills**
  12 swatches + No fill; targets Cells / Rows / Columns; precedence column → row → cell; `id|col` and `id|col|2` keys; row fill also applies to every checked row; remembers the last color. Persisted through Task 5.

- [x] **Task 12 — Grouping with totals**
  Chips builder (Customer, Carrier, Ship date, Pick up, Delivery, Update, PU zip, Del zip), nested, group rows with `Rate · Sold · Profit` sums, collapse/expand all, natural sort unless the column is in the sort list.

- [x] **Task 13 — Value filters, multi-sort, frozen columns**
  Per-column popover with value search, (Select all), counts that respect the other columns' filters and the global search, Clear/Done; active-filter pill clears all. Shift+click adds to the sort with an ordinal badge. Frozen column count with sticky offsets and the `#b8763d` edge shadow; header right-click sets it.

- [x] **Task 14 — Menus, bulk bar, CSV export**
  Row and header context menus; bulk bar per the handoff (`Set update…`, `Fill rows`, `Duplicate`, `Delete`, `Clear`) beside 2A's archive/export; CSV export of the filtered+sorted rows and visible columns, RFC-4180, `load-board.csv`, alongside the existing `.xlsx` export.

## Status

All 14 tasks complete. Backend 926 green, portal 949 green, tsc + vue-tsc clean.
Verified live against the org holding the user's real 26-load MEIBORG import
(probe rows created and deleted; their data untouched). Three defects the unit
tests could not reach were found in that live pass and fixed: a new row landing
at the TOP of the board (max+1 on a board of NULL boardLines computed 1), a
cell that saved but did not repaint (TanStack memoizes its row models and never
notified the render effect), and grouping by CARRIER silently doing nothing
(it is the second line of CUSTOMER, not a column of its own).

## Verification

Every task: RED → GREEN, backend `npm test` in `fleet-backend/`, portal `npm test` in `fleet-portal/`, `tsc`/`vue-tsc` clean, and — for anything visible — a live screenshot of the real board (the demo org holds the user's real 26-load MEIBORG import; re-import the fixture rather than editing those rows in a probe).

Constraint carried from every previous slice: **no git commits and no `git add`** in this session.
