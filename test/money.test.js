import test from 'node:test';
import assert from 'node:assert/strict';
import { toMinor, format, divRoundHalfEven, splitExactly } from '../src/money.js';

test('parses amounts into minor units at the currency precision', () => {
  assert.equal(toMinor('AED', '1,200.00'), 120000n);
  assert.equal(toMinor('AED', '25'), 2500n);
  assert.equal(toMinor('BHD', '10.000'), 10000n);
  assert.equal(toMinor('BHD', '0.5'), 500n);
});

test('refuses input with more decimals than the currency has', () => {
  assert.throws(() => toMinor('AED', '1.005'), /2 decimals/);
  assert.throws(() => toMinor('BHD', '3.3333'), /3 decimals/);
});

test('formats at the currency precision', () => {
  assert.equal(format('AED', -37000n), '-370.00');
  assert.equal(format('AED', 120000n), '1,200.00');
  assert.equal(format('BHD', 3334n), '3.334');
  assert.equal(format('BHD', 8n), '0.008');
});

test('half-even rounding sends ties to the even neighbour', () => {
  assert.equal(divRoundHalfEven(125n, 10n), 12n); // 12.5 -> 12
  assert.equal(divRoundHalfEven(135n, 10n), 14n); // 13.5 -> 14
  assert.equal(divRoundHalfEven(166n, 10n), 17n);
  assert.equal(divRoundHalfEven(-125n, 10n), -12n);
});

test('exact split conserves the total (10.000 BHD in three parts)', () => {
  const parts = splitExactly(10000n, 3);
  assert.deepEqual(parts, [3333n, 3333n, 3334n]);
  assert.equal(parts.reduce((a, b) => a + b, 0n), 10000n);
});
