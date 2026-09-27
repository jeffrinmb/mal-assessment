# WORKLOG

Times are local (IST, UTC+05:30), taken from the machine clock while the work happened.
Tooling: Node.js 24, no dependencies. Built as a pairing session with Claude Code (AI
assistant). The design decisions come from a brainstorming session held earlier the same
morning (10:17–11:06). This log records what happened, including dead ends.

| Time  | Entry |
|-------|-------|
| 10:17 | Brainstorming session on the brief: question storming, reversing assumptions in the acceptance criteria, worst-possible-idea, Disney method for Part 2. |
| 11:06 | Brainstorm closed. Decisions: a bitemporal two-column report, suspense handling for Auth-Z, integer minor units, and fees idempotent per (account, value day). Still open: what happens to Auth-A's leftover hold, the fee/interest order, replay order, rounding mode, and the back-value window N. |
| 11:12 | Checked the toolchain. There is no Python on this machine. Node 24 is available, so I chose JS with BigInt minor units and `node:test` (zero dependencies, runs anywhere Node runs). |
| 11:16 | `git init`. Scaffolded `package.json` and `src/money.js` (parse, format, half-even division, exact split). |
| 11:18 | `node --test test/` failed: Node treated the directory argument as a single file and reported one failure with no useful detail. I switched the scripts to glob patterns, which need Node 21 or later. Money tests are green (5/5). |
| 11:18 | Settled the brainstorm TODOs before writing the core. (1) Auth-A's leftover 15.00 is released on settlement (single-settlement model). (2) Fees are assessed before interest at each close. (3) Replay is strict list order with a forward-only clock, so E10 is a late arrival. (4) Rounding is HALF_EVEN. (5) Back-value window N = 5. |
| 11:19 | Wrote `src/ledger.js`. Private fields keep state encapsulated, every record is frozen, and balances are always derived. Before the first run I rewrote the skip conditions in the accrual loop: the first version mixed up "past day unchanged" with "today's accrual is zero", so a zero accrual on the current day would have been dropped for some days and not others. |
| 11:20 | First replay. Output matched the hand trace from the brainstorm: fees at D2, D4, D5 (booked Day 5), Auth-B declined at -295.00, restated D2 = 225.00, final 390.93, interest 0.93 AED and 0.008 BHD. |
| 11:21 | Committed the core and the replay separately. Fixed column width for the INT-* refs in the report. |
| 11:24 | Wrote the scenario tests (one per acceptance criterion) and the invariant tests (synthetic cases). |
| 11:25 | One test failed, and the test was wrong. It expected a hold placed on Day 1 to expire at the close of Day 6. With `HOLD_EXPIRY_DAYS = 7` and release at the close of authDay+6, the earliest expiry is the close of Day 7. **No hold can ever expire inside the six-day window**, so the expiry code is unreachable from the brief's stream. Made `lastDay` a constructor option (default 6) so the expiry path can be tested, and added a test that pins the unreachability. 30/30 green. |
