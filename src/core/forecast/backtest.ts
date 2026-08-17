/**
 * Rolling-origin backtesting.
 *
 * A forecaster is chosen by how well it predicts data it has not seen, never by
 * how well it fits data it has. Fitting accuracy always improves with model
 * complexity, so selecting on it reliably picks the most overfitted candidate.
 */

import { at, mean } from '../stats.ts';
import type { Forecaster, ForecastMethod } from './methods.ts';

export interface AccuracyMetrics {
  /** Mean absolute error, in stock units. */
  readonly mae: number;
  /** Root mean squared error. Punishes the large misses that cause stockouts. */
  readonly rmse: number;
  /** Symmetric MAPE, as a fraction. Defined when actuals are zero, unlike MAPE. */
  readonly smape: number;
  /**
   * Mean absolute scaled error. The primary selection criterion: it is scale-free,
   * defined for series containing zeros, and directly interpretable — below 1 means
   * the forecaster beats the naive benchmark, above 1 means it is worse than doing
   * nothing at all.
   */
  readonly mase: number;
  /** Mean error. Positive means the forecast runs low, which becomes stockouts. */
  readonly bias: number;
  /** Number of (forecast, actual) pairs the metrics were computed over. */
  readonly observations: number;
}

const EMPTY_METRICS: AccuracyMetrics = {
  mae: Number.POSITIVE_INFINITY,
  rmse: Number.POSITIVE_INFINITY,
  smape: Number.POSITIVE_INFINITY,
  mase: Number.POSITIVE_INFINITY,
  bias: 0,
  observations: 0,
};

/**
 * Mean absolute error of the in-sample one-step naive forecast.
 *
 * This is the denominator of MASE. A series with no variation at all has a scale
 * of zero and cannot be scaled, so callers get `Infinity` MASE and fall through
 * to the default forecaster.
 */
export function naiveScale(series: readonly number[]): number {
  if (series.length < 2) return 0;
  let acc = 0;
  for (let i = 1; i < series.length; i += 1) {
    acc += Math.abs(at(series, i) - at(series, i - 1));
  }
  return acc / (series.length - 1);
}

export function accuracy(
  actuals: readonly number[],
  forecasts: readonly number[],
  scale: number,
): AccuracyMetrics {
  const n = Math.min(actuals.length, forecasts.length);
  if (n === 0) return EMPTY_METRICS;

  const absoluteErrors: number[] = [];
  const squaredErrors: number[] = [];
  const symmetricErrors: number[] = [];
  const errors: number[] = [];

  for (let i = 0; i < n; i += 1) {
    const actual = at(actuals, i);
    const forecast = at(forecasts, i);
    const error = actual - forecast;
    errors.push(error);
    absoluteErrors.push(Math.abs(error));
    squaredErrors.push(error * error);

    const denominator = (Math.abs(actual) + Math.abs(forecast)) / 2;
    symmetricErrors.push(denominator === 0 ? 0 : Math.abs(error) / denominator);
  }

  const mae = mean(absoluteErrors);

  return {
    mae,
    rmse: Math.sqrt(mean(squaredErrors)),
    smape: mean(symmetricErrors),
    mase: scale > 0 ? mae / scale : Number.POSITIVE_INFINITY,
    bias: mean(errors),
    observations: n,
  };
}

export interface BacktestOptions {
  /** Days ahead each origin forecasts. Should match the real planning horizon. */
  readonly horizon: number;
  /** Minimum history before the first origin. Guards against fitting to noise. */
  readonly minimumTrainSize: number;
  /** Days between successive origins. Larger values trade precision for speed. */
  readonly step: number;
}

export const DEFAULT_BACKTEST: BacktestOptions = {
  horizon: 7,
  minimumTrainSize: 28,
  step: 7,
};

export interface BacktestResult {
  readonly method: ForecastMethod;
  readonly metrics: AccuracyMetrics;
  /** How many origins contributed. One or zero means the result is not trustworthy. */
  readonly origins: number;
}

/**
 * Evaluate a forecaster by walking an expanding window forward through history.
 *
 * At each origin the forecaster sees only the data up to that point, produces a
 * `horizon`-day projection, and is scored against what actually happened. This
 * mirrors how the system is used in production, which is the only evaluation that
 * predicts production behaviour.
 */
export function backtest(
  series: readonly number[],
  forecaster: Forecaster,
  options: BacktestOptions = DEFAULT_BACKTEST,
): BacktestResult {
  const { horizon, minimumTrainSize, step } = options;
  if (step < 1) throw new RangeError(`Backtest step must be at least 1, received ${step}`);

  const scale = naiveScale(series);
  const actuals: number[] = [];
  const predictions: number[] = [];
  let origins = 0;
  let method: ForecastMethod = 'naive';

  for (let origin = minimumTrainSize; origin + horizon <= series.length; origin += step) {
    const train = series.slice(0, origin);
    const result = forecaster(train, horizon);
    method = result.method;
    origins += 1;

    for (let h = 0; h < horizon; h += 1) {
      actuals.push(at(series, origin + h));
      predictions.push(at(result.point, h));
    }
  }

  if (origins === 0) {
    // Not enough history to hold anything out; report a single in-sample origin so
    // callers can still rank candidates, and signal the weakness via `origins: 0`.
    const result = forecaster(series, horizon);
    return { method: result.method, metrics: EMPTY_METRICS, origins: 0 };
  }

  return { method, metrics: accuracy(actuals, predictions, scale), origins };
}
