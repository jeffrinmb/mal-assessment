# REJECTED

## Part 1: acceptance-criteria rulings

| # | Criterion (short) | Ruling |
|---|---|---|
| AC1 | Day 2 = −370.00 at end of Day 5, pre-fee | **Accepted** |
| AC2 | E7 causes exactly one fee, on Day 2 | **Rejected** |
| AC3 | Auth-A's Day 4 settlement must be accepted | **Accepted** |
| AC4 | Unknown-auth settlements rejected; funds don't leave | **Partly rejected** |
| AC5 | Approved Auth-B hold reduces available, not ledger | **Accepted** (vacuous in-stream) |
| AC6 | After E9, balances and fees return to pre-E7 | **Rejected** |
| AC7 | Each E10 instalment is BHD 3.334 | **Rejected** |
| AC8 | Rounding remainder is discarded | **Rejected** |

The evidence for each ruling is printed at the bottom of `npm run replay` and pinned by a same-named test in `test/scenario.test.js`.

---

### AC2: rejected. E7 causes three fees, not one.

E7 is value-dated Day 2. So it lowers every day from Day 2 onward, not just Day 2. As known at the end of Day 5 (AED):

| Value day | Before fee | Fee? | After fee |
|---|---|---|---|
| 2 | 250.00 − 620.00 = −370.00 | yes | −395.00 |
| 3 | −395.00 + 400.00 = 5.00 | no | 5.00 |
| 4 | 5.00 − 185.00 = −180.00 | yes | −205.00 |
| 5 | −205.00 | yes | −230.00 |

Without E7, Day 4 would have closed at 465.00 and Day 5 at 465.00. None of the three fees would exist. So E7 causes three fees (value days 2, 4 and 5), all booked on Day 5.

Day 3 escapes only because of the cascade: without the Day 2 fee, Day 3 would be 30.00. A fee above 30.00 would make it four fees (NUMBERS.md).

### AC4: partly rejected. "Funds must not leave the account" is accepted; "must be rejected" is refused.

- **Accepted part:** the customer's account is not debited for Auth-Z. The customer never authorized it, and debiting it would have taken Day 4 to −335.00 before fees, as known at the end of Day 5.
- **Refused part:**
  1. **"Rejected" assumes the money can be refused.** By the time a card settlement arrives, the scheme has already settled with the acquirer. The issuer's funds have left the bank whatever the ledger does. Dropping the record would leave the bank with a real cash movement and no accounting entry: an unreconciled break, and a lost claim for chargeback. So the settlement is recorded against an internal suspense account (`SUSPENSE-AED`, −180.00), with `ERROR UNMATCHED_SETTLEMENT`, for operations to match, charge back, or force-post after investigation.
  2. **"Not present in the ledger" is a category error.** An authorization is not a ledger entry: it moves no money and only reserves it. In this design authorizations live in their own log, and the settlement is matched against that log.
  3. **"Any" is too broad.** Real orphans include auths that have expired and been purged, offline or below-floor-limit transactions that never had an online auth, and auth-ID mismatches from the scheme. Several of these are ones the bank is contractually obliged to pay. A blanket rule is wrong. The right rule is to hold in suspense and resolve each case.

### AC6: rejected. Balances and fees do not return to their pre-E7 values.

