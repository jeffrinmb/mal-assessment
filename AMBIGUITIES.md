# AMBIGUITIES

Every place where the brief could be read more than one way. Each entry gives the readings considered, the one chosen, and where the choice lives in code or tests. They are grouped by topic, not ordered by importance.

---

## A. Time: booking day vs value day

### 1. Which "Day N closing balance"?
A backdated entry makes "the Day 2 closing balance" mean two different things: what was known at the end of Day 2 (250.00), or Day 2 as restated after later bookings (−370.00 at the end of Day 5, 225.00 at the end of Day 6).
**Resolved:** both are reported. The per-day blocks show the balance **as known then**, and the bitemporal table shows **as-known-then** next to **as-restated**. `Ledger.balance(acc, valueDay, { bookedThrough })` gives any point on either axis. AC1's wording ("evaluated at end of Day 5") only makes sense under this model.

### 2. What is "the day assessed" for a retroactive fee?
The fee is "booked with value_date equal to the day assessed". That could mean the day whose balance was negative (Day 2), or the day the assessment ran (Day 5).
**Resolved:** value_date = the day whose balance was evaluated. booking_day = the day the ledger discovered it. Dating the fee to Day 5 would charge a Day-2 overdraft against Day 5's balance and move Day 3 and Day 4 onto a different fee path.

### 3. When is a retroactive fee assessed: at once, or at the next close?
E7 (booked Day 5) makes Days 2 and 4 negative. Those days are already closed.
**Resolved:** at once. The moment an entry lands in a closed day, the fee rule re-runs for all closed days (`#afterPosting`). Today's own fee waits for today's close. This is visible in the output: Auth-B, later on Day 5, sees available of −295.00 (−155.00 ledger, −50.00 retroactive fees, −90.00 hold). Deferring retroactive fees to the close would have given −245.00. Auth-B is declined either way.

### 4. "Once per day per account": per value day or per booking day?
On Day 5 the ledger books three fees, for value days 2, 4 and 5. Read as "once per booking day", only one could be booked.
**Resolved:** per **value** day. The rule is attached to "that day's closing ledger balance", which is a value-day concept. It is enforced by a key set on `account|valueDay`.

### 5. Does a fee count toward the balance used to test later days?
**Resolved:** yes. Days are evaluated in ascending order, and each posted fee is part of every later day's balance. That is the cascade: the Day 2 fee takes Day 3 from 30.00 to 5.00, which stays non-negative, while Day 4 goes from −155.00 to −180.00. A day's own fee is triggered by its pre-fee balance.

### 6. Is a day that was restated back to positive un-feed?
After E9, Days 2, 4 and 5 are positive in the restated view.
**Resolved:** no automatic refund. The rules define when a fee is charged, not when it is returned, and the ledger cannot delete. Each fee was correct against the ledger as it stood when it was assessed. A refund is possible as an explicit `FEE_REVERSAL` (`reverseFee()`, tested), but the replay does not call it. See REJECTED.md AC6 and DESIGN.md §2.

### 7. Replay order vs booking-day order (E10)
E10 claims booking day 5, but it is listed after E9 (Day 6). "Replayed in this order" conflicts with the stated booking day.
**Resolved:** replay in list order. The day clock only moves forward. E10 is treated as a **late arrival**: it is booked on the current day (6), keeps value day 5, and raises `WARN LATE_ARRIVAL`. Closed days are never reopened. Sorting by booking day would silently rewrite the arrival order. No ACC-001 figure depends on this choice.

### 8. Forward-dated and very old value dates
The brief has neither.
**Resolved:** forward-dated entries are refused (`FUTURE_VALUE_DATE`). Entries more than `BACK_VALUE_WINDOW_DAYS` (5) back are refused (`BACK_VALUE_LIMIT`). See NUMBERS.md.

## B. Fees and currency

### 9. What overdraft fee applies to a BHD account?
The fee is stated in AED, and ACC-002 is BHD. The options are to charge AED 25.00 into a BHD account (mixing currencies), convert it (which rate, what source, when fixed), or charge nothing.
**Resolved:** no BHD fee is configured. If a BHD account closes negative, the ledger raises `ERROR NO_FEE_CONFIGURED` once for that day and posts nothing. This case never arises in the stream (ACC-002 only receives credits), and a synthetic test covers it. Building an FX engine was out of scope, and inventing a rate would be worse than refusing.

