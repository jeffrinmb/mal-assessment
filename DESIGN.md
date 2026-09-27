# DESIGN: architecture, trade-offs, production

Everything here refers to `src/ledger.js` or `src/constants.js`. One constant runs through all four sections: the **back-value window N** (`BACK_VALUE_WINDOW_DAYS`). It bounds how far history can be restated. That makes it the line for what can be cached, what can be pruned, and what needs a second approver.

---

## 1. Append-only at scale

**What breaks first: day close, on CPU, before memory runs out.**

- `balance()` is a linear scan of every entry.
- `#accrueInterest` calls it for every account × every value day since the window began, then filters the whole accrual list to compare. So one close costs about accounts × days elapsed × (entries + accruals), and the cost grows every day.
- `#afterPosting` re-runs fee assessment for **all** accounts when **one** account receives a backdated entry.

At 100× volume the close goes from milliseconds to hours. The authorization path degrades too: `authState()` scans the transition log, and `activeHolds()` calls it once per auth. Every approval therefore costs O(auths × transitions), and that is on the latency-critical path.

**Unbounded state.** The entry log is meant to grow; that is the contract. The problem is that the working state lives as long as the audit record:

| Structure | Grows with | Pruned? |
|---|---|---|
| `#accruals` | accounts × days, plus adjustments | never, not even after capitalization |
| `#auths`, `#authLog` | every auth, terminal ones included | never |
| `#feeKeys` | accounts × negative days | never |
| `#dayReports` | days × accounts, each copying that day's entries | never |
| `#diagnostics` | every error or warning | never |

**Cheapest structural change: a frozen checkpoint at `today − N`.** The value-date guard already refuses anything older than N days, so state before `today − N` can never change again.

1. **Checkpoint:** keep one closing balance and one accrual total per account at `today − N`. Balance queries start from the checkpoint and fold in only the entries inside the window.
2. **Scoped loops:** fee and interest loops walk `[today − N, today]`, and only for accounts touched since the last close. Restatement cost becomes O(N) per affected account instead of O(history) across all accounts.
3. **Auth projection:** keep a derived `authId → state` map, updated when a transition is appended. Terminal auths older than N drop out of the map.
4. **Archive:** fee keys, accrual records and day snapshots older than the checkpoint go to archive storage.

The log remains the source of truth, and checkpoints are rebuildable caches. The change adds no new guarantee; it only uses one the guard already enforces. What remains is the growth of the log itself, which is a storage partitioning problem (by account and value month), not a memory problem.

---

## 2. Value-dated entries in production

**The surface.** A back-valued entry changes facts that people have already relied on.

- **Statements and fees:** already-issued statements become wrong. Worse, fees appear for past days the customer could not have seen or avoided at the time. The CBUAE Consumer Protection Regulation and Standards require fees to be transparent and fair, so retroactive charging needs an explicit policy. Today this design charges such fees and never refunds them.
- **Interest:** accrual adjustments are correct inside the ledger. But interest that has already been paid, reported on a statement or tax certificate, or distributed as profit on an Islamic product has to be corrected across a period boundary.
- **GL and regulatory reporting:** a value date inside a closed month changes figures already reported, including management accounts, IFRS 9 inputs, and prudential returns filed with CBUAE. Finance must decide between a prior-period adjustment and a current-period correction.
- **Financial crime:** monitoring usually runs on booking time, so back-valuing opens a gap between when money moved economically and when monitoring saw it. Unexplained back-valuation is also a classic insider-fraud pattern: an overdraft erased, interest shifted, a fee avoided. goAML reports must carry both dates.
- **Irreversible decisions:** auth approvals and declines were made on the balance known at the time, and restatement cannot undo them. Complaints will cite the balance the customer saw, so both views must be reproducible. That is what `balance(acc, day, { bookedThrough })` exists for.
- **Audit:** every restated figure must trace back to the entry that caused it, the person who booked it and the reason.

**The control I would add: back-value authorization with an impact record.**

- Every entry dated before its booking day carries a mandatory reason code.
- Beyond N days, or into a closed accounting period, the entry needs a second approver (maker-checker) before it posts.
- On posting, the system writes an impact record linked to the entry: every fee, accrual adjustment and restated balance it triggered. Operations uses that record to decide on refunds and customer notices.

