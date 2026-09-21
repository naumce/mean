# Night shift

## MODE — platform vs file

`MODE` in `.env` picks which loads the worker watches:

- **`MODE=platform`** (default — leave it unset). Every 60 s the worker reads
  every `Load` a dispatcher has switched on (the board's Night Shift switch),
  builds a brief from it, and starts a trip under its policy. It also applies
  supervision commands from the drawer (stop, takeover, hand back, reply,
  correct, call, send the customer email) and removes trips whose load was
  switched off or delivered. No file argument; no single driver/dispatcher —
  every trip's contacts and policy come from its own load and `AgentPolicy`
  row. `DATABASE_URL` must point at the **same** database `fleet-backend`
  uses (`fleet` on :5434 in dev) — this is where `Load`, `AgentPolicy` and
  `AgentCommand` live; a night-shift-only database has none of them.
- **`MODE=file`** — the original single-load run described below, unchanged:
  one JSON file on the command line, one driver, one dispatcher, always live.

## Before the first run (once)
1. `npm install` in `night-shift/`.
2. Fill `night-shift/.env` (copy `.env.example`). Twilio SID/token/number, Gmail user + App Password, your phone as DRIVER_PHONE, your inbox as DISPATCHER_EMAIL. MAPBOX_TOKEN and LINK_SECRET are already filled.
3. In the Twilio console, enable Geo Permissions for your driver's country under Messaging → Settings and Voice → Settings.
4. `cd fleet-backend && npx prisma migrate deploy` (the AgentTrip/AgentEvent tables).

## No Twilio number yet? (this is the better setup for a Macedonian phone anyway)
Macedonian carriers do not deliver SMS from international long codes — a US number would arrive "best effort" with the sender replaced. Twilio's guidance for Macedonia is an alphanumeric sender, and it needs no number purchase and no verification wait:
1. `.env`: `TWILIO_FROM_NUMBER=NIGHTSHIFT` (1–11 letters/digits/spaces).
2. Twilio console → Phone Numbers → Manage → Verified Caller IDs → add the phone the call should come FROM (any phone you can answer a verification code on). Put it in `.env` as `TWILIO_CALLER_ID=+389…`.
3. Skip the SMS webhook step below: an alphanumeric sender cannot receive replies. The driver answers on the page, which is the primary channel anyway; the rung-2 SMS still goes out (one-way, with the link).
4. If the caller ID and the driver phone are the same handset, the call is your phone calling itself — some carriers refuse that. Use a second phone for one of the two if you can.

## Demo speed
`NIGHT_SHIFT_TIME_SCALE=0.2` in `.env` runs the stop rule and the ladder five times faster: question at 3 minutes stopped, again at 5, call at 8, retry at 9, escalation (email + boss call) at 10. Delay, gone-dark and off-route keep their real minutes. The worker logs `timeScale` at startup. Remove it for a real drive.

## Every run (MODE=file)
1. `.env`: `MODE=file`.
2. Terminal A: `npm run night:tunnel` — copy the `https://….trycloudflare.com` URL it prints.
3. Put it in `.env` as `PUBLIC_URL=` (no trailing slash). The tunnel URL changes every time you start it.
4. Twilio console → your number → Messaging → "A message comes in": Webhook, `https://….trycloudflare.com/twilio/sms`, HTTP POST. (Voice needs no console setting — the worker tells Twilio what to say per call.)
5. Edit `loads/test-drive.json`: origin = where you are, destination = 20–40 minutes away, `deadlineAt` tight enough to be late if you dawdle.
6. Terminal B: `npm run night:start -- loads/test-drive.json`. It prints the driver link; your phone gets it by SMS within seconds.

## Every run (MODE=platform)
1. `.env`: `MODE=platform` (or leave it unset). `DATABASE_URL` points at the fleet database; the switch is flipped on a load from the Control Tower or the Broker Board.
2. `npm run night:start` — **no file argument**. It logs `"night-shift worker polling the board"` and, within one poll (60 s), starts a trip for every switched-on load it can resolve a brief for.
3. A load it cannot resolve (no phone, an appointment that did not parse, a stop that did not geocode) gets pill `Attention` and one line naming what is missing, and is retried every poll — nothing more to do on the worker side; fix the row and it picks it up on the next pass.

## What you will see
- Phone: the SMS with the link → tap → **Accept** → "Sharing location · last sent HH:MM". Leave the tab open in the foreground; iOS suspends background tabs and the agent will honestly report *gone dark*.
- Drive. Stop somewhere for 15 minutes → the page shows *"You've been stopped 15 min near …, everything OK?"* Reply in the box (or by SMS to the Twilio number) — "bathroom" → *"Got it, thanks."*
- Ignore the next question → 10 min later it asks again → 15 min later **your phone rings** and the agent speaks. Say anything, or don't answer.
- Your inbox: the escalation email with the whole ladder and a one-click link. If `DISPATCHER_PHONE` is set, that phone rings right after with a spoken briefing (load, driver, reason, last position) and hangs up — it does not listen. Tap it: the customer email goes (to the address in the load, or nowhere if null).
- Arrive: on time → nothing more; late → an email to you with the arrival note drafted.
- Terminal B: every event as a JSON line; the "sheet row" lines are what the SharePoint row will say once that plan lands.

## Changing what the agent hears
`library/situations.md` is the source of truth — the classifier's table is generated from it.

1. Edit the notebook: add phrasings under *Driver says* (freely), or under *Agent listens for* (carefully — a common word drags in sentences that are not that situation).
2. `npm run library:compile`. It rewrites `src/core/situations.data.ts`, prints how much of the corpus each block hears, and lists every proposed block whose phrasings currently land somewhere else.
3. `npm test`. The build fails if the notebook and the generated table disagree, if a phrasing lands in the wrong block, or if a level-3 block forgets to ask whether the driver is safe.

A new block is inert until a human changes its `Status: proposed` to `approved` — writing it down never switches it on. Test lines naming a proposed block are reported as waiting, not failed.

## Known limits of this slice
- No sheet (MODE=file): rows go to the log. MODE=platform writes real pill/`AgentUpdate` rows instead.
- Chat is in memory: restarting the worker loses undelivered chat (the event log still has it).
- A voice call blocks that trip's tick for up to 90 s. One trip at a time is the design point here.
- The tunnel URL changes per run and Twilio's SMS webhook must be updated to match. A fixed hostname is a hosting decision.
- MODE=platform's writes to `Load.agentPill`/`AgentUpdate` are plain Prisma writes, not through `fleet-backend`'s traced writer (`applyLoadChange`) or its realtime layer (`emitLoadChanged`) — this task's brief keeps the worker to `db.js` only. Each write bumps `Load.version` so an open board's echo guard still accepts the next frame it DOES see, but there is no live push for these writes and no `LoadChange` audit row for them; a board only shows the new pill/line on its next reload or poll. See `task-4-report.md`.

## Troubleshooting
- If the worker seems to pick up `fleet-backend`'s database or Mapbox token instead of this package's: importing `mapboxRouter.ts` pulls in `fleet-backend`'s Prisma client, which loads `fleet-backend/.env` as a side effect — but `node --env-file=.env` sets `night-shift/.env` first and dotenv never overrides an already-set variable, so `night-shift/.env` always wins.
