/**
 * Test fixtures.
 *
 * Deliberately outside `src/core` so that helper code never counts toward the
 * domain coverage thresholds — coverage should measure the logic under test, not
 * the scaffolding around it.
 *
 * Series are generated deterministically. No `Math.random` anywhere: a test that
 * fails one run in fifty is worse than no test, because the team learns to re-run
 * it rather than read it.
 */

import { money } from '@/core/money';
import type { StockMovement } from '@/core/ledger';
import type { DemandPoint, Sku, StockContext, Supplier } from '@/core/types';

export const GBP = 'GBP';

export function makeSku(overrides: Partial<Sku> = {}): Sku {
  return {
    id: 'sku_flour',
    orgId: 'org_1',
    code: 'FLOUR-25KG',
    name: 'Strong white flour, 25kg sack',
    stockUnit: 'each',
    unitCost: money(1_850, GBP),
    unitPrice: money(3_200, GBP),
    perishable: false,
    active: true,
    ...overrides,
  };
}

export function makeSupplier(overrides: Partial<Supplier> = {}): Supplier {
  return {
    id: 'sup_mill',
    orgId: 'org_1',
    name: 'Northern Mills',
    nominalLeadTimeDays: 5,
    minimumOrderQuantity: 10,
    orderMultiple: 5,
    orderingCost: money(2_500, GBP),
    ...overrides,
  };
}

/** A pseudo-random generator with a fixed seed, so every run sees the same data. */
export function seededNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32 — small, fast, and identical on every platform.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

export interface SeriesOptions {
  readonly days: number;
  readonly base: number;
  /** Peak-to-trough amplitude of the weekly cycle. */
  readonly weekly?: number;
  /** Units added per day of trend. */
  readonly trend?: number;
  /** Maximum absolute noise added per day. */
  readonly noise?: number;
  readonly seed?: number;
}

/** Build a daily demand series with optional weekly seasonality, trend and noise. */
export function buildSeries(options: SeriesOptions): number[] {
  const { days, base, weekly = 0, trend = 0, noise = 0, seed = 42 } = options;
  const random = seededNoise(seed);
  const out: number[] = [];

  for (let day = 0; day < days; day += 1) {
    const seasonal = weekly === 0 ? 0 : (weekly / 2) * Math.sin((2 * Math.PI * day) / 7);
    const jitter = noise === 0 ? 0 : (random() - 0.5) * 2 * noise;
    out.push(Math.max(0, Math.round(base + seasonal + trend * day + jitter)));
  }

  return out;
}

/** An intermittent series: `size` units every `interval` days, zero otherwise. */
export function buildIntermittentSeries(days: number, interval: number, size: number): number[] {
  return Array.from({ length: days }, (_, day) => ((day + 1) % interval === 0 ? size : 0));
}

/** Turn a bare number series into dated demand points ending today. */
export function toDemandPoints(series: readonly number[], endDate = '2026-06-30'): DemandPoint[] {
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return series.map((quantity, index) => ({
    date: new Date(end - (series.length - 1 - index) * 86_400_000).toISOString().slice(0, 10),
    quantity,
  }));
}

export function makeContext(overrides: Partial<StockContext> = {}): StockContext {
  const series = buildSeries({ days: 120, base: 20, weekly: 6, noise: 3 });
  return {
    sku: makeSku(),
    siteId: 'site_main',
    supplier: makeSupplier(),
    demandHistory: toDemandPoints(series),
    onHand: 400,
    reserved: 0,
    onOrder: 0,
    lots: [],
    observedLeadTimeDays: [5, 5, 6, 4, 5],
    daysSinceLastIssue: 1,
    ...overrides,
  };
}

let movementCounter = 0;

export function makeMovement(overrides: Partial<StockMovement> = {}): StockMovement {
  movementCounter += 1;
  return {
    id: `mv_${String(movementCounter).padStart(4, '0')}`,
    skuId: 'sku_flour',
    siteId: 'site_main',
    kind: 'RECEIPT',
    quantity: 100,
    occurredAt: '2026-06-01T09:00:00.000Z',
    actor: 'user_test',
    ...overrides,
  };
}

/** Reset the movement id counter so ids are stable within a test file. */
export function resetMovementIds(): void {
  movementCounter = 0;
}
