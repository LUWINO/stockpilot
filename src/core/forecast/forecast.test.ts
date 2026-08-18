import { describe, expect, it } from 'vitest';
import {
  croston,
  holtLinear,
  holtWinters,
  movingAverage,
  naive,
  seasonalNaive,
  simpleExponentialSmoothing,
  zeroForecast,
} from './methods.ts';
import { accuracy, backtest, naiveScale } from './backtest.ts';
import { classifyDemand, forecastDemand, selectForecaster } from './select.ts';
import { buildIntermittentSeries, buildSeries } from '@/testing/fixtures';

const flat = Array.from({ length: 60 }, () => 10);

describe('zeroForecast', () => {
  it('predicts nothing for a SKU that has never moved', () => {
    const result = zeroForecast([0, 0, 0], 3);
    expect(result.point).toEqual([0, 0, 0]);
    expect(result.method).toBe('zero');
  });
});

describe('naive', () => {
  it('repeats the last observation across the horizon', () => {
    expect(naive([1, 2, 3], 3).point).toEqual([3, 3, 3]);
  });

  it('degrades to zero for an empty series rather than producing NaN', () => {
    expect(naive([], 2).point).toEqual([0, 0]);
  });
});

describe('movingAverage', () => {
  it('averages the trailing window', () => {
    expect(movingAverage(3)([9, 10, 11], 1).point[0]).toBeCloseTo(10, 10);
  });

  it('shortens the window when history is thin', () => {
    expect(movingAverage(30)([4, 6], 1).point[0]).toBeCloseTo(5, 10);
  });

  it('rejects a nonsensical window', () => {
    expect(() => movingAverage(0)).toThrow(RangeError);
    expect(() => movingAverage(2.5)).toThrow(RangeError);
  });
});

describe('simpleExponentialSmoothing', () => {
  it('reproduces a constant series exactly, with zero residual error', () => {
    const result = simpleExponentialSmoothing()(flat, 5);
    expect(result.point[0]).toBeCloseTo(10, 6);
    expect(result.residualStdDev).toBeCloseTo(0, 6);
  });

  it('fits alpha by minimising squared error when none is supplied', () => {
    const result = simpleExponentialSmoothing()(buildSeries({ days: 90, base: 30, noise: 5 }), 7);
    expect(result.params.alpha).toBeGreaterThan(0);
    expect(result.params.alpha).toBeLessThan(1);
  });

  it('honours a pinned alpha', () => {
    expect(simpleExponentialSmoothing(0.4)(flat, 1).params.alpha).toBe(0.4);
  });

  it('never forecasts negative demand', () => {
    const declining = Array.from({ length: 40 }, (_, i) => Math.max(0, 20 - i));
    expect(simpleExponentialSmoothing()(declining, 5).point.every((v) => v >= 0)).toBe(true);
  });

  it('falls back for degenerate inputs', () => {
    expect(simpleExponentialSmoothing()([], 2).point).toEqual([0, 0]);
    expect(simpleExponentialSmoothing()([7], 2).point).toEqual([7, 7]);
  });
});

describe('holtLinear', () => {
  const rising = Array.from({ length: 40 }, (_, i) => 10 + i);

  it('projects an upward trend forward', () => {
    const result = holtLinear()(rising, 5);
    expect(result.point[0]).toBeGreaterThan(45);
    expect(result.point[4]).toBeGreaterThan(result.point[0] ?? 0);
  });

  it('damps the trend so a long horizon does not run away', () => {
    const damped = holtLinear(0.5, 0.3, 0.8)(rising, 30);
    const undamped = holtLinear(0.5, 0.3, 1)(rising, 30);
    expect(damped.point[29]).toBeLessThan(undamped.point[29] ?? Infinity);
  });

  it('clamps to zero rather than forecasting negative demand on a decline', () => {
    const falling = Array.from({ length: 40 }, (_, i) => Math.max(0, 40 - i));
    expect(holtLinear()(falling, 30).point.every((v) => v >= 0)).toBe(true);
  });

  it('defers to simpler smoothing when history is too short to see a trend', () => {
    expect(holtLinear()([5, 6], 2).method).toBe('ses');
  });
});

