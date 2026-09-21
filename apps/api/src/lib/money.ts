/**
 * Money — the single owner of every monetary conversion and calculation (ADR 0006).
 *
 * ## The two representations, and where each is allowed
 *   - **Integer minor units** (`number`): what the DB stores, in columns suffixed
 *     `_minor` and typed `INTEGER` (FR4). `123456` is one thousand two hundred
 *     thirty-four dollars and fifty-six cents.
 *   - **Decimal string**: what JSON carries, always a string, **never** a JSON
 *     number (FR4). `"1234.56"`.
 *
 * Nothing outside this module may convert, round, add, or subtract money. The
 * repository layer calls in on the way in and out; no other layer does money math.
 *
 * ## The fixed exponent is the decision, not an oversight
 * `MONEY_EXPONENT` is hard-coded to 2. Zero-decimal currencies (JPY) and
 * three-decimal currencies (KWD, BHD) are therefore **not supported** — an accepted
 * limitation under A2 (one currency for the whole dataset). Input with more than two
 * decimal places is **rejected**, never rounded: silently turning `"1.005"` into
 * `"1.00"` or `"1.01"` is precisely the failure mode ADR 0006 exists to prevent, and
 * acceptance case 36 asserts the rejection.
 *
 * ## Why no floating point anywhere
 * The conversion never multiplies. `parseFloat("1.15") * 100` is
 * `114.99999999999999`, so any implementation built on that is wrong before it
 * starts. Instead the decimal string's digits are re-assembled into an integer
 * digit string (`"1234" + "56"` → `"123456"`) and parsed once with `Number()`,
 * which is exact for every integer up to `Number.MAX_SAFE_INTEGER`.
 *
 * ## Why `number` and not `bigint`
 * The exact-integer range of an IEEE-754 double is ±9,007,199,254,740,991
 * (~9.0e15 minor units, i.e. ~90 trillion major units). The largest value the
 * acceptance cases require, `"999999999.99"`, is `99_999_999_999` (~1.0e11) —
 * five orders of magnitude inside that range, and sums of millions of such rows
 * still are. `number` also matches what `better-sqlite3` hands back for an
 * `INTEGER` column with no `safeIntegers` mode, so `bigint` would add a
 * conversion at every repository boundary to buy headroom we cannot reach.
 * The trade is made safe rather than assumed: every value produced or accepted
 * here is checked against `MAX_MONEY_MINOR_UNITS` and rejected if it would land
 * outside the exact range, so the failure is loud rather than silently lossy.
 *
 * Framework-agnostic by rule: this module imports nothing at all (B1/B3).
 */

/* ------------------------------------------------------------------ *
 * Named constants — the fixed-exponent decision and its consequences
 * ------------------------------------------------------------------ */

/**
 * Decimal places in the minor unit. **Hard-coded to 2 (hundredths).** Changing
 * this number is not a supported configuration change; see the module note.
 */
export const MONEY_EXPONENT = 2;

/** Radix for every digit-string parse below. Never rely on an implicit default. */
const DECIMAL_RADIX = 10;

/** The character separating major from minor digits in a decimal string. */
const DECIMAL_POINT = '.';

/** Sign prefix emitted for negative amounts. */
const NEGATIVE_SIGN = '-';

/* A leading `+` is accepted by the pattern below but never emitted. */

/** Filler used when padding a short fractional part or a sub-unit amount. */
const ZERO_DIGIT = '0';

/**
 * The only accepted decimal-string shape: an optional sign, at least one integer
 * digit, and an optional fractional part of one or two digits.
 *
 * Deliberately strict — it rejects surrounding whitespace, thousands separators,
 * exponent notation (`1e2`), a bare `"."`, `".5"`, `"5."`, `"1.2.3"`, `Infinity`,
 * `NaN`, and the empty string. Input is never trimmed or repaired: a caller
 * sending `" 1.00 "` has a bug worth surfacing, not whitespace worth eating.
 */
const DECIMAL_AMOUNT_PATTERN = /^[+-]?\d+(?:\.\d{1,2})?$/;

/** Capture groups for the same shape, used after the pattern test passes. */
const DECIMAL_AMOUNT_PARTS_PATTERN = /^(?<sign>[+-])?(?<whole>\d+)(?:\.(?<fraction>\d{1,2}))?$/;

