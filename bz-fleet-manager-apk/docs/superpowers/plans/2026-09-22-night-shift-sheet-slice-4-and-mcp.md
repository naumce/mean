# Night Shift in the Sheet — Slice 4 (two-way) + MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Board edits flow back into the customer's sheet, deleted rows archive their load and stop the agent, a sheet outage emails the dispatcher, our own writes stop re-triggering reads, and the MCP server lets a dispatcher drive Night Shift from Claude/Cursor with an org API key.

**Architecture:** Everything sits on the existing sync tick. Write-back is one more pass after the status pass, driven by `LoadChange` rows of board sources newer than a per-binding high-water mark; conflicts are decided by whether the board's value survived this tick's row pass (sheet wins ties). Vanished rows already lose `sheetRowIndex`; they now also archive and stop. The worker emails on a binding flipping to `error`. The connector's content digest becomes a shared function so the status pass can pre-compute the digest the sheet will have after our own writes. MCP is a separate stateless package calling the backend with an `OrgApiKey`.

**Tech Stack:** Express 4, Prisma 5, zod, vitest/supertest; night-shift worker (nodemailer already there); `@modelcontextprotocol/sdk` for the MCP package.

**Spec:** `docs/superpowers/specs/2026-09-19-night-shift-as-a-product-design.md` §6.3 (conflicts, deleted rows, failure), §10 (MCP), §12 (`OrgApiKey`), §13.

## Global Constraints
- No git commits/add by implementers (the controller commits). Never read `.env`.
- Every Load write through `applyLoadChange`/`applyStatusChange`/`applyAgentSwitch`; every handler in `asyncRoute`; zod bodies; org-scoped; 404 not 403.
- Nothing under `fleet-backend/src/lib/sheet/` knows thresholds/rungs/classifications/phones. We never write the switch cell.
- No MCP tool can enable/disable the agent's live mode or edit a policy's `shadow`.
- Checks per task: `cd fleet-backend && npx vitest run tests/sheet tests/night-shift-routes.test.ts && npx tsc --noEmit`; night-shift `npm test && npm run typecheck` when touched; portal `npx vitest run src/nightshift && npx vue-tsc --noEmit -p tsconfig.app.json` when touched. Full backend suite once at the end of each task that touches `src/`.

## File Structure
Created: `fleet-backend/src/lib/sheet/writeBack.ts` (+test), `fleet-backend/src/lib/sheet/digest.ts`, `night-shift/src/live/sheetAlerts.ts` (+test), `fleet-backend/src/lib/apiKeys.ts` (+test), `fleet-backend/src/middleware/apiKeyAuth.ts`, `fleet-backend/src/routes/dispatcherApiKeys.ts` (+test), `night-shift-mcp/` (package.json, `src/index.ts`, `src/tools.ts`, `README.md`, tests), migration `<ts>_sheet_two_way_and_api_keys`.
Modified: `sync.ts`, `statusPass.ts`, `googleConnector.ts`, `fakeConnector.ts`, `connector.ts`, `dispatcherSheet.ts`, `schema.prisma`, `worker.ts`, `app.ts`, portal Settings tab (API key card).

---

### Task 1: Shared digest + post-write version capture
**Files:** create `src/lib/sheet/digest.ts` (`digestOf(values: string[][]): string` = sha256 of JSON); modify `googleConnector.ts`, `fakeConnector.ts` to use it; `statusPass.ts` returns the rows as they will read after our writes; `sync.ts` stores `lastVersion = digestOf([header, ...rowsAfterWrites])` when the status pass wrote cells (only when the digest algorithm and range match what `readRows` hashes — make `readRows` hash exactly `[header, ...rows]` so both sides agree; document).
**Tests:** after a tick that writes status cells, the next tick with an unchanged sheet reports `changed: false` and does no row pass; a human edit between the ticks is still detected.

