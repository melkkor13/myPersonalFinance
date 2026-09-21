/**
 * Cases 10 and 36 — `lib/money.ts`.
 *
 * The scaffold's money rule (ADR 0006) is a fixed exponent of 2: amounts are
 * decimal strings at the boundary and integer minor units inside. These tests
 * pin both halves of it — lossless round-tripping, and **rejection rather than
 * rounding** of anything that cannot be represented. The second half is the point:
 * `parseFloat("1.005") * 100` silently yields `100.49999999999999`, and a suite
 * that only checked the happy values would never notice.
 */
import { describe, expect, it } from 'vitest';

import {
  formatMinorUnitsToMoney,
  MoneyConversionError,
  parseMoneyToMinorUnits,
} from '../src/lib/money.js';

/** The five values case 10 names, with their exact minor-unit encodings. */
const ROUND_TRIP_VALUES = [
  { decimal: '0.01', minorUnits: 1 },
  { decimal: '1234.56', minorUnits: 123_456 },
  { decimal: '-0.07', minorUnits: -7 },
  { decimal: '0.00', minorUnits: 0 },
  { decimal: '999999999.99', minorUnits: 99_999_999_999 },
] as const;

/** The canonical example case 10 calls out on its own. */
const CANONICAL_DECIMAL = '1234.56';
const CANONICAL_MINOR_UNITS = 123_456;

/**
 * Inputs that must be **rejected, not rounded or coerced**. `"1.005"` is the
 * headline: it is the value that documents the fixed-exponent-2 limitation
 * instead of hiding it behind a rounding mode.
 */
const REJECTED_INPUTS = [
  '1.005',
  '0.001',
  '-1.005',
  'abc',
  '',
  '1.2.3',
  '.',
  '.5',
  '5.',
  ' 1.00 ',
  '1,234.56',
  '1e2',
  'Infinity',
  'NaN',
  '-',
  '$1.00',
] as const;

/** Non-integer / unsafe minor-unit values the formatter must reject. */
const REJECTED_MINOR_UNITS = [1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e300] as const;

/** Substring the >2dp message must contain, so the error is actionable. */
const EXCESS_DECIMALS_MESSAGE_FRAGMENT = 'decimal places';

describe('money — lossless 2dp round-tripping (case 10)', () => {
  it.each(ROUND_TRIP_VALUES)(
    'round-trips $decimal through $minorUnits identically',
    ({ decimal, minorUnits }) => {
      expect(parseMoneyToMinorUnits(decimal)).toBe(minorUnits);
      expect(formatMinorUnitsToMoney(minorUnits)).toBe(decimal);
      expect(formatMinorUnitsToMoney(parseMoneyToMinorUnits(decimal))).toBe(decimal);
    },
  );

  it('converts "1234.56" to exactly 123456 minor units', () => {
    expect(parseMoneyToMinorUnits(CANONICAL_DECIMAL)).toBe(CANONICAL_MINOR_UNITS);
  });

  it('keeps a negative zero magnitude out of the formatted output', () => {
    expect(formatMinorUnitsToMoney(parseMoneyToMinorUnits('-0.00'))).toBe('0.00');
  });
});

describe('money — rejects rather than rounds (case 36)', () => {
  it.each(REJECTED_INPUTS)('rejects %o with a MoneyConversionError', (input) => {
    expect(() => parseMoneyToMinorUnits(input)).toThrow(MoneyConversionError);
  });

  it('names the >2dp limitation explicitly for "1.005" instead of rounding it', () => {
    let thrown: unknown;
    try {
      parseMoneyToMinorUnits('1.005');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MoneyConversionError);
    expect((thrown as MoneyConversionError).message).toContain(EXCESS_DECIMALS_MESSAGE_FRAGMENT);
  });

  it.each(REJECTED_MINOR_UNITS)('refuses to format %o as an amount', (minorUnits) => {
    expect(() => formatMinorUnitsToMoney(minorUnits)).toThrow(MoneyConversionError);
  });
});
