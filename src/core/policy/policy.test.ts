import { describe, expect, it } from 'vitest';
import { money } from '../money.ts';
import {
  computeSafetyStock,
  coverDays,
  serviceLevelZ,
  summariseLeadTime,
} from './safety-stock.ts';
import {
  applyOrderConstraints,
  DEFAULT_HOLDING_COST_RATE,
  economicOrderQuantity,
  holdingCostPerUnitPerYear,
  planReplenishment,
} from './replenishment.ts';
import {
  ABC_THRESHOLDS,
  classifyAbc,
  classifyXyz,
  policyFor,
  segmentCatalogue,
} from './classification.ts';
import { makeSupplier } from '@/testing/fixtures';

describe('serviceLevelZ', () => {
  it('returns the textbook multipliers', () => {
    expect(serviceLevelZ(0.5)).toBeCloseTo(0, 6);
    expect(serviceLevelZ(0.95)).toBeCloseTo(1.645, 3);
    expect(serviceLevelZ(0.99)).toBeCloseTo(2.326, 3);
  });

  it('clamps rather than diverging at the extremes', () => {
    // Below 50% the buffer would be negative, which is a modelling error.
    expect(serviceLevelZ(0.1)).toBeCloseTo(0, 6);
    expect(Number.isFinite(serviceLevelZ(1))).toBe(true);
  });
});

describe('computeSafetyStock', () => {
  it('applies King’s formula for demand variability alone', () => {
    // z(0.95) × √(4 × 5²) = 1.645 × 10 = 16.45, rounded up to 17.
    const result = computeSafetyStock({
      averageDailyDemand: 10,
      demandStdDev: 5,
      leadTimeDays: 4,
      leadTimeStdDevDays: 0,
      serviceLevel: 0.95,
    });

    expect(result.safetyStock).toBe(17);
    expect(result.leadTimeDemand).toBe(40);
    expect(result.reorderPoint).toBe(57);
    expect(result.leadTimeVarianceShare).toBe(0);
  });

  it('adds lead-time variance, which is often the larger term', () => {
    const steadySupplier = computeSafetyStock({
      averageDailyDemand: 10,
      demandStdDev: 2,
      leadTimeDays: 7,
      leadTimeStdDevDays: 0,
      serviceLevel: 0.95,
    });

    const erraticSupplier = computeSafetyStock({
      averageDailyDemand: 10,
      demandStdDev: 2,
      leadTimeDays: 7,
      leadTimeStdDevDays: 3,
      serviceLevel: 0.95,
    });

    expect(erraticSupplier.safetyStock).toBeGreaterThan(steadySupplier.safetyStock * 3);
    expect(erraticSupplier.leadTimeVarianceShare).toBeGreaterThan(0.8);
  });

  it('raises the buffer as the service level rises', () => {
    const base = { averageDailyDemand: 10, demandStdDev: 4, leadTimeDays: 5, leadTimeStdDevDays: 1 };
    const at90 = computeSafetyStock({ ...base, serviceLevel: 0.9 }).safetyStock;
    const at99 = computeSafetyStock({ ...base, serviceLevel: 0.99 }).safetyStock;

    expect(at99).toBeGreaterThan(at90);
  });

  it('needs no buffer when nothing varies', () => {
    const result = computeSafetyStock({
      averageDailyDemand: 10,
      demandStdDev: 0,
      leadTimeDays: 5,
      leadTimeStdDevDays: 0,
      serviceLevel: 0.99,
    });

    expect(result.safetyStock).toBe(0);
    expect(result.reorderPoint).toBe(50);
  });

  it('rejects negative inputs rather than producing a meaningless buffer', () => {
    const base = { averageDailyDemand: 10, demandStdDev: 1, leadTimeDays: 5, leadTimeStdDevDays: 1, serviceLevel: 0.95 };
    expect(() => computeSafetyStock({ ...base, leadTimeDays: -1 })).toThrow(RangeError);
    expect(() => computeSafetyStock({ ...base, demandStdDev: -1 })).toThrow(RangeError);
    expect(() => computeSafetyStock({ ...base, leadTimeStdDevDays: -1 })).toThrow(RangeError);
  });
});

