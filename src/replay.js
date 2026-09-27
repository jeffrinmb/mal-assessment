import { fileURLToPath } from 'node:url';
import { Ledger } from './ledger.js';
import { ACCOUNTS, EVENTS } from './events.js';
import { LAST_DAY, FIRST_DAY } from './constants.js';
import { format } from './money.js';

// Replays events strictly in the order given. The ledger clock only moves
// forward: an event whose booking day is ahead of the clock closes the days
// in between. An event whose booking day is BEHIND the clock (E10) is a
// late arrival. It is posted on the current day, keeps its own value day,
// and a warning is raised. Closed days are never reopened.
export function replay(events = EVENTS, accounts = ACCOUNTS) {
  const ledger = new Ledger();
  for (const a of accounts) ledger.openAccount(a.id, a.ccy);

  for (const ev of events) {
    while (ledger.currentDay < ev.bookingDay) ledger.closeDay();
    if (ev.bookingDay < ledger.currentDay) {
      ledger.warn('LATE_ARRIVAL', ev.id,
        `declared booking day ${ev.bookingDay} but arrived after day ${ev.bookingDay} closed; booked on day ${ledger.currentDay}`);
    }
    apply(ledger, ev);
  }
  while (!ledger.windowClosed) ledger.closeDay();
  return ledger;
}

export function apply(ledger, ev) {
  const base = { ref: ev.id, account: ev.account, valueDay: ev.valueDay };
  switch (ev.type) {
    case 'CREDIT': return ledger.credit({ ...base, amount: ev.amount, instalments: ev.instalments ?? 1 });
    case 'DEBIT': return ledger.debit({ ...base, amount: ev.amount });
    case 'AUTHORIZATION': return ledger.authorize({ ...base, authId: ev.authId, amount: ev.amount });
    case 'SETTLEMENT': return ledger.settle({ ...base, authId: ev.authId, amount: ev.amount });
    case 'REVERSAL': return ledger.reverse({ ref: ev.id, target: ev.target, valueDay: ev.valueDay });
    default: throw new Error(`Unknown event type ${ev.type}`);
  }
}

// ---------------------------------------------------------------- report

const pad = (s, n) => String(s).padStart(n);
const signed = (ccy, v) => (v > 0n ? '+' : '') + format(ccy, v);

