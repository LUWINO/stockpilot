/**
 * Demand forecasting methods.
 *
 * Each forecaster takes a daily demand series (oldest first, gaps zero-filled)
 * and returns both the forward projection and the in-sample one-step-ahead fits.
 * The fits matter as much as the projection: their residuals are what
 * `safetyStock` uses to size the buffer, and a forecast without an honest error
 * estimate is worse than no forecast at all, because it invites false confidence.
 *
 * Smoothing parameters are fitted by grid search against sum-of-squared-error.
 * Grid search rather than gradient descent because the surfaces are low
 * dimensional, the grids are small, and determinism beats a marginally better
 * optimum when an auditor asks why the system ordered what it ordered.
 */

import { at, mean, standardDeviation } from '../stats.ts';

export type ForecastMethod =
  | 'zero'
  | 'naive'
  | 'moving_average'
  | 'ses'
  | 'holt'
  | 'holt_winters'
  | 'seasonal_naive'
  | 'croston_sba';

export interface ForecastResult {
  readonly method: ForecastMethod;
  /** Projection for the next `horizon` days, index 0 being tomorrow. */
  readonly point: readonly number[];
  /** One-step-ahead in-sample fits, aligned to the input series. */
  readonly fitted: readonly number[];
  /** Standard deviation of the one-step-ahead residuals. Feeds safety stock. */
  readonly residualStdDev: number;
  /** Fitted parameter values, recorded so a forecast can be reproduced exactly. */
  readonly params: Readonly<Record<string, number>>;
}

export type Forecaster = (series: readonly number[], horizon: number) => ForecastResult;

function residualStdDev(series: readonly number[], fitted: readonly number[]): number {
  const residuals: number[] = [];
  for (let i = 0; i < series.length && i < fitted.length; i += 1) {
    residuals.push(at(series, i) - at(fitted, i));
  }
  return standardDeviation(residuals);
}

function constantPoint(value: number, horizon: number): number[] {
  return Array.from({ length: horizon }, () => value);
}

/** Everything is zero. The honest answer for a SKU that has never moved. */
export const zeroForecast: Forecaster = (series, horizon) => ({
  method: 'zero',
  point: constantPoint(0, horizon),
  fitted: series.map(() => 0),
  residualStdDev: standardDeviation([...series]),
  params: {},
});

/** Tomorrow looks like today. The benchmark every other method must beat. */
export const naive: Forecaster = (series, horizon) => {
  if (series.length === 0) return zeroForecast(series, horizon);
  const last = at(series, series.length - 1);
  const fitted = series.map((_, i) => (i === 0 ? at(series, 0) : at(series, i - 1)));
  return {
    method: 'naive',
    point: constantPoint(last, horizon),
    fitted,
    residualStdDev: residualStdDev(series, fitted),
    params: {},
  };
};

/** Flat average of the trailing `window` observations. */
export function movingAverage(window: number): Forecaster {
  if (!Number.isInteger(window) || window < 1) {
    throw new RangeError(`Moving-average window must be a positive integer, received ${window}`);
  }
  return (series, horizon) => {
    if (series.length === 0) return zeroForecast(series, horizon);
    const effective = Math.min(window, series.length);
    const fitted = series.map((_, i) => {
      if (i === 0) return at(series, 0);
      const start = Math.max(0, i - effective);
      return mean(series.slice(start, i));
    });
    const level = mean(series.slice(series.length - effective));
    return {
      method: 'moving_average',
      point: constantPoint(level, horizon),
      fitted,
      residualStdDev: residualStdDev(series, fitted),
      params: { window: effective },
    };
  };
}

function sesFit(series: readonly number[], alpha: number): { fitted: number[]; level: number } {
  let level = at(series, 0);
  const fitted: number[] = [level];
  for (let i = 1; i < series.length; i += 1) {
    level = alpha * at(series, i - 1) + (1 - alpha) * level;
    fitted.push(level);
  }
  // Fold in the final observation so the projection reflects all known data.
  const finalLevel = alpha * at(series, series.length - 1) + (1 - alpha) * level;
  return { fitted, level: finalLevel };
}

function sumSquaredError(series: readonly number[], fitted: readonly number[]): number {
  let acc = 0;
  for (let i = 0; i < series.length && i < fitted.length; i += 1) {
    acc += (at(series, i) - at(fitted, i)) ** 2;
  }
  return acc;
}

const ALPHA_GRID = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const BETA_GRID = [0.02, 0.05, 0.1, 0.2, 0.3, 0.4];
const PHI_GRID = [0.8, 0.9, 0.95, 0.98, 1];
const GAMMA_GRID = [0.05, 0.1, 0.2, 0.3, 0.5];

