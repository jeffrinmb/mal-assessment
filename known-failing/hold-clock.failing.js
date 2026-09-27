// KNOWN-FAILING TEST. It is kept outside test/ so `npm test` stays green.
// Run it with: npm run test:failing
//
// What it asks: "a hold placed on Day 5 is no longer blocking funds by Day 12".
// In real card processing that is true: an unsettled authorization lapses
// after the scheme's hold period whether or not anything else happens on the
// account.
//
// Why it fails: this design has no clock. Time moves only when closeDay() is
// called, and the replay driver calls closeDay() only to reach the booking day
// of the next event, or to finish the window. Hold state is a log of
// transitions (ACTIVE -> SETTLED/EXPIRED/...). It is not a function of time,
// so a question about Day 12, asked while the ledger is still on Day 5, is
// answered with the hold state as of now.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { toMinor } from '../src/money.js';

const aed = (s) => toMinor('AED', s);

test('a Day-5 hold no longer reduces available balance on Day 12', () => {
  const l = new Ledger({ lastDay: 14 });
  l.openAccount('A', 'AED');
  l.credit({ ref: 'c', account: 'A', amount: aed('100.00'), valueDay: 1 });
  for (let i = 0; i < 4; i += 1) l.closeDay();                // now Day 5
  // Auth-B's shape (90.00 on Day 5), but on an account where it gets approved.
  assert.equal(l.authorize({ ref: 'E8-like', authId: 'Auth-B', account: 'A', amount: aed('90.00'), valueDay: 5 }), 'ACTIVE');

  // No further events: a merchant that never settles produces nothing.
  //
  // REVEALS (1): availableOn() takes a day argument, but only the ledger-
  // balance half of the formula honours it. activeHolds() ignores the day.
  // Available is therefore NOT a bitemporal query, although the ledger balance
  // is. The report's "available" column cannot be restated for past days
  // either.
  //
  // REVEALS (2): HOLD_EXPIRY_DAYS exists and #expireHolds() is correct, but it
  // only runs inside closeDay(). A merchant that never settles emits no event,
  // so nothing drives the clock. An inert account keeps the hold until
  // something unrelated happens to it.
  //
  // REVEALS (3): the day this hold should lapse (close of Day 11) is past the
  // brief's Day-6 window. Inside the window the expiry path can never fire
  // (see test/invariants.test.js). The Day-6 report therefore can only ever
  // show an approved-and-unsettled hold as ACTIVE.
  //
  // Fix I would make: derive hold state from (log, asOfDay). An ACTIVE hold
  // whose expiry day is <= asOfDay counts as EXPIRED in any query, and a
  // scheduler (not the event stream) appends the HOLD_EXPIRED record.
  assert.equal(l.availableOn('A', 12), aed('100.00'));        // actual: 10.00
});
