# One honest record — the Cockpit and Their Board share one truth

**Date:** 2026-09-09
**Status:** approved in design review (2026-09-09); spec for implementation planning
**Builds on:** `2026-09-07-broker-board-night-shift-design.md` (Their Board, §3 "one load, one record"), `2026-09-06-night-shift-agent-design.md` (the agent), `2026-09-01-dispatch-service-platform-design.md` (the Cockpit)
**Slice:** A of three. B (the agent as the shared story — broker spec §6–§8, slices 3–5) and C (cross-board navigation) are separate specs that build on this one.

## 1. What this is

Their Board and the Cockpit render the same Prisma `Load` rows. That is the only thing they share today, and the shared record is **wrong in ways each board cannot see**:

| A dispatcher does this on Their Board | The Cockpit sees |
|---|---|
| types a pickup city | a stop with `lat/lng = null` — off the map, invisible to late-risk |
| types `DEL: 07/17 - 10:00` in APPT | nothing — the cell editor stores text; only the importer creates `Appointment` rows |
| types a carrier | a real `Carrier` row the Cockpit's read model ignores; the load shows as **uncovered** |
| types `DELIVERED 07/17/2026` in UPDATE | nothing — `status` stays `open` |

Measured on the org's real board (26 brokered loads, 2026-09-09): **all 26 have `status = open`**, including the 3 whose UPDATE says DELIVERED and the 4 that say PICKED UP; 7 of 52 stops have no coordinates. The late-risk engine treats delivered freight as open.

This spec makes the record honest: **every change to a Load goes through one writer that derives the structured truth once**, both boards learn about it from one event, two people cannot silently overwrite each other, and a brokered load appears in the Cockpit as what it is — covered by a carrier.

## 2. Scope

In:
- The `LoadWriter`: one module every Load mutation passes through (§4), with a derivation pipeline for appointments, geocoding, status and Attention (§4.2).
- Data model: `Load.version`, `LoadChange`, `LoadLock`, `UpdateRule`; one `geocodeStatus` convention (§5).
- The status vocabulary: UPDATE text drives `Load.status` through a per-org, human-editable rule set, with a guard, a trace and an undo (§6).
- Load-level locks while editing, on both boards, with a version backstop (§7).
- The Cockpit: per-load carrier in the projection, carrier lanes, the corrected backlog rule (§8).
- Realtime: one shared socket in the portal, one `load_changed` event, rows patched by id (§9).
- The disagreement marks on Their Board (§10).
- The importer refactored onto the writer; a one-time backfill (§11).
- Four defects found while mapping this, closed here (§16).

Out (named so the boundaries stay put):
- The agent writing into the platform — pills beyond `attention`, drawer, shadow mode, Attention lane, trip panel. **Slice B.** It plugs into the writer built here; nothing in B needs a second derivation path.
- Deep links between the boards, "open in Cockpit". **Slice C.**
- A settings UI for the vocabulary; the API ships here, the screen later.
- Configuring a geocoding provider (a hosting decision; §17).

## 3. Decisions

Made in design review on 2026-09-09. Two go against the recommendation given at the time; both are recorded with the mitigation that makes them safe.

| # | Decision | Chosen | Why / mitigation |
|---|---|---|---|
| D1 | Architecture | **One `LoadWriter`, every path through it** | One place the record can be wrong. The importer already has a derivation path that disagrees with the cell editor's absence of one; a third for the agent would repeat the mistake. |
| D2 | Free text → status | **UPDATE drives status** (against recommendation: mirror only) | The record is already lying the other way — 26 open loads, 3 of them delivered. Made safe by: rules are data a human owns (§6.1), unknown text never changes anything (§6.2), a guard protects loads our own drivers run (§6.3), every transition is traced and undoable (§6.4). |
| D3 | Appointments | **`Appointment` rows are truth; text stays verbatim** | A board edit parses into rows as import does; an unparseable line keeps its text and raises Attention. A Cockpit change never rewrites their cell — the cell shows a mark (§10). |
| D4 | Concurrency | **Lock the load while editing** (against recommendation: version check only) | Predictable to a dispatcher. Made safe by: paste locks are atomic and last milliseconds (§7.2), locks are enforced server-side not only drawn (§7.3), and a `version` check under the lock stops an expired lock from losing a write (§7.4). |
| D5 | Brokered loads in the Cockpit | **A lane per carrier** | The boss sees brokered and own freight on one board; the backlog stops calling covered freight uncovered; slice B has a lane to draw the truck on. Coverage itself is still decided by `status` (§8.2), so this adds a lane, not a second coverage rule. |
| D6 | `geocodeStatus` on a miss | **`pending`** | The schema default and the recorded intent ("miss = pending, never a guess"); the importer's `failed` is aligned in the refactor. |