/**
 * Simple exponential smoothing.
 *
 * The workhorse for stable demand with no trend. `alpha` is fitted unless pinned.
 */
export function simpleExponentialSmoothing(alpha?: number): Forecaster {
  return (series, horizon) => {
    if (series.length === 0) return zeroForecast(series, horizon);
    if (series.length === 1) return naive(series, horizon);

    let bestAlpha = alpha ?? at(ALPHA_GRID, 0);
    let best = sesFit(series, bestAlpha);

    if (alpha === undefined) {
      let bestSse = sumSquaredError(series, best.fitted);
      for (const candidate of ALPHA_GRID) {
        const fit = sesFit(series, candidate);
        const sse = sumSquaredError(series, fit.fitted);
        if (sse < bestSse) {
          bestSse = sse;
          bestAlpha = candidate;
          best = fit;
        }
      }
    }

    return {
      method: 'ses',
      point: constantPoint(Math.max(0, best.level), horizon),
      fitted: best.fitted,
      residualStdDev: residualStdDev(series, best.fitted),
      params: { alpha: bestAlpha },
    };
  };
}

function holtFit(
  series: readonly number[],
  alpha: number,
  beta: number,
  phi: number,
): { fitted: number[]; level: number; trend: number } {
  let level = at(series, 0);
  let trend = series.length > 1 ? at(series, 1) - at(series, 0) : 0;
  const fitted: number[] = [level];

  for (let i = 1; i < series.length; i += 1) {
    const forecast = level + phi * trend;
    fitted.push(forecast);
    const observation = at(series, i);
    const previousLevel = level;
    level = alpha * observation + (1 - alpha) * forecast;
    trend = beta * (level - previousLevel) + (1 - beta) * phi * trend;
  }

  return { fitted, level, trend };
}

/**
 * Holt's linear trend method with damping.
 *
 * The damping factor `phi` keeps a trend from extrapolating to absurdity over a
 * long horizon — an undamped upward trend will happily order a warehouse full of
 * stock off the back of one good fortnight.
 */
export function holtLinear(alpha?: number, beta?: number, phi?: number): Forecaster {
  return (series, horizon) => {
    if (series.length < 3) return simpleExponentialSmoothing(alpha)(series, horizon);

    let bestParams = { alpha: alpha ?? 0.3, beta: beta ?? 0.1, phi: phi ?? 0.95 };
    let best = holtFit(series, bestParams.alpha, bestParams.beta, bestParams.phi);
    let bestSse = sumSquaredError(series, best.fitted);

    const alphas = alpha === undefined ? ALPHA_GRID : [alpha];
    const betas = beta === undefined ? BETA_GRID : [beta];
    const phis = phi === undefined ? PHI_GRID : [phi];

    for (const a of alphas) {
      for (const b of betas) {
        for (const p of phis) {
          const fit = holtFit(series, a, b, p);
          const sse = sumSquaredError(series, fit.fitted);
          if (sse < bestSse) {
            bestSse = sse;
            bestParams = { alpha: a, beta: b, phi: p };
            best = fit;
          }
        }
      }
    }

    // Damped trend accumulates as a geometric series, not linearly.
    const point: number[] = [];
    let damping = 0;
    for (let h = 1; h <= horizon; h += 1) {
      damping += bestParams.phi ** h;
      point.push(Math.max(0, best.level + damping * best.trend));
    }

    return {
      method: 'holt',
      point,
      fitted: best.fitted,
      residualStdDev: residualStdDev(series, best.fitted),
      params: bestParams,
    };
  };
}

/** Same weekday last week. Captures weekly retail rhythm with no fitting at all. */
export function seasonalNaive(period: number): Forecaster {
  if (!Number.isInteger(period) || period < 2) {
    throw new RangeError(`Seasonal period must be an integer of at least 2, received ${period}`);
  }
  return (series, horizon) => {
    if (series.length < period) return naive(series, horizon);
    const fitted = series.map((_, i) => (i < period ? at(series, i) : at(series, i - period)));
    const point: number[] = [];
    for (let h = 0; h < horizon; h += 1) {
      point.push(at(series, series.length - period + (h % period)));
    }
    return {
      method: 'seasonal_naive',
      point,
      fitted,
      residualStdDev: residualStdDev(series, fitted),
      params: { period },
    };
  };
}

