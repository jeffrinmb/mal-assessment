# NUMBERS

Every constant in the code, with its value, its source, why it has that value, and what would break at half of it. All of them are in [`src/constants.js`](src/constants.js) or [`src/money.js`](src/money.js).

Some of these values come from the brief. For those, "why not half" means: what would break if someone halved it. That shows the value is load-bearing and not arbitrary.

---

### `CURRENCY_EXPONENT` — AED 2, BHD 3
- **Source:** brief (and ISO 4217).
- **Why:** Money is stored as integer minor units: AED in fils (1/100), BHD in fils (1/1000). Floats cannot hold 0.10 exactly, and interest accruals are exactly the kind of small repeated amount where float drift compounds.
- **Why not half:** An exponent of 1 for AED would make 0.10/day interest unrepresentable, and every accrual on ACC-001 would round to 0.0 or 0.1. Halving BHD's 3 (to 1 or 2) would make the E10 split impossible to conserve at 3.333/3.333/3.334, and would round away the 0.004 BHD daily accrual on ACC-002 entirely. The exponent is a property of the currency, not a tuning knob.

### `OVERDRAFT_FEE` — `{ AED: 2500n }` (AED 25.00)
- **Source:** brief.
- **Why:** Stored as minor units keyed by currency. It is deliberately **not** defined for BHD. See AMBIGUITIES #9.
- **Why not half:** At 12.50 the ACC-001 figures change by 37.50 in total: the as-known-then Day 5 balance would be −192.50 instead of −230.00. The *number* of fees would not change, because each fee is triggered by the pre-fee balance. The cascade check is the exception: the Day 2 fee leaves Day 3 at +5.00. At 12.50 Day 3 would be +17.50, still positive, so the outcome is the same. A fee above 30.00 would push Day 3 negative and create a fourth fee. So the 25.00 value sits 5.00 away from changing the fee count. That makes the fee-cascade test (`scenario.test.js`, AC2) sensitive to this constant on purpose.

### `DAILY_RATE_NUM / DAILY_RATE_DEN` — 4 / 10000 (0.04% per day)
- **Source:** brief.
- **Why:** Held as an exact rational, applied as `round(balance × 4 / 10000)`, so no decimal-to-binary conversion is ever made. It works out to 14.6% simple per annum, which is plausible for a product with daily interest.
- **Why not half:** At 0.02% the ACC-002 daily accrual on 10.000 BHD is 0.002. The result is still exact, but two AED days land exactly on a half-way tie: restated Day 2 (225.00 × 0.0002 = 0.045) and restated Day 3 (625.00 × 0.0002 = 0.125). Rounding mode would then change the capitalized total on this stream. At 0.04% no day lands on a tie. Halving the rate halves the interest figures and makes the result depend on the tie-breaking rule. The rounding test covers ties separately (`invariants.test.js`).

### Rounding mode — HALF_EVEN, applied once per daily accrual
- **Source:** my choice.
- **Why:** Rounding happens in exactly one place: the per-day accrual. Every other amount is either an input (checked for excess precision and refused, never rounded) or a sum of already-rounded amounts. HALF_EVEN has no systematic upward bias over thousands of daily accruals. HALF_UP would round every x.xx5 up, a small consistent drift in the bank's disfavour on credit interest.
- **Why not "half" (HALF_UP):** On this stream both modes give identical results (no ties). The choice matters at scale, not here. `divRoundHalfEven` is tested on 0.125 → 0.12 and 0.135 → 0.14.

### Capitalization rule — total = Σ rounded daily accruals (not round(Σ unrounded))
- **Source:** my choice, forced by the brief's "must sum exactly".
- **Why:** The capitalized amount is defined as the sum of the rounded daily accrual records. `#capitalize()` also recomputes the per-day targets and throws if the two differ, so a remainder cannot exist by construction.

### `FIRST_DAY` / `LAST_DAY` — 1 / 6
- **Source:** brief.
- **Why:** The window. Capitalization happens at the close of `LAST_DAY`.
- **Why not half:** At 3 the window would end before E5–E10. Worse, a 3-day window is shorter than the observed auth-to-settlement lag plus back-value depth (E7 lands 3 days back). This constant is also what makes hold expiry unreachable. See `HOLD_EXPIRY_DAYS`.

### `HOLD_EXPIRY_DAYS` — 7 (hold lives authDay … authDay+6, released at close of authDay+6)
- **Source:** my choice.
- **Why:** 7 days is the common card-scheme hold period for ordinary retail authorizations. Expiry must exceed the longest auth→settlement lag we expect. In the stream that lag is 2 days (Auth-A: Day 2 → Day 4).
- **Why not half:** 3.5 days would let a routine settlement land after its hold had already been released. The customer would then have spent the "freed" money twice, and the settlement would arrive as an orphan. At 3 days, Auth-A would have survived by only one day of margin. A 1-day expiry would orphan Auth-A outright.
- **Consequence found during the build:** a 7-day hold placed on Day 1 or later cannot expire before the close of Day 7, and the window ends at Day 6. So **the expiry path is unreachable inside the brief's window.** The tests widen the window to reach it, and this is part of what the failing test documents.

### `BACK_VALUE_WINDOW_DAYS` — 5
- **Source:** my choice.
- **Why:** The largest back-dating in the stream is E9: booked Day 6, value Day 2, so 4 days. E7 is 3 days. N = 5 accepts both with one day of margin, and refuses anything older with `BACK_VALUE_LIMIT` (in production that entry would go to maker-checker). Forward-dated entries are refused outright (`FUTURE_VALUE_DATE`).
- **Why not half:** N = 2.5 (effectively 2) would refuse both E7 and E9 and push them into manual approval. The stream could not be replayed without an operator. N also bounds the cost of restatement: each back-valued entry re-runs fee and interest logic for at most N closed days, and state older than N days can be archived. See DESIGN.md §1.

### E10 instalment split — 3.333 / 3.333 / 3.334
- **Source:** derived. `splitExactly(10000n, 3)`.
- **Why:** The parts must sum to exactly 10.000. The leftover minor unit goes to the **last** instalment, so any shortfall on the earlier instalments is recovered by the final one. Parts differ by at most one fil.
- **Why not half:** Not a tunable. The count (3) comes from the brief.

### Fee cap — one per (account, value day)
- **Source:** brief ("once per day per account").
- **Why:** Enforced by a `Set` of `account|valueDay` keys that is checked before posting. Retroactive assessment and repeated backdating cannot double-charge a day (see `invariants.test.js`).