/**
 * Largest magnitude, in minor units, that a double represents exactly. Values
 * beyond this are rejected rather than silently rounded to a nearby double.
 */
export const MAX_MONEY_MINOR_UNITS = Number.MAX_SAFE_INTEGER;

/** Mirror of the above for negative amounts. */
export const MIN_MONEY_MINOR_UNITS = Number.MIN_SAFE_INTEGER;

/** Total digits a decimal string may carry, sign and point excluded. */
const MAX_SIGNIFICANT_DIGITS = String(MAX_MONEY_MINOR_UNITS).length;

/** Minimum width of the emitted minor-unit digit string: `0` + `.` + two digits. */
const MIN_FORMATTED_DIGITS = MONEY_EXPONENT + 1;

/* ------------------------------------------------------------------ *
 * Error messages — one named constant each, so tests and operators see
 * the same text and the reason is always stated explicitly.
 * ------------------------------------------------------------------ */

const ERROR_NOT_A_STRING = 'must be a decimal string, not a number or other type';
const ERROR_EMPTY = 'must not be empty';
const ERROR_NOT_DECIMAL_STRING = `is not a valid decimal amount (expected digits with at most ${String(MONEY_EXPONENT)} decimal places, e.g. "1234.56")`;
const ERROR_TOO_MANY_DECIMALS = `has more than ${String(MONEY_EXPONENT)} decimal places; amounts are never rounded, so this value cannot be represented`;
const ERROR_OUT_OF_RANGE = `exceeds the exactly representable range of +/-${String(MAX_MONEY_MINOR_UNITS)} minor units`;
const ERROR_MINOR_NOT_INTEGER = 'minor units must be a safe integer number of hundredths';
const ERROR_SUM_OUT_OF_RANGE = `result exceeds the exactly representable range of +/-${String(MAX_MONEY_MINOR_UNITS)} minor units`;

const QUOTE = '"';
const MESSAGE_SEPARATOR = ' ';

/**
 * Raised for every rejected amount. A single error type keeps the caller's
 * handling simple; `message` always names the offending value and the reason.
 */
export class MoneyConversionError extends Error {
  override readonly name = 'MoneyConversionError';

  constructor(
    reason: string,
    /** The rejected input, exactly as received. */
    readonly value: unknown,
  ) {
    super(`${QUOTE}${String(value)}${QUOTE}${MESSAGE_SEPARATOR}${reason}`);
  }
}

/* ------------------------------------------------------------------ *
 * Conversions
 * ------------------------------------------------------------------ */

/**
 * Decimal string → integer minor units. The JSON-to-DB direction.
 *
 * `"1234.56"` → `123456`, `"-0.07"` → `-7`, `"5"` → `500`, `"5.1"` → `510`.
 *
 * @throws MoneyConversionError for anything that is not exactly representable at
 * `MONEY_EXPONENT` decimal places — including `"1.005"` (more than two decimals),
 * non-numeric text, the empty string, and values outside the safe-integer range.
 * It never rounds and never returns a fallback.
 */
export function parseMoneyToMinorUnits(amount: string): number {
  // Widened deliberately: this module is the last line of defence for values
  // that reached it from JSON, where a bare number would already be a contract
  // violation (FR4 — money in JSON is a string). A `number` here must fail loudly
  // rather than be coerced, so the guard survives even though the type says string.
  const raw: unknown = amount;
  if (typeof raw !== 'string') {
    throw new MoneyConversionError(ERROR_NOT_A_STRING, raw);
  }
  if (amount.length === 0) {
    throw new MoneyConversionError(ERROR_EMPTY, amount);
  }

  if (!DECIMAL_AMOUNT_PATTERN.test(amount)) {
    // Distinguish the one failure the spec calls out by name — too much
    // precision — from "this is not a number at all", so the message tells the
    // caller which of the two rules they broke.
    throw new MoneyConversionError(
      hasExcessDecimalPlaces(amount) ? ERROR_TOO_MANY_DECIMALS : ERROR_NOT_DECIMAL_STRING,
      amount,
    );
  }

  const parts = DECIMAL_AMOUNT_PARTS_PATTERN.exec(amount)?.groups;
  if (parts === undefined) {
    throw new MoneyConversionError(ERROR_NOT_DECIMAL_STRING, amount);
  }

  const whole = parts.whole ?? ZERO_DIGIT;
  const fraction = (parts.fraction ?? '').padEnd(MONEY_EXPONENT, ZERO_DIGIT);
  const isNegative = parts.sign === NEGATIVE_SIGN;

  // No multiplication: concatenating the digit groups *is* the shift by
  // 10**MONEY_EXPONENT, so there is no float to lose precision.
  const digits = `${whole}${fraction}`;

  if (stripLeadingZeros(digits).length > MAX_SIGNIFICANT_DIGITS) {
    throw new MoneyConversionError(ERROR_OUT_OF_RANGE, amount);
  }

  const magnitude = Number.parseInt(digits, DECIMAL_RADIX);
  if (!Number.isSafeInteger(magnitude)) {
    throw new MoneyConversionError(ERROR_OUT_OF_RANGE, amount);
  }

  // `-0` would be an unpleasant thing to hand to SQLite or to compare against,
  // so a zero magnitude stays positive zero regardless of the input sign.
  return isNegative && magnitude !== 0 ? -magnitude : magnitude;
}

