# SDD ledger — plan: (none; ad-hoc work under "finish what is missing")

Carrier commission / statements, plus the live pass over the Money view.

## Live pass finding: a $450 invoice error from one millisecond

Found by opening the page, not by any test. The UI read $777 where an API call
minutes earlier had said $1,227 for the same intended period.

Cause: `carrierStatements.ts` ceilinged the RAW MILLISECOND span into weeks.
"The last 7 days" built from two Date.now() calls is 7 days + 1 ms, which
ceilings to TWO weeks. Two trucks at $225/wk = $450 of error on a real invoice,
appearing and disappearing with timestamp jitter.

Ruling: the week rule moves into `commission.ts` as the exported `weeksInSpan`;
`carrierStatements.ts` calls it. My first regression test RESTATED the formula
instead of importing it — a copy of the implementation cannot catch the
implementation drifting, the same "one definition per concept" fault behind
most defects on this branch. Rewritten to call the real export.

## Second finding, same class, one layer down

The two callers disagree about what a range MEANS. The default period sends an
exact 7.000-day span; the date pickers send an inclusive end-of-day, so seven
picked calendar days arrive as 6.99999 days. Flooring bills eight picked days
as ONE week; ceiling bills the default seven as TWO. Rounding to whole days is
the only rule under which both conventions agree, since each is within a
millisecond of a whole day.

Ruling: `Math.round` on the day count, then ceil to whole weeks (a carrier
dispatched three days still owes the week).
Cost if wrong: a half-day span — which neither caller produces — rounds up.

## Verification

- Discrimination proofs, both directions:
  ceil-on-ms -> "expected 2 to be 1" (the double-bill)
  floor      -> "expected 1 to be 2" (the picker under-bill)
- Backend 781 tests / 111 files pass; portal 759 pass; tsc + vue-tsc clean.
- Live, against the running server:
  default "last 7 days" x3  -> $777.20, Ozark 2 tw (stable across jitter)
  picker 7 calendar days    -> $777.20, Ozark 2 tw (conventions agree)
  picker 8 calendar days    -> $1227.20, Ozark 4 tw (the $450 now earned)
- Browser, three fresh mounts of /money: $777 each, no console errors.

## Environment hazard noted, NOT changed

Two servers listen on port 3001: this backend on the wildcard bind, and an
unrelated Fastify app from E:\jarvis on 127.0.0.1 specifically. curl resolves
localhost to IPv4 and reaches jarvis; the browser resolves to IPv6 and reaches
this backend. Same URL, different servers, decided by resolution order. The
portal's VITE_API_URL is http://localhost:3001/api. Left alone — jarvis is the
user's other project and not mine to kill — but it is a coin flip on restart.
