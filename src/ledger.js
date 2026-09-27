import { divRoundHalfEven, splitExactly, format } from './money.js';
import {
  FIRST_DAY, LAST_DAY, OVERDRAFT_FEE, DAILY_RATE_NUM, DAILY_RATE_DEN,
  HOLD_EXPIRY_DAYS, BACK_VALUE_WINDOW_DAYS,
} from './constants.js';

// Every record the ledger keeps (entries, accruals, authorization transitions,
// diagnostics, day reports) goes into an append-only list and is frozen on
// insert. Balances, holds and authorization states are derived from those
// lists and are never stored.

const suspenseAccountFor = (ccy) => `SUSPENSE-${ccy}`;

export class Ledger {
  #accounts = new Map();   // id -> { id, ccy, internal }
  #entries = [];           // ledger entries (money movements)
  #accruals = [];          // interest accrual sub-ledger (memo, not balance-affecting)
  #auths = new Map();      // authId -> frozen creation record
  #authLog = [];           // authorization state transitions
  #diagnostics = [];       // errors and warnings
  #dayReports = [];        // frozen snapshot taken at each day close
  #feeKeys = new Set();    // `${account}|${valueDay}` for assessed fees
  #seq = 0;
  #day = FIRST_DAY;
  #windowClosed = false;

