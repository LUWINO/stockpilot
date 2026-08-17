import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  applyRounding,
  compare,
  CurrencyMismatchError,
  format,
  fromMajorUnits,
  isNegative,
  isPositive,
  isZero,
  max,
  min,
  money,
  multiply,
  negate,
  subtract,
  sumMoney,
  zero,
} from './money.ts';

describe('money construction', () => {
  it('normalises the currency code to upper case', () => {
    expect(money(100, 'gbp').currency).toBe('GBP');
  });

  it('rejects fractional amounts, because minor units are indivisible', () => {
    expect(() => money(10.5, 'GBP')).toThrow(TypeError);
  });

  it('rejects amounts beyond the safe integer range', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 2, 'GBP')).toThrow(RangeError);
  });

  it('rejects anything that is not a three-letter ISO code', () => {
    expect(() => money(100, 'POUNDS')).toThrow(TypeError);
    expect(() => money(100, 'G1P')).toThrow(TypeError);
  });

  it('is immutable once built', () => {
    const value = money(100, 'GBP');
    expect(() => {
      (value as { amount: number }).amount = 200;
    }).toThrow();
  });
});

describe('fromMajorUnits', () => {
  it('converts a decimal to minor units', () => {
    expect(fromMajorUnits(12.34, 'GBP').amount).toBe(1234);
  });

  it('absorbs binary floating-point error rather than propagating it', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE 754.
    expect(fromMajorUnits(0.1 + 0.2, 'GBP').amount).toBe(30);
  });

  it('rounds ties away from zero, symmetrically about zero', () => {
    // 0.125 is exactly representable in binary, so this is a genuine tie at 12.5.
    expect(fromMajorUnits(0.125, 'GBP').amount).toBe(13);
    expect(fromMajorUnits(-0.125, 'GBP').amount).toBe(-13);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(add(money(1999, 'GBP'), money(1, 'GBP')).amount).toBe(2000);
    expect(subtract(money(2000, 'GBP'), money(1, 'GBP')).amount).toBe(1999);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(100, 'GBP'), money(100, 'EUR'))).toThrow(CurrencyMismatchError);
    expect(() => subtract(money(100, 'GBP'), money(100, 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => compare(money(100, 'GBP'), money(100, 'USD'))).toThrow(CurrencyMismatchError);
  });

  it('negates', () => {
    expect(negate(money(250, 'GBP')).amount).toBe(-250);
  });

  it('sums a list, returning zero for an empty one', () => {
    expect(sumMoney([money(100, 'GBP'), money(250, 'GBP')], 'GBP').amount).toBe(350);
    expect(sumMoney([], 'GBP')).toEqual(zero('GBP'));
  });

  it('multiplies exactly by an integer quantity', () => {
    expect(multiply(money(1850, 'GBP'), 12).amount).toBe(22_200);
  });

  it('rejects a non-finite multiplier', () => {
    expect(() => multiply(money(100, 'GBP'), Number.NaN)).toThrow(TypeError);
  });
});

describe('rounding modes', () => {
  it('uses banker’s rounding by default so long series do not drift upward', () => {
    // Both are exact ties; half-even sends them to the nearest even integer.
    expect(applyRounding(2.5, 'half-even')).toBe(2);
    expect(applyRounding(3.5, 'half-even')).toBe(4);
    expect(applyRounding(-2.5, 'half-even')).toBe(-2);
  });

  it('supports the other explicit modes', () => {
    expect(applyRounding(2.5, 'half-away-from-zero')).toBe(3);
    expect(applyRounding(-2.5, 'half-away-from-zero')).toBe(-3);
    expect(applyRounding(2.9, 'floor')).toBe(2);
    expect(applyRounding(2.1, 'ceil')).toBe(3);
  });

  it('accumulates no bias across many tie-rounded multiplications', () => {
    // Every one of these is an exact .5 tie. Half-up would gain 50 minor units
    // over 100 operations; half-even should land within a couple of units of zero.
    let drift = 0;
    for (let i = 1; i <= 100; i += 1) {
      const exact = i * 0.5;
      drift += applyRounding(exact, 'half-even') - exact;
    }
    expect(Math.abs(drift)).toBeLessThanOrEqual(1);
  });
});

describe('allocate', () => {
  it('splits without creating or destroying money', () => {
    const parts = allocate(money(100, 'GBP'), 3);
    expect(parts.map((p) => p.amount)).toEqual([34, 33, 33]);
    expect(parts.reduce((acc, p) => acc + p.amount, 0)).toBe(100);
  });

  it('handles an exact division', () => {
    expect(allocate(money(100, 'GBP'), 4).map((p) => p.amount)).toEqual([25, 25, 25, 25]);
  });

  it('preserves the total for negative amounts too', () => {
    const parts = allocate(money(-100, 'GBP'), 3);
    expect(parts.reduce((acc, p) => acc + p.amount, 0)).toBe(-100);
  });

  it('rejects a non-positive part count', () => {
    expect(() => allocate(money(100, 'GBP'), 0)).toThrow(RangeError);
    expect(() => allocate(money(100, 'GBP'), 2.5)).toThrow(RangeError);
  });
});

describe('comparison and predicates', () => {
  it('orders amounts', () => {
    expect(compare(money(1, 'GBP'), money(2, 'GBP'))).toBe(-1);
    expect(compare(money(2, 'GBP'), money(2, 'GBP'))).toBe(0);
    expect(compare(money(3, 'GBP'), money(2, 'GBP'))).toBe(1);
    expect(max(money(1, 'GBP'), money(2, 'GBP')).amount).toBe(2);
    expect(min(money(1, 'GBP'), money(2, 'GBP')).amount).toBe(1);
  });

  it('classifies sign', () => {
    expect(isZero(zero('GBP'))).toBe(true);
    expect(isNegative(money(-1, 'GBP'))).toBe(true);
    expect(isPositive(money(1, 'GBP'))).toBe(true);
  });
});

describe('format', () => {
  it('renders minor units as a currency string', () => {
    // Intl inserts a narrow no-break space in some locales, so match loosely.
    expect(format(money(123_456, 'GBP'))).toMatch(/1,234\.56/);
  });
});