## 4. The LoadWriter

`fleet-backend/src/lib/loadWriter.ts`. Pure orchestration over Prisma; no HTTP, no `res`. Runs inside the caller's transaction.

### 4.1 Interface

```ts
type ChangeSource = "board" | "paste" | "import" | "loadboard" | "agent" | "backfill";

interface LoadPatch {
  // Scalar columns, each optional; undefined = untouched, null = cleared.
  bolNumber?, customerName?, trackingUrl?, orderRef?, boardLoadNo?, updateText?, apptText?,
  carrierPhone?, carrierContactName?, driverCell?, shipDate?, revenueCents?, soldRateCents?,
  carrierId?, extras?,
  // A stop by ROLE, never by position.
  stops?: { pickup?: { address: string }; delivery?: { address: string } };
}

interface Actor { dispatcherId: string | null; name: string; }   // null = a system source

function applyLoadChange(tx, args: {
  loadId: string; orgId: string; actor: Actor; source: ChangeSource;
  patch: LoadPatch;
  /** the version the caller's view was based on; see §7.4 */
  baseVersion?: number;
  /** derive everything regardless of what changed — the backfill (§11.2) */
  force?: boolean;
}): Promise<{ version: number; changed: string[]; attention: string[] }>
```

Producers, in this slice:
- **Their Board cells and paste** — `boardCellApply.ts` becomes a translator from `CellPlan` to `LoadPatch`; it no longer writes Prisma itself.
- **The importer** — `brokerImport.ts` builds one `LoadPatch` per row pair and calls the writer with `source: "import"` (§11).
- **`/loadboard`** — `PATCH /dispatcher/loads/:id` (stops, appointments) calls the writer with `source: "loadboard"`.
- **Backfill** — `source: "backfill"`, an empty patch, derivation forced (§11.2).

Slice B adds `source: "agent"` with no change to this module's shape.

### 4.2 Derivation — only for what changed

Run after the patch is applied, in this order, in the same transaction:

1. **Appointments** — when `apptText` changed. `parseApptText(lines, { year, tz })` with `year` = `shipDate`'s year (else the current UTC year) and `tz` = `Org.timezone`. For each role (PU → the pickup stop, DEL → the delivery stop):
   - a parsed window **upserts** that stop's `Appointment` (`windowStart`, `windowEnd`, `type` = the stop's type, `kind`);
   - a line that does not parse **leaves the existing `Appointment` untouched** and adds Attention `can't read DEL appointment: "<line>"`.
   This corrects the importer, which today deletes the appointment before it knows whether the new text parses (§16).
2. **Geocoding** — when a stop's `address` changed. The address is normalised to `City, ST ZIP` (the gazetteer's parser needs the comma) and `geocodeAddress()` is called in-process. A hit writes `lat`, `lng`, `geocodeStatus: "ok"`. A miss writes `lat/lng = null`, `geocodeStatus: "pending"` and adds Attention `can't place "<address>"`. Never a guess.
3. **Status** — when `updateText` changed, **or when `carrierId` changed** (the `SCHEDULED` rule reads it: booking a carrier on a SCHEDULED load moves it from `open` to `assigned` without anyone retyping the cell). §6.
4. **Attention** — the load's `AgentUpdate` rows of kind `attention` are replaced by the set produced above, in the same transaction (today import wipes and re-adds in two steps).
5. **Version and trace** — `Load.version += 1`; one `LoadChange` row per changed field (§5.2).

### 4.3 After commit

The route that owns the transaction emits exactly one `load_changed { orgId, loadId, version, fields }` (§9). Nothing is emitted from inside the transaction.

## 5. Data model

### 5.1 `Load`
- `version Int @default(0)` — bumped by the writer on every change.
- No other new columns. `geocodeStatus` on `LoadStop` keeps its three values `ok | pending | failed`; only `ok` and `pending` are written from now on (`failed` is reserved for a provider that answered "no such place", not for a gazetteer miss).

### 5.2 `LoadChange` — the trace
```
id, loadId (FK, cascade), orgId, atMs BigInt,
actorId String?, actorName String, source String,   // ChangeSource
field String, before String?, after String?,          // rendered as the cell would show them
note String?                                          // e.g. the UPDATE text that drove a status change
@@index([loadId, atMs])
```
Read by the drawer in slice B and by the undo in §6.4. Never edited or deleted.

### 5.3 `LoadLock`
```
id, loadId @unique, orgId, dispatcherId, dispatcherName, since DateTime, expiresAt DateTime
@@index([orgId, expiresAt])
```