  get currentDay() { return this.#day; }
  get windowClosed() { return this.#windowClosed; }

  // ---------- setup ----------

  openAccount(id, ccy, { internal = false } = {}) {
    if (this.#accounts.has(id)) throw new Error(`Account ${id} already exists`);
    this.#accounts.set(id, Object.freeze({ id, ccy, internal }));
    if (!internal && !this.#accounts.has(suspenseAccountFor(ccy))) {
      this.#accounts.set(suspenseAccountFor(ccy),
        Object.freeze({ id: suspenseAccountFor(ccy), ccy, internal: true }));
    }
  }

  // ---------- read side (all derived) ----------

  get entries() { return [...this.#entries]; }
  get accruals() { return [...this.#accruals]; }
  get authLog() { return [...this.#authLog]; }
  get diagnostics() { return [...this.#diagnostics]; }
  get dayReports() { return [...this.#dayReports]; }
  get accounts() { return [...this.#accounts.values()]; }

  account(id) {
    const a = this.#accounts.get(id);
    if (!a) throw new Error(`Unknown account ${id}`);
    return a;
  }

  // Closing ledger balance of `valueDay`: entries with value_date <= valueDay.
  // bookedThrough limits the view to what had been booked by that day (the
  // "as known then" view); by default every entry posted so far counts.
  balance(accountId, valueDay, { bookedThrough = Infinity, excludeTypes = [] } = {}) {
    let sum = 0n;
    for (const e of this.#entries) {
      if (e.account === accountId && e.valueDay <= valueDay && e.bookingDay <= bookedThrough
          && !excludeTypes.includes(e.type)) sum += e.amount;
    }
    return sum;
  }

  authState(authId) {
    let state;
    for (const t of this.#authLog) if (t.authId === authId) state = t.state;
    return state;
  }

  auth(authId) { return this.#auths.get(authId); }

  activeHolds(accountId) {
    let sum = 0n;
    for (const a of this.#auths.values()) {
      if (a.account === accountId && this.authState(a.authId) === 'ACTIVE') sum += a.amount;
    }
    return sum;
  }

  // Available = ledger balance (value-dated through `day`) minus active holds.
  availableOn(accountId, day = this.#day) {
    return this.balance(accountId, day) - this.activeHolds(accountId);
  }

  // ---------- write side ----------

  #diag(level, code, ref, message) {
    this.#diagnostics.push(Object.freeze({ day: this.#day, level, code, ref, message }));
  }

  #post({ account, type, amount, valueDay, ref, note = '', reverses = null }) {
    const acc = this.account(account);
    this.#seq += 1;
    const entry = Object.freeze({
      seq: this.#seq,
      id: `L${String(this.#seq).padStart(4, '0')}`,
      account, ccy: acc.ccy, type, amount, valueDay,
      bookingDay: this.#day, ref, note, reverses,
    });
    this.#entries.push(entry);
    return entry;
  }

  #transition(authId, state, detail = {}) {
    this.#authLog.push(Object.freeze({ day: this.#day, authId, state, ...detail }));
  }

  #assertOpen() {
    if (this.#windowClosed) throw new Error('Window is closed; no further events accepted');
  }

  // Value-date guard. Returns true when the date is acceptable.
  #checkValueDay(ref, valueDay) {
    if (valueDay > this.#day) {
      this.#diag('ERROR', 'FUTURE_VALUE_DATE', ref,
        `value day ${valueDay} is after booking day ${this.#day}; forward-dated entries are not supported`);
      return false;
    }
    if (this.#day - valueDay > BACK_VALUE_WINDOW_DAYS) {
      this.#diag('ERROR', 'BACK_VALUE_LIMIT', ref,
        `value day ${valueDay} is ${this.#day - valueDay} days back; limit is ${BACK_VALUE_WINDOW_DAYS} (needs maker-checker)`);
      return false;
    }
    return true;
  }

  // A posting into an already-closed day restates it. The overdraft rule then
  // has to be re-run for the closed days straight away.
  #afterPosting(valueDay) {
    if (valueDay < this.#day) this.#assessFees(this.#day - 1);
  }

  warn(code, ref, message) { this.#diag('WARN', code, ref, message); }

  credit({ ref, account, amount, valueDay, instalments = 1 }) {
    this.#assertOpen();
    if (!this.#checkValueDay(ref, valueDay)) return [];
    if (amount <= 0n) throw new Error(`${ref}: credit amount must be positive`);
    const parts = splitExactly(amount, instalments);
    const posted = parts.map((p, i) => this.#post({
      account, type: 'CREDIT', amount: p, valueDay, ref,
      note: instalments > 1 ? `instalment ${i + 1}/${instalments}` : '',
    }));
    this.#afterPosting(valueDay);
    return posted;
  }

  // Posted debits are cleared instructions: they are not checked against the
  // available balance. Only authorizations are.
  debit({ ref, account, amount, valueDay }) {
    this.#assertOpen();
    if (!this.#checkValueDay(ref, valueDay)) return null;
    if (amount <= 0n) throw new Error(`${ref}: debit amount must be positive`);
    const e = this.#post({ account, type: 'DEBIT', amount: -amount, valueDay, ref });
    this.#afterPosting(valueDay);
    return e;
  }

  authorize({ ref, authId, account, amount, valueDay }) {
    this.#assertOpen();
    if (this.#auths.has(authId)) {
      this.#diag('ERROR', 'DUPLICATE_AUTH_ID', ref, `${authId} already exists; request ignored`);
      return this.authState(authId);
    }
    const acc = this.account(account);
    const availableBefore = this.availableOn(account);
    const availableAfter = availableBefore - amount;
    this.#auths.set(authId, Object.freeze({ authId, account, ccy: acc.ccy, amount, day: this.#day, valueDay, ref }));
    if (availableAfter >= 0n) {
      this.#transition(authId, 'ACTIVE', { ref, amount, availableAfter });
      return 'ACTIVE';
    }
    this.#transition(authId, 'DECLINED', { ref, amount, availableAfter });
    this.#diag('WARN', 'AUTH_DECLINED', ref,
      `${authId} declined: available after hold would be ${format(acc.ccy, availableAfter)}`);
    return 'DECLINED';
  }

  // A settlement that cannot be matched to an ACTIVE authorization it fits
  // does not touch the customer. It is recorded against the internal
  // suspense account for operations to investigate.
  settle({ ref, authId, account, amount, valueDay }) {
    this.#assertOpen();
    if (!this.#checkValueDay(ref, valueDay)) return null;
    const acc = this.account(account);
    const auth = this.#auths.get(authId);
    const state = this.authState(authId);
    let problem = null;
    if (!auth) problem = ['UNMATCHED_SETTLEMENT', `${authId} has no authorization`];
    else if (auth.account !== account) problem = ['SETTLEMENT_ACCOUNT_MISMATCH', `${authId} belongs to ${auth.account}`];
    else if (state !== 'ACTIVE') problem = [`SETTLEMENT_ON_${state}`, `${authId} is ${state}`];
    else if (amount > auth.amount) problem = ['OVER_SETTLEMENT', `${authId} hold ${format(acc.ccy, auth.amount)} < settlement ${format(acc.ccy, amount)}`];

    if (problem) {
      const e = this.#post({
        account: suspenseAccountFor(acc.ccy), type: 'SUSPENSE', amount: -amount, valueDay, ref,
        note: `${problem[0]} ${authId} for ${account}`,
      });
      this.#diag('ERROR', problem[0], ref, `${problem[1]}; ${format(acc.ccy, amount)} parked in ${e.account}, customer not debited`);
      return null;
    }

    const e = this.#post({ account, type: 'SETTLEMENT', amount: -amount, valueDay, ref, note: authId });
    // Single-settlement model: the hold is consumed and any remainder released.
    this.#transition(authId, 'SETTLED', { ref, settled: amount, released: auth.amount - amount });
    this.#afterPosting(valueDay);
    return e;
  }

  reverse({ ref, target, valueDay }) {
    this.#assertOpen();
    const original = this.#entries.find((e) => e.ref === target && ['CREDIT', 'DEBIT', 'SETTLEMENT'].includes(e.type));
    if (!original) {
      this.#diag('ERROR', 'REVERSAL_TARGET_NOT_FOUND', ref, `no reversible entry for ${target}`);
      return null;
    }
    if (this.#entries.some((e) => e.reverses === original.id)) {
      this.#diag('ERROR', 'ALREADY_REVERSED', ref, `${target} was already reversed`);
      return null;
    }
    if (valueDay !== original.valueDay) {
      this.#diag('WARN', 'REVERSAL_VALUE_DAY_DIFFERS', ref,
        `reversal value day ${valueDay} differs from original ${original.valueDay}`);
    }
    if (!this.#checkValueDay(ref, valueDay)) return null;
    const e = this.#post({
      account: original.account, type: 'REVERSAL', amount: -original.amount, valueDay, ref,
      note: `reverses ${target}`, reverses: original.id,
    });
    this.#afterPosting(valueDay);
    return e;
  }

  // Manual goodwill refund of an assessed fee. Nothing in the replay calls it.
  // Reversing a debit does NOT refund fees automatically.
  reverseFee({ ref, feeEntryId }) {
    this.#assertOpen();
    const fee = this.#entries.find((e) => e.id === feeEntryId && e.type === 'FEE');
    if (!fee) throw new Error(`No fee entry ${feeEntryId}`);
    if (this.#entries.some((e) => e.reverses === fee.id)) throw new Error(`${feeEntryId} already refunded`);
    const e = this.#post({
      account: fee.account, type: 'FEE_REVERSAL', amount: -fee.amount, valueDay: fee.valueDay, ref,
      note: `refunds ${fee.id}`, reverses: fee.id,
    });
    this.#afterPosting(fee.valueDay);
    return e;
  }

  // ---------- end-of-day processing ----------

  // At most one fee per (account, value day). Days are walked in ascending
  // order because a fee on day d lowers every later day's balance.
  #assessFees(throughDay) {
    for (const acc of this.#accounts.values()) {
      if (acc.internal) continue;
      for (let d = FIRST_DAY; d <= throughDay; d += 1) {
        const key = `${acc.id}|${d}`;
        if (this.#feeKeys.has(key)) continue;
        const bal = this.balance(acc.id, d);
        if (bal >= 0n) continue;
        const fee = OVERDRAFT_FEE[acc.ccy];
        this.#feeKeys.add(key);
        if (fee === undefined) {
          this.#diag('ERROR', 'NO_FEE_CONFIGURED', acc.id,
            `day ${d} closed at ${format(acc.ccy, bal)} but no ${acc.ccy} overdraft fee is configured`);
          continue;
        }
        this.#post({
          account: acc.id, type: 'FEE', amount: -fee, valueDay: d, ref: `FEE-${acc.id}-D${d}`,
          note: `overdraft fee, day ${d} closed at ${format(acc.ccy, bal)}`,
        });
      }
    }
  }

  static dailyAccrual(balance) {
    return balance > 0n ? divRoundHalfEven(balance * DAILY_RATE_NUM, DAILY_RATE_DEN) : 0n;
  }

  // Accruals are appended per value day. When a backdated posting changes a
  // day's balance, the difference is appended as an ADJUSTMENT accrual for that
  // day. The accrual list therefore always sums to the per-day target.
  #accrueInterest(throughDay) {
    for (const acc of this.#accounts.values()) {
      if (acc.internal) continue;
      for (let d = FIRST_DAY; d <= throughDay; d += 1) {
        const target = Ledger.dailyAccrual(this.balance(acc.id, d, { excludeTypes: ['INTEREST_CAPITALIZATION'] }));
        const recorded = this.#accruals
          .filter((a) => a.account === acc.id && a.valueDay === d)
          .reduce((s, a) => s + a.amount, 0n);
        const isToday = d === this.#day;
        // Today's accrual is always recorded, even when zero, so every day has
        // a line. Past days get a record only when their target moved.
        if (!isToday && target === recorded) continue;
        this.#accruals.push(Object.freeze({
          account: acc.id, ccy: acc.ccy, valueDay: d, bookingDay: this.#day,
          amount: target - recorded, kind: isToday ? 'DAILY' : 'ADJUSTMENT',
          basis: this.balance(acc.id, d),
        }));
      }
    }
  }

  #expireHolds() {
    for (const a of this.#auths.values()) {
      if (this.authState(a.authId) === 'ACTIVE' && this.#day >= a.day + HOLD_EXPIRY_DAYS - 1) {
        this.#transition(a.authId, 'EXPIRED', { released: a.amount });
      }
    }
  }

  #capitalize() {
    for (const acc of this.#accounts.values()) {
      if (acc.internal) continue;
      const mine = this.#accruals.filter((a) => a.account === acc.id);
      const total = mine.reduce((s, a) => s + a.amount, 0n);
      // Invariant: the capitalized amount is exactly the sum of the rounded
      // daily accruals. There is no remainder to discard.
      let expected = 0n;
      for (let d = FIRST_DAY; d <= LAST_DAY; d += 1) {
        expected += Ledger.dailyAccrual(this.balance(acc.id, d, { excludeTypes: ['INTEREST_CAPITALIZATION'] }));
      }
      if (total !== expected) throw new Error(`Accrual drift on ${acc.id}: ${total} vs ${expected}`);
      if (total !== 0n) {
        this.#post({
          account: acc.id, type: 'INTEREST_CAPITALIZATION', amount: total, valueDay: LAST_DAY,
          ref: `INT-${acc.id}`, note: `capitalizes ${mine.length} accrual records`,
        });
      }
    }
  }

  closeDay() {
    this.#assertOpen();
    const d = this.#day;
    this.#assessFees(d);
    this.#accrueInterest(d);
    this.#expireHolds();
    if (d === LAST_DAY) this.#capitalize();

    const accounts = {};
    for (const acc of this.#accounts.values()) {
      accounts[acc.id] = Object.freeze({
        ccy: acc.ccy,
        internal: acc.internal,
        closing: this.balance(acc.id, d),
        holds: this.activeHolds(acc.id),
        available: this.availableOn(acc.id, d),
        bookedToday: Object.freeze(this.#entries.filter((e) => e.account === acc.id && e.bookingDay === d)),
        accruedToday: Object.freeze(this.#accruals.filter((a) => a.account === acc.id && a.bookingDay === d)),
      });
    }
    const authStates = {};
    for (const id of this.#auths.keys()) authStates[id] = this.authState(id);
    this.#dayReports.push(Object.freeze({
      day: d,
      accounts: Object.freeze(accounts),
      authTransitions: Object.freeze(this.#authLog.filter((t) => t.day === d)),
      authStates: Object.freeze(authStates),
      diagnostics: Object.freeze(this.#diagnostics.filter((x) => x.day === d)),
    }));

    if (d === LAST_DAY) this.#windowClosed = true;
    else this.#day = d + 1;
  }
}