1. **Fees:** the three fees are ledger entries and the ledger is append-only. They cannot "return". They could only be offset by compensating `FEE_REVERSAL` entries, and the brief defines no refund rule (AMBIGUITIES #6). After E9, AED 75.00 of fees remain.
2. **Balances:** restated after E9, the balances are 250.00 / 225.00 / 625.00 / 415.00 / 390.00 (Days 1–5). Pre-E7 they were 250.00 / 250.00 / 650.00 / 465.00 / 465.00. Every day from Day 2 onward is lower by the fees charged up to that day.
3. **Decisions don't return:** Auth-B was declined on Day 5 against an available balance that E7 had pushed down. Reversing E7 does not un-decline it. This path dependence is inherent: a restatement changes balances, not decisions already made on them.
4. **Interest:** accruals for Days 2–5 were cut to zero on Day 5, then re-accrued on the post-fee balances on Day 6. The capitalized total is 0.93. Without E7 and E9 it would have been 1.03 (0.10 + 0.10 + 0.26 + 0.19 + 0.19 + 0.19). The 0.10 gap is interest lost on the fees.

Even with automatic fee refunds, the criterion would still be false on the Auth-B decision and on the extra ledger entries.

### AC7: rejected. Three instalments of 3.334 total 10.002 BHD.

3 × 3.334 = 10.002, which is 0.002 BHD more than the credit. Money would be created from nothing. BHD's three decimals cannot split 10.000 into three equal parts. Conservation beats equality: the ledger posts **3.333 / 3.333 / 3.334**, which sums to 10.000 exactly, with the extra fil on the last instalment (`splitExactly`).

### AC8: rejected. It contradicts a non-negotiable rule.

The brief requires that "the rounded daily accruals must sum exactly to the capitalized total." AC8 describes what to do when they don't, and resolves it by discarding money. That is an unreconciled leak: the customer's statement shows accruals that were never paid, or a payment that doesn't match its accruals. The design makes the situation impossible instead. The capitalized amount is *defined* as the sum of the rounded daily records. `#capitalize()` recomputes the per-day targets and throws if they differ, and the report prints the reconciliation (`OK`).

### Accepted, with notes

- **AC1:** entries with value_date ≤ Day 2, booked by the end of Day 5, excluding fees: 1,200.00 − 950.00 − 620.00 = **−370.00**. Correct. It is also the first place the brief requires a bitemporal query.
- **AC3:** Auth-A was approved (available 50.00 after the hold), and 185.00 ≤ 200.00. The authorization is the bank's permission, and settlement does not re-check the balance. That matters, because in the restated view the settlement drives Day 4 to −180.00 *and it should still be accepted*. The remaining 15.00 is released.
- **AC5:** correct as an invariant, and proven by a synthetic test (`invariants.test.js`). In the stream, Auth-B is **declined** (available after the hold would be −295.00), so the condition never fires. I accepted it rather than rejecting it: a conditional with a false premise is still a correct statement of hold semantics. The trap is to assume Auth-B was approved.

---

## Approaches abandoned mid-build

Only things actually tried or written during the build are listed. Design alternatives settled in the pre-build brainstorm are in AMBIGUITIES.md instead.

1. **`node --test test/` (directory argument).** It failed at the first run: Node reported one opaque failure instead of discovering the files. I replaced it with glob patterns (`"test/**/*.test.js"`) and raised the engine floor to Node 22.
2. **The first version of the accrual loop's skip conditions.** It used two chained `continue` guards that mixed up "past day whose target hasn't moved" with "today's accrual is zero". Depending on the day, a zero accrual on the current day was either recorded or silently dropped, so the daily report would have been inconsistent. I rewrote it before the first run as a single explicit rule: today always gets a `DAILY` record, and a past day gets an `ADJUSTMENT` only if its target moved.
3. **A hard-coded `LAST_DAY` inside the ledger.** It was abandoned when a hold-expiry test failed. The test assumed a Day-1 hold would expire by the close of Day 6, but with a 7-day expiry the earliest expiry is the close of Day 7. So the expiry path could not be tested, and never runs in the brief's window. The window end became a constructor option (defaulting to 6). A new test pins the fact that expiry is unreachable inside the window.
4. **Treating `availableOn(account, day)` as a bitemporal query.** I wrote it with a `day` parameter on the assumption that it could answer "available as of day N". While writing the known-failing test I found that only the ledger half honours `day`. Hold state is "as of now". Rather than patch it quietly, I kept it as the documented failing test, because the fix (hold state derived from the log plus an as-of day, and a scheduler for expiry) is a design change, not a bug fix.