### 5.4 `UpdateRule` — the vocabulary
```
id, orgId, prefix String, status String, enabled Boolean @default(true), createdAt
@@unique([orgId, prefix])
```
`status` is one of the platform's values: `open | assigned | in_progress | delivered | canceled`. `tendered` and `archived` are never set from text.

## 6. The status vocabulary

### 6.1 The rules are data a human owns

Seeded per org from the words on the org's own board (measured 2026-09-09, 26 rows):

| Prefix (case-insensitive, leading words) | Status | Rows today |
|---|---|---|
| `PENDING` | `open` | 3 |
| `SCHEDULED` | `assigned` when `carrierId` is set, else `open` | 10 |
| `PICKED UP`, `IN TRANSIT`, `LOADED`, `EN ROUTE` | `in_progress` | 10 |
| `DELIVERED` | `delivered` | 3 |
| `CANCELLED`, `CANCELED`, `TONU` | `canceled` | 0 |

A rule matches when the cell, trimmed and upper-cased, **starts with the prefix and the next character is the end of the text or a non-letter** — so `DELIVERED 07/17` and `DELIVERED - POD SENT` match `DELIVERED`, and `DELIVEREDX` matches nothing. Longer prefixes win over shorter ones. Everything after the match is a note (`- ON TIME`, `- ETA 09:30`, a date) and is ignored by the rule. `GET/PUT /api/dispatcher/update-rules` edits the set; the screen for it is a later slice.

### 6.2 Unknown text changes nothing

