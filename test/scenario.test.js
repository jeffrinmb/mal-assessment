// Replays the brief's event stream and pins every number the report prints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { replay, renderReport } from '../src/replay.js';
import { toMinor } from '../src/money.js';

const aed = (s) => toMinor('AED', s);
const bhd = (s) => toMinor('BHD', s);
const L = replay();
const fees = L.entries.filter((e) => e.type === 'FEE');

test('AC1 (accepted): Day 2 closing as known at end of Day 5, before fees, is -370.00', () => {
  assert.equal(L.balance('ACC-001', 2, { bookedThrough: 5, excludeTypes: ['FEE'] }), aed('-370.00'));
});

test('AC2 (rejected): E7 drives three overdraft fees (value days 2, 4, 5), not one', () => {
  assert.deepEqual(fees.map((f) => [f.account, f.valueDay, f.bookingDay, f.amount]), [
    ['ACC-001', 2, 5, aed('-25.00')],
    ['ACC-001', 4, 5, aed('-25.00')],
    ['ACC-001', 5, 5, aed('-25.00')],
  ]);
  // The fee cascade: the Day 2 fee alone leaves Day 3 at +5.00, so Day 3 is not charged.
  assert.equal(L.balance('ACC-001', 3, { bookedThrough: 5 }), aed('5.00'));
});

test('AC3 (accepted): Auth-A settles 185.00 against its 200.00 hold; 15.00 is released', () => {
  const t = L.authLog.filter((x) => x.authId === 'Auth-A');
  assert.deepEqual(t.map((x) => [x.day, x.state]), [[2, 'ACTIVE'], [4, 'SETTLED']]);
  assert.equal(t[1].settled, aed('185.00'));
  assert.equal(t[1].released, aed('15.00'));
});

test('AC4 (partly refused): Auth-Z never touches ACC-001 but is recorded in suspense', () => {
  assert.equal(L.entries.filter((e) => e.ref === 'E6' && e.account === 'ACC-001').length, 0);
  const s = L.entries.filter((e) => e.ref === 'E6');
  assert.equal(s.length, 1);
  assert.equal(s[0].account, 'SUSPENSE-AED');
  assert.equal(s[0].amount, aed('-180.00'));
  assert.ok(L.diagnostics.some((d) => d.code === 'UNMATCHED_SETTLEMENT' && d.day === 4));
});

test('AC5 (accepted, vacuous in-stream): Auth-B is declined, so it never holds funds', () => {
  const t = L.authLog.find((x) => x.authId === 'Auth-B');
  assert.equal(t.state, 'DECLINED');
  // Ledger -155.00 minus the two retroactive fees (-205.00), less the 90.00 hold.
  assert.equal(t.availableAfter, aed('-295.00'));
  assert.equal(L.authState('Auth-B'), 'DECLINED');
});

test('AC6 (rejected): after E9, fees stay on the ledger and balances do not return', () => {
  assert.equal(fees.length, 3);
  const restated = [1, 2, 3, 4, 5, 6].map((d) => L.balance('ACC-001', d));
  assert.deepEqual(restated, ['250.00', '225.00', '625.00', '415.00', '390.00', '390.93'].map(aed));
  // Without E7 at all, Day 4 would have closed at 465.00.
  assert.notEqual(restated[3], aed('465.00'));
});

test('AC7 (rejected): E10 posts 3.333 / 3.333 / 3.334 and conserves 10.000', () => {
  const parts = L.entries.filter((e) => e.ref === 'E10').map((e) => e.amount);
  assert.deepEqual(parts, [bhd('3.333'), bhd('3.333'), bhd('3.334')]);
  assert.equal(parts.reduce((a, b) => a + b, 0n), bhd('10.000'));
});

test('AC8 (rejected): capitalized interest equals the sum of rounded accruals, nothing discarded', () => {
  for (const [acc, expected] of [['ACC-001', aed('0.93')], ['ACC-002', bhd('0.008')]]) {
    const cap = L.entries.find((e) => e.account === acc && e.type === 'INTEREST_CAPITALIZATION');
    const sum = L.accruals.filter((a) => a.account === acc).reduce((s, a) => s + a.amount, 0n);
    assert.equal(cap.amount, expected);
    assert.equal(sum, expected);
    assert.equal(cap.valueDay, 6);
  }
});

test('as-known-then closing balances per day', () => {
  const then = [1, 2, 3, 4, 5, 6].map((d) => L.balance('ACC-001', d, { bookedThrough: d }));
  assert.deepEqual(then, ['250.00', '250.00', '650.00', '465.00', '-230.00', '390.93'].map(aed));
  const reported = L.dayReports.map((r) => r.accounts['ACC-001'].closing);
  assert.deepEqual(reported, then);
});

test('E10 is a late arrival: it is booked on Day 6 with value Day 5, and a warning is raised', () => {
  const e = L.entries.filter((x) => x.ref === 'E10');
  assert.ok(e.every((x) => x.bookingDay === 6 && x.valueDay === 5));
  assert.ok(L.diagnostics.some((d) => d.code === 'LATE_ARRIVAL' && d.ref === 'E10' && d.day === 6));
  assert.equal(L.balance('ACC-002', 5), bhd('10.000'));
  assert.equal(L.balance('ACC-002', 5, { bookedThrough: 5 }), 0n);
});

test('replay is deterministic: running it twice gives an identical report', () => {
  assert.equal(renderReport(replay()), renderReport(replay()));
});

test('every stored record is frozen, so nothing can be edited in place', () => {
  for (const e of L.entries) assert.ok(Object.isFrozen(e));
  for (const a of L.accruals) assert.ok(Object.isFrozen(a));
  for (const t of L.authLog) assert.ok(Object.isFrozen(t));
  assert.throws(() => { L.entries[0].amount = 0n; }, TypeError);
  // The getters return copies; changing the copy leaves the ledger untouched.
  const n = L.entries.length;
  L.entries.pop();
  assert.equal(L.entries.length, n);
});
