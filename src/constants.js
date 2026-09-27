// Every tunable number lives here. Rationale for each: NUMBERS.md.

export const FIRST_DAY = 1;
export const LAST_DAY = 6; // interest capitalizes at the close of this day

// Overdraft fee per currency, in minor units. Only AED is defined by the brief.
// A negative BHD account raises NO_FEE_CONFIGURED instead of inventing an FX rate.
export const OVERDRAFT_FEE = Object.freeze({ AED: 2500n });

// 0.04% per day as an exact fraction: 4 / 10000.
export const DAILY_RATE_NUM = 4n;
export const DAILY_RATE_DEN = 10000n;

// A hold lives for this many days, counting the day it was placed.
// It is released at the close of day (authDay + HOLD_EXPIRY_DAYS - 1).
export const HOLD_EXPIRY_DAYS = 7;

// Entries may be value-dated at most this many days before their booking day.
// Anything older is refused and would need maker-checker approval in production.
export const BACK_VALUE_WINDOW_DAYS = 5;
