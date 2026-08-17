import { beforeEach, describe, expect, it } from 'vitest';
import { money, zero } from '../money.ts';
import { DEFAULT_AUTONOMY, gate, tightest, type AutonomyPolicy } from './autonomy.ts';
import {
  catalogueAbc,
  decisionId,
  evaluate,
  prioritise,
  proposeTransfers,
  type Decision,
  type Evaluation,
} from './decision-engine.ts';
import {
  buildSeries,
  makeContext,
  makeMovement,
  makeSku,
  makeSupplier,
  resetMovementIds,
  toDemandPoints,
} from '@/testing/fixtures';
import type { StockContext } from '../types.ts';

beforeEach(resetMovementIds);

const TODAY = '2026-06-30';

const permissive: AutonomyPolicy = {
  ...DEFAULT_AUTONOMY,
  maxAutoValue: money(1_000_000_00, 'GBP'),
  maxDailyAutoValue: money(10_000_000_00, 'GBP'),
  minConfidence: 0,
};

describe('tightest', () => {
  it('always returns the more restrictive of two levels', () => {
    expect(tightest('act', 'propose')).toBe('propose');
    expect(tightest('propose', 'act')).toBe('propose');
    expect(tightest('act', 'act')).toBe('act');
    expect(tightest('monitor', 'act_within_limits')).toBe('monitor');
  });
});

describe('gate', () => {
  const baseInput = {
    kind: 'REPLENISH' as const,
    value: money(100_00, 'GBP'),
    confidence: 0.9,
    segmentAutonomy: 'act_within_limits' as const,
    policy: DEFAULT_AUTONOMY,
    committedToday: zero('GBP'),
  };

  it('executes a small, confident decision inside every limit', () => {
    const result = gate(baseInput);
    expect(result.outcome).toBe('execute');
    expect(result.effectiveLevel).toBe('act_within_limits');
  });

  it('proposes rather than executes when the value exceeds the per-decision cap', () => {
    const result = gate({ ...baseInput, value: money(5_000_00, 'GBP') });

    expect(result.outcome).toBe('propose');
    expect(result.reasons.join(' ')).toMatch(/per-decision limit/);
  });

  it('proposes when confidence is below the floor', () => {
    const result = gate({ ...baseInput, confidence: 0.2 });

    expect(result.outcome).toBe('propose');
    expect(result.reasons.join(' ')).toMatch(/below the automatic-execution floor/);
  });

  it('enforces the daily budget across the whole run', () => {
    const result = gate({ ...baseInput, committedToday: money(2_450_00, 'GBP') });

    expect(result.outcome).toBe('propose');
    expect(result.reasons.join(' ')).toMatch(/daily cap/);
  });

  it('blocks everything when autonomy is paused', () => {
    const result = gate({ ...baseInput, policy: { ...DEFAULT_AUTONOMY, paused: true } });

    expect(result.outcome).toBe('block');
    expect(result.reasons.join(' ')).toMatch(/paused/);
  });

  it('blocks when the effective level is monitor-only', () => {
    expect(gate({ ...baseInput, segmentAutonomy: 'monitor' }).outcome).toBe('block');
  });

  it('never lets a permissive org policy promote a restricted segment', () => {
    const result = gate({
      ...baseInput,
      policy: { ...permissive, level: 'act' },
      segmentAutonomy: 'propose',
    });

    expect(result.outcome).toBe('propose');
    expect(result.effectiveLevel).toBe('propose');
  });

  it('always asks a human about write-offs and markdowns', () => {
    expect(gate({ ...baseInput, kind: 'WRITE_OFF', policy: permissive }).outcome).toBe('propose');
    expect(gate({ ...baseInput, kind: 'MARKDOWN', policy: permissive }).outcome).toBe('propose');
  });

  it('lets advisory decisions through, since they commit nothing', () => {
    for (const kind of ['ALERT', 'COUNT', 'HOLD_REPLENISHMENT'] as const) {
      const result = gate({ ...baseInput, kind, confidence: 0, policy: { ...DEFAULT_AUTONOMY, paused: true } });
      expect(result.outcome).toBe('execute');
    }
  });

  it('refuses to act when it cannot compare currencies', () => {
    const result = gate({ ...baseInput, value: money(10_00, 'EUR') });

    expect(result.outcome).toBe('propose');
    expect(result.reasons.join(' ')).toMatch(/cannot verify the limit/);
  });

  it('reports every rule that fired, not just the first', () => {
    const result = gate({ ...baseInput, value: money(9_999_00, 'GBP'), confidence: 0.1 });

    expect(result.reasons.length).toBeGreaterThan(1);
  });

  it('skips the value checks entirely at full autonomy', () => {
    const result = gate({
      ...baseInput,
      value: money(999_999_00, 'GBP'),
      segmentAutonomy: 'act',
      policy: { ...DEFAULT_AUTONOMY, level: 'act' },
    });

    expect(result.outcome).toBe('execute');
  });
});