The code already enforces the hard limit (`BACK_VALUE_LIMIT`). In production, a breach would go to a checker queue instead of being refused.

---

## 3. Authorization lifecycle

In this model an authorization can end in three ways other than a matching settlement:

| Ending | In code | Real-world scenario | Behavior I would mandate |
|---|---|---|---|
| **Declined at birth** | `authorize()` → `DECLINED` | Insufficient available balance, or a risk decline | Record the decision together with the available balance it was judged on (done). Place no hold. Send any later settlement against it to suspense (done). Return a reason code to the scheme. |
| **Expired** | `#expireHolds()` → `EXPIRED` | The merchant never clears: an abandoned order, or a fuel pre-auth never completed | Release the full hold after the scheme period, driven by a **scheduler**. Here expiry runs only inside `closeDay()`, so an inactive account keeps its hold forever (the known-failing test). A settlement that arrives after expiry goes to suspense, and ops force-posts it where the scheme obliges payment. |
| **Remainder released on under-settlement** | `settle()` records `released` | The final amount is below the authorized amount (fuel, hotels, restaurants) | Release the difference in the same transition (done). For merchant categories that clear in several pieces, keep the remainder open until expiry. |

Two cases leave an auth **open** and so need their own rule:

- **Over-settlement:** the settlement goes to suspense and the auth stays `ACTIVE`. The mandate is a tolerance per merchant category (tips, FX movement). Within tolerance, settle and debit the excess. Above it, go to suspense and chargeback review, and close the hold so it cannot be released and then charged again when ops force-posts.
- **Still active at window end:** this is expected. The hold keeps reducing available balance until the expiry scheduler picks it up.

The model has no endings for **merchant reversal or void**, **incremental authorization**, or **account freeze or closure**. Production needs:
- `REVERSED`, idempotent because reversals are retried;
- increments on the existing auth, checked for the increment only;
- holds kept on a frozen account, with settlements routed to review, and closure blocked while holds are open.

The rule behind all of these: an auth ends only through an explicit, logged transition, and a hold is never quietly dropped. The transition log already has that shape. What it lacks is a clock.

---

## 4. What I cut and why

| Cut | Why | Production risk deferred |
|---|---|---|
| **Double-entry and GL.** Customer accounts plus a one-sided suspense account. | The brief is about customer balances. | Nothing proves the books balance. Suspense, fees and interest have no contra-legs, so nothing reconciles to the GL. This is the largest gap. |
| **Persistence** | Out of scope by instruction | A crash loses everything. Freezing objects only proves immutability within a single process. |
| **Concurrency** | Single ordered stream | The check-then-hold in `authorize()` is a race: two concurrent auths can both pass on the same funds. It needs a per-account serial queue or a conditional write. |
| **Inbound idempotency** | Stream replayed once | A redelivered event posts again, because `ref` is not a unique key. |
| **Hold-expiry clock** | Only event-driven closes | Unsettled holds block funds on inactive accounts indefinitely. |
| **Calendar, time zones, cut-offs** | "Day" is an integer | No weekends, holidays or cut-off times. AED and BHD books have different local cut-offs, so "end of day" is undefined across them. |
| **FX** | Not needed in-window | A negative non-AED account raises an error and is charged no fee: a revenue leak until an FX rate policy exists. |
| **Fee refund policy** | No rule given | Customers keep fees caused by entries the bank later reversed, which is a conduct and complaints risk. |
| **Multi-clearing, incremental auths, over-settlement tolerance** | Single clearings only | Hotel, fuel and tip flows land in suspense and need manual work. |
| **Forward-dated entries** | Not needed | Scheduled payments cannot be modeled. They are refused. |
| **Debit interest, overdraft limits, account states** | Not in scope | Overdrafts are priced only by the flat fee. There is no limit, freeze or closure. |
| **Indexes and checkpoints** | Correctness first | Day close is super-linear in history (§1). |
| **Day-count convention** | Flat daily rate | Products quoted as an annual rate on Actual/365 or Actual/360 would accrue differently. |

**Kept on purpose:**
- integer minor units;
- a single rounding point;
- capitalization defined as the sum of the rounded accruals;
- frozen records with derived balances;
- the bitemporal balance query;
- suspense instead of silently dropping entries.

Each cut above leaves the system incomplete. Getting any of the kept items wrong would make it incorrect.
