import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  detectAnomalies,
  severityRank,
  totalImpact,
  type Anomaly,
  type AnomalyKind,
} from './anomaly.ts';
import { money } from './money.ts';
import {
  buildSeries,
  makeContext,
  makeMovement,
  makeSku,
  resetMovementIds,
  toDemandPoints,
} from '@/testing/fixtures';

beforeEach(resetMovementIds);

const TODAY = '2026-06-30';

function kinds(anomalies: readonly { kind: AnomalyKind }[]): AnomalyKind[] {
  return anomalies.map((a) => a.kind);
}

describe('detectAnomalies', () => {
  it('finds nothing wrong with a healthy, well-stocked SKU', () => {
    const context = makeContext({ onHand: 300, daysSinceLastIssue: 1 });
    const found = detectAnomalies({ context, dailyDemand: 20, today: TODAY, movements: [] });

    expect(found).toEqual([]);
  });

  it('orders findings with the most severe first', () => {
    // Idle for over a year, holding far too much cover, from an erratic supplier:
    // three findings spanning three severities.
    const context = makeContext({
      onHand: 200,
      daysSinceLastIssue: 400,
      observedLeadTimeDays: [2, 14, 3, 21, 4],
    });
    const found = detectAnomalies({ context, dailyDemand: 1, today: TODAY, movements: [] });

    expect(found.length).toBeGreaterThan(2);
    for (let i = 1; i < found.length; i += 1) {
      const previous = found[i - 1];
      const current = found[i];
      if (previous && current) {
        expect(severityRank(previous.severity)).toBeGreaterThanOrEqual(severityRank(current.severity));
      }
    }
  });
});

describe('NEGATIVE_STOCK', () => {
  it('is always critical, because the books cannot be trusted', () => {
    const context = makeContext({ onHand: -12 });
    const found = detectAnomalies({ context, dailyDemand: 20, today: TODAY, movements: [] });
    const negative = found.find((a) => a.kind === 'NEGATIVE_STOCK');

    expect(negative?.severity).toBe('critical');
    expect(negative?.evidence.onHand).toBe(-12);
    expect(negative?.financialImpact.amount).toBe(12 * 1_850);
  });
});

describe('STOCKOUT_IMMINENT', () => {
  it('fires when cover falls below the threshold with nothing inbound', () => {
    const context = makeContext({ onHand: 20, onOrder: 0 });
    const found = detectAnomalies({ context, dailyDemand: 20, today: TODAY, movements: [] });
    const stockout = found.find((a) => a.kind === 'STOCKOUT_IMMINENT');

    expect(stockout).toBeDefined();
    expect(stockout?.evidence.coverDays).toBeCloseTo(1, 4);
    expect(stockout?.summary).toMatch(/nothing inbound/);
  });

  it('stays quiet when a delivery already covers the gap', () => {
    const context = makeContext({ onHand: 20, onOrder: 500 });
    const found = detectAnomalies({ context, dailyDemand: 20, today: TODAY, movements: [] });

    expect(kinds(found)).not.toContain('STOCKOUT_IMMINENT');
  });

  it('escalates to critical once available stock is exhausted', () => {
    const context = makeContext({ onHand: 10, reserved: 10 });
    const found = detectAnomalies({ context, dailyDemand: 20, today: TODAY, movements: [] });

    expect(found.find((a) => a.kind === 'STOCKOUT_IMMINENT')?.severity).toBe('critical');
  });

  it('values the exposure as lost margin, not lost revenue', () => {
    const context = makeContext({ onHand: 0 });
    const found = detectAnomalies({ context, dailyDemand: 10, today: TODAY, movements: [] });
    const stockout = found.find((a) => a.kind === 'STOCKOUT_IMMINENT');

    // Margin is 3200 − 1850 = 1350 per unit, over 3 days of demand at 10/day.
    expect(stockout?.financialImpact.amount).toBe(30 * 1_350);
  });

  it('does not fire for a SKU with no demand', () => {
    const context = makeContext({ onHand: 0 });
    const found = detectAnomalies({ context, dailyDemand: 0, today: TODAY, movements: [] });

    expect(kinds(found)).not.toContain('STOCKOUT_IMMINENT');
  });
});

describe('DEAD_STOCK', () => {
  it('flags stock that has not moved for a full quarter', () => {
    const context = makeContext({ onHand: 200, daysSinceLastIssue: 120 });
    const found = detectAnomalies({ context, dailyDemand: 0, today: TODAY, movements: [] });
    const dead = found.find((a) => a.kind === 'DEAD_STOCK');

    expect(dead).toBeDefined();
    expect(dead?.financialImpact.amount).toBe(200 * 1_850);
  });

  it('escalates when the stock has been idle for twice the threshold', () => {
    const context = makeContext({ onHand: 200, daysSinceLastIssue: 200 });
    const found = detectAnomalies({ context, dailyDemand: 0, today: TODAY, movements: [] });

    expect(found.find((a) => a.kind === 'DEAD_STOCK')?.severity).toBe('high');
  });

  it('ignores a SKU that is simply out of stock', () => {
    const context = makeContext({ onHand: 0, daysSinceLastIssue: 400 });
    const found = detectAnomalies({ context, dailyDemand: 0, today: TODAY, movements: [] });

    expect(kinds(found)).not.toContain('DEAD_STOCK');
  });

  it('ignores a SKU that has never been issued at all', () => {
    const context = makeContext({ onHand: 50, daysSinceLastIssue: null });
    const found = detectAnomalies({ context, dailyDemand: 0, today: TODAY, movements: [] });

    expect(kinds(found)).not.toContain('DEAD_STOCK');
  });
});

