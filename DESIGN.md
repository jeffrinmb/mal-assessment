# DESIGN: architecture, trade-offs, production

Part 2. Every point below refers to something in `src/ledger.js` or a constant in `src/constants.js`. It does not describe a hypothetical system.

One constant recurs throughout: the **back-value window N** (`BACK_VALUE_WINDOW_DAYS`, 5). It bounds how far history can be restated. It is therefore also the boundary for what can be cached, what can be pruned, and what needs a second approver.

---

## 1. Append-only at scale

### What breaks first at 100×

**Day close breaks first, and it breaks on CPU before memory.** Three pieces of the code are to blame:

- `balance()` is a linear scan of every entry, for every account.
- `closeDay()` calls it inside `#accrueInterest`. For every account and every value day since Day 1, it recomputes the accrual target and filters the whole accrual list to compare. One close costs roughly accounts × days-elapsed × (entries + accruals).
- `#afterPosting` re-runs `#assessFees` over **all accounts** and all closed days whenever **any** backdated entry lands, even though only one account changed.

At 100× accounts and 100× entries per account, the close goes from milliseconds to hours. It also gets slower every day it runs, because "days elapsed" grows with no bound. The auth path degrades in the same way. `authState()` scans the whole transition log, and `activeHolds()` calls it once per auth. That makes every authorization decision O(auths × transitions), and it sits on the latency-critical path.

### Where state accumulates without bound

| Structure | Grows with | Ever shrinks? |
|---|---|---|
| `#entries` | every posting | no, by design |
| `#accruals` | accounts × days, plus one adjustment per restated day | no, and it is not even cleared after capitalization |
| `#authLog`, `#auths` | every auth, including terminal ones | no |
| `#feeKeys` | accounts × negative days | no |
| `#dayReports` | days × accounts, and **each snapshot copies that day's entry list** | no |
| `#diagnostics` | every error or warning | no |

The entry log *should* grow. That is the append-only contract. The problem is everything else: the working state is kept at the same lifetime as the audit record.

### Cheapest structural change: a closed-period checkpoint at `today − N`

Anything with a value date older than `today − N` can no longer change, because the value-date guard refuses it. So:

1. **Keep one frozen checkpoint per account:** the closing balance as of `today − N`, plus the accrual total up to that day. Every balance query starts from the checkpoint and folds in only the entries whose value dates fall inside the window.
2. **Loop only over the window.** `#assessFees` and `#accrueInterest` walk `[today − N, today]` instead of `[1, today]`, and only for accounts touched since the last close. Restatement cost becomes O(N) per affected account, not O(history) across all accounts.
3. **Keep a derived auth projection:** a map of authId → current state, updated when a transition is appended. Terminal auths older than N drop out of the hot map. The transition log stays.
4. **Evict the working state** (fee keys, accrual records, terminal auths, day snapshots) for dates past the checkpoint. Archive it. Nothing needs it in memory, because nothing can restate it.

Nothing is deleted from the record, and the log remains the source of truth. The checkpoints are rebuildable caches. That is the point: the change only makes explicit a guarantee the value-date guard already enforces. What remains is the log itself, which is a storage problem (partition by account and value month), not a memory problem.

---

## 2. Value-dated entries in production

### The surface a back-valued entry creates

A back-valued entry changes facts that other people have already relied on. In a CBUAE-licensed bank, that touches:

- **Customer statements and disclosures.** A statement for a closed period is now wrong. In this model a Day 2 that closed at 250.00 now shows 225.00, and a fee appears on Day 2 that the customer could not have seen or avoided on Day 2. Under the CBUAE Consumer Protection Regulation and Standards, fees must be transparent and fair. A fee charged retroactively for a period the customer could not observe needs a documented policy, not an accident of the replay logic. This design currently charges it and never refunds it (AMBIGUITIES #6).
- **Interest.** Accruals are restated through adjustment records. That is correct for the ledger. But if interest had already been *paid* or *reported*, for example on a statement, a tax certificate or a profit distribution for Islamic products, the adjustment has to cross a period boundary.
- **The general ledger and financial reporting.** An entry whose value date falls in a closed month changes balances already reported in that period: management accounts, IFRS 9 staging inputs, and prudential returns already submitted to the regulator. Finance needs to know whether to adjust the prior period or book the correction in the current one. This model has no GL, so it cannot answer that (§4).
- **AML and financial-crime monitoring.** Transaction monitoring and velocity rules usually run on booking time. Back-valuing creates a gap between when money was economically moved and when monitoring saw it. Unexplained back-valuation is also a classic insider-fraud pattern: an overdraft made to vanish, interest shifted, a fee dodged. Any goAML report has to carry both dates.
- **Decisions already taken.** Authorization approvals and declines were made on the balance known at the time. Restatement cannot undo them (the Auth-B decline). Disputes and complaints will cite the balance the customer saw, so both views must be reproducible. The bitemporal query (`balance(acc, day, { bookedThrough })`) exists for this.
- **Audit.** Every restated figure must be traceable to the entry that caused it, the person who booked it, and the reason.

### The control I would add before go-live

**Back-value authorization with a restatement impact report.** Any entry whose value date is earlier than its booking date must carry a reason code. Beyond N days, or when the value date falls in a closed accounting period, it needs a second approver (maker-checker) before it posts. On posting, the system automatically produces an impact record: every fee, accrual adjustment and restated closing balance the entry triggered, linked to it. That record is what operations uses to decide on refunds and customer notices. The hard limit is already in the code (`BACK_VALUE_LIMIT`). Today the code refuses such an entry. In production it would queue it for the checker instead.

---

## 3. Authorization lifecycle

These are the ways an authorization in **this model** can end other than a matching settlement, followed by those the model is missing.

### Endings the model implements

| Ending | Where | Real-world scenario | Behavior I would mandate |
|---|---|---|---|
| **Declined at birth** (`DECLINED`) | `authorize()` | Insufficient available balance, as with Auth-B | Record the decline with the available figure it was judged on (done). No hold. Any later settlement against it goes to suspense (done, `SETTLEMENT_ON_DECLINED`). Return a decline reason code to the scheme. |
| **Expired** (`EXPIRED`) | `#expireHolds()` in `closeDay()` | The merchant never clears: a cancelled order, or a fuel-pump pre-auth | Release the full hold after the scheme period (7 days). It must be driven by a scheduler, not by the next event. This is the failing test: here expiry only runs when a day closes, and never inside the window. A late settlement after expiry goes to suspense, and ops force-posts it when the scheme obliges payment. |
| **Remainder released on partial settlement** | `settle()` sets `released` | The final amount is lower than the authorized amount (Auth-A: 185 of 200, typical of fuel or hotels) | Release the difference in the same transition (done). Where the MCC allows several clearings, keep the remainder open until the expiry date instead. |

### Situations that leave the auth open (not endings, but they need a rule)

| Situation | Model behavior | Mandate |
|---|---|---|
| **Over-settlement** | Clearing goes to suspense and the auth stays `ACTIVE` | Apply a per-MCC tolerance (tips, currency movement). Within tolerance, settle and debit the excess. Above it, send to suspense and chargeback review. Leaving the hold active risks releasing it later and double-charging once ops force-posts. |
| **Still active at window end** | Reported `ACTIVE` | Expected state. It must still reduce available balance, and the expiry scheduler must pick it up. |
| **Duplicate auth ID** | Request ignored with an error | Treat it as a scheme retry: return the original decision idempotently. |

### Endings the model does not have (and should)

| Ending | Real-world scenario | Mandate |
|---|---|---|
| **Reversal or cancellation** | The merchant voids the sale, or the terminal times out and sends a reversal | A `REVERSED` state that releases the hold immediately. It must be idempotent, because reversals are retried. |
| **Incremental authorization** | A hotel or car hire extends the hold | Add to the existing auth, not a new one. Check available only for the increment. |
| **Account closed or frozen** | A sanctions hit, the death of the customer, or a court order | Keep holds on a frozen account (do not release funds), and route settlements to ops review. On closure, holds must be resolved before the account can close. |

The rule behind all of these: **every auth reaches a terminal state through an explicit, logged transition, and a hold is never released by being quietly dropped.** The transition log in this design already has that shape. What it lacks is the clock.

---

## 4. What I cut and why

| Cut | Why | Production risk it defers |
|---|---|---|
| **Double-entry and GL.** Only customer accounts plus a one-sided suspense account. | The brief is about customer balances. A chart of accounts would have doubled the model. | No proof that the books balance. The suspense entry has no contra-leg, fees have no income account, interest has no expense account, and nothing reconciles to the GL. This is the biggest gap. |
| **Persistence and durability** | Out of scope by instruction | A crash loses everything, and there is no write-ahead log. Frozen in-memory objects prove immutability only inside one process. |
| **Concurrency** | One thread, one ordered stream | The check-then-hold in `authorize()` is a race. Two concurrent auths can both see 100.00 available and both be approved. It needs a per-account serial queue or a conditional write. |
| **Idempotency on inbound events** | The stream is replayed once | `credit()` with a `ref` it has already seen posts again. A redelivered message double-credits. `ref` must be a unique key. |
| **Hold expiry clock** | Only event-driven closes exist | Unsettled holds block funds until something else happens on the account (the failing test). |
| **Calendar, time zones and cut-offs** | "Day" is an integer | No weekends or holidays (the UAE weekend is Sat–Sun). ACC-002 is BHD, a Bahrain-currency account, which may have a different cut-off from the AED book. "End of day" is undefined across time zones. |
| **FX** | Not needed by the stream | A BHD account that goes negative raises `NO_FEE_CONFIGURED` and pays no fee. That is a revenue leak until a rate policy exists. |
| **Fee refund policy** | No rule in the brief | Customers keep fees caused by entries the bank reversed (AC6). This is a complaints and conduct risk. |
| **Multi-clearing, incremental auths, over-settlement tolerance** | The stream has single clearings | Hotel, fuel and tip transactions will land in suspense and need manual work. |
| **Forward-dated entries** | Not in the stream | Scheduled payments and standing orders cannot be modeled. They are refused today. |
| **Debit interest, arranged overdraft limits, account states** | Not in the rules | Overdrafts are unpriced beyond the flat fee. There is no limit, freeze or closure. |
| **Performance structures** (indexes, checkpoints) | Correctness first, and replay is fast at this size | See §1. Day close is super-linear in history. |
| **Day-count basis** | A flat daily rate | Real products quote an annual rate on Actual/365 or Actual/360. A flat 0.04% ignores leap years and product terms. |

**What I deliberately did not cut:** integer minor units, a single rounding point, capitalization defined as the sum of the rounded accruals, frozen records with derived balances, a bitemporal balance query, and suspense instead of silently dropping entries. Getting any of these wrong would make the numbers wrong. Every cut above makes the system incomplete, not incorrect, inside the window.