function holtWintersFit(
  series: readonly number[],
  period: number,
  alpha: number,
  beta: number,
  gamma: number,
): { fitted: number[]; level: number; trend: number; seasonal: number[] } {
  const firstSeason = series.slice(0, period);
  const seasonMean = mean(firstSeason);
  const seasonal = firstSeason.map((v) => v - seasonMean);

  let level = seasonMean;
  let trend =
    series.length >= 2 * period ? (mean(series.slice(period, 2 * period)) - seasonMean) / period : 0;

  const fitted: number[] = [];

  for (let i = 0; i < series.length; i += 1) {
    const seasonalIndex = i % period;
    const seasonalComponent = at(seasonal, seasonalIndex);
    const forecast = level + trend + seasonalComponent;
    fitted.push(forecast);

    const observation = at(series, i);
    const previousLevel = level;
    level = alpha * (observation - seasonalComponent) + (1 - alpha) * (level + trend);
    trend = beta * (level - previousLevel) + (1 - beta) * trend;
    seasonal[seasonalIndex] = gamma * (observation - level) + (1 - gamma) * seasonalComponent;
  }

  return { fitted, level, trend, seasonal };
}

/**
 * Additive Holt–Winters.
 *
 * Additive rather than multiplicative because demand series routinely contain
 * zeros (closed days, stockouts) and the multiplicative form is undefined there.
 * Requires two full seasons of history before it is allowed to run.
 */
export function holtWinters(period: number): Forecaster {
  if (!Number.isInteger(period) || period < 2) {
    throw new RangeError(`Seasonal period must be an integer of at least 2, received ${period}`);
  }

  return (series, horizon) => {
    if (series.length < 2 * period) return holtLinear()(series, horizon);

    let bestParams = { alpha: 0.3, beta: 0.1, gamma: 0.1 };
    let best = holtWintersFit(series, period, bestParams.alpha, bestParams.beta, bestParams.gamma);
    let bestSse = sumSquaredError(series, best.fitted);

    for (const a of ALPHA_GRID) {
      for (const b of BETA_GRID) {
        for (const g of GAMMA_GRID) {
          const fit = holtWintersFit(series, period, a, b, g);
          const sse = sumSquaredError(series, fit.fitted);
          if (sse < bestSse) {
            bestSse = sse;
            bestParams = { alpha: a, beta: b, gamma: g };
            best = fit;
          }
        }
      }
    }

    const point: number[] = [];
    for (let h = 1; h <= horizon; h += 1) {
      const seasonalIndex = (series.length + h - 1) % period;
      point.push(Math.max(0, best.level + h * best.trend + at(best.seasonal, seasonalIndex)));
    }

    return {
      method: 'holt_winters',
      point,
      fitted: best.fitted,
      residualStdDev: residualStdDev(series, best.fitted),
      params: { ...bestParams, period },
    };
  };
}

/**
 * Croston's method with the Syntetos–Boylan bias correction.
 *
 * Spare parts and slow movers produce series that are mostly zeros. Exponential
 * smoothing applied to such a series drifts toward the mean including the zeros
 * and systematically under-forecasts the days that actually matter. Croston
 * separates *how much* is demanded from *how often*, smooths each independently,
 * and divides. The 1−α/2 factor corrects the upward bias in the original method.
 */
export function croston(alpha = 0.1): Forecaster {
  if (alpha <= 0 || alpha >= 1) throw new RangeError(`Croston alpha must lie in (0, 1), received ${alpha}`);

  return (series, horizon) => {
    const nonZeroIndices: number[] = [];
    for (let i = 0; i < series.length; i += 1) {
      if (at(series, i) > 0) nonZeroIndices.push(i);
    }

    if (nonZeroIndices.length === 0) return zeroForecast(series, horizon);
    if (nonZeroIndices.length === 1) {
      const rate = at(series, at(nonZeroIndices, 0)) / series.length;
      return {
        method: 'croston_sba',
        point: constantPoint(rate, horizon),
        fitted: series.map(() => rate),
        residualStdDev: standardDeviation([...series]),
        params: { alpha, size: at(series, at(nonZeroIndices, 0)), interval: series.length },
      };
    }

    let size = at(series, at(nonZeroIndices, 0));
    let interval = at(nonZeroIndices, 0) + 1;
    const fitted: number[] = [];
    let previousIndex = at(nonZeroIndices, 0);
    let rate = (size / interval) * (1 - alpha / 2);

    for (let i = 0; i < series.length; i += 1) {
      fitted.push(rate);
      const observation = at(series, i);
      if (observation > 0 && i > at(nonZeroIndices, 0)) {
        size = alpha * observation + (1 - alpha) * size;
        interval = alpha * (i - previousIndex) + (1 - alpha) * interval;
        previousIndex = i;
        rate = (size / interval) * (1 - alpha / 2);
      }
    }

    return {
      method: 'croston_sba',
      point: constantPoint(Math.max(0, rate), horizon),
      fitted,
      residualStdDev: residualStdDev(series, fitted),
      params: { alpha, size, interval },
    };
  };
}
