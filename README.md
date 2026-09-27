# ledger-core

An in-memory, append-only, value-dated account ledger. It has no web layer, persistence, UI or database, and no dependencies.

## Run it

Needs Node.js 22 or later (the test globs need Node 21+).

```bash
npm run replay          # replay the event stream and print the daily report
npm test                # main suite, 30 tests, all green
npm run test:failing    # the one deliberately failing test (see below)
```

Without npm: `node src/replay.js` and `node --test "test/**/*.test.js"`.

## Layout

| Path | What it is |
|---|---|
| `src/money.js` | Integer minor units (BigInt), parse/format, half-even division, exact n-way split |
| `src/constants.js` | Every tunable number. Rationale is in [NUMBERS.md](NUMBERS.md) |
| `src/ledger.js` | The ledger: append-only records, derived balances, auths, fees, interest, day close |
| `src/events.js` | The brief's accounts and event stream, in replay order |
| `src/replay.js` | Replay driver (forward-only day clock) and the report printer |
| `test/` | `money`, `scenario` (one test per acceptance criterion) and `invariants` (synthetic cases the stream never exercises) |
| `known-failing/` | The failing test against this design, with inline annotations |

## Reading the output

The report has four parts.

**1. One block per day close (Day 1 to Day 6).** The figures are what the ledger knew when that day closed.

- `closing ledger balance`: the sum of entries with `value_date <= day`.
- `active holds` / `available balance`: available is the ledger balance minus active holds.
- `postings booked today`: every entry booked that day, with its value day. A value day earlier than the booking day means a backdated entry.
- `fee assessments`: fees booked today. Fees marked `(retroactive)` belong to an earlier value day that a backdated entry pushed negative.
- `interest accruals`: `day N` is today's accrual. `adj day N` is an adjustment for an earlier day whose balance was restated.
- `Authorizations`: the state of every auth. `<- today:` shows transitions that happened that day.
- `Errors / warnings`: `ERROR` means the event was not applied to the customer, for example an unmatched settlement parked in `SUSPENSE-AED`. `WARN` means it was applied or recorded but needs attention (declined auth, late arrival).
- The internal `SUSPENSE-AED` account appears once it has a balance.

**2. Bitemporal closing balances.** For every value day there are two columns:

- `as-known-then`: entries booked by that day's close.
- `as-restated`: all entries booked by the end of Day 6.

`*restated` marks days that backdated entries changed. This table is the evidence for the AC1, AC2 and AC6 rulings in [REJECTED.md](REJECTED.md).

**3. Interest reconciliation.** Net accrual per value day, their sum, and the capitalized credit. `OK` means they are equal to the minor unit.

**4. Acceptance-criteria evidence.** The figures each ruling in REJECTED.md depends on.

## Headline results

| | ACC-001 (AED) | ACC-002 (BHD) |
|---|---|---|
| Final closing balance, Day 6 | 390.93 | 10.008 |
| Overdraft fees | 3 × 25.00 (value days 2, 4, 5; all booked Day 5) | none |
| Interest capitalized | 0.93 | 0.008 |
| Auths | Auth-A SETTLED 185.00 (15.00 released); Auth-B DECLINED; Auth-Z unmatched, so 180.00 went to suspense | – |

## The failing test

`known-failing/hold-clock.failing.js` asserts that a hold placed on Day 5 no longer blocks funds on Day 12. It fails because this design has no clock. Hold state changes only through events and day closes, and `availableOn(account, day)` applies `day` to the ledger balance but not to holds. The annotations in the file explain what it reveals and the fix.

## Other documents

- [NUMBERS.md](NUMBERS.md): every constant, why that value, and why not half of it.
- [AMBIGUITIES.md](AMBIGUITIES.md): every ambiguity found and how it was resolved.
- [REJECTED.md](REJECTED.md): the acceptance criteria refused, with reasons, and the approaches abandoned mid-build.
- [WORKLOG.md](WORKLOG.md): a timestamped log of the build.
- [DESIGN.md](DESIGN.md): Part 2, architecture, trade-offs and production considerations.