describe('seasonalNaive', () => {
  it('repeats the previous cycle', () => {
    const weekly = [1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7];
    expect(seasonalNaive(7)(weekly, 7).point).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('falls back to naive when there is less than one full cycle', () => {
    expect(seasonalNaive(7)([1, 2, 3], 2).method).toBe('naive');
  });

  it('rejects an invalid period', () => {
    expect(() => seasonalNaive(1)).toThrow(RangeError);
  });
});

describe('holtWinters', () => {
  it('captures a weekly cycle better than flat smoothing', () => {
    const seasonal = buildSeries({ days: 120, base: 40, weekly: 30, noise: 1 });
    const hw = holtWinters(7)(seasonal, 14);
    const ses = simpleExponentialSmoothing()(seasonal, 14);

    expect(hw.method).toBe('holt_winters');
    expect(hw.residualStdDev).toBeLessThan(ses.residualStdDev);
  });

  it('produces a forecast that varies across the week', () => {
    const seasonal = buildSeries({ days: 120, base: 40, weekly: 30, noise: 1 });
    const point = holtWinters(7)(seasonal, 7).point;
    expect(Math.max(...point) - Math.min(...point)).toBeGreaterThan(5);
  });

  it('does not collapse over a long horizon because of one low final day', () => {
    // A partially complete trading day, or a depot that has not synced yet,
    // appears as a trailing zero. Undamped, the trend extrapolates that downturn
    // across the whole horizon and the forecast falls apart — which would stop
    // the agent replenishing a perfectly healthy product.
    const seasonal = buildSeries({ days: 365, base: 60, weekly: 40, noise: 6 });
    const trueMean = seasonal.reduce((a, b) => a + b, 0) / seasonal.length;

    const withPartialDay = [...seasonal, 0];
    const point = holtWinters(7)(withPartialDay, 28).point;
    const forecastMean = point.reduce((a, b) => a + b, 0) / point.length;

    // Tolerate the dip a single zero legitimately causes, but nothing like the
    // collapse an undamped trend produces.
    expect(forecastMean).toBeGreaterThan(trueMean * 0.7);
    // The far horizon must not run away downward either.
    expect(point[27] ?? 0).toBeGreaterThan(trueMean * 0.4);
  });

  it('damps its trend rather than extrapolating it linearly', () => {
    const rising = buildSeries({ days: 200, base: 30, weekly: 10, trend: 0.4, noise: 2 });
    const point = holtWinters(7)(rising, 60).point;

    // With linear extrapolation the 60-day-ahead level would exceed the 30-day
    // one by roughly the same step again; damping makes the gap shrink.
    const early = point.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
    const middle = point.slice(27, 34).reduce((a, b) => a + b, 0) / 7;
    const late = point.slice(53, 60).reduce((a, b) => a + b, 0) / 7;

    expect(late - middle).toBeLessThan(middle - early);
  });

  it('requires two full seasons before it will run', () => {
    expect(holtWinters(7)(Array.from({ length: 10 }, () => 5), 3).method).not.toBe('holt_winters');
  });

  it('rejects an invalid period', () => {
    expect(() => holtWinters(0)).toThrow(RangeError);
  });
});

describe('croston', () => {
  it('estimates the underlying rate of an intermittent series', () => {
    // 10 units every 5 days is a rate of 2/day; the SBA correction shades it down.
    const series = buildIntermittentSeries(100, 5, 10);
    const rate = croston(0.1)(series, 1).point[0] ?? 0;

    expect(rate).toBeGreaterThan(1.5);
    expect(rate).toBeLessThan(2.1);
  });

  it('does not collapse toward zero the way plain smoothing does', () => {
    const series = buildIntermittentSeries(100, 10, 20);
    const crostonRate = croston(0.1)(series, 1).point[0] ?? 0;
    expect(crostonRate).toBeGreaterThan(1);
  });

  it('returns zero when nothing has ever sold', () => {
    expect(croston()(Array.from({ length: 50 }, () => 0), 3).point).toEqual([0, 0, 0]);
  });

  it('handles a series with exactly one sale', () => {
    const series = [...Array.from({ length: 49 }, () => 0), 10];
    const rate = croston()(series, 1).point[0] ?? 0;
    expect(rate).toBeCloseTo(0.2, 6);
  });

  it('rejects an alpha outside (0, 1)', () => {
    expect(() => croston(0)).toThrow(RangeError);
    expect(() => croston(1)).toThrow(RangeError);
  });
});

describe('accuracy metrics', () => {
  it('reports a perfect forecast as zero error', () => {
    const metrics = accuracy([1, 2, 3], [1, 2, 3], 1);
    expect(metrics.mae).toBe(0);
    expect(metrics.rmse).toBe(0);
    expect(metrics.mase).toBe(0);
    expect(metrics.bias).toBe(0);
  });

  it('signs the bias so a chronically low forecast is visible', () => {
    // Actuals exceed forecasts, so the forecast runs low and bias is positive.
    expect(accuracy([10, 10, 10], [8, 8, 8], 1).bias).toBe(2);
    expect(accuracy([8, 8, 8], [10, 10, 10], 1).bias).toBe(-2);
  });

  it('scales MASE against the naive benchmark', () => {
    // Naive scale of 2 with a mean absolute error of 2 gives MASE exactly 1.
    expect(accuracy([10, 10], [8, 8], 2).mase).toBe(1);
  });

  it('returns an infinite MASE when the series has no variation to scale by', () => {
    expect(accuracy([10, 10], [8, 8], 0).mase).toBe(Number.POSITIVE_INFINITY);
  });

  it('keeps sMAPE finite when actuals are zero, unlike plain MAPE', () => {
    expect(Number.isFinite(accuracy([0, 0], [0, 0], 1).smape)).toBe(true);
    expect(accuracy([0, 0], [0, 0], 1).smape).toBe(0);
  });

  it('handles an empty comparison', () => {
    expect(accuracy([], [], 1).observations).toBe(0);
  });
});

describe('naiveScale', () => {
  it('averages the absolute first difference', () => {
    expect(naiveScale([1, 3, 5])).toBe(2);
  });

  it('is zero for a constant or single-point series', () => {
    expect(naiveScale([5, 5, 5])).toBe(0);
    expect(naiveScale([5])).toBe(0);
  });
});

describe('backtest', () => {
  const series = buildSeries({ days: 120, base: 25, weekly: 8, noise: 3 });

  it('evaluates across multiple rolling origins', () => {
    const result = backtest(series, simpleExponentialSmoothing());
    expect(result.origins).toBeGreaterThan(5);
    expect(result.metrics.observations).toBe(result.origins * 7);
  });

  it('reports zero origins when history is too short to hold anything out', () => {
    expect(backtest([1, 2, 3], naive).origins).toBe(0);
  });

  it('rewards the better method with the lower MASE', () => {
    const seasonal = buildSeries({ days: 200, base: 40, weekly: 36, noise: 1 });
    const seasonalResult = backtest(seasonal, seasonalNaive(7));
    const flatResult = backtest(seasonal, simpleExponentialSmoothing());

    expect(seasonalResult.metrics.mase).toBeLessThan(flatResult.metrics.mase);
  });

  it('rejects a non-positive step', () => {
    expect(() => backtest(series, naive, { horizon: 7, minimumTrainSize: 28, step: 0 })).toThrow(
      RangeError,
    );
  });
});

describe('classifyDemand', () => {
  it('labels steady daily demand as smooth', () => {
    expect(classifyDemand(buildSeries({ days: 120, base: 30, noise: 2 })).pattern).toBe('smooth');
  });

  it('labels regular sparse demand as intermittent', () => {
    const classification = classifyDemand(buildIntermittentSeries(100, 5, 10));
    expect(classification.pattern).toBe('intermittent');
    expect(classification.adi).toBeCloseTo(5, 6);
  });

  it('labels sparse demand of varying size as lumpy', () => {
    const lumpy = Array.from({ length: 100 }, (_, i) =>
      i % 7 === 0 ? (i % 21 === 0 ? 100 : 2) : 0,
    );
    expect(classifyDemand(lumpy).pattern).toBe('lumpy');
  });

  it('labels a SKU that has never sold as having no demand', () => {
    const classification = classifyDemand(Array.from({ length: 50 }, () => 0));
    expect(classification.pattern).toBe('no_demand');
    expect(classification.adi).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('selectForecaster', () => {
  it('picks Croston for intermittent demand and never a seasonal method', () => {
    const selection = selectForecaster(buildIntermittentSeries(150, 6, 12));
    expect(selection.method).toBe('croston_sba');
  });

  it('picks a seasonal method for strongly weekly demand', () => {
    const selection = selectForecaster(buildSeries({ days: 220, base: 40, weekly: 36, noise: 1 }));
    expect(['holt_winters', 'seasonal_naive']).toContain(selection.method);
  });

  it('short-circuits to the zero forecast when nothing has ever sold', () => {
    const selection = selectForecaster(Array.from({ length: 60 }, () => 0));
    expect(selection.method).toBe('zero');
    expect(selection.confidence).toBe(1);
  });

  it('publishes a ranked leaderboard so the choice can be explained', () => {
    const selection = selectForecaster(buildSeries({ days: 150, base: 30, weekly: 10, noise: 4 }));
    const scores = selection.leaderboard.map((entry) => entry.mase);

    expect(scores.length).toBeGreaterThan(1);
    expect([...scores]).toEqual([...scores].sort((a, b) => a - b));
  });

  it('reports low confidence when history is too short to validate anything', () => {
    const selection = selectForecaster([5, 6, 7, 5, 6]);
    expect(selection.metrics).toBeNull();
    expect(selection.confidence).toBeLessThan(0.5);
  });

  it('keeps confidence within [0, 1] across a range of inputs', () => {
    for (const series of [
      buildSeries({ days: 120, base: 30, noise: 2 }),
      buildIntermittentSeries(120, 8, 5),
      buildSeries({ days: 120, base: 5, noise: 20, seed: 7 }),
    ]) {
      const { confidence } = selectForecaster(series);
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('forecastDemand', () => {
  it('summarises the horizon into a daily rate the policy layer can use', () => {
    const forecast = forecastDemand(buildSeries({ days: 150, base: 20, weekly: 6, noise: 2 }), 14);

    expect(forecast.result.point).toHaveLength(14);
    expect(forecast.horizonTotal).toBeCloseTo(
      forecast.result.point.reduce((a, b) => a + b, 0),
      6,
    );
    expect(forecast.dailyRate).toBeCloseTo(forecast.horizonTotal / 14, 6);
    expect(forecast.dailyRate).toBeGreaterThan(10);
    expect(forecast.dailyRate).toBeLessThan(30);
  });

  it('rejects a non-positive horizon', () => {
    expect(() => forecastDemand(flat, 0)).toThrow(RangeError);
    expect(() => forecastDemand(flat, 1.5)).toThrow(RangeError);
  });
});
