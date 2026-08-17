/**
 * Safety stock and reorder points.
 *
 * Safety stock exists to absorb two independent sources of surprise: demand
 * being higher than forecast, and the supplier arriving later than promised.
 * Sizing it against only the first — which is what a plain `z × σ_demand × √LT`
 * does — is the most common and most expensive modelling error in inventory
 * management, because supplier lateness is usually the larger variance.
 */

import { clamp, inverseNormalCdf, mean, standardDeviation } from '../stats.ts';
import type { Quantity } from '../types.ts';

/**
 * Probability of not stocking out during a replenishment cycle.
 *
 * Clamped to [0.50, 0.9999]: below 0.5 safety stock is negative, which is a
 * modelling error rather than a policy; above 0.9999 the required buffer grows
 * without bound for no measurable service improvement.
 */
export function serviceLevelZ(serviceLevel: number): number {
  return inverseNormalCdf(clamp(serviceLevel, 0.5, 0.9999));
}

export interface SafetyStockInput {
  /** Mean demand per day over the recent horizon. */
  readonly averageDailyDemand: number;
  /**
   * Standard deviation of *daily forecast error*, not of raw demand. Using the
   * residual is what makes a better forecast translate into less stock rather
   * than merely a different number.
   */
  readonly demandStdDev: number;
  /** Expected supplier lead time in days. */
  readonly leadTimeDays: number;
  /** Standard deviation of observed lead times in days. Zero if never measured. */
  readonly leadTimeStdDevDays: number;
  /** Target cycle service level, e.g. 0.95. */
  readonly serviceLevel: number;
}

export interface SafetyStockResult {
  readonly safetyStock: Quantity;
  readonly reorderPoint: Quantity;
  /** Demand expected to arrive while waiting for a replenishment. */
  readonly leadTimeDemand: number;
  readonly z: number;
  /** Share of the buffer attributable to lead-time variability, in [0, 1]. */
  readonly leadTimeVarianceShare: number;
}

/**
 * King's formula for safety stock under combined demand and lead-time variance:
 *
 * ```
 * SS = z × √( LT × σ_d²  +  d̄² × σ_LT² )
 * ```
 *
 * The two variances add under the root because the sources are independent.
 * Ordering is triggered when available stock falls to `d̄ × LT + SS`.
 */
export function computeSafetyStock(input: SafetyStockInput): SafetyStockResult {
  const { averageDailyDemand, demandStdDev, leadTimeDays, leadTimeStdDevDays, serviceLevel } = input;

  if (leadTimeDays < 0) throw new RangeError(`Lead time cannot be negative, received ${leadTimeDays}`);
  if (demandStdDev < 0) throw new RangeError(`Demand standard deviation cannot be negative`);
  if (leadTimeStdDevDays < 0) throw new RangeError(`Lead-time standard deviation cannot be negative`);

  const z = serviceLevelZ(serviceLevel);

  const demandVarianceTerm = leadTimeDays * demandStdDev ** 2;
  const leadTimeVarianceTerm = averageDailyDemand ** 2 * leadTimeStdDevDays ** 2;
  const totalVariance = demandVarianceTerm + leadTimeVarianceTerm;

  const safetyStock = Math.ceil(z * Math.sqrt(totalVariance));
  const leadTimeDemand = averageDailyDemand * leadTimeDays;

  return {
    safetyStock: Math.max(0, safetyStock),
    reorderPoint: Math.max(0, Math.ceil(leadTimeDemand + safetyStock)),
    leadTimeDemand,
    z,
    leadTimeVarianceShare: totalVariance === 0 ? 0 : leadTimeVarianceTerm / totalVariance,
  };
}

/**
 * Summarise observed lead times, falling back to the contractual figure.
 *
 * A single observation tells you the mean but nothing about the spread, so the
 * variance stays at the conservative default until there are at least two.
 */
export function summariseLeadTime(
  observed: readonly number[],
  nominalDays: number,
): { readonly leadTimeDays: number; readonly leadTimeStdDevDays: number; readonly samples: number } {
  const valid = observed.filter((d) => Number.isFinite(d) && d >= 0);

  if (valid.length === 0) {
    // With no evidence at all, assume a 25% coefficient of variation. This is
    // deliberately pessimistic: a new supplier has not yet earned trust.
    return { leadTimeDays: nominalDays, leadTimeStdDevDays: nominalDays * 0.25, samples: 0 };
  }

  if (valid.length === 1) {
    return { leadTimeDays: mean(valid), leadTimeStdDevDays: nominalDays * 0.25, samples: 1 };
  }

  return {
    leadTimeDays: mean(valid),
    leadTimeStdDevDays: standardDeviation(valid),
    samples: valid.length,
  };
}

/**
 * Days of demand the current position covers.
 *
 * `Infinity` when there is no demand — an important distinction from "zero days
 * of cover", which would otherwise look like an emergency and trigger an order
 * for something nobody wants.
 */
export function coverDays(available: Quantity, averageDailyDemand: number): number {
  if (averageDailyDemand <= 0) return Number.POSITIVE_INFINITY;
  return available / averageDailyDemand;
}
