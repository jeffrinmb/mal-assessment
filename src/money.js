// Money is always an integer count of minor units (BigInt), tagged by currency.
// No floats anywhere in the money path.

export const CURRENCY_EXPONENT = Object.freeze({ AED: 2, BHD: 3 });

export function exponent(ccy) {
  const e = CURRENCY_EXPONENT[ccy];
  if (e === undefined) throw new Error(`Unknown currency ${ccy}`);
  return e;
}

// "1,200.00" -> 120000n (AED). Refuses more decimals than the currency allows
// rather than silently rounding an input amount.
export function toMinor(ccy, text) {
  const e = exponent(ccy);
  const s = String(text).replace(/,/g, '').trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`Bad amount "${text}"`);
  const frac = m[3] ?? '';
  if (frac.length > e) {
    throw new Error(`${ccy} has ${e} decimals; "${text}" has ${frac.length}`);
  }
  const v = BigInt(m[2]) * 10n ** BigInt(e) + BigInt(frac.padEnd(e, '0') || '0');
  return m[1] ? -v : v;
}

export function format(ccy, minor) {
  const e = exponent(ccy);
  const neg = minor < 0n;
  const a = neg ? -minor : minor;
  const scale = 10n ** BigInt(e);
  const whole = (a / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (a % scale).toString().padStart(e, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

// round(num / den) to an integer, ties to even (banker's rounding). den > 0.
export function divRoundHalfEven(num, den) {
  if (den <= 0n) throw new Error('den must be positive');
  const neg = num < 0n;
  const n = neg ? -num : num;
  let q = n / den;
  const twiceRem = (n % den) * 2n;
  if (twiceRem > den || (twiceRem === den && q % 2n === 1n)) q += 1n;
  return neg ? -q : q;
}

// Split a non-negative total into n parts that differ by at most one minor
// unit and sum exactly to the total. Leftover units go to the LAST parts,
// so 10.000 / 3 -> 3.333, 3.333, 3.334.
export function splitExactly(total, n) {
  if (total < 0n) throw new Error('splitExactly expects a non-negative total');
  if (!Number.isInteger(n) || n < 1) throw new Error('n must be a positive integer');
  const N = BigInt(n);
  const base = total / N;
  const extra = Number(total - base * N);
  return Array.from({ length: n }, (_, i) => (i >= n - extra ? base + 1n : base));
}
