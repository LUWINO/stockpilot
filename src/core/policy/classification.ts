/**
 * ABC / XYZ segmentation.
 *
 * A catalogue of 20,000 SKUs cannot be managed with one policy. Segmentation
 * splits it along the two axes that actually change what you should do:
 *
 *  - **ABC** — how much money the SKU represents. Decides how much attention and
 *    how much service level it deserves.
 *  - **XYZ** — how predictable it is. Decides how much of that service level can
 *    be bought with forecasting rather than with stock.
 *
 * The nine cells map to concrete parameters — service level, review frequency and
 * how much autonomy the agent is granted — so segmentation drives behaviour rather
 * than merely decorating a report.
 */

import { coefficientOfVariation } from '../stats.ts';
import type { SkuId } from '../types.ts';

export type AbcClass = 'A' | 'B' | 'C';
export type XyzClass = 'X' | 'Y' | 'Z';

export interface AbcInput {
  readonly skuId: SkuId;
  /** Annual consumption value: units used per year × unit cost, in minor units. */
  readonly annualValue: number;
}

export interface AbcResult {
  readonly skuId: SkuId;
  readonly annualValue: number;
  readonly abc: AbcClass;
  /** Running share of total value up to and including this SKU, in [0, 1]. */
  readonly cumulativeShare: number;
}

/** Cumulative-value cut points. A ends at 80%, B at 95%, C takes the tail. */
export const ABC_THRESHOLDS = { a: 0.8, b: 0.95 } as const;

/**
 * Pareto classification by cumulative annual value.
 *
 * Ties are broken by SKU id so the result is stable across runs — a SKU flipping
 * between B and C on consecutive nights because of tie ordering would churn its
 * service level and its stock with it.
 */
export function classifyAbc(items: readonly AbcInput[]): AbcResult[] {
  const total = items.reduce((acc, item) => acc + Math.max(0, item.annualValue), 0);

  const sorted = [...items].sort((a, b) => {
    if (b.annualValue !== a.annualValue) return b.annualValue - a.annualValue;
    return a.skuId < b.skuId ? -1 : 1;
  });

  if (total <= 0) {
    return sorted.map((item) => ({
      skuId: item.skuId,
      annualValue: item.annualValue,
      abc: 'C' as const,
      cumulativeShare: 1,
    }));
  }

  let running = 0;
  return sorted.map((item) => {
    // Classify on the share accumulated *before* this item, so the SKU that
    // crosses a threshold joins the higher class. Testing the inclusive share
    // instead would put a single dominant SKU — one worth 98% of the catalogue —
    // into class C, which is precisely backwards.
    const shareBefore = running / total;
    running += Math.max(0, item.annualValue);

    const abc: AbcClass =
      shareBefore < ABC_THRESHOLDS.a ? 'A' : shareBefore < ABC_THRESHOLDS.b ? 'B' : 'C';

    return { skuId: item.skuId, annualValue: item.annualValue, abc, cumulativeShare: running / total };
  });
}

/** Variability cut points on the coefficient of variation of demand. */
export const XYZ_THRESHOLDS = { x: 0.5, y: 1 } as const;

export interface XyzResult {
  readonly xyz: XyzClass;
  readonly coefficientOfVariation: number;
}

/**
 * Classify predictability from the coefficient of variation of demand.
 *
 * X is steady enough to forecast well, Y is seasonal or trending, Z is effectively
 * unpredictable and must be handled with stock or with make-to-order, not with
 * cleverer mathematics.
 */
export function classifyXyz(demandSeries: readonly number[]): XyzResult {
  const cv = coefficientOfVariation(demandSeries);
  const xyz: XyzClass = cv <= XYZ_THRESHOLDS.x ? 'X' : cv <= XYZ_THRESHOLDS.y ? 'Y' : 'Z';
  return { xyz, coefficientOfVariation: cv };
}

/** How much rope the autonomous agent is given for a segment. */
export type AutonomyLevel =
  /** Observe and report only. */
  | 'monitor'
  /** Draft actions for a human to approve. */
  | 'propose'
  /** Act, but only within the configured value and confidence limits. */
  | 'act_within_limits'
  /** Act without limits. Reserved for low-value, high-predictability stock. */
  | 'act';

export interface SegmentPolicy {
  readonly abc: AbcClass;
  readonly xyz: XyzClass;
  /** Target cycle service level for this segment. */
  readonly serviceLevel: number;
  /** Days between replenishment reviews. */
  readonly reviewPeriodDays: number;
  readonly autonomy: AutonomyLevel;
  readonly rationale: string;
}

/**
 * The nine-box policy matrix.
 *
 * The shape of it: **value raises the service level**, because a stockout on an A
 * item costs more; **unpredictability lowers autonomy**, because acting
 * confidently on a forecast nobody trusts is exactly how an autonomous system
 * destroys value. AZ — expensive and unpredictable — is the one cell that always
 * asks a human, and CX — cheap and steady — is the one cell that never needs to.
 */
export function policyFor(abc: AbcClass, xyz: XyzClass): SegmentPolicy {
  const serviceLevel = { A: 0.98, B: 0.95, C: 0.9 }[abc];
  const reviewPeriodDays = { A: 1, B: 3, C: 7 }[abc];

  let autonomy: AutonomyLevel;
  let rationale: string;

  if (xyz === 'Z') {
    autonomy = abc === 'C' ? 'act_within_limits' : 'propose';
    rationale =
      abc === 'C'
        ? 'Unpredictable but cheap: the agent may act, and a wrong call is inexpensive.'
        : 'Unpredictable and valuable: forecasts are unreliable here, so a human approves every order.';
  } else if (xyz === 'Y') {
    autonomy = abc === 'A' ? 'act_within_limits' : 'act_within_limits';
    rationale = 'Seasonal or trending demand: the agent acts inside its value and confidence limits.';
  } else {
    autonomy = abc === 'C' ? 'act' : 'act_within_limits';
    rationale =
      abc === 'C'
        ? 'Steady and low value: fully automatic, reviewed in aggregate rather than per order.'
        : 'Steady demand: the agent acts inside its value and confidence limits.';
  }

  return { abc, xyz, serviceLevel, reviewPeriodDays, autonomy, rationale };
}

export interface Segment extends SegmentPolicy {
  readonly skuId: SkuId;
  readonly annualValue: number;
  readonly cumulativeShare: number;
  readonly coefficientOfVariation: number;
}

/** Segment a whole catalogue in one pass and attach each SKU's operating policy. */
export function segmentCatalogue(
  items: readonly (AbcInput & { readonly demandSeries: readonly number[] })[],
): Segment[] {
  const abcResults = new Map(classifyAbc(items).map((r) => [r.skuId, r]));

  return items.map((item) => {
    const abcResult = abcResults.get(item.skuId);
    const abc = abcResult?.abc ?? 'C';
    const { xyz, coefficientOfVariation: cv } = classifyXyz(item.demandSeries);
    return {
      skuId: item.skuId,
      annualValue: item.annualValue,
      cumulativeShare: abcResult?.cumulativeShare ?? 1,
      coefficientOfVariation: cv,
      ...policyFor(abc, xyz),
    };
  });
}
