// Synthetic cases for rules the brief's stream never exercises.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { toMinor } from '../src/money.js';

const aed = (s) => toMinor('AED', s);
const bhd = (s) => toMinor('BHD', s);

function fresh() {
  const l = new Ledger();
  l.openAccount('A', 'AED');
  l.openAccount('B', 'BHD');
  return l;
}

test('an approved hold reduces available balance but not ledger balance (AC5 invariant)', () => {
  const l = fresh();
  l.credit({ ref: 'c', account: 'A', amount: aed('100.00'), valueDay: 1 });
  assert.equal(l.authorize({ ref: 'a', authId: 'X', account: 'A', amount: aed('90.00'), valueDay: 1 }), 'ACTIVE');
  assert.equal(l.balance('A', 1), aed('100.00'));
  assert.equal(l.availableOn('A'), aed('10.00'));
});

test('an authorization that leaves available at exactly zero is approved', () => {
  const l = fresh();
  l.credit({ ref: 'c', account: 'A', amount: aed('50.00'), valueDay: 1 });
  assert.equal(l.authorize({ ref: 'a', authId: 'X', account: 'A', amount: aed('50.00'), valueDay: 1 }), 'ACTIVE');
  assert.equal(l.authorize({ ref: 'b', authId: 'Y', account: 'A', amount: aed('0.01'), valueDay: 1 }), 'DECLINED');
});

test('a negative BHD account gets no invented fee; it raises NO_FEE_CONFIGURED once per day', () => {
  const l = fresh();
  l.debit({ ref: 'd', account: 'B', amount: bhd('1.000'), valueDay: 1 });
  l.closeDay();
  assert.equal(l.entries.filter((e) => e.type === 'FEE').length, 0);
  assert.equal(l.diagnostics.filter((d) => d.code === 'NO_FEE_CONFIGURED').length, 1);
});

test('two backdated debits into the same day produce one fee for that day', () => {
  const l = fresh();
  l.closeDay(); l.closeDay(); // now on day 3
  l.debit({ ref: 'd1', account: 'A', amount: aed('10.00'), valueDay: 1 });
  l.debit({ ref: 'd2', account: 'A', amount: aed('10.00'), valueDay: 1 });
  const d1Fees = l.entries.filter((e) => e.type === 'FEE' && e.valueDay === 1);
  assert.equal(d1Fees.length, 1);
});

test('an entry value-dated beyond the back-value window is refused', () => {
  const l = fresh();
  for (let i = 0; i < 5; i += 1) l.closeDay(); // day 6
  assert.equal(l.debit({ ref: 'old', account: 'A', amount: aed('1.00'), valueDay: 0 }), null);
  assert.ok(l.diagnostics.some((d) => d.code === 'BACK_VALUE_LIMIT'));
  assert.notEqual(l.debit({ ref: 'ok', account: 'A', amount: aed('1.00'), valueDay: 1 }), null);
});

test('a forward-dated entry is refused', () => {
  const l = fresh();
  assert.equal(l.debit({ ref: 'f', account: 'A', amount: aed('1.00'), valueDay: 3 }), null);
  assert.ok(l.diagnostics.some((d) => d.code === 'FUTURE_VALUE_DATE'));
});

test('duplicate, over- and declined-auth settlements go to suspense, not the customer', () => {
  const l = fresh();
  l.credit({ ref: 'c', account: 'A', amount: aed('100.00'), valueDay: 1 });
  l.authorize({ ref: 'a1', authId: 'X', account: 'A', amount: aed('50.00'), valueDay: 1 });
  l.authorize({ ref: 'a2', authId: 'Y', account: 'A', amount: aed('500.00'), valueDay: 1 }); // declined
  l.settle({ ref: 's1', authId: 'X', account: 'A', amount: aed('60.00'), valueDay: 1 });  // over
  assert.equal(l.authState('X'), 'ACTIVE');
  l.settle({ ref: 's2', authId: 'X', account: 'A', amount: aed('50.00'), valueDay: 1 });  // ok
  l.settle({ ref: 's3', authId: 'X', account: 'A', amount: aed('50.00'), valueDay: 1 });  // duplicate
  l.settle({ ref: 's4', authId: 'Y', account: 'A', amount: aed('10.00'), valueDay: 1 });  // declined auth
  const codes = l.diagnostics.filter((d) => d.level === 'ERROR').map((d) => d.code);
  assert.deepEqual(codes, ['OVER_SETTLEMENT', 'SETTLEMENT_ON_SETTLED', 'SETTLEMENT_ON_DECLINED']);
  assert.equal(l.balance('A', 1), aed('50.00'));
  assert.equal(l.balance('SUSPENSE-AED', 1), aed('-120.00'));
});

