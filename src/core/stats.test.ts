import { describe, expect, it } from 'vitest';
import {
  at,
  averageDemandInterval,
  clamp,
  coefficientOfVariation,
  inverseNormalCdf,
  mean,
  median,
  medianAbsoluteDeviation,
  normalCdf,
  quantile,
  robustZScore,
  squaredCvOfNonZero,
  standardDeviation,
  sum,
  variance,
} from './stats.ts';

describe('at', () => {
  it('returns the element in range', () => {
    expect(at([10, 20, 30], 1)).toBe(20);
  });

  it('throws rather than returning undefined out of range', () => {
    expect(() => at([1, 2], 5)).toThrow(RangeError);
    expect(() => at([1, 2], -1)).toThrow(RangeError);
  });
});

describe('central tendency', () => {
  it('sums and averages', () => {
    expect(sum([1, 2, 3, 4])).toBe(10);
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it('treats an empty series as zero rather than NaN', () => {
    expect(mean([])).toBe(0);
    expect(variance([])).toBe(0);
    expect(median([])).toBe(0);
  });
});

describe('variance', () => {
  it('uses the sample (n−1) divisor', () => {
    // Population variance of this series is 4; the sample variance is 32/7.
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(32 / 7, 10);
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });

  it('is zero for a single observation, since one point has no spread', () => {
    expect(variance([5])).toBe(0);
  });

  it('reports a zero coefficient of variation when the mean is zero', () => {
    expect(coefficientOfVariation([0, 0, 0])).toBe(0);
    expect(coefficientOfVariation([-5, 5])).toBe(0);
  });
});

describe('quantile', () => {
  it('interpolates linearly between order statistics', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3], 0.5)).toBe(2);
  });

  it('clamps to the extremes outside [0, 1]', () => {
    expect(quantile([4, 1, 3], 0)).toBe(1);
    expect(quantile([4, 1, 3], 1)).toBe(4);
  });

  it('does not mutate the input', () => {
    const input = [3, 1, 2];
    quantile(input, 0.5);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('medianAbsoluteDeviation', () => {
  it('scales to estimate sigma for normal data', () => {
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])).toBeCloseTo(1.4826, 4);
  });

  it('ignores a single extreme outlier, unlike the standard deviation', () => {
    const clean = [10, 10, 11, 10, 9, 10, 10];
    const contaminated = [...clean, 10_000];

    const madShift = Math.abs(
      medianAbsoluteDeviation(contaminated) - medianAbsoluteDeviation(clean),
    );
    const sdShift = Math.abs(standardDeviation(contaminated) - standardDeviation(clean));

    expect(madShift).toBeLessThan(1);
    expect(sdShift).toBeGreaterThan(1000);
  });
});

describe('robustZScore', () => {
  it('scores a clear outlier well beyond the alerting threshold', () => {
    const baseline = [10, 11, 9, 10, 10, 11, 9, 10];
    expect(robustZScore(40, baseline)).toBeGreaterThan(10);
  });

  it('scores a typical value near zero', () => {
    const baseline = [10, 11, 9, 10, 10, 11, 9, 10];
    expect(Math.abs(robustZScore(10, baseline))).toBeLessThan(1);
  });

  it('falls back to the classical z-score when the MAD collapses to zero', () => {
    // More than half the baseline is identical, so the MAD is zero.
    const baseline = [5, 5, 5, 5, 5, 9];
    expect(Number.isFinite(robustZScore(9, baseline))).toBe(true);
  });

  it('returns zero for an empty baseline instead of NaN', () => {
    expect(robustZScore(10, [])).toBe(0);
  });
});

describe('normal distribution', () => {
  it('inverts the CDF at the service levels the policy engine uses', () => {
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 6);
    expect(inverseNormalCdf(0.95)).toBeCloseTo(1.6449, 3);
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.96, 3);
    expect(inverseNormalCdf(0.99)).toBeCloseTo(2.3263, 3);
  });

  it('is antisymmetric about the median', () => {
    expect(inverseNormalCdf(0.1)).toBeCloseTo(-inverseNormalCdf(0.9), 6);
  });

  it('round-trips against the forward CDF', () => {
    for (const p of [0.01, 0.25, 0.5, 0.8, 0.95, 0.999]) {
      expect(normalCdf(inverseNormalCdf(p))).toBeCloseTo(p, 5);
    }
  });

  it('handles the degenerate endpoints and rejects impossible probabilities', () => {
    expect(inverseNormalCdf(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(inverseNormalCdf(1)).toBe(Number.POSITIVE_INFINITY);
    expect(() => inverseNormalCdf(1.5)).toThrow(RangeError);
    expect(() => inverseNormalCdf(-0.2)).toThrow(RangeError);
  });

  it('evaluates the forward CDF at known points', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 4);
  });
});

describe('clamp', () => {
  it('bounds a value', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });

  it('rejects an inverted range rather than silently returning nonsense', () => {
    expect(() => clamp(5, 10, 0)).toThrow(RangeError);
  });
});

describe('demand shape measures', () => {
  it('computes the average interval between non-zero demands', () => {
    expect(averageDemandInterval([0, 1, 0, 1])).toBe(2);
    expect(averageDemandInterval([1, 1, 1, 1])).toBe(1);
  });

  it('reports an infinite interval when nothing ever sells', () => {
    expect(averageDemandInterval([0, 0, 0])).toBe(Number.POSITIVE_INFINITY);
  });

  it('measures variability of the non-zero demands only', () => {
    // The zeros are excluded, so a constant non-zero size has no variability.
    expect(squaredCvOfNonZero([0, 10, 0, 10, 0, 10])).toBeCloseTo(0, 10);
    expect(squaredCvOfNonZero([0, 1, 0, 50, 0, 100])).toBeGreaterThan(0.49);
  });

  it('returns zero when there are fewer than two non-zero observations', () => {
    expect(squaredCvOfNonZero([0, 0, 7])).toBe(0);
  });
});
