import { toMinor } from './money.js';

export const ACCOUNTS = [
  { id: 'ACC-001', ccy: 'AED' },
  { id: 'ACC-002', ccy: 'BHD' },
];

// The event stream from the brief, in replay order. `bookingDay` is the day
// the event says it was booked. The replay driver compares it with the
// ledger clock (see replay.js).
export const EVENTS = [
  { id: 'E1', bookingDay: 1, type: 'CREDIT', account: 'ACC-001', amount: toMinor('AED', '1,200.00'), valueDay: 1 },
  { id: 'E2', bookingDay: 1, type: 'DEBIT', account: 'ACC-001', amount: toMinor('AED', '950.00'), valueDay: 1 },
  { id: 'E3', bookingDay: 2, type: 'AUTHORIZATION', account: 'ACC-001', authId: 'Auth-A', amount: toMinor('AED', '200.00'), valueDay: 2 },
  { id: 'E4', bookingDay: 3, type: 'CREDIT', account: 'ACC-001', amount: toMinor('AED', '400.00'), valueDay: 3 },
  { id: 'E5', bookingDay: 4, type: 'SETTLEMENT', account: 'ACC-001', authId: 'Auth-A', amount: toMinor('AED', '185.00'), valueDay: 4 },
  { id: 'E6', bookingDay: 4, type: 'SETTLEMENT', account: 'ACC-001', authId: 'Auth-Z', amount: toMinor('AED', '180.00'), valueDay: 4 },
  { id: 'E7', bookingDay: 5, type: 'DEBIT', account: 'ACC-001', amount: toMinor('AED', '620.00'), valueDay: 2 },
  { id: 'E8', bookingDay: 5, type: 'AUTHORIZATION', account: 'ACC-001', authId: 'Auth-B', amount: toMinor('AED', '90.00'), valueDay: 5 },
  { id: 'E9', bookingDay: 6, type: 'REVERSAL', account: 'ACC-001', target: 'E7', valueDay: 2 },
  { id: 'E10', bookingDay: 5, type: 'CREDIT', account: 'ACC-002', amount: toMinor('BHD', '10.000'), valueDay: 5, instalments: 3 },
];