### 10. Fee vs interest order at the close
**Resolved:** the fee is assessed first, then interest accrues on the post-fee balance. A negative balance earns nothing either way. The order only matters on a day where the fee would take a small positive balance negative, which a fee on a positive balance never does. So the order is a convention, applied the same way every day.

## C. Interest

### 11. Interest on a balance that is later restated
Accruals for Days 2–5 were computed on balances that E7 and then E9 changed.
**Resolved:** accruals follow the value-dated balance. At each close, every day up to today is recomputed. When a past day's target moves, the difference is appended as an `ADJUSTMENT` accrual for that value day. Nothing is edited. The net per value day always equals `round(balance × rate)` on the final restated balance. ACC-001's Day 2 accrual went 0.10 → 0.00 (Day 5) → 0.09 (Day 6).

### 12. Negative balances
**Resolved:** zero interest, and no debit interest. "Positive balances only."

### 13. Day 6: fee, accrual and capitalization order, and interest on interest
**Resolved:** in this order: fee check, Day 6 accrual, then capitalization, value-dated Day 6. The accrual base excludes the capitalization entry, so interest is not compounded within the window. The printed Day 6 closing balance includes the capitalized credit.

### 14. Rounding of each daily accrual
**Resolved:** round half-even to the currency's precision, once per value day. See NUMBERS.md.

## D. Authorizations and settlements

### 15. Which "ledger balance" does the authorization check use?
**Resolved:** the value-dated balance through the current day, including every entry and retroactive fee already booked, minus the holds that are active now.

### 16. Are posted debits checked against available balance?
E7 is a plain debit that overdraws the account.
**Resolved:** no. The available-balance rule is stated for authorizations only. A booked debit is a cleared instruction. Refusing it would make overdraft fees unreachable, which contradicts the rest of the brief.

### 17. Auth-A settles for less than its hold (185.00 vs 200.00)
Options: release the 15.00 remainder, keep it open for a second settlement, or let it vanish silently.
**Resolved:** single-settlement model. The auth moves to `SETTLED` with `settled: 185.00, released: 15.00` recorded on the transition. Partial or multi-clearing (for example, hotels) is out of scope.

### 18. Auth-Z: settlement with no authorization
Options: reject and drop it, debit the customer anyway (force-post), or park it.
**Resolved:** park it. A `SUSPENSE` entry is posted to the internal account `SUSPENSE-AED` and an `ERROR UNMATCHED_SETTLEMENT` is raised. The customer is not debited. Nothing is dropped, because the scheme has already moved the money. See REJECTED.md AC4.

### 19. Other settlements that don't fit
The same suspense route handles a settlement against a DECLINED, SETTLED or EXPIRED auth, one above the hold amount (`OVER_SETTLEMENT`, zero tolerance), and one on the wrong account. The auth keeps its state, so an over-settled auth stays ACTIVE. All of these are tested.

### 20. Declined authorizations
**Resolved:** a declined auth creates no hold. It is still recorded (`DECLINED` transition plus a `WARN AUTH_DECLINED`). Auth-B is declined: available after the hold would be −295.00.

### 21. "Auth-B is never settled inside the window"
This matters only if Auth-B is approved, and it is not. For an approved-and-unsettled hold, the report would show `ACTIVE` at Day 6. A 7-day expiry can never fire before the window ends, as the failing test shows.

## E. Reversals

### 22. What does "reverses E7" post?
**Resolved:** an equal and opposite `REVERSAL` entry linked to the original (`reverses: L0006`), dated to the value day given (Day 2). If the given value day differs from the original's, a `REVERSAL_VALUE_DAY_DIFFERS` warning is raised. A second reversal of the same entry is refused (`ALREADY_REVERSED`).

### 23. Does a reversal undo decisions made in between?
**Resolved:** no. Auth-B's decline stands, and the fees stand. The ledger restates balances, not history. See REJECTED.md AC6.

## F. Model boundaries

### 24. Opening balances of zero
**Resolved:** no opening entry is posted. A non-zero opening balance would be a value-dated entry on Day 0.

### 25. Internal accounts
**Resolved:** suspense accounts are created per currency and excluded from fees and interest.

### 26. What counts as an "error" in the daily output
**Resolved:** `ERROR` means the event was not applied to the customer (unmatched or invalid settlement, refused value date, missing fee configuration). `WARN` means it was applied or recorded but needs attention (declined auth, late arrival, reversal date mismatch).

### 27. What a "day" is
**Resolved:** an abstract integer, with no calendar, time zone or cut-off time. UAE and Bahrain share no cut-off in reality. See DESIGN.md §4.
