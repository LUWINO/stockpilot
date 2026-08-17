/**
 * Automatic forecaster selection.
 *
 * There is no single best forecasting method for inventory. A supermarket staple
 * and a spare gearbox need genuinely different mathematics, and a system that
 * applies one method to both will be wrong about at least one of them. Selection
 * runs in two stages:
 *
 *  1. **Classify** the demand pattern from its intermittency and variability
 *     (Syntetos–Boylan). This decides which candidates are even admissible —
 *     running Holt–Winters on a series that is 90% zeros is not a close call.
 *  2. **Rank** the admissible candidates by out-of-sample MASE, and keep the
 *     winner only if it actually beats the naive benchmark.
 *
 * When history is too short to hold anything out, the classification alone
 * decides, which is a defensible prior rather than a guess.
 */

import { averageDemandInterval, squaredCvOfNonZero } from '../stats.ts';
import { backtest, DEFAULT_BACKTEST, naiveScale, type BacktestOptions, type AccuracyMetrics } from './backtest.ts';
import {
  croston,
  holtLinear,
  holtWinters,
  movingAverage,
  naive,
  seasonalNaive,
  simpleExponentialSmoothing,
  zeroForecast,
  type Forecaster,
  type ForecastMethod,
  type ForecastResult,
} from './methods.ts';

/**
 * Syntetos–Boylan demand categories.
 *
 * The cutoffs (ADI 1.32, CV² 0.49) are the published values at which Croston's
 * method starts to outperform exponential smoothing.
 */
export type DemandPattern = 'no_demand' | 'smooth' | 'erratic' | 'intermittent' | 'lumpy';

export const ADI_CUTOFF = 1.32;
export const CV2_CUTOFF = 0.49;

export interface DemandClassification {
  readonly pattern: DemandPattern;
  /** Average interval between non-zero demands, in days. */
  readonly adi: number;
  /** Squared coefficient of variation of the non-zero demands. */
  readonly cv2: number;
}

export function classifyDemand(series: readonly number[]): DemandClassification {
  const adi = averageDemandInterval(series);
  const cv2 = squaredCvOfNonZero(series);

  if (!Number.isFinite(adi)) return { pattern: 'no_demand', adi, cv2 };

  const intermittent = adi >= ADI_CUTOFF;
  const variable = cv2 >= CV2_CUTOFF;

  const pattern: DemandPattern = intermittent
    ? variable
      ? 'lumpy'
      : 'intermittent'
    : variable
      ? 'erratic'
      : 'smooth';

  return { pattern, adi, cv2 };
}

export interface SelectionOptions extends BacktestOptions {
  /**
   * Length of the seasonal cycle in days. Seven captures the weekly trading
   * rhythm that dominates most retail and hospitality demand.
   */
  readonly seasonalPeriod: number;
}

export const DEFAULT_SELECTION: SelectionOptions = {
  ...DEFAULT_BACKTEST,
  seasonalPeriod: 7,
};

export interface Candidate {
  readonly method: ForecastMethod;
  readonly forecaster: Forecaster;
}

/** Candidates admissible for a given demand pattern. */
export function candidatesFor(pattern: DemandPattern, seasonalPeriod: number): Candidate[] {
  const smoothing: Candidate[] = [
    { method: 'ses', forecaster: simpleExponentialSmoothing() },
    { method: 'moving_average', forecaster: movingAverage(7) },
    { method: 'naive', forecaster: naive },
  ];

  switch (pattern) {
    case 'no_demand':
      return [{ method: 'zero', forecaster: zeroForecast }];

    case 'smooth':
      return [
        ...smoothing,
        { method: 'holt', forecaster: holtLinear() },
        { method: 'holt_winters', forecaster: holtWinters(seasonalPeriod) },
        { method: 'seasonal_naive', forecaster: seasonalNaive(seasonalPeriod) },
      ];

    case 'erratic':
      // Trend extrapolation on a volatile series amplifies noise into orders, so
      // Holt is deliberately excluded here.
      return [
        ...smoothing,
        { method: 'holt_winters', forecaster: holtWinters(seasonalPeriod) },
        { method: 'seasonal_naive', forecaster: seasonalNaive(seasonalPeriod) },
        { method: 'moving_average', forecaster: movingAverage(28) },
      ];

    case 'intermittent':
    case 'lumpy':
      return [
        { method: 'croston_sba', forecaster: croston(0.1) },
        { method: 'croston_sba', forecaster: croston(0.2) },
        { method: 'moving_average', forecaster: movingAverage(28) },
        { method: 'ses', forecaster: simpleExponentialSmoothing() },
      ];
  }
}