describe('EXPIRY_RISK', () => {
  const perishable = makeSku({ id: 'sku_cream', code: 'CREAM-1L', perishable: true, shelfLifeDays: 14 });

  it('quantifies stock that cannot sell before its date', () => {
    const context = makeContext({
      sku: perishable,
      onHand: 100,
      lots: [
        {
          id: 'lot_1',
          skuId: 'sku_cream',
          siteId: 'site_main',
          quantity: 100,
          receivedAt: '2026-06-28T08:00:00.000Z',
          expiresOn: '2026-07-02',
        },
      ],
    });

    const found = detectAnomalies({ context, dailyDemand: 10, today: TODAY, movements: [] });
    const risk = found.find((a) => a.kind === 'EXPIRY_RISK');

    // Two days of cover at 10/day sells 20 units; the other 80 will spoil.
    expect(risk?.evidence.unitsAtRisk).toBe(80);
    expect(risk?.severity).toBe('high');
  });

  it('stays quiet when demand comfortably clears the lot', () => {
    const context = makeContext({
      sku: perishable,
      onHand: 20,
      lots: [
        {
          id: 'lot_1',
          skuId: 'sku_cream',
          siteId: 'site_main',
          quantity: 20,
          receivedAt: '2026-06-28T08:00:00.000Z',
          expiresOn: '2026-07-30',
        },
      ],
    });

    const found = detectAnomalies({ context, dailyDemand: 10, today: TODAY, movements: [] });
    expect(kinds(found)).not.toContain('EXPIRY_RISK');
  });

  it('does not apply to non-perishable stock', () => {
    const context = makeContext({ onHand: 100, lots: [] });
    const found = detectAnomalies({ context, dailyDemand: 0, today: TODAY, movements: [] });

    expect(kinds(found)).not.toContain('EXPIRY_RISK');
  });
});

describe('OVERSTOCK', () => {
  it('flags stock far beyond the cover target and sizes the surplus', () => {
    const context = makeContext({ onHand: 5000, daysSinceLastIssue: 1 });
    const found = detectAnomalies({ context, dailyDemand: 10, today: TODAY, movements: [] });
    const overstock = found.find((a) => a.kind === 'OVERSTOCK');

    expect(overstock).toBeDefined();
    // 120 days of cover at 10/day is 1,200 units; the rest is surplus.
    expect(overstock?.evidence.excessUnits).toBe(3800);
  });

  it('stays quiet at a normal level of cover', () => {
    const context = makeContext({ onHand: 200 });
    const found = detectAnomalies({ context, dailyDemand: 20, today: TODAY, movements: [] });

    expect(kinds(found)).not.toContain('OVERSTOCK');
  });
});

describe('demand shifts', () => {
  it('detects a sustained spike against the baseline', () => {
    const baseline = buildSeries({ days: 60, base: 10, noise: 1 });
    const spike = Array.from({ length: 7 }, () => 90);
    const context = makeContext({
      demandHistory: toDemandPoints([...baseline, ...spike]),
      onHand: 500,
    });

    const found = detectAnomalies({ context, dailyDemand: 40, today: TODAY, movements: [] });
    expect(kinds(found)).toContain('DEMAND_SPIKE');
  });

  it('detects a collapse and says to stop replenishing', () => {
    const baseline = buildSeries({ days: 60, base: 40, noise: 2 });
    const collapse = Array.from({ length: 7 }, () => 2);
    const context = makeContext({
      demandHistory: toDemandPoints([...baseline, ...collapse]),
      onHand: 300,
    });

    const found = detectAnomalies({ context, dailyDemand: 3, today: TODAY, movements: [] });
    const shift = found.find((a) => a.kind === 'DEMAND_COLLAPSE');

    expect(shift).toBeDefined();
    expect(shift?.summary).toMatch(/stop replenishing/);
  });

  it('says nothing about a steady series', () => {
    const context = makeContext({ demandHistory: toDemandPoints(buildSeries({ days: 90, base: 20, noise: 2 })) });
    const found = detectAnomalies({ context, dailyDemand: 20, today: TODAY, movements: [] });

    expect(kinds(found)).not.toContain('DEMAND_SPIKE');
    expect(kinds(found)).not.toContain('DEMAND_COLLAPSE');
  });

  it('needs three weeks of history before it will judge a shift', () => {
    const context = makeContext({ demandHistory: toDemandPoints([1, 2, 3, 100, 100, 100]) });
    const found = detectAnomalies({ context, dailyDemand: 50, today: TODAY, movements: [] });

    expect(kinds(found)).not.toContain('DEMAND_SPIKE');
  });
});