A cell that matches no enabled prefix is stored verbatim and **does not touch `status`**. Free notes are the normal case, not an error, so they raise no Attention. (Slice B's morning list may *propose* frequently-seen unknown prefixes as new rules, the way the situation library proposes phrasings; nothing is added without a human.)

### 6.3 The guard

If the load has an `Assignment` — one of our own drivers — the cell is stored, but the transition is **refused**: the assignment lifecycle (`POST /assignments/:id/status`) owns those trips, and a board cell must not move a driver's leg. The response carries `recordStatus` so the cell shows the mark (§10) with *"record says assigned — advance the trip in the Cockpit."* For brokered loads (no `Assignment`) the transition applies. `archived` loads are never moved by text.

### 6.4 Trace and undo

Every applied transition writes `LoadChange { field: "status", before, after, note: <the UPDATE text> , source }`. The row shows *"status set from UPDATE"* in the cell's tooltip. `POST /api/dispatcher/loads/:id/undo-status` restores `before` (a `LoadChange` of its own, `source: "board"`), and is refused with a sentence when a later structured change has already moved the load past it.

## 7. Locks

### 7.1 Shape
Same family as lane locks: TTL **60 s**, client heartbeat every **20 s** while an editor is open, released explicitly on commit or cancel, released on socket close like lane locks are. Events `load_lock { loadId, by, dispatcherId, since }` and `load_unlock { loadId }`; this wires `stores/locks.ts` `applyEvent`, which exists today and is never called.

### 7.2 When a lock is taken
- **Their Board, one cell:** opening the inline editor acquires; Enter/Tab/blur/Escape releases.
- **Their Board, paste / bulk "Set update…" / fill:** acquires every target load inside the single write transaction and releases with it. The transaction lasts milliseconds, so other users see at most a flicker. If any target is held by someone else, the whole paste is refused **naming the holder and the LOAD#s** — nothing partial lands, consistent with the paste's all-or-nothing contract.
- **Cockpit:** drag-to-assign and replan take the load lock alongside the lane lock they already take; the `/loadboard` load editor takes it on open.
- **Import:** holds each load only inside its own write transaction, never across the preview.

### 7.3 Enforcement
A write to a load locked by another dispatcher is refused server-side with 409 `LOAD_LOCKED { by, since }` — the badge is not the only protection. The UI shows *"Maria is editing"* on the row (Their Board) and on the brick (Cockpit); cells are read-only until the badge clears.

### 7.4 The version backstop
Every write carries `baseVersion` — the `Load.version` the client rendered. If the row's version moved (a lock expired while a laptop was shut; a system source wrote), the write is refused with 409 `STALE_VERSION { current, theirs: <the field's current rendered value> }`, and the cell shows both values with **keep mine / take theirs**. This is not a second concurrency model; it is what stops an expired lock from silently losing a write. `source: "import"` and `"backfill"` skip the check (they are the truth arriving, not a view of it).

## 8. The Cockpit side

### 8.1 Projection
The loadboard load projection gains: `carrierId`, `carrierName`, `carrierMc`, `customerName`, `updateText`, `apptText`, `shipDate`, `boardLoadNo`, `version`. The stale comment "Load carries no carrierId column" goes, and the loadboard's carrier filter applies to `Load.carrierId` as well as to driver/tractor/trailer carriers.

### 8.2 Coverage is decided by status
The Cockpit already reads coverage from `status`; brokered loads follow the same rule rather than a second one. A brokered load is **covered** when its status is `assigned`, `in_progress` or `delivered` — which, on Their Board, is what `SCHEDULED`, `PICKED UP`/`IN TRANSIT` and `DELIVERED` mean (§6.1). A carrier row that is filled in while the status is still `open` (`PENDING RATE CONFIRMATION`) is a carrier *lined up*, not a carrier *booked*, and the load is still uncovered.

### 8.3 Carrier lanes and the backlog
- `projectLanes` gains a lane kind `carrier:<carrierId>`: a load with **no `Assignment`, a `carrierId`, and a covered status** is bucketed there. The lane is labelled with the carrier's name and MC; it has no driver, tractor or trailer. The brick spans PU `windowStart` → DEL `windowEnd` from the `Appointment` rows §4.2 now guarantees; a load with no parsed windows renders as an unplaced brick at the lane's left edge carrying its Attention text. Bricks are marked *brokered*.
- The backlog rule is **unchanged**: `!assignment && status ∈ {open, tendered}`. What changes is that a backlog load with a `carrierId` now shows a **carrier chip** — "Blue Road LLC · pending" — so the boss can tell *no carrier* from *carrier not yet confirmed*.
- Consequence worth stating: a brokered load whose UPDATE matches no rule stays `open` and in the backlog, carrier chip or not. Nothing said it was confirmed, so the board does not say so either.

### 8.4 Risk
`dispatcherRisk` already keys on the last delivery stop's `Appointment.windowEnd`; brokered loads acquire risk with no change once §4.2 produces their appointments. `in_progress` brokered loads have no GPS in this slice, so `behind_schedule` cannot fire for them until slice B; `late_start` does.

### 8.5 Acceptance on the real board
After the backfill (§11.2) on the org holding the 26 MEIBORG rows: the backlog shows **exactly the 3 `PENDING …` loads**, each with a carrier chip; the 10 `SCHEDULED` sit in carrier lanes as `assigned`; 3 are `delivered` and **9** `in_progress` (the tenth `IN TRANSIT` row is `archived`, and archived is never moved by text — §6.3); every stop whose city is in the gazetteer has coordinates, and every one that is not carries an Attention.

## 9. Realtime

- **Server:** the writer's owning route emits `load_changed { orgId, loadId, version, fields: string[] }`. `board_update` keeps firing unchanged for one slice so nothing regresses; it is removed when both stores are on `load_changed`.
- **Portal:** one socket singleton, `lib/realtime.ts`, replacing the two per-store sockets (`loadboard` and `tracking` each open their own today). Stores subscribe by event type. `brokerBoard` subscribes — today it emits and never listens — and on `load_changed` fetches only those ids (`GET /broker-board?ids=`) and swaps rows in place. `loadboard` patches by id and falls back to the full five-endpoint refresh only for events that carry no id. `locks` receives `load_lock`/`load_unlock`.

## 10. The marks

The board GET hands each cell an optional `record` hint, rendered as a small dot in the cell's corner with a tooltip; the text itself is never changed.

| Cell | Hint | When |
|---|---|---|
| APPT | `recordAppt: "PU 07/14 12:00 · DEL 07/17 10:00"` | the `Appointment` rows disagree with what the cell text parses to (a Cockpit edit moved them, or the text failed to parse) |
| UPDATE | `recordStatus: "assigned"` | the cell **matches a rule** and that rule's status ≠ `Load.status` (a guard refused it, or the Cockpit moved the load). Text that matches no rule never carries this mark — free notes are not disagreements. |
| any locked row | `lockedBy: "Maria"` | §7 |

## 11. Importer and backfill

### 11.1 Importer
`confirmImport` builds a `LoadPatch` per row pair and calls the writer with `source: "import"`. Behaviour is preserved except: an unparseable appointment no longer deletes the previous one (§4.2.1); a geocode miss writes `pending`, not `failed` (D6); Attention rows are replaced atomically. The existing broker-import suite must stay green apart from the tests added for those three changes.

### 11.2 Backfill
`npm run loads:rederive [--org <id>]` in `fleet-backend`: for every load, `applyLoadChange` with an empty patch and `force: true`, so appointments, coordinates, status and Attention are derived from what is already stored. Idempotent; logs one line per load whose status changed. Run once per org after deploy; it is also how a new `UpdateRule` is applied retroactively.

## 12. Honesty rules (carried from the broker spec §10, extended)

- A human's cell is never rewritten by the system — not by the writer, not by the Cockpit, not by the agent.
- Nothing is invented: an unreadable appointment or an unplaceable city becomes Attention quoting the offending text; the previous good value stays.
- Every status change driven by text is traced with the text that drove it and can be undone in one click.
- Every lock is visible and named; every refusal is a sentence the dispatcher can act on.
- A refusal never leaves a partial write.

## 13. API

Under the dispatcher's auth, org-scoped:
- `PATCH /api/dispatcher/broker-board/loads/:id/cell` and `POST …/cells` — unchanged shape, plus `baseVersion` in the body; responses carry `version` and the cells' `record` hints.
- `GET /api/dispatcher/broker-board?ids=a,b,c` — the rows for those ids only (for realtime patching).
- `POST /api/dispatcher/loads/:id/lock`, `POST …/lock/heartbeat`, `DELETE …/lock` — `{ by, since, expiresAt }`; 409 `LOAD_LOCKED` when held by another.
- `POST /api/dispatcher/loads/:id/undo-status` — §6.4.
- `GET/PUT /api/dispatcher/update-rules` — the org's vocabulary.
- `GET /api/dispatcher/loads/:id/changes` — the `LoadChange` list (the drawer's source in slice B).
- Realtime: `load_changed`, `load_lock`, `load_unlock`.

## 14. Testing

- **Writer (unit, no HTTP):** one test per derivation; the appointment rule *unparseable line keeps the previous Appointment*; address normalisation for the gazetteer; each vocabulary row and the guard; `LoadChange` written per field; `version` monotonic; `baseVersion` refusal.
- **Importer:** existing suite green; new tests for the three behaviour changes in §11.1.
- **Routes:** cell → Appointment / coordinates / status / trace; paste refused naming the lock holder; lock acquire, heartbeat, expiry, release-on-disconnect; `STALE_VERSION` on an expired lock; undo refused after a later structured change.
- **Cockpit projection:** a carrier-only load lands in `carrier:<id>` and leaves the backlog; the carrier filter includes it; risk fires on its `Appointment`.
- **Portal:** one socket per tab; both stores patch by id; marks and lock badges render; the paste refusal names LOAD#s.
- **Live acceptance:** §8.5 on the real board, screenshot both surfaces.

## 15. Build order

Each ships alone and leaves the system consistent.

1. **Writer + data model + backfill** — `loadWriter.ts`, migrations, importer refactor, `loads:rederive`. The record becomes honest with no UI change. 3 days.
2. **Vocabulary + trace + undo** — `UpdateRule` seed, guard, `LoadChange`, undo route; the UPDATE mark. 2 days.
3. **Locks + version backstop** — `LoadLock`, routes, events, badges on both boards, paste refusal. 2 days.
4. **Cockpit carrier lanes + projection + backlog rule.** 2 days.
5. **Realtime unification** — shared socket, `load_changed`, patch-by-id, retire `board_update`. 1–2 days.

## 16. Defects this slice closes (found while mapping it)

1. A LOAD# typed on the carrier line writes `Load.boardLoadNo` but the GET renders that cell from `externalId` — the value vanishes on refresh. The GET renders `boardLoadNo`.
2. APPT edits on the board never became `Appointment` rows (import did). §4.2.1.
3. City edits on the board never geocoded. §4.2.2.
4. The GET reads stops **positionally** (`stops[0]` = pickup); a load with an odd stop set shows the wrong cell. The GET and the writer address stops by `type`.
5. The importer deleted a good appointment before checking whether the replacement parsed. §4.2.1.

## 17. Open points

- **Geocoding coverage.** With no `GEOCODER_URL`, only the 141-city gazetteer answers; 7 of 52 stops on the real board already miss. The Attention is truthful, but the fix is the provider — a hosting decision (broker spec slice 6). Until then, expect Attention on non-hub cities.
- **`SCHEDULED` on a load with no carrier yet** maps to `open`; if the org uses SCHEDULED to mean "customer confirmed, carrier pending", a second rule (`SCHEDULED` → `tendered`) is one row in `UpdateRule` — not decided here.
- **Undo across the assignment lifecycle.** Undo restores the previous status only while no structured change has followed; whether it should also be offered on a Cockpit-driven change is slice B's call.
- **Two dispatchers on the same org both pasting** the same block: the second is refused naming the first's LOAD#s (§7.2). Whether the second paste should instead *queue* is deferred until it is observed.
