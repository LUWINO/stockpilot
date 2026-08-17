/**
 * Statistics used by forecasting, safety stock and anomaly detection.
 *
 * Everything here is deliberately dependency-free and deterministic: the same
 * inputs always produce bit-identical outputs, which is what makes an autonomous
 * decision reproducible months later during an audit.
 */

/** Bounds-checked array access. Required because `noUncheckedIndexedAccess` is on. */
export function at<T>(xs: readonly T[], index: number): T {
  const value = xs[index];
  if (value === undefined) {
    throw new RangeError(`Index ${index} is out of bounds for length ${xs.length}`);
  }
  return value;
}

export function sum(xs: readonly number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return sum(xs) / xs.length;
}

/**
 * Sample variance (Bessel-corrected, n−1).
 *
 * The n−1 divisor matters: demand history is a *sample* of an ongoing process,
 * and the population formula would systematically understate variability, which
 * in turn understates safety stock and causes stockouts.
 */
export function variance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) ** 2;
  return acc / (xs.length - 1);
}

export function standardDeviation(xs: readonly number[]): number {
  return Math.sqrt(variance(xs));
}

/** Ratio of spread to level. Undefined for a zero mean, reported as 0. */
export function coefficientOfVariation(xs: readonly number[]): number {
  const m = mean(xs);
  if (m === 0) return 0;
  return standardDeviation(xs) / Math.abs(m);
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

/** Linear-interpolation quantile (the "type 7" definition used by R and NumPy). */
export function quantile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  if (p <= 0) return Math.min(...xs);
  if (p >= 1) return Math.max(...xs);
  const sorted = [...xs].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return at(sorted, lower);
  const weight = position - lower;
  return at(sorted, lower) * (1 - weight) + at(sorted, upper) * weight;
}

/**
 * Median absolute deviation, scaled to be a consistent estimator of σ for
 * normally distributed data.
 *
 * Preferred over the standard deviation for anomaly detection because a single
 * enormous outlier — exactly the thing being detected — inflates σ enough to hide
 * itself, whereas the MAD is unmoved by up to half the sample being corrupt.
 */
export function medianAbsoluteDeviation(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const med = median(xs);
  const deviations = xs.map((x) => Math.abs(x - med));
  return 1.4826 * median(deviations);
}

/**
 * Robust z-score of `value` against a baseline sample.
 *
 * Falls back to the classical z-score when the MAD is zero (which happens when
 * more than half the baseline is identical, e.g. a long run of zero demand).
 */
export function robustZScore(value: number, baseline: readonly number[]): number {
  if (baseline.length === 0) return 0;
  const mad = medianAbsoluteDeviation(baseline);
  if (mad > 0) return (value - median(baseline)) / mad;
  const sd = standardDeviation(baseline);
  if (sd === 0) return value === mean(baseline) ? 0 : Number.POSITIVE_INFINITY * Math.sign(value - mean(baseline));
  return (value - mean(baseline)) / sd;
}

/**
 * Inverse standard normal CDF — the z-multiplier for a target service level.
 *
 * Uses Peter Acklam's rational approximation, refined by one step of Halley's
 * method. Accurate to roughly 1e-15 across the open interval, which is far more
 * precision than a service level ever needs but costs nothing.
 */
export function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) {
    if (p === 0) return Number.NEGATIVE_INFINITY;
    if (p === 1) return Number.POSITIVE_INFINITY;
    throw new RangeError(`Probability must lie in (0, 1), received ${p}`);
  }

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let x: number;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q + at(c, 5)) /
      ((((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((at(a, 0) * r + at(a, 1)) * r + at(a, 2)) * r + at(a, 3)) * r + at(a, 4)) * r + at(a, 5)) * q) /
      (((((at(b, 0) * r + at(b, 1)) * r + at(b, 2)) * r + at(b, 3)) * r + at(b, 4)) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q + at(c, 5)) /
      ((((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1);
  }

  // One Halley refinement removes the approximation's residual error.
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** Standard normal CDF, via the error function. */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Abramowitz & Stegun 7.1.26 — max absolute error 1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return sign * y;
}

/** Clamp `value` into `[lower, upper]`. */
export function clamp(value: number, lower: number, upper: number): number {
  if (lower > upper) throw new RangeError(`Empty clamp range [${lower}, ${upper}]`);
  return Math.min(Math.max(value, lower), upper);
}

/**
 * Average demand interval — mean gap between non-zero demand observations.
 *
 * Together with the squared coefficient of variation of the non-zero demands,
 * this places a SKU in the Syntetos–Boylan quadrant that decides which forecasting
 * method is appropriate.
 */
export function averageDemandInterval(series: readonly number[]): number {
  const nonZero = series.reduce((count, v) => (v !== 0 ? count + 1 : count), 0);
  if (nonZero === 0) return Number.POSITIVE_INFINITY;
  return series.length / nonZero;
}

/** Squared coefficient of variation of the non-zero entries only. */
export function squaredCvOfNonZero(series: readonly number[]): number {
  const nonZero = series.filter((v) => v !== 0);
  if (nonZero.length < 2) return 0;
  return coefficientOfVariation(nonZero) ** 2;
}
