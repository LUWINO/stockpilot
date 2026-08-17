/**
 * Integer money.
 *
 * A `Money` value is a whole number of minor units (pence, cents) tagged with an
 * ISO 4217 currency. Every operation is exact; the only place rounding happens is
 * `multiply`, and it is explicit about which rule it applied.
 */

export interface Money {
  /** Whole number of minor units. May be negative. */
  readonly amount: number;
  /** ISO 4217 alphabetic code, upper case. */
  readonly currency: string;
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Cannot combine ${a} with ${b}: currencies must match`);
    this.name = 'CurrencyMismatchError';
  }
}

const ISO_4217 = /^[A-Z]{3}$/;

export function money(amount: number, currency: string): Money {
  if (!Number.isInteger(amount)) {
    throw new TypeError(`Money amount must be an integer number of minor units, received ${amount}`);
  }
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`Money amount ${amount} exceeds the safe integer range`);
  }
  const code = currency.toUpperCase();
  if (!ISO_4217.test(code)) {
    throw new TypeError(`Invalid ISO 4217 currency code: ${currency}`);
  }
  return Object.freeze({ amount, currency: code });
}

export function zero(currency: string): Money {
  return money(0, currency);
}

/** Build `Money` from a major-unit decimal (e.g. 12.34 GBP). Rounds half away from zero. */
export function fromMajorUnits(value: number, currency: string, minorUnitDigits = 2): Money {
  const factor = 10 ** minorUnitDigits;
  return money(roundHalfAwayFromZero(value * factor), currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amount, a.currency);
}

export function sumMoney(values: readonly Money[], currency: string): Money {
  return values.reduce<Money>((acc, v) => add(acc, v), zero(currency));
}

export type RoundingMode = 'half-away-from-zero' | 'half-even' | 'floor' | 'ceil';

/**
 * Scale an amount by an arbitrary factor.
 *
 * Quantities are integers, so `multiply(unitCost, 12)` is exact. A fractional
 * factor (a tax rate, a markdown) needs a rounding rule, and the caller picks it.
 */
export function multiply(a: Money, factor: number, mode: RoundingMode = 'half-even'): Money {
  if (!Number.isFinite(factor)) throw new TypeError(`Multiplier must be finite, received ${factor}`);
  return money(applyRounding(a.amount * factor, mode), a.currency);
}

export function applyRounding(value: number, mode: RoundingMode): number {
  switch (mode) {
    case 'floor':
      return Math.floor(value);
    case 'ceil':
      return Math.ceil(value);
    case 'half-away-from-zero':
      return roundHalfAwayFromZero(value);
    case 'half-even':
      return roundHalfEven(value);
  }
}

function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Banker's rounding. Ties go to the nearest even integer, so a long series of
 * roundings does not accumulate an upward bias — the behaviour accountants expect.
 */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

export const isZero = (a: Money): boolean => a.amount === 0;
export const isNegative = (a: Money): boolean => a.amount < 0;
export const isPositive = (a: Money): boolean => a.amount > 0;

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

/**
 * Split an amount into `n` parts that sum back to exactly the original.
 *
 * The remainder is distributed one minor unit at a time across the leading parts,
 * so no money is created or destroyed by the split.
 */
export function allocate(a: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new RangeError(`Cannot allocate into ${parts} parts`);
  }
  const base = Math.trunc(a.amount / parts);
  let remainder = a.amount - base * parts;
  const step = remainder < 0 ? -1 : 1;
  const out: Money[] = [];
  for (let i = 0; i < parts; i += 1) {
    if (remainder !== 0) {
      out.push(money(base + step, a.currency));
      remainder -= step;
    } else {
      out.push(money(base, a.currency));
    }
  }
  return out;
}

/** Render for humans and logs. Not for persistence — store `amount` and `currency`. */
export function format(a: Money, locale = 'en-GB', minorUnitDigits = 2): string {
  const value = a.amount / 10 ** minorUnitDigits;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: a.currency,
    minimumFractionDigits: minorUnitDigits,
  }).format(value);
}