/**
 * Integer minor units → decimal string. The DB-to-JSON direction.
 *
 * `123456` → `"1234.56"`, `-7` → `"-0.07"`, `0` → `"0.00"`. The result always
 * carries exactly `MONEY_EXPONENT` decimal places, so it round-trips through
 * `parseMoneyToMinorUnits` unchanged (acceptance case 10).
 *
 * @throws MoneyConversionError if `minorUnits` is not a safe integer — a
 * fractional minor unit means someone did money math outside this module.
 */
export function formatMinorUnitsToMoney(minorUnits: number): string {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new MoneyConversionError(ERROR_MINOR_NOT_INTEGER, minorUnits);
  }

  const isNegative = minorUnits < 0;
  const digits = String(Math.abs(minorUnits)).padStart(MIN_FORMATTED_DIGITS, ZERO_DIGIT);
  const splitAt = digits.length - MONEY_EXPONENT;
  const whole = digits.slice(0, splitAt);
  const fraction = digits.slice(splitAt);

  return `${isNegative ? NEGATIVE_SIGN : ''}${whole}${DECIMAL_POINT}${fraction}`;
}

/* ------------------------------------------------------------------ *
 * Arithmetic — all of it, because no other module may do money math
 * ------------------------------------------------------------------ */

/** Sum minor-unit amounts exactly. @throws MoneyConversionError on overflow. */
export function addMinorUnits(...amounts: readonly number[]): number {
  let total = 0;
  for (const amount of amounts) {
    if (!Number.isSafeInteger(amount)) {
      throw new MoneyConversionError(ERROR_MINOR_NOT_INTEGER, amount);
    }
    total += amount;
    if (!Number.isSafeInteger(total)) {
      throw new MoneyConversionError(ERROR_SUM_OUT_OF_RANGE, total);
    }
  }
  return total;
}

/** `minuend - subtrahend` in minor units. @throws MoneyConversionError on overflow. */
export function subtractMinorUnits(minuend: number, subtrahend: number): number {
  if (!Number.isSafeInteger(subtrahend)) {
    throw new MoneyConversionError(ERROR_MINOR_NOT_INTEGER, subtrahend);
  }
  return addMinorUnits(minuend, -subtrahend);
}

/** Flip the sign of a minor-unit amount, never producing `-0`. */
export function negateMinorUnits(minorUnits: number): number {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new MoneyConversionError(ERROR_MINOR_NOT_INTEGER, minorUnits);
  }
  return minorUnits === 0 ? 0 : -minorUnits;
}

/**
 * True when `amount` is a decimal string this module can represent exactly.
 * For validation sites that want a boolean instead of a thrown error.
 */
export function isValidMoneyString(amount: string): boolean {
  try {
    parseMoneyToMinorUnits(amount);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

/** True for numeric-looking input whose only fault is excess precision. */
function hasExcessDecimalPlaces(amount: string): boolean {
  const excessPrecision = new RegExp(
    `^[+-]?\\d+\\${DECIMAL_POINT}\\d{${String(MONEY_EXPONENT + 1)},}$`,
  );
  return excessPrecision.test(amount);
}

/** Drop leading zeros so `"000123"` is measured as three digits, not six. */
function stripLeadingZeros(digits: string): string {
  const firstSignificant = digits.search(/[1-9]/);
  return firstSignificant === -1 ? ZERO_DIGIT : digits.slice(firstSignificant);
}
