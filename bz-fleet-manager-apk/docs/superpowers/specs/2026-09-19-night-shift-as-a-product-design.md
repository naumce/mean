# Night Shift as a product — the agent in the dispatcher's own sheet

**Date:** 2026-09-19
**Status:** draft for review
**Builds on:** `2026-09-06-night-shift-agent-design.md` (the agent; its §1 was sheet-first), `2026-09-07-broker-board-night-shift-design.md` (the boards, §17 the switch and policies), `2026-09-11-night-shift-on-the-board.md` (the plan that built the switch, policies, `PlatformLoads`, `PlatformSheet`, the drawer).

## 1. What this is

A dispatcher keeps working in the Google Sheet they already run loads from — one row per load. They connect the sheet to Night Shift, map their columns once, and two columns appear at the right edge: **Night Shift** (a dropdown: `OFF` or a policy name) and **Night Shift status** (a coloured dot, the pill word, and the agent's last line). Choosing a policy in the first cell switches the agent on for that row. From then on the agent does what it already does — plans the route and the break, reads GPS from the driver's link, detects stopped / delayed / dark / off-route, climbs the ladder, classifies the reply, drafts the customer email — and writes what it is doing into the second cell. Calls and texts happen on phones. Escalations arrive by email and SMS with a link that opens the load's timeline and the supervision buttons, on a phone, at 02:14.

Nothing about the agent changes. The sheet is a third surface over the same worker, next to Their Board and the Control Tower, and it plugs in where those do: a sheet row becomes a `Load` row, and `PlatformLoads` / `PlatformSheet` never learn that a sheet exists.

**Distribution first, features second.** Setup under ten minutes, no engineer, no install, no app-store review between us and the first paying customer.

## 2. Scope

In:
- The Google Sheets connector and the `SheetConnector` interface it implements (§5).
- Column mapping, the two cells, and the two-way sync loop (§5–§6).
- Multi-tenancy: sign-up creates an org; telephony per org; A2P 10DLC under our ISV brand; BYO Twilio as the escape hatch (§7).
- The prepaid wallet, metering in the core, and the guardrails that keep an out-of-credit org from dialling (§8).
- The hosted app: the portal under a `sheet` plan flag, with Connect, Board, Night Shift, Usage, Settings, and a phone-friendly deep link per load (§9).
- The MCP server as thin wrappers over the same routes (§10).
- What lands in the core versus the sheet layer, so the agreed engineering slices (platform GPS + rich brief, itinerary, model-driven call, memory, policy profiles) are not blocked or duplicated (§11).

Out (named so it does not creep in):
- The Excel/Graph connector implementation — interface and a stub with the same test suite only.
- Google Workspace Marketplace listing and the Apps Script sidebar. The hosted flow ships as an OAuth app; the Marketplace add-on is a shell over it, built only if acquisition needs it.
- ELD share-link ingestion (Samsara/Motive/Linxup). Still the human-only button; still the one-hour spike named in the boards spec §7.2.
- Stripe subscriptions. Only one-off top-ups.
- The model-driven multi-turn call, the itinerary, the memory tables. They are core work in the agreed order; the sheet customer inherits them when they land.
- Fixing prices. Every price is a field on `Plan` with a null default; the code path does not depend on its value.

## 3. Distribution options considered

| Option | What it is | Why not first |
|---|---|---|
| **A. Google Sheets add-on / Excel Office add-in** | Apps Script sidebar for setup and policy; the agent writes cells through the same API. | Marketplace OAuth review is 2–6 weeks and repeats on scope changes; Excel needs a second add-in and a second review. Apps Script cannot run the worker — it is a thin client over a hosted API that has to exist anyway. It removes nothing from C; it adds a shell. |
| **B. MCP server** | Tools `watch_load`, `stop`, `status`, `set_policy`, `call_now`; a dispatcher using Claude/ChatGPT/Copilot drives the agent in natural language. | Reaches only AI-tool users. Multi-tenant OAuth for MCP is not settled. A "sync the sheet" tool is wrong — sync must run every minute whether or not a chat window is open. Every tool is a one-line wrapper over a route C needs. |
| **C. Hosted "connect your sheet"** | OAuth to the sheet, map columns, the two cells appear, we poll and write back. | — |

**Decision:** C is the core. B ships in parallel because its tools are wrappers over routes C must have, so the parallel cost is days; it is the door for dispatchers who already sit in an AI tool, and the demo that needs no screen. A is deferred until Marketplace presence is shown to matter for acquisition.

The alternative structure — a separate "sheet agent" with its own store, faster for week one — was rejected because it is a fork of the worker by week four, and every core slice would then have to be built twice.

## 4. The structural decision

**A sheet row becomes a `Load` row** in an `Org` created for that customer. The sheet layer is a sync surface: rows → `Load` (through the traced writer), pill and line → cells. The agent reads `Load`, writes `Load.agentPill` and `AgentUpdate`, exactly as it does for the boards. Consequences:

- Slice 1 (platform GPS, rich brief), the itinerary, the model-driven call, the memory tables and policy profiles are core changes; the sheet customer gets them on deploy with no sheet-layer work.
- The Control Tower is the same org one click away, hidden by a plan flag, not a different product. "Sell without adopting the Control Tower" becomes "sell, and let them adopt it later without a migration".
- The Broker Board — their layout, editable cells, pill + agent line per row — is the hosted page. Its spec §9.3 named live-sheet sync as its next step; this spec is that step.

## 4a. Two products, one platform — the distinction

Night Shift is not a separate application. It runs on the same backend, database, worker and portal as the Control Tower. It **is** a separate product, and the line between the two must be visible to a customer and to a reviewer.

| | **Night Shift** (`Plan.tier = "sheet"`) | **Control Tower** (`Plan.tier = "tower"`) |
|---|---|---|
| What they buy | An agent that watches their trucks at night | A dispatch platform (Night Shift included) |
| System of record | **Their sheet.** We mirror it; if we vanish, their sheet is intact | **Our database.** A sheet is an import |
| Where they work | Their Google Sheet and a phone | Our Cockpit and boards |
| What they see of us | Two cells, escalation email/SMS, the phone-sized timeline page, a small setup/usage site | The whole portal |
| Who edits load data | They do, in the sheet; our Board is a convenience mirror | They do, in our boards |
| Drivers | Their carriers' drivers via the link; no app | Their own drivers on our driver app with GPS |
| Priced by | Load-night + messages, prepaid (§8) | Seats / fleet size (a later spec) |
| Onboarding | Self-serve, under ten minutes | Sales-led import and setup |
| Name | "Night Shift" | "Control Tower" |

**Where the line lives in code:** one field, `Plan.tier`, and one folder, `fleet-backend/src/lib/sheet/`. Everything else is shared on purpose.

**Rules:**
- A sheet-tier customer must never *need* the Tower to use Night Shift. If a Night Shift feature only works from a Tower screen, it is a bug.
- A Tower customer gets Night Shift as a feature, not a second purchase.
- Upgrade is flipping the tier. The sheet sync may keep running afterwards; the Board already serves both.
- What stays distinct although the code is shared: the sign-up and landing page (they sign up for Night Shift, not a fleet platform), the nav (four items, no Cockpit), the email footer and branding, the pricing page.
- What must never diverge: the agent, the policies, the drawer, the ledger, the pill vocabulary.

## 5. Connecting the sheet

### 5.1 The connector interface

`fleet-backend/src/lib/sheet/connector.ts` (the backend's setup routes and the worker both need it; the worker already imports `fleet-backend/src/db.js`):

```ts
export interface TabRef { spreadsheetId: string; tabId: string; }
export interface RawRow { rowIndex: number; cells: string[]; }

export interface SheetConnector {
  listSpreadsheets(): Promise<{ id: string; title: string }[]>;
  listTabs(spreadsheetId: string): Promise<{ id: string; title: string }[]>;
  readHeader(ref: TabRef, headerRow: number): Promise<string[]>;
  /** Every data row below the header. `version` is opaque (Drive revision id
   *  for Google); a caller passing the last version back gets an empty `rows`
   *  when nothing changed, so an idle sheet costs one metadata call a minute. */
  readRows(ref: TabRef, sinceVersion?: string): Promise<{ rows: RawRow[]; version: string }>;
  writeCells(ref: TabRef, writes: { rowIndex: number; col: number; value: string; note?: string }[]): Promise<void>;
  /** Adds the named columns at the right edge if absent, installs the
   *  dropdown validation and the conditional formatting; returns col indexes. */
  ensureAgentColumns(ref: TabRef, names: { switch: string; status: string }, policyNames: string[]): Promise<{ switch: number; status: number }>;
}
```

Implementations: `GoogleSheetsConnector` (Sheets API v4 only — no Drive API: the dispatcher pastes the sheet's link, `spreadsheets.get` answers its title and tabs, and the tab's version is a digest of the values read; OAuth 2 with the `spreadsheets` scope, refresh token encrypted at rest per org). `GraphExcelConnector` is a stub that throws `not implemented` and shares the connector test suite, so the day it is written the tests already exist. An in-memory `FakeConnector` for every other test.

### 5.2 The binding and the mapping

`SheetBinding` (one per org in this release; the model allows more):

```
id, orgId, provider ("google" | "graph"), spreadsheetId, tabId, tabTitle,
headerRow Int, columns Json, agentSwitchCol Int, agentStatusCol Int,
lastVersion String?, lastSyncAt, lastError String?, status ("connected" | "paused" | "error")
```

`columns` maps our keys to their header names: `loadRef` (required), `driverPhone` (required), `driverName`, `pickup` (required), `delivery` (required), `pickupAppt`, `deliveryAppt` (required), `customerEmail`, `carrierName`, `carrierPhone`, `rate`, `notes`. Every other header is an `extra` and mirrors into `Load.extras` both ways, so the hosted board shows their whole row. The proposal comes from `proposeLayout(headerRow)` in `fleet-backend/src/lib/boardLayout.ts`, which already matches by header-name similarity for the `.xlsx` import; the dispatcher confirms or corrects it once. The same call seeds the org's `BoardLayout`.

### 5.3 Row identity

`rowKey` is the `loadRef` cell. A row index is not stable — an insertion above shifts every row — so a row without a load number is not mirrored; its status cell says `ATTENTION — needs a load number` and nothing else happens. No fingerprinting, no guessing. A load number that appears twice in the sheet marks both rows `ATTENTION — duplicate load number` and mirrors neither.

### 5.4 Parsing

Appointments through `parseApptText` (`fleet-backend/src/lib/apptText.ts`), cities through `geocodeAddress`, money through `parseMoney` — the Broker Board import's functions, unchanged. A cell that will not parse becomes `Attention` in the status cell with the offending text quoted, and the agent does not start on that row. Nothing invents a deadline.

## 6. The two cells and the sync loop

### 6.1 The switch cell — `Night Shift`

A data-validation dropdown installed by `ensureAgentColumns`: `OFF`, then one entry per policy name (`Standard`, and any the org adds; adding a policy re-runs `ensureAgentColumns`). Choosing a policy is the switch-on gesture — boards spec §17.2's "pick the policy in the same gesture". The sync loop reads it and calls the existing switch route (`POST /api/dispatcher/loads/:id/agent`) with `{ enabled, policyId }`, so the worker starts the trip exactly as it does from a board and the `LoadChange` row records source `sheet`. Typing `OFF` is the `stop` command. **We never write this cell.**

### 6.2 The status cell — `Night Shift status`

We write it; they may overwrite it; every write of ours is a full overwrite and the `Load` row remains the truth. Format:

```
● WATCHING — 40 mi out, ETA 10:20
● ASKED — stopped 25 min near Bethany, asked driver
● ESCALATED — stop unresolved after 2 calls, you were emailed 02:31
● SHADOW — would say: Hi Milan, this is the dispatch assistant for load 145219…
● ATTENTION — can't read DEL appointment: "08-15:00 fcfs?"
● DELIVERED 07/15/2026
```

The pill word in capitals from the §6.1 vocabulary plus `HELD`, then the latest `AgentUpdate.text`. The dot is coloured by conditional formatting installed once (grey / green / amber / red / blue, as the boards spec colours the pill). One cell, not two: it halves the writes and their sheet is already wide; splitting the pill into its own column later is a mapping change. Shadow shows `would say:` verbatim, so the proof of restraint is in the sheet where the buyer looks.

The cell carries a **note** (the Sheets cell comment) with the deep link for that load (§9.4). Hover, click, timeline.

### 6.3 The sync loop

`fleet-backend/src/lib/sheet/sync.ts`, run by the worker every 60 s per `connected` binding, **before** `syncPlatformLoads` (so a policy chosen in the dropdown starts its trip in the same tick) and before `applyPendingCommands`:

1. `readRows(ref, lastVersion)`. Unchanged sheet → skip to step 4.
2. For every row with a `loadRef`: build a `LoadPatch` from the mapping, upsert the `Load` by `(orgId, boardLoadNo)` through `applyLoadChange` with `source: "sheet"`. Only cells whose value differs from the mirrored value produce a patch, so a re-read of an unchanged row writes nothing.
3. Read the switch cell; if it differs from `Load.agentEnabled`/`agentPolicyId`, call the switch route.
4. For every `Load` in the binding whose `agentPill` or latest `AgentUpdate` changed since the last write (tracked as `Load.sheetStatusWrittenAt` vs `AgentUpdate.atMs`), and for every `Load` whose `extras`/mapped columns changed with `source: "board"` since the last sync, collect the writes.
5. One `writeCells` batch per binding per tick. Sheets API quota is 300 write requests per minute per project; one batch per customer per minute is safe to hundreds of customers per project, and the loop backs off to 5 minutes on a 429 and records `lastError`.

**Conflicts.** Our page and their sheet are both editable. Rule: last write wins per cell. Each `LoadChange` records its source; when a sheet write overrides a board edit made since the last sync (or the reverse), the drawer shows a one-line conflict note naming both values and where each came from, per boards spec §9.3. No merge dialogs.

**Row deleted in the sheet.** The `Load` is archived (`status = "archived"`), the trip stopped with a `stop` command, and an `AgentUpdate` line records "row removed from sheet". Never deleted — the audit trail outlives the row.

**Failure.** `readRows` or `writeCells` failing three ticks in a row sets `SheetBinding.status = "error"`, emails the dispatcher naming the error (token revoked, sheet deleted, quota), and puts `ATTENTION — sheet sync failed, see email` in every watched row's status cell on the next successful write. The worker keeps ticking the running trips: a sheet outage never blinds the agent, it only blinds the sheet.

## 7. Tenancy and telephony

### 7.1 Tenant = `Org`

Sign-up (`/signup`, existing) creates the `Org`, the first `Dispatcher`, the seeded `Standard` policy with `shadow: true`, and a `Plan` row:

```
Plan { orgId, tier ("sheet" | "tower"), loadNightCents Int?, messagingMarkup Float @default(1.5),
       dailyCommsCapCents Int @default(2000), createdAt }
```

`tier = "sheet"` hides the Control Tower navigation in the portal (§9.1). Unlocking it is a one-field change; no data moves.

### 7.2 Telephony per org

Replaces today's single global Twilio configuration in `night-shift/src/live/config.ts`:

```
OrgTelephony { orgId, provider ("ours" | "byo"), region ("US" | "intl"),
               smsSender String?, callerId String?, messagingServiceSid String?,
               tenDlcCampaignSid String?, tenDlcStatus ("none" | "pending" | "approved" | "rejected"),
               byoAccountSid String? (encrypted), byoAuthToken String? (encrypted),
               numberPurchasedAt, createdAt, updatedAt }
```

- **Default: ours.** On the first policy flipped to live, we buy one dedicated local number for the org from our Twilio account (≈ $1.15/month, charged to the wallet as `number_rent`). Dedicated, not pooled: drivers save the number, inbound SMS and calls route by `To` with no per-driver mapping, and one customer's spam complaint cannot poison a neighbour.
- **A2P 10DLC.** We register once as an ISV brand. At sign-up with `region = US` we file a campaign for the org under that brand ("dispatch notifications to consenting drivers", low-volume mixed use). Registration takes one to three days, so **going live is blocked while `tenDlcStatus != "approved"`**: the Settings page shows "SMS registration pending, usually 1–3 days; the driver link and voice work now". Voice does not need 10DLC, so rung 3 is never blocked. Shadow needs nothing.
- **International** (`region = "intl"`, e.g. Macedonia): an alphanumeric sender plus a verified caller ID, as `README-live.md` documents; no 10DLC; priced per destination (§8).
- **BYO.** A shop with its own Twilio and its own 10DLC pastes SID, token and number under Settings; we skip registration, rent and message metering (still metering `load_night`). Documented, not promoted; not on the ten-minute path.

### 7.3 The worker

`TwilioMessenger` and `TwilioPhone` are constructed per trip from the trip's org's `OrgTelephony` rather than from `config.twilio`; the Twilio webhooks (`/twilio/sms`, `/twilio/voice/…`) resolve `To` → `OrgTelephony` → org → trip. `config.ts` keeps `TWILIO_ACCOUNT_SID`/`AUTH_TOKEN` as *our* master account (used for `provider = "ours"`) and drops `TWILIO_FROM_NUMBER`/`CALLER_ID` in platform mode; file mode is unchanged. The ports do not change.

### 7.4 Isolation

Every new table carries `orgId`; every query is org-scoped; a binding, wallet or telephony row of another org is a 404, not a 403. The worker's per-tick loops iterate orgs and never hold one org's Prisma results while writing another's. The driver link token and the deep-link token (§9.4) both embed the org id and are verified against it.

## 8. Wallet and metering

### 8.1 The wallet

```
OrgWallet  { orgId (unique), balanceCents Int, currency "USD", lowWaterCents Int @default(1000),
             pausedForCredit Boolean @default(false), updatedAt }
WalletEntry { id, orgId, atMs BigInt, kind ("topup" | "load_night" | "sms" | "voice" | "number_rent" | "adjustment"),
              amountCents Int (signed), ref String? (AgentEvent id, Load id, Stripe payment id, Twilio sid),
              note String, createdAt }
```

`balanceCents` is derived from entries and cached in the same transaction. Every deduction has a `ref` to what caused it, so the Usage page can say *which text on which load* cost what. Top-ups are Stripe Checkout one-off payments; the webhook writes the `topup` entry.

### 8.2 What is metered, and where

All in the core, none in the sheet layer, so the boards' customers are metered identically the day they get a `Plan`:

- **`load_night`** — when a trip starts *live* (a shadow trip is free). One per load per calendar night in the org's timezone; a trip that crosses midnight is charged again at 00:00. Amount `Plan.loadNightCents`; when null (unpriced), the entry is written with amount 0 and note `unpriced`, so usage is visible before prices exist.
- **`sms` / `voice`** — a `MeteredMessenger` and `MeteredPhone` decorate the Twilio adapters behind the same `MessengerPort` / `PhonePort`. At send time they write an entry at the **estimated** list price for the destination region × `Plan.messagingMarkup`; Twilio's actual price arrives on the status callback and a nightly reconciliation writes an `adjustment` for the difference. The customer sees the estimate; rounding is ours. Voice is charged per started minute from the call's `duration`.
- **`number_rent`** — monthly, on the anniversary of `numberPurchasedAt`.
- **Mapbox** routing is not metered. Shadow mode therefore costs the customer nothing, which makes shadow the free trial by construction.

### 8.3 Guardrails

- Balance below `lowWaterCents` → one email; the agent continues.
- Balance ≤ 0 → `pausedForCredit = true`; every live policy behaves as shadow (`policy.shadow || wallet.pausedForCredit` at the ladder's send points); every watched row's status cell gets `ATTENTION — Night Shift paused: out of credit`; one email. Nothing dials on credit we do not hold. A top-up clears the flag automatically on the next tick.
- `Plan.dailyCommsCapCents` — the sum of `sms + voice` for the org in the org's calendar day. Reaching it degrades the org to shadow for the rest of the day and emails. It is a runaway brake, not a price tier; default $20.
- An org in `pausedForCredit` or over its daily cap still logs every `would say:` line, so the morning shows what it missed.

### 8.4 Usage page

Balance, a "top up" button (Stripe Checkout, fixed amounts), entries grouped by night and by load, and one plain sentence per night: "Last night: 6 loads watched, 14 texts, 2 calls — $X."

## 9. The hosted app

### 9.1 The portal under `tier = "sheet"`

The existing `fleet-portal`, with the sidebar reduced to **Board**, **Night Shift**, **Usage**, **Settings** when `Plan.tier = "sheet"`. Nothing is deleted; the Control Tower routes exist and are hidden, and `tier = "tower"` shows them all.

### 9.2 Board

`BrokerBoardView` / `BrokerGrid` as built, with the org's `BoardLayout` seeded from the sheet's header at connect time. Cell edits go through the existing cell-write route with `source: "board"` and the sync loop writes them to the sheet within a minute. The AGENT column is the existing pill + switch; the pill opens the existing `AgentDrawer`. The import and export buttons stay (export is their layout; import is how a customer without a cloud sheet still uses the product).

### 9.3 Night Shift → Connect

`NightShiftView` gains a first tab, **Connect**, five steps each with a default:

1. **Sign in with Google** — OAuth; we list their spreadsheets.
2. **Pick the sheet and the tab** — defaults to the most recently edited.
3. **Map the columns** — the proposed mapping as a two-column table (our key, their header, a dropdown to change), required keys marked, unmatched headers listed as "kept as extra".
4. **Contacts** — dispatcher email (pre-filled from sign-up) and phone; written into `Standard`. Timezone from the sheet's locale, editable.
5. **Install the two columns** — one button; shows the two headers that will be added and the dropdown values. Done: "Choose a policy in the Night Shift column on any row to start. Everything runs in shadow until you go live in Settings."

Re-mapping later is step 3 again. Disconnecting revokes our token, sets the binding `paused`, leaves the `Load` rows.

The **Policies** tab is the existing one.

### 9.4 The deep link

`/n/:orgToken/:loadId` renders the `AgentDrawer` full-screen for that load — timeline newest first, the buttons (*Call the driver now*, *I've got it* / *Hand it back*, *Stop*, *Send the customer email* when a draft exists, *Correct* on a classified reply, the reply box) — laid out for a phone, because that is where the dispatcher is when the escalation SMS arrives. `orgToken` is an HMAC over the org id with the org's own secret (rotatable in Settings), the same pattern as the driver link's `linkSecret`; it grants the drawer for that org's loads and nothing else. The same URL is in the status cell's note, the escalation email and the escalation SMS.

### 9.5 Settings

Telephony (§7.2: region, our number or BYO, 10DLC status), the shadow/live switch per policy with its confirmation sentence, the org secret rotation, and *Delete my data* (revokes the token, archives the loads, keeps the ledger for the legally required period, and says so).

## 10. The MCP server

`night-shift-mcp/`, a separate stateless package, published to npm, configured with the org's API key (an `OrgApiKey` row with role `nightshift`, §12, alongside the existing webhook-ingest key). Tools, each one HTTP call to an existing or §12 route:

| Tool | Route |
|---|---|
| `list_watched_loads()` | `GET /api/dispatcher/night-shift/loads` |
| `load_status(loadRef)` | `GET /api/dispatcher/loads/:id/agent` |
| `watch_load(loadRef, policy?)` | `POST /api/dispatcher/loads/:id/agent` |
| `stop(loadRef)` / `call_now` / `takeover` / `handback` / `reply(loadRef, text)` / `correct(loadRef, key)` | `POST /api/dispatcher/loads/:id/agent/commands` |
| `list_policies()` / `set_policy(name, patch)` | `GET` / `PUT /api/dispatcher/night-shift/policies` |
| `usage(range)` | `GET /api/dispatcher/night-shift/usage` |

No `sync_sheet` tool: sync is the worker's job and runs whether or not a chat is open; the tool that looks like it is `load_status`. No tool can flip shadow to live — that stays a click on a page with a confirmation sentence. Auth is the API key for this release; OAuth when the MCP authorization spec settles. Ships with a one-paragraph "add to Claude Desktop / Cursor" README.

## 11. Core versus sheet layer

The agreed engineering order stands and lands in the core; this spec adds a surface, not a fork.

| Work | Where | Sheet layer impact |
|---|---|---|
| Slice 1: platform GPS (`DriverLocation` as a ping source), rich brief (stop windows, dwell, notes, appointment text, contacts) | `night-shift/src/live/platformLoads.ts`, a `PlatformLocation` adapter, `Brief` | None. A sheet customer has no driver app, so their GPS still comes from the driver link; the rich brief fills from the mirrored `Load` columns automatically. |
| Itinerary (all breaks, fuel, live ETA) | `core/plan.ts` | The status line gets richer; no sheet change. |
| Multi-turn call with a model, trip summary | `core/`, `live/twilioPhone.ts` | Voice minutes metered by the same decorator. |
| Memory tables (place / driver / lane) | `fleet-backend` schema + `core/` | Fed by `Load`, `AgentEvent`, `DriverLocation`; sheet rows are `Load` rows, so they feed it too. |
| Policy profiles + preview call | `AgentPolicy`, `NightShiftView` | Policy names appear in the switch dropdown via `ensureAgentColumns`. |

Rule for reviewers: if a change under `fleet-backend/src/lib/sheet/` knows about a threshold, a rung, a classification or a phone, it is in the wrong place.

## 12. Data model and API summary

New tables: `SheetBinding` (§5.2), `Plan` (§7.1), `OrgTelephony` (§7.2), `OrgWallet`, `WalletEntry` (§8.1). New columns: `Load.sheetRowIndex Int?`, `Load.sheetStatusWrittenAt DateTime?`; `LoadChange.source` gains the value `"sheet"`. `Org.apiKey` becomes a small `OrgApiKey { orgId, role ("ingest" | "nightshift"), key, createdAt, revokedAt? }` table so the two roles do not share a key.

New routes, all under the dispatcher's auth, org-scoped, `asyncRoute`-wrapped, zod-validated:

- `GET/POST/DELETE /api/dispatcher/night-shift/sheet` — the binding; `POST …/sheet/oauth/start`, `…/oauth/callback`; `GET …/sheet/spreadsheets`, `GET …/sheet/tabs`, `GET …/sheet/header`; `POST …/sheet/mapping` (validated: required keys present, no header used twice); `POST …/sheet/install` (runs `ensureAgentColumns`); `POST …/sheet/sync-now`.
- `GET /api/dispatcher/night-shift/loads` — watched loads with pill and line (for the MCP list tool).
- `GET /api/dispatcher/night-shift/usage?from&to` — entries and the per-night sentence; `POST …/usage/topup` → Stripe Checkout URL; `POST /api/billing/stripe/webhook` (unauthenticated, signature-verified).
- `GET/PUT /api/dispatcher/night-shift/telephony`; `POST …/telephony/go-live` (buys the number, checks 10DLC status); `POST /twilio/*` webhooks route by `To`.
- `GET /n/:orgToken/:loadId` — the deep link (portal route; token verified server-side by `GET /api/n/:orgToken/loads/:id/agent`).

## 13. Honesty and permission rules

Carried from the boards spec §10, plus:

- The switch cell is theirs; we never write it. The status cell is ours; we always overwrite it whole.
- Shadow writes `would say:` into their sheet, so the buyer sees exactly what would have gone out before anything does.
- Going live is a click on a page with a sentence naming what changes; no tool, sheet value or API call can do it.
- Out of credit or over the daily cap degrades to shadow and says so in the sheet; it never fails silently and never dials on our money.
- We read only the mapped and extra columns of the one tab they chose, opened by the link they pasted (the `spreadsheets` scope, no Drive listing of their files at all); disconnecting revokes the token.
- A sheet outage blinds the sheet, not the agent: trips keep running on the platform record.

## 14. Testing

- **Connector suite** runs against `FakeConnector`, `GoogleSheetsConnector` (recorded fixtures of the Sheets API), and `GraphExcelConnector` (expected to fail as `not implemented` — the suite exists before the code).
- **Sync**: a fixture sheet → `Load` rows with the right patches; an unchanged sheet produces zero writes; an edit on the board reaches the sheet in one tick; a sheet edit reaches the board; a conflict produces one note naming both sources; a row without a load number is not mirrored and says so; a deleted row archives and stops.
- **Cells**: choosing a policy in the dropdown flips the switch through the traced route with source `sheet`; `OFF` stops; every pill state renders to its exact status-cell string; shadow lines start with `would say:`.
- **Tenancy**: two orgs, two bindings, two numbers — an SMS to org A's number never reaches org B's trip; another org's binding is a 404.
- **Metering**: a live trip start writes one `load_night`; a shadow start writes none; a sent SMS writes an estimate and the callback reconciles it; balance ≤ 0 makes the next ladder send a `would say:` line and writes the Attention status; a top-up resumes.
- **10DLC gate**: `go-live` refuses while the campaign is pending and says so.
- **MCP**: each tool calls exactly one route with the org's key; no tool can set `shadow: false`.
- **E2E (Playwright)**: connect the fixture sheet (Sheets API mocked at the HTTP layer), map, install, choose `Standard` on a row, see `● SHADOW — would say:` appear in the cell within one tick, open the deep link from the note on a phone viewport, press *I've got it*, see `HELD`.
- The agent's own tests are untouched; that is the fork check.

## 15. Build order

Each slice ships on its own and is demoable.

1. **Tenancy + telephony per org** — `Plan`, `OrgTelephony`, `OrgApiKey`; the worker constructs Twilio per trip; webhooks route by `To`; the `sheet` tier hides the Tower nav. Nothing user-visible yet, but every later slice depends on it. 3 days.
2. **Connector + binding + read-only sync** — Google OAuth, the Connect tab through step 3, rows mirror into `Load`, the board shows them; no cells installed yet. 4 days.
3. **The two cells** — `ensureAgentColumns`, the switch read, the status write, the note with the link, the deep link page. **This is the pitch: choose a policy in a cell, watch the status cell change.** 4 days.
4. **Two-way + conflicts + failure paths** — board edits back to the sheet, conflict notes, deleted rows, sync error handling. 3 days.
5. **Wallet + metering + guardrails + Usage page** — the decorators, the ledger, Stripe top-up, out-of-credit degrade, the cap. 4 days.
6. **10DLC + go-live** — ISV brand (one-off, ours), per-org campaign filing, the gate, number purchase. Calendar time dominated by Twilio's review, so start the brand registration on day one of slice 1. 2 days of code.
7. **MCP server** — in parallel from slice 3 onward, since its routes exist from then. 2 days.

Slice 1 of the *engineering* order (platform GPS + rich brief) is independent of all of this and can run alongside slices 1–2 here; it touches `platformLoads.ts` and a new `PlatformLocation`, which this spec does not modify.

## 16. Open points

- Whether the first customer's sheet has one tab per month (common) — the binding model allows several bindings per org, the Connect UI in this release exposes one. Decide when we see the sheet.
- Twilio's ISV 10DLC brand requires an EIN and a business address; that is a business task on the critical path, not an engineering one.
- Google OAuth app verification for the `spreadsheets` scope: the app can run as "unverified" for up to 100 users with a warning screen; verification should be filed at slice 2 and takes weeks.
- The Excel/Graph connector's delta semantics (workbook session vs. `driveItem` delta) are unresolved and deliberately out of scope.
- Prices: `loadNightCents` and `messagingMarkup` are fields; the numbers come after the first two live customers.