describe('decisionId', () => {
  it('is stable for identical inputs, so replays do not duplicate work', () => {
    expect(decisionId(['REPLENISH', 'sku_1', 'site_1', TODAY, 50])).toBe(
      decisionId(['REPLENISH', 'sku_1', 'site_1', TODAY, 50]),
    );
  });

  it('differs when any input differs', () => {
    const base = decisionId(['REPLENISH', 'sku_1', 'site_1', TODAY, 50]);
    expect(decisionId(['REPLENISH', 'sku_1', 'site_1', TODAY, 51])).not.toBe(base);
    expect(decisionId(['REPLENISH', 'sku_2', 'site_1', TODAY, 50])).not.toBe(base);
    expect(decisionId(['WRITE_OFF', 'sku_1', 'site_1', TODAY, 50])).not.toBe(base);
  });

  it('produces a fixed-width hexadecimal id', () => {
    expect(decisionId(['a'])).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('evaluate', () => {
  const healthySeries = buildSeries({ days: 180, base: 20, weekly: 6, noise: 3 });

  it('raises a replenishment when stock runs down', () => {
    const context = makeContext({
      demandHistory: toDemandPoints(healthySeries),
      onHand: 10,
      onOrder: 0,
    });

    const result = evaluate({ context, movements: [], today: TODAY, policy: permissive });
    const replenish = result.decisions.find((d) => d.kind === 'REPLENISH');

    expect(replenish).toBeDefined();
    expect(replenish?.quantity).toBeGreaterThan(0);
    expect(replenish?.value.amount).toBe((replenish?.quantity ?? 0) * 1_850);
  });

  it('raises nothing when the SKU is comfortably stocked', () => {
    const context = makeContext({ demandHistory: toDemandPoints(healthySeries), onHand: 2000 });
    const result = evaluate({ context, movements: [], today: TODAY, policy: permissive });

    expect(result.decisions.filter((d) => d.kind === 'REPLENISH')).toHaveLength(0);
  });

  it('explains every replenishment in terms a buyer can check', () => {
    const context = makeContext({ demandHistory: toDemandPoints(healthySeries), onHand: 10 });
    const result = evaluate({ context, movements: [], today: TODAY, policy: permissive });
    const replenish = result.decisions.find((d) => d.kind === 'REPLENISH');

    expect(replenish?.rationale.length).toBeGreaterThanOrEqual(4);
    expect(replenish?.rationale.join(' ')).toMatch(/reorder point/);
    expect(replenish?.rationale.join(' ')).toMatch(/Forecast/);
    expect(replenish?.rationale.join(' ')).toMatch(/service level/);
    expect(replenish?.evidence.reorderPoint).toBeGreaterThan(0);
  });

  it('suspends replenishment when the ledger has gone negative', () => {
    const context = makeContext({ demandHistory: toDemandPoints(healthySeries), onHand: -20 });
    const result = evaluate({ context, movements: [], today: TODAY, policy: permissive });

    expect(result.decisions.map((d) => d.kind)).toContain('HOLD_REPLENISHMENT');
    expect(result.decisions.map((d) => d.kind)).not.toContain('REPLENISH');
    expect(result.decisions.map((d) => d.kind)).toContain('COUNT');
  });

  it('withholds the order when demand has collapsed, and says what it avoided', () => {
    const series = [...buildSeries({ days: 90, base: 40, noise: 2 }), ...Array.from({ length: 7 }, () => 1)];
    const context = makeContext({ demandHistory: toDemandPoints(series), onHand: 5 });

    const result = evaluate({ context, movements: [], today: TODAY, policy: permissive });
    const hold = result.decisions.find((d) => d.kind === 'HOLD_REPLENISHMENT');

    expect(hold).toBeDefined();
    expect(hold?.rationale.join(' ')).toMatch(/no longer applies/);
    expect(result.decisions.map((d) => d.kind)).not.toContain('REPLENISH');
  });

  it('writes off expired stock and marks down what will expire', () => {
    const perishable = makeSku({ id: 'sku_cream', code: 'CREAM-1L', perishable: true });
    const context = makeContext({
      sku: perishable,
      demandHistory: toDemandPoints(healthySeries),
      onHand: 150,
      lots: [
        {
          id: 'lot_gone',
          skuId: 'sku_cream',
          siteId: 'site_main',
          quantity: 50,
          receivedAt: '2026-06-01T08:00:00.000Z',
          expiresOn: '2026-06-20',
        },
        {
          id: 'lot_soon',
          skuId: 'sku_cream',
          siteId: 'site_main',
          quantity: 100,
          receivedAt: '2026-06-25T08:00:00.000Z',
          expiresOn: '2026-07-02',
        },
      ],
    });

    const result = evaluate({ context, movements: [], today: TODAY, policy: permissive });
    const writeOff = result.decisions.find((d) => d.kind === 'WRITE_OFF');
    const markdown = result.decisions.find((d) => d.kind === 'MARKDOWN');

    expect(writeOff?.quantity).toBe(50);
    expect(markdown).toBeDefined();
    // Both destroy value permanently, so neither may execute automatically.
    expect(writeOff?.outcome).toBe('propose');
    expect(markdown?.outcome).toBe('propose');
  });

  it('discounts confidence when history is too short to trust', () => {
    const short = makeContext({ demandHistory: toDemandPoints(buildSeries({ days: 20, base: 20 })), onHand: 10 });
    const long = makeContext({ demandHistory: toDemandPoints(healthySeries), onHand: 10 });

    const shortResult = evaluate({ context: short, movements: [], today: TODAY, policy: permissive });
    const longResult = evaluate({ context: long, movements: [], today: TODAY, policy: permissive });

    expect(shortResult.confidence).toBeLessThan(longResult.confidence);
  });

  it('defaults an unclassified SKU to the lowest service level, not the highest', () => {
    const context = makeContext({ demandHistory: toDemandPoints(healthySeries), onHand: 10 });

    const unclassified = evaluate({ context, movements: [], today: TODAY, policy: permissive });
    const classifiedA = evaluate({ context, movements: [], today: TODAY, policy: permissive, abc: 'A' });

    expect(unclassified.segment.abc).toBe('C');
    expect(classifiedA.segment.serviceLevel).toBeGreaterThan(unclassified.segment.serviceLevel);
  });

  it('holds more safety stock for an A item than a C item', () => {
    const context = makeContext({ demandHistory: toDemandPoints(healthySeries), onHand: 10 });

    const a = evaluate({ context, movements: [], today: TODAY, policy: permissive, abc: 'A' });
    const c = evaluate({ context, movements: [], today: TODAY, policy: permissive, abc: 'C' });

    expect(a.plan.safetyStock).toBeGreaterThan(c.plan.safetyStock);
  });

  it('routes a large order to a human under the default policy', () => {
    const context = makeContext({
      sku: makeSku({ unitCost: money(50_000, 'GBP') }),
      demandHistory: toDemandPoints(healthySeries),
      onHand: 5,
    });

    const result = evaluate({ context, movements: [], today: TODAY });
    const replenish = result.decisions.find((d) => d.kind === 'REPLENISH');

    expect(replenish?.outcome).toBe('propose');
    expect(replenish?.gateReasons.join(' ')).toMatch(/limit/);
  });

  it('raises a count when shrinkage crosses the threshold', () => {
    const movements = [
      makeMovement({ kind: 'RECEIPT', quantity: 1000 }),
      makeMovement({ kind: 'ISSUE', quantity: 900 }),
      makeMovement({ kind: 'ADJUSTMENT', quantity: -60 }),
    ];

    const context = makeContext({ demandHistory: toDemandPoints(healthySeries), onHand: 40 });
    const result = evaluate({ context, movements, today: TODAY, policy: permissive });

    expect(result.decisions.map((d) => d.kind)).toContain('COUNT');
  });

  it('turns dead stock into an alert carrying its tied-up value', () => {
    const context = makeContext({
      demandHistory: toDemandPoints(Array.from({ length: 180 }, () => 0)),
      onHand: 300,
      daysSinceLastIssue: 250,
    });

    const result = evaluate({ context, movements: [], today: TODAY, policy: permissive });
    const alert = result.decisions.find((d) => d.kind === 'ALERT');

    expect(alert).toBeDefined();
    expect(alert?.expectedBenefit.amount).toBe(300 * 1_850);
  });

  it('produces identical decision ids when replayed over identical inputs', () => {
    const context = makeContext({ demandHistory: toDemandPoints(healthySeries), onHand: 10 });

    const first = evaluate({ context, movements: [], today: TODAY, policy: permissive });
    const second = evaluate({ context, movements: [], today: TODAY, policy: permissive });

    expect(second.decisions.map((d) => d.id)).toEqual(first.decisions.map((d) => d.id));
  });

  it('records the gate outcome and its reasons on every decision', () => {
    const context = makeContext({ demandHistory: toDemandPoints(healthySeries), onHand: 10 });
    const result = evaluate({ context, movements: [], today: TODAY });

    for (const decision of result.decisions) {
      expect(['execute', 'propose', 'block']).toContain(decision.outcome);
      expect(decision.createdOn).toBe(TODAY);
    }
  });

  it('blocks every value-committing decision when autonomy is paused', () => {
    const context = makeContext({ demandHistory: toDemandPoints(healthySeries), onHand: 10 });
    const result = evaluate({
      context,
      movements: [],
      today: TODAY,
      policy: { ...permissive, paused: true },
    });

    for (const decision of result.decisions.filter((d) => d.kind === 'REPLENISH')) {
      expect(decision.outcome).toBe('block');
    }
  });
});

describe('proposeTransfers', () => {
  function evaluateSite(siteId: string, onHand: number): { evaluation: Evaluation; context: StockContext } {
    const context = makeContext({
      siteId,
      demandHistory: toDemandPoints(buildSeries({ days: 180, base: 20, noise: 2 })),
      onHand,
      supplier: makeSupplier({ minimumOrderQuantity: 1, orderMultiple: 1 }),
    });
    return {
      evaluation: evaluate({ context, movements: [], today: TODAY, policy: permissive }),
      context,
    };
  }

  it('moves surplus from a well-stocked site to one that is short', () => {
    const short = evaluateSite('site_short', 5);
    const flush = evaluateSite('site_flush', 4000);

    const contexts = new Map([
      [`${short.evaluation.skuId}:site_short`, short.context],
      [`${flush.evaluation.skuId}:site_flush`, flush.context],
    ]);

    const transfers = proposeTransfers(
      [short.evaluation, flush.evaluation],
      contexts,
      TODAY,
      money(50, 'GBP'),
    );

    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.evidence.fromSite).toBe('site_flush');
    expect(transfers[0]?.evidence.toSite).toBe('site_short');
    expect(transfers[0]?.quantity).toBeGreaterThan(0);
    // Transfers spend money too, so they go to a human by default.
    expect(transfers[0]?.outcome).toBe('propose');
  });

  it('declines to transfer when moving costs more than buying', () => {
    const short = evaluateSite('site_short', 5);
    const flush = evaluateSite('site_flush', 4000);

    const contexts = new Map([
      [`${short.evaluation.skuId}:site_short`, short.context],
      [`${flush.evaluation.skuId}:site_flush`, flush.context],
    ]);

    const transfers = proposeTransfers(
      [short.evaluation, flush.evaluation],
      contexts,
      TODAY,
      money(5_000, 'GBP'),
    );

    expect(transfers).toHaveLength(0);
  });

  it('never pushes a donor below its own reorder point', () => {
    const short = evaluateSite('site_short', 5);
    const alsoShort = evaluateSite('site_also_short', 8);

    const contexts = new Map([
      [`${short.evaluation.skuId}:site_short`, short.context],
      [`${alsoShort.evaluation.skuId}:site_also_short`, alsoShort.context],
    ]);

    expect(
      proposeTransfers([short.evaluation, alsoShort.evaluation], contexts, TODAY, money(50, 'GBP')),
    ).toHaveLength(0);
  });

  it('does nothing for a single-site network', () => {
    const only = evaluateSite('site_only', 5);
    expect(proposeTransfers([only.evaluation], new Map(), TODAY, money(50, 'GBP'))).toHaveLength(0);
  });
});

describe('prioritise', () => {
  function stub(id: string, severity: Decision['severity'], benefit: number): Decision {
    return {
      id,
      kind: 'ALERT',
      skuId: 'sku_flour',
      siteId: 'site_main',
      value: zero('GBP'),
      expectedBenefit: money(benefit, 'GBP'),
      confidence: 1,
      severity,
      rationale: [],
      evidence: {},
      outcome: 'execute',
      gateReasons: [],
      createdOn: TODAY,
    };
  }

  it('sorts by severity, then by money at stake', () => {
    const decisions = [stub('b', 'low', 100), stub('a', 'critical', 1), stub('c', 'low', 900)];
    expect(prioritise(decisions).map((d) => d.id)).toEqual(['a', 'c', 'b']);
  });

  it('breaks ties deterministically and does not mutate its input', () => {
    const decisions = [stub('b', 'high', 100), stub('a', 'high', 100)];

    expect(prioritise(decisions).map((d) => d.id)).toEqual(['a', 'b']);
    expect(decisions.map((d) => d.id)).toEqual(['b', 'a']);
  });
});

describe('catalogueAbc', () => {
  it('maps every SKU to a class', () => {
    const classes = catalogueAbc([
      { skuId: 'big', annualValue: 900 },
      { skuId: 'small', annualValue: 10 },
    ]);

    expect(classes.get('big')).toBe('A');
    expect(classes.get('small')).toBe('C');
  });
});