export interface Selection {
  readonly classification: DemandClassification;
  readonly method: ForecastMethod;
  readonly forecaster: Forecaster;
  /** Out-of-sample accuracy of the winner. `null` when history was too short. */
  readonly metrics: AccuracyMetrics | null;
  /** Ranked scoreboard, best first. Surfaced in the UI to explain the choice. */
  readonly leaderboard: readonly { method: ForecastMethod; mase: number }[];
  /**
   * Confidence in the selection, in [0, 1]. Derived from out-of-sample accuracy
   * and the number of origins tested. The decision engine multiplies its own
   * confidence by this, so a poorly understood SKU cannot trigger a large
   * automatic order.
   */
  readonly confidence: number;
}

/**
 * Map MASE and evidence volume onto a confidence score.
 *
 * MASE 0 → 1.0, MASE 1 (no better than naive) → 0.35, MASE ≥ 2 → floor. The
 * result is then discounted when few origins were available, because a good score
 * measured twice is not the same evidence as a good score measured twenty times.
 */
function confidenceFrom(metrics: AccuracyMetrics | null, origins: number): number {
  if (metrics === null || !Number.isFinite(metrics.mase)) return 0.25;
  const accuracyScore = Math.max(0.1, Math.min(1, 1 - metrics.mase * 0.65));
  const evidenceScore = Math.min(1, origins / 8);
  return Number((accuracyScore * (0.5 + 0.5 * evidenceScore)).toFixed(4));
}

/** Choose the best forecaster for a series and explain the choice. */
export function selectForecaster(
  series: readonly number[],
  options: SelectionOptions = DEFAULT_SELECTION,
): Selection {
  const classification = classifyDemand(series);
  const candidates = candidatesFor(classification.pattern, options.seasonalPeriod);

  if (classification.pattern === 'no_demand') {
    return {
      classification,
      method: 'zero',
      forecaster: zeroForecast,
      metrics: null,
      leaderboard: [{ method: 'zero', mase: 0 }],
      confidence: 1,
    };
  }

  const scored = candidates
    .map((candidate) => ({ candidate, result: backtest(series, candidate.forecaster, options) }))
    .filter((entry) => entry.result.origins > 0)
    .sort((a, b) => a.result.metrics.mase - b.result.metrics.mase);

  const best = scored[0];

  if (best === undefined) {
    // Too little history to hold anything out. Fall back on the classification,
    // which is a principled prior rather than an arbitrary default.
    const fallback = candidates[0] ?? { method: 'naive' as const, forecaster: naive };
    return {
      classification,
      method: fallback.method,
      forecaster: fallback.forecaster,
      metrics: null,
      leaderboard: [],
      confidence: naiveScale(series) === 0 ? 0.4 : 0.25,
    };
  }

  return {
    classification,
    method: best.candidate.method,
    forecaster: best.candidate.forecaster,
    metrics: best.result.metrics,
    leaderboard: scored.map((entry) => ({
      method: entry.candidate.method,
      mase: Number(entry.result.metrics.mase.toFixed(4)),
    })),
    confidence: confidenceFrom(best.result.metrics, best.result.origins),
  };
}

export interface DemandForecast extends Selection {
  readonly result: ForecastResult;
  /** Total demand expected over the whole horizon. */
  readonly horizonTotal: number;
  /** Mean demand per day over the horizon. Drives reorder point arithmetic. */
  readonly dailyRate: number;
}

/** Select a forecaster, run it, and summarise the projection for downstream policy. */
export function forecastDemand(
  series: readonly number[],
  horizon: number,
  options: SelectionOptions = DEFAULT_SELECTION,
): DemandForecast {
  if (!Number.isInteger(horizon) || horizon < 1) {
    throw new RangeError(`Forecast horizon must be a positive integer, received ${horizon}`);
  }

  const selection = selectForecaster(series, options);
  const result = selection.forecaster(series, horizon);
  const horizonTotal = result.point.reduce((acc, v) => acc + v, 0);

  return {
    ...selection,
    result,
    horizonTotal,
    dailyRate: horizonTotal / horizon,
  };
}