export function renderReport(ledger) {
  const out = [];
  const line = (s = '') => out.push(s);
  const customerAccounts = ledger.accounts.filter((a) => !a.internal);

  line('LEDGER REPLAY: Day 1 to Day 6');
  line('Balances are closing ledger balances (entries with value_date <= day).');
  line('The per-day section shows what was known at that day\'s close. See the bitemporal table at the end for restated figures.');

  for (const r of ledger.dayReports) {
    line();
    line(`==================== DAY ${r.day} CLOSE ====================`);
    for (const acc of ledger.accounts) {
      const s = r.accounts[acc.id];
      if (acc.internal && s.bookedToday.length === 0 && s.closing === 0n) continue;
      line(`${acc.id} (${s.ccy})${acc.internal ? ' [internal]' : ''}`);
      line(`  closing ledger balance : ${pad(format(s.ccy, s.closing), 12)}`);
      if (!acc.internal) {
        line(`  active holds           : ${pad(format(s.ccy, s.holds), 12)}`);
        line(`  available balance      : ${pad(format(s.ccy, s.available), 12)}`);
      }
      const postings = s.bookedToday.filter((e) => e.type !== 'FEE');
      const fees = s.bookedToday.filter((e) => e.type === 'FEE');
      line(`  postings booked today  : ${postings.length ? '' : 'none'}`);
      for (const e of postings) {
        line(`    ${e.id} ${e.ref.padEnd(12)} ${e.type.padEnd(24)} ${pad(signed(e.ccy, e.amount), 10)}  value day ${e.valueDay}${e.note ? `  (${e.note})` : ''}`);
      }
      if (!acc.internal) {
        line(`  fee assessments        : ${fees.length ? '' : 'none'}`);
        for (const e of fees) {
          line(`    ${e.id} ${e.type} ${signed(e.ccy, e.amount)} value day ${e.valueDay}${e.valueDay !== r.day ? ' (retroactive)' : ''}: ${e.note}`);
        }
        const acr = s.accruedToday.filter((a) => a.amount !== 0n || a.kind === 'DAILY');
        line(`  interest accruals      : ${acr.map((a) => `${a.kind === 'DAILY' ? '' : 'adj '}day ${a.valueDay} ${signed(a.ccy, a.amount)}`).join(', ') || 'none'}`);
      }
    }
    line('Authorizations');
    const ids = Object.keys(r.authStates);
    if (!ids.length) line('  none');
    for (const id of ids) {
      const moved = r.authTransitions.filter((t) => t.authId === id);
      const a = ledger.auth(id);
      const detail = moved.map((t) => {
        if (t.state === 'ACTIVE') return `approved, hold ${format(a.ccy, t.amount)}, available after ${format(a.ccy, t.availableAfter)}`;
        if (t.state === 'DECLINED') return `declined, available after hold would be ${format(a.ccy, t.availableAfter)}`;
        if (t.state === 'SETTLED') return `settled ${format(a.ccy, t.settled)}, released ${format(a.ccy, t.released)}`;
        if (t.state === 'EXPIRED') return `expired, released ${format(a.ccy, t.released)}`;
        return t.state;
      }).join('; ');
      line(`  ${id.padEnd(7)} ${r.authStates[id].padEnd(9)}${detail ? ` <- today: ${detail}` : ''}`);
    }
    line('Errors / warnings');
    if (!r.diagnostics.length) line('  none');
    for (const x of r.diagnostics) line(`  ${x.level.padEnd(5)} ${x.code} [${x.ref}] ${x.message}`);
  }

  // Bitemporal view: the same value day seen at its own close and at the end.
  line();
  line('==================== BITEMPORAL CLOSING BALANCES ====================');
  line('as-known-then = entries booked by that day\'s close; as-restated = all entries booked by end of Day 6');
  for (const acc of customerAccounts) {
    line(`${acc.id} (${acc.ccy})`);
    line(`  day  ${pad('as-known-then', 14)}  ${pad('as-restated', 14)}  ${pad('fee (value day)', 16)}`);
    for (let d = FIRST_DAY; d <= LAST_DAY; d += 1) {
      const then = ledger.balance(acc.id, d, { bookedThrough: d });
      const now = ledger.balance(acc.id, d);
      const fee = ledger.entries.filter((e) => e.account === acc.id && e.type === 'FEE' && e.valueDay === d)
        .reduce((s, e) => s + e.amount, 0n);
      line(`  ${pad(d, 3)}  ${pad(format(acc.ccy, then), 14)}  ${pad(format(acc.ccy, now), 14)}  ${pad(fee ? format(acc.ccy, fee) : '-', 16)}${then !== now ? '  *restated' : ''}`);
    }
  }

  line();
  line('==================== INTEREST RECONCILIATION ====================');
  for (const acc of customerAccounts) {
    const acr = ledger.accruals.filter((a) => a.account === acc.id);
    const perDay = [];
    for (let d = FIRST_DAY; d <= LAST_DAY; d += 1) {
      perDay.push(acr.filter((a) => a.valueDay === d).reduce((s, a) => s + a.amount, 0n));
    }
    const cap = ledger.entries.find((e) => e.account === acc.id && e.type === 'INTEREST_CAPITALIZATION');
    const sum = perDay.reduce((s, v) => s + v, 0n);
    line(`${acc.id}: net daily accruals ${perDay.map((v) => format(acc.ccy, v)).join(' + ')} = ${format(acc.ccy, sum)}; capitalized ${cap ? format(acc.ccy, cap.amount) : '0'} (${acr.length} accrual records)${(cap?.amount ?? 0n) === sum ? '  OK' : '  MISMATCH'}`);
  }

  line();
  line('==================== ACCEPTANCE-CRITERIA EVIDENCE ====================');
  const d2AtD5NoFee = ledger.balance('ACC-001', 2, { bookedThrough: 5, excludeTypes: ['FEE'] });
  line(`AC1 Day 2 closing, as known at end of Day 5, before fees : AED ${format('AED', d2AtD5NoFee)}`);
  const fees = ledger.entries.filter((e) => e.type === 'FEE');
  line(`AC2 overdraft fees assessed (value days)                : ${fees.map((e) => `D${e.valueDay}`).join(', ')} -> ${fees.length} fees, not 1`);
  line(`AC4 Auth-Z: customer entries ${ledger.entries.filter((e) => e.ref === 'E6' && e.account === 'ACC-001').length}, suspense entries ${ledger.entries.filter((e) => e.ref === 'E6' && e.type === 'SUSPENSE').length}`);
  line(`AC5 Auth-B final state                                  : ${ledger.authState('Auth-B')}`);
  line(`AC6 fees still on the ledger after E9                   : AED ${format('AED', fees.reduce((s, e) => s + e.amount, 0n))}`);
  line(`AC7 E10 instalments                                     : ${ledger.entries.filter((e) => e.ref === 'E10').map((e) => format('BHD', e.amount)).join(' / ')}`);

  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(renderReport(replay()));
}