describe('summariseLeadTime', () => {
  it('assumes a pessimistic spread for a supplier with no track record', () => {
    const result = summariseLeadTime([], 8);
    expect(result.leadTimeDays).toBe(8);
    expect(result.leadTimeStdDevDays).toBe(2);
    expect(result.samples).toBe(0);
  });

  it('keeps the pessimistic spread until there are at least two deliveries', () => {
    const result = summariseLeadTime([6], 8);
    expect(result.leadTimeDays).toBe(6);
    expect(result.leadTimeStdDevDays).toBe(2);
  });

  it('uses observed statistics once there is real evidence', () => {
    const result = summariseLeadTime([4, 5, 6, 5], 10);
    expect(result.leadTimeDays).toBe(5);
    expect(result.leadTimeStdDevDays).toBeCloseTo(0.8165, 3);
    expect(result.samples).toBe(4);
  });

  it('discards impossible observations', () => {
    expect(summariseLeadTime([5, -3, Number.NaN, 5], 7).samples).toBe(2);
  });
});

describe('coverDays', () => {
  it('divides stock by demand', () => {
    expect(coverDays(100, 10)).toBe(10);
  });

  it('reports unlimited cover when there is no demand, not zero', () => {
    expect(coverDays(100, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('economicOrderQuantity', () => {
  it('matches the Wilson formula', () => {
    // √(2 × 1000 × 1000 / 200) = 100.
    expect(
      economicOrderQuantity({
        annualDemand: 1000,
        orderingCost: money(1000, 'GBP'),
        holdingCostPerUnitPerYear: money(200, 'GBP'),
      }),
    ).toBe(100);
  });

  it('orders larger batches when raising an order is expensive', () => {
    const cheap = economicOrderQuantity({
      annualDemand: 5000,
      orderingCost: money(500, 'GBP'),
      holdingCostPerUnitPerYear: money(100, 'GBP'),
    });
    const expensive = economicOrderQuantity({
      annualDemand: 5000,
      orderingCost: money(5000, 'GBP'),
      holdingCostPerUnitPerYear: money(100, 'GBP'),
    });

    expect(expensive).toBeGreaterThan(cheap);
  });

  it('is zero when there is no demand', () => {
    expect(
      economicOrderQuantity({
        annualDemand: 0,
        orderingCost: money(1000, 'GBP'),
        holdingCostPerUnitPerYear: money(200, 'GBP'),
      }),
    ).toBe(0);
  });

  it('refuses to divide by a zero holding cost or mix currencies', () => {
    expect(() =>
      economicOrderQuantity({
        annualDemand: 100,
        orderingCost: money(1000, 'GBP'),
        holdingCostPerUnitPerYear: money(0, 'GBP'),
      }),
    ).toThrow(RangeError);

    expect(() =>
      economicOrderQuantity({
        annualDemand: 100,
        orderingCost: money(1000, 'GBP'),
        holdingCostPerUnitPerYear: money(200, 'EUR'),
      }),
    ).toThrow(TypeError);
  });
});

describe('holdingCostPerUnitPerYear', () => {
  it('applies the configured rate to unit cost', () => {
    expect(holdingCostPerUnitPerYear(money(1000, 'GBP'), 0.25).amount).toBe(250);
    expect(holdingCostPerUnitPerYear(money(1000, 'GBP')).amount).toBe(
      Math.round(1000 * DEFAULT_HOLDING_COST_RATE),
    );
  });
});

describe('applyOrderConstraints', () => {
  it('raises to the minimum before rounding to the case multiple', () => {
    expect(applyOrderConstraints(7, 10, 4)).toBe(12);
  });

  it('always rounds up, so a replenishment is never quietly cut short', () => {
    expect(applyOrderConstraints(11, 0, 5)).toBe(15);
    expect(applyOrderConstraints(10, 0, 5)).toBe(10);
  });

  it('passes through when there are no constraints', () => {
    expect(applyOrderConstraints(13, 0, 1)).toBe(13);
  });

  it('keeps zero at zero, so constraints cannot manufacture an order', () => {
    expect(applyOrderConstraints(0, 50, 10)).toBe(0);
  });
});

describe('planReplenishment', () => {
  const baseInput = {
    available: 40,
    onOrder: 0,
    averageDailyDemand: 20,
    demandStdDev: 6,
    serviceLevel: 0.95,
    supplier: makeSupplier(),
    observedLeadTimeDays: [5, 5, 6, 4],
    unitCost: money(1_850, 'GBP'),
    reviewPeriodDays: 1,
  };

  it('orders when the position falls to the reorder point', () => {
    const plan = planReplenishment(baseInput);

    expect(plan.shouldOrder).toBe(true);
    expect(plan.orderQuantity).toBeGreaterThan(0);
    expect(plan.inventoryPosition).toBe(40);
    expect(plan.coverDaysAfterOrder).toBeGreaterThan(plan.coverDaysNow);
  });

  it('does not order when there is plenty of stock', () => {
    const plan = planReplenishment({ ...baseInput, available: 5000 });

    expect(plan.shouldOrder).toBe(false);
    expect(plan.orderQuantity).toBe(0);
    expect(plan.rationale).toMatch(/above the reorder point/);
  });

  it('counts stock already on order, so the same order is not placed twice', () => {
    const withoutInbound = planReplenishment(baseInput);
    const withInbound = planReplenishment({ ...baseInput, onOrder: 5000 });

    expect(withoutInbound.shouldOrder).toBe(true);
    expect(withInbound.shouldOrder).toBe(false);
  });

  it('respects the supplier’s minimum and case multiple', () => {
    const plan = planReplenishment({
      ...baseInput,
      supplier: makeSupplier({ minimumOrderQuantity: 200, orderMultiple: 25 }),
    });

    expect(plan.orderQuantity).toBeGreaterThanOrEqual(200);
    expect(plan.orderQuantity % 25).toBe(0);
  });

  it('never orders for a SKU with no demand', () => {
    const plan = planReplenishment({ ...baseInput, averageDailyDemand: 0, available: 0 });
    expect(plan.shouldOrder).toBe(false);
  });

  it('holds more stock for an unreliable supplier than a dependable one', () => {
    const dependable = planReplenishment({ ...baseInput, observedLeadTimeDays: [5, 5, 5, 5] });
    const erratic = planReplenishment({ ...baseInput, observedLeadTimeDays: [1, 9, 2, 14] });

    expect(erratic.safetyStock).toBeGreaterThan(dependable.safetyStock);
    expect(erratic.reorderPoint).toBeGreaterThan(dependable.reorderPoint);
  });

  it('lengthens the exposure window when reviews are infrequent', () => {
    const daily = planReplenishment({ ...baseInput, reviewPeriodDays: 1 });
    const weekly = planReplenishment({ ...baseInput, reviewPeriodDays: 7 });

    expect(weekly.orderUpToLevel).toBeGreaterThan(daily.orderUpToLevel);
    expect(weekly.safetyStock).toBeGreaterThan(daily.safetyStock);
  });

  it('values the order at unit cost', () => {
    const plan = planReplenishment(baseInput);
    expect(plan.orderValue.amount).toBe(plan.orderQuantity * 1_850);
    expect(plan.orderValue.currency).toBe('GBP');
  });

  it('writes a rationale that names the numbers behind the call', () => {
    const plan = planReplenishment(baseInput);
    expect(plan.rationale).toMatch(/reorder point/);
    expect(plan.rationale).toMatch(/service level/);
  });
});

describe('classifyAbc', () => {
  it('splits the catalogue on cumulative value', () => {
    const result = classifyAbc([
      { skuId: 'high', annualValue: 800 },
      { skuId: 'mid', annualValue: 150 },
      { skuId: 'low', annualValue: 50 },
    ]);

    expect(result.map((r) => r.abc)).toEqual(['A', 'B', 'C']);
    expect(result[0]?.cumulativeShare).toBeCloseTo(0.8, 6);
    expect(result[2]?.cumulativeShare).toBeCloseTo(1, 6);
  });

  it('honours the documented thresholds', () => {
    expect(ABC_THRESHOLDS.a).toBe(0.8);
    expect(ABC_THRESHOLDS.b).toBe(0.95);
  });

  it('breaks ties deterministically, so classes do not churn between runs', () => {
    const items = [
      { skuId: 'b', annualValue: 100 },
      { skuId: 'a', annualValue: 100 },
      { skuId: 'c', annualValue: 100 },
    ];

    expect(classifyAbc(items).map((r) => r.skuId)).toEqual(['a', 'b', 'c']);
    expect(classifyAbc([...items].reverse()).map((r) => r.skuId)).toEqual(['a', 'b', 'c']);
  });

  it('treats a valueless catalogue as all C rather than dividing by zero', () => {
    const result = classifyAbc([{ skuId: 'x', annualValue: 0 }]);
    expect(result[0]?.abc).toBe('C');
  });

  it('puts a single dominant SKU in class A, not C', () => {
    // Its own value carries the cumulative share past 95% immediately, so
    // classifying on the inclusive share would misfile the most important SKU
    // in the catalogue.
    const result = classifyAbc([
      { skuId: 'dominant', annualValue: 980 },
      { skuId: 'rest', annualValue: 20 },
    ]);

    expect(result[0]?.abc).toBe('A');
    expect(result[1]?.abc).toBe('C');
  });
});

describe('classifyXyz', () => {
  it('calls steady demand X', () => {
    expect(classifyXyz([10, 10, 11, 10, 9, 10]).xyz).toBe('X');
  });

  it('calls moderately variable demand Y', () => {
    expect(classifyXyz([10, 2, 18, 3, 20, 5]).xyz).toBe('Y');
  });

  it('calls wildly variable demand Z', () => {
    expect(classifyXyz([0, 0, 100, 0, 0, 2]).xyz).toBe('Z');
  });
});

describe('policyFor', () => {
  it('raises the service level with value', () => {
    expect(policyFor('A', 'X').serviceLevel).toBeGreaterThan(policyFor('C', 'X').serviceLevel);
  });

  it('reviews valuable stock more often', () => {
    expect(policyFor('A', 'X').reviewPeriodDays).toBeLessThan(policyFor('C', 'X').reviewPeriodDays);
  });

  it('always asks a human about expensive, unpredictable stock', () => {
    expect(policyFor('A', 'Z').autonomy).toBe('propose');
    expect(policyFor('B', 'Z').autonomy).toBe('propose');
  });

  it('runs cheap, steady stock fully automatically', () => {
    expect(policyFor('C', 'X').autonomy).toBe('act');
  });

  it('lets the agent act within limits everywhere in between', () => {
    expect(policyFor('A', 'X').autonomy).toBe('act_within_limits');
    expect(policyFor('B', 'Y').autonomy).toBe('act_within_limits');
    expect(policyFor('C', 'Z').autonomy).toBe('act_within_limits');
  });

  it('explains itself', () => {
    expect(policyFor('A', 'Z').rationale.length).toBeGreaterThan(20);
  });
});

describe('segmentCatalogue', () => {
  it('assigns each SKU a class and an operating policy in one pass', () => {
    const segments = segmentCatalogue([
      { skuId: 'staple', annualValue: 900, demandSeries: [50, 52, 48, 51, 49, 50] },
      { skuId: 'oddity', annualValue: 20, demandSeries: [0, 0, 30, 0, 0, 1] },
    ]);

    const staple = segments.find((s) => s.skuId === 'staple');
    const oddity = segments.find((s) => s.skuId === 'oddity');

    expect(staple?.abc).toBe('A');
    expect(staple?.xyz).toBe('X');
    expect(oddity?.abc).toBe('C');
    expect(oddity?.xyz).toBe('Z');
    expect(staple?.serviceLevel).toBeGreaterThan(oddity?.serviceLevel ?? 1);
  });

  it('returns one segment per input SKU', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      skuId: `sku_${i}`,
      annualValue: (i + 1) * 100,
      demandSeries: [i, i + 1, i],
    }));

    expect(segmentCatalogue(items)).toHaveLength(25);
  });
});