### Task 2: Board → sheet write-back with conflicts
**Schema:** `SheetBinding.boardSyncAtMs BigInt @default(0)`.
**Files:** create `src/lib/sheet/writeBack.ts`: `collectBoardEdits(orgId, sinceAtMs, mapping, header)` reads `LoadChange` rows with `source IN ('board','paste','loadboard')`, `atMs > since`, `field` in the reverse map of mapped keys (`boardLoadNo→loadRef`, `driverCell→driverPhone`, `carrierContactName→driverName`, `stops.pickup`/`stops.delivery` → pickup/delivery (the writer's field names — read `loadWriter.ts` for the exact `field` strings), `apptText→appointment column(s)`, `customerEmail`, `carrier.name→carrierName`, `carrierPhone`, `revenueCents→rate` (render as `$x,xxx.xx`), `updateText→notes`, `extras.<header>` → that header) for loads with `sheetRowIndex != null` in this binding. For each edit: if the Load's CURRENT value still equals the edit's `after` (it survived this tick's row pass) → a `CellWrite` at the load's row (bottom row for the bottom-owned keys when `rowsPerLoad === 2` and the pair has a bottom — `foldPairs` must expose `hasBottom` per virtual row); else → an `AgentUpdate` kind `status` text `conflict: sheet has "<sheet value>", board tried "<board value>" — sheet kept` and no write. Never write the switch or status columns through this path. One `writeCells` batch, then `boardSyncAtMs = max atMs seen`.
**sync.ts:** run after the status pass, only on ticks where the sheet was read (changed or not — board edits must reach the sheet even when the sheet is idle: on an unchanged tick use the previous fold's row indexes from the DB).
**Tests:** a board cell edit reaches the sheet cell next tick; a two-row binding writes carrier phone to the bottom row; a same-tick sheet edit of the same cell produces the conflict line and leaves the sheet's value; the switch/status columns are byte-identical; `boardSyncAtMs` advances; an idle sheet still receives the edit.

### Task 3: Deleted rows archive and stop
**Files:** `sync.ts` `forgetVanishedRows` → also `applyStatusChange(... status "archived", note "row removed from sheet")` when the load is not already archived/delivered, queue an `AgentCommand` `stop` when `agentEnabled`, and an `AgentUpdate` kind `status` "row removed from sheet". Duplicated refs (both rows present) do NOT archive — only unlink (existing behaviour).
**Tests:** delete a row → load archived, stop queued, line written, row never written again; duplicate → unlinked only; re-adding the row with the same LOAD# → un-archives? RULING: no — a new row with an archived load's number creates NOTHING and gets `● ATTENTION — load <ref> is archived; use a new number` (add the aspect representative `archived load: "x"`).

### Task 4: Sync-failure email (worker)
**Files:** create `night-shift/src/live/sheetAlerts.ts`: after `syncAllSheets()`, for each binding whose `status` is `error` and whose `lastError` differs from what was emailed last (in-memory map + `SheetBinding.alertedError String?` column so a restart doesn't re-email), send one email via the worker's `SmtpMailer` to the org's Standard policy `dispatcherEmail`: subject `Night Shift: your sheet stopped syncing`, body naming the sheet title/tab, the error in plain words (token revoked → "Google access was removed — open Night Shift → Connect and sign in again"; 429 → "Google rate limit, retrying"), and the Connect page link (`PORTAL_URL/night-shift?tab=connect`). When status returns to `connected`, clear `alertedError`.
**Tests:** fake mailer records one email per distinct error; restored binding clears; no email while `connected`.

### Task 5: Org API keys + MCP server
**Schema:** `OrgApiKey { id, orgId, role ("ingest"|"nightshift"), keyHash, prefix (first 8 chars), name, createdAt, revokedAt? }`. Keys shown once; stored hashed (sha256). Migrate the existing `Org.apiKey` webhook key into a row with role `ingest` (keep the old column read path working until the webhook router is switched — do switch it in this task and drop the column).
**Backend:** `src/lib/apiKeys.ts` (`issueKey`, `verifyKey`), `src/middleware/apiKeyAuth.ts` (`x-api-key` → `req.orgScope` like the session does, role check), routes `GET/POST/DELETE /api/dispatcher/night-shift/api-keys` (+ `GET /api/dispatcher/night-shift/loads` listing watched loads, and `GET .../usage` returning `{ nights: [] }` placeholder with a comment that the wallet is the next plan). The dispatcher routes the MCP needs accept EITHER a bearer session OR an `x-api-key` with role `nightshift`; the key can never hit `PUT /night-shift/policies/:id` with `shadow: false` (reject 403 with message) nor the sheet OAuth routes.
**Portal:** Settings tab gets an "API keys" card (create with a name → show once, list with prefix/created, revoke).
**MCP package** `night-shift-mcp/`: `@modelcontextprotocol/sdk` stdio server; env `NIGHT_SHIFT_URL`, `NIGHT_SHIFT_API_KEY`; tools exactly: `list_watched_loads`, `load_status(loadRef)`, `watch_load(loadRef, policy?)`, `stop(loadRef)`, `call_now(loadRef)`, `takeover(loadRef)`, `handback(loadRef)`, `reply(loadRef, text)`, `correct(loadRef, key)`, `list_policies`, `set_policy(name, patch)` (patch may not contain `shadow`), `usage(range?)`; each resolves `loadRef` → load id via the watched-loads list or a `GET /api/dispatcher/loads?ref=` lookup (add if absent). README: add to Claude Desktop / Cursor config. Tests: each tool → exactly one HTTP call with the right method/path/body (mock fetch); `set_policy` with `shadow` refuses locally.

### Task 6: Verification
Full suites; ledger; controller commits and pushes (no deploy).