test('an entry cannot be reversed twice', () => {
  const l = fresh();
  l.debit({ ref: 'd', account: 'A', amount: aed('5.00'), valueDay: 1 });
  assert.notEqual(l.reverse({ ref: 'r1', target: 'd', valueDay: 1 }), null);
  assert.equal(l.reverse({ ref: 'r2', target: 'd', valueDay: 1 }), null);
  assert.ok(l.diagnostics.some((d) => d.code === 'ALREADY_REVERSED'));
});

test('a fee refund is a new compensating entry; the fee itself stays', () => {
  const l = fresh();
  l.debit({ ref: 'd', account: 'A', amount: aed('5.00'), valueDay: 1 });
  l.closeDay();
  const fee = l.entries.find((e) => e.type === 'FEE');
  l.reverseFee({ ref: 'goodwill', feeEntryId: fee.id });
  assert.equal(l.entries.filter((e) => e.type === 'FEE').length, 1);
  assert.equal(l.balance('A', 1), aed('-5.00'));
  assert.throws(() => l.reverseFee({ ref: 'again', feeEntryId: fee.id }), /already refunded/);
});

test('daily accrual rounds half-even at the currency precision', () => {
  assert.equal(Ledger.dailyAccrual(aed('312.50')), aed('0.12'));  // 0.125 -> 0.12
  assert.equal(Ledger.dailyAccrual(aed('337.50')), aed('0.14'));  // 0.135 -> 0.14
  assert.equal(Ledger.dailyAccrual(bhd('10.000')), bhd('0.004'));
  assert.equal(Ledger.dailyAccrual(aed('-100.00')), 0n);
});

test('a hold expires at the close of day authDay + 6 once day closes run that far', () => {
  // With a 7-day expiry, the earliest possible expiry is the close of Day 7.
  // That is outside the brief's window, so this test widens the window.
  const l = new Ledger({ lastDay: 14 });
  l.openAccount('A', 'AED');
  l.credit({ ref: 'c', account: 'A', amount: aed('100.00'), valueDay: 1 });
  l.authorize({ ref: 'a', authId: 'X', account: 'A', amount: aed('40.00'), valueDay: 1 });
  for (let i = 0; i < 6; i += 1) l.closeDay();
  assert.equal(l.authState('X'), 'ACTIVE');   // day 7 open, not yet closed
  l.closeDay();                               // close of day 7 = 1 + 7 - 1
  assert.equal(l.authState('X'), 'EXPIRED');
  assert.equal(l.availableOn('A'), aed('100.00'));
});

test('with a 7-day expiry, no hold can expire inside the six-day window', () => {
  const l = fresh();
  l.credit({ ref: 'c', account: 'A', amount: aed('100.00'), valueDay: 1 });
  l.authorize({ ref: 'a', authId: 'X', account: 'A', amount: aed('40.00'), valueDay: 1 });
  while (!l.windowClosed) l.closeDay();
  assert.equal(l.authState('X'), 'ACTIVE');
});

test('the window refuses events after Day 6 has closed', () => {
  const l = fresh();
  for (let i = 0; i < 6; i += 1) l.closeDay();
  assert.throws(() => l.credit({ ref: 'late', account: 'A', amount: aed('1.00'), valueDay: 6 }), /Window is closed/);
});