describe('SHRINKAGE', () => {
  it('adds up small losses that individually look unremarkable', () => {
    const movements = [
      makeMovement({ kind: 'RECEIPT', quantity: 1000 }),
      makeMovement({ kind: 'ISSUE', quantity: 900 }),
      makeMovement({ kind: 'ADJUSTMENT', quantity: -30 }),
      makeMovement({ kind: 'SCRAP', quantity: 20 }),
    ];

    const found = detectAnomalies({
      context: makeContext({ onHand: 50 }),
      dailyDemand: 20,
      today: TODAY,
      movements,
    });
    const shrinkage = found.find((a) => a.kind === 'SHRINKAGE');

    // 50 units lost against 1,900 of throughput is 2.6%, past the 2% threshold.
    expect(shrinkage).toBeDefined();
    expect(shrinkage?.evidence.lostUnits).toBe(50);
    expect(shrinkage?.evidence.throughput).toBe(1900);
  });

  it('ignores a single bookkeeping correction within tolerance', () => {
    const movements = [
      makeMovement({ kind: 'RECEIPT', quantity: 1000 }),
      makeMovement({ kind: 'ISSUE', quantity: 900 }),
      makeMovement({ kind: 'ADJUSTMENT', quantity: -2 }),
    ];

    const found = detectAnomalies({
      context: makeContext({ onHand: 98 }),
      dailyDemand: 20,
      today: TODAY,
      movements,
    });

    expect(kinds(found)).not.toContain('SHRINKAGE');
  });

  it('ignores positive corrections, which are not losses', () => {
    const movements = [
      makeMovement({ kind: 'RECEIPT', quantity: 100 }),
      makeMovement({ kind: 'ADJUSTMENT', quantity: 50 }),
    ];

    const found = detectAnomalies({
      context: makeContext({ onHand: 150 }),
      dailyDemand: 20,
      today: TODAY,
      movements,
    });

    expect(kinds(found)).not.toContain('SHRINKAGE');
  });
});

describe('SUPPLIER_UNRELIABLE', () => {
  it('flags a supplier whose lead time swings wildly', () => {
    const context = makeContext({ observedLeadTimeDays: [2, 14, 3, 21, 4] });
    const found = detectAnomalies({ context, dailyDemand: 20, today: TODAY, movements: [] });
    const unreliable = found.find((a) => a.kind === 'SUPPLIER_UNRELIABLE');

    expect(unreliable).toBeDefined();
    expect(unreliable?.summary).toMatch(/safety stock/);
  });

  it('accepts a supplier that is consistently slow', () => {
    const context = makeContext({ observedLeadTimeDays: [20, 21, 20, 19, 20] });
    const found = detectAnomalies({ context, dailyDemand: 20, today: TODAY, movements: [] });

    expect(kinds(found)).not.toContain('SUPPLIER_UNRELIABLE');
  });

  it('waits for enough deliveries before judging', () => {
    const context = makeContext({ observedLeadTimeDays: [1, 20] });
    const found = detectAnomalies({ context, dailyDemand: 20, today: TODAY, movements: [] });

    expect(kinds(found)).not.toContain('SUPPLIER_UNRELIABLE');
  });
});

describe('thresholds', () => {
  it('can be tightened per organisation', () => {
    const context = makeContext({ onHand: 200, daysSinceLastIssue: 30 });

    const withDefaults = detectAnomalies({ context, dailyDemand: 0, today: TODAY, movements: [] });
    const withStrict = detectAnomalies({
      context,
      dailyDemand: 0,
      today: TODAY,
      movements: [],
      thresholds: { ...DEFAULT_THRESHOLDS, deadStockDays: 14 },
    });

    expect(kinds(withDefaults)).not.toContain('DEAD_STOCK');
    expect(kinds(withStrict)).toContain('DEAD_STOCK');
  });
});

describe('totalImpact', () => {
  function withImpact(amount: number, currency: string): Anomaly {
    return {
      kind: 'DEAD_STOCK',
      skuId: 'sku_flour',
      siteId: 'site_main',
      severity: 'low',
      summary: 'stub',
      evidence: {},
      financialImpact: money(amount, currency),
      detectedAt: TODAY,
    };
  }

  it('adds up exposure in a single currency', () => {
    expect(totalImpact([withImpact(1000, 'GBP'), withImpact(2500, 'GBP')], 'GBP').amount).toBe(3500);
  });

  it('excludes amounts in other currencies rather than adding them blindly', () => {
    expect(totalImpact([withImpact(1000, 'GBP'), withImpact(9999, 'EUR')], 'GBP').amount).toBe(1000);
  });

  it('is zero for an empty set', () => {
    expect(totalImpact([], 'GBP').amount).toBe(0);
  });
});
