/**
 * Anomaly detection.
 *
 * These detectors answer "what is wrong right now?", separately from "what should
 * we order?". Keeping them apart matters: an anomaly is a statement about the
 * world that a human can verify, whereas a replenishment is a proposal about the
 * future. Mixing the two produces alerts nobody can check and orders nobody can
 * explain.
 *
 * Every detector attaches quantified evidence and, where it can, a monetary
 * impact — an alert that cannot be costed cannot be prioritised.
 */

import { type Money, multiply, zero } from './money.ts';
import { quantityAtExpiryRisk, type StockMovement } from './ledger.ts';
import { coefficientOfVariation, mean, robustZScore } from './stats.ts';
import type { IsoDate, Severity, StockContext } from './types.ts';

export type AnomalyKind =
  | 'NEGATIVE_STOCK'
  | 'STOCKOUT_IMMINENT'
  | 'DEAD_STOCK'
  | 'EXPIRY_RISK'
  | 'OVERSTOCK'
  | 'DEMAND_SPIKE'
  | 'DEMAND_COLLAPSE'
  | 'SHRINKAGE'
  | 'SUPPLIER_UNRELIABLE';

export interface Anomaly {
  readonly kind: AnomalyKind;
  readonly skuId: string;
  readonly siteId: string;
  readonly severity: Severity;
  /** One sentence a warehouse manager can act on without reading the code. */
  readonly summary: string;
  /** Numeric evidence, rendered verbatim in the console and the audit trail. */
  readonly evidence: Readonly<Record<string, number>>;
  /** Money at stake. Zero when the anomaly has no direct financial exposure. */
  readonly financialImpact: Money;
  readonly detectedAt: IsoDate;
}

export interface DetectionThresholds {
  /** Days without an outbound movement before stock is considered dead. */
  readonly deadStockDays: number;
  /** Days of cover above which stock is considered excessive. */
  readonly overstockCoverDays: number;
  /** Robust z-score beyond which a day's demand is called a spike. */
  readonly demandSpikeZ: number;
  /** Fraction of baseline demand below which a collapse is flagged. */
  readonly demandCollapseRatio: number;
  /** Cumulative negative adjustment, as a fraction of throughput, flagged as loss. */
  readonly shrinkageRate: number;
  /** Lead-time coefficient of variation above which a supplier is unreliable. */
  readonly leadTimeCv: number;
  /** Days of cover below which a stockout is called imminent. */
  readonly stockoutCoverDays: number;
}

export const DEFAULT_THRESHOLDS: DetectionThresholds = {
  deadStockDays: 90,
  overstockCoverDays: 120,
  demandSpikeZ: 3.5,
  demandCollapseRatio: 0.35,
  shrinkageRate: 0.02,
  leadTimeCv: 0.5,
  stockoutCoverDays: 3,
};

interface DetectionInput {
  readonly context: StockContext;
  /** Recent daily demand rate from the forecast, not the raw history. */
  readonly dailyDemand: number;
  readonly today: IsoDate;
  readonly movements: readonly StockMovement[];
  readonly thresholds?: DetectionThresholds;
}

/** Run every detector and return the findings, most severe first. */
export function detectAnomalies(input: DetectionInput): Anomaly[] {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const findings = [
    detectNegativeStock(input, thresholds),
    detectStockoutImminent(input, thresholds),
    detectDeadStock(input, thresholds),
    detectExpiryRisk(input, thresholds),
    detectOverstock(input, thresholds),
    detectDemandShift(input, thresholds),
    detectShrinkage(input, thresholds),
    detectSupplierUnreliability(input, thresholds),
  ].filter((a): a is Anomaly => a !== null);

  return findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

const SEVERITY_ORDER: readonly Severity[] = ['info', 'low', 'medium', 'high', 'critical'];

export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

function base(input: DetectionInput): Pick<Anomaly, 'skuId' | 'siteId' | 'detectedAt'> {
  return { skuId: input.context.sku.id, siteId: input.context.siteId, detectedAt: input.today };
}

/**
 * On-hand below zero.
 *
 * Always critical and never a mathematical artefact: the ledger cannot go negative
 * through normal operation, so this means goods left without being booked out, or
 * a receipt was never recorded. Either way the books and the shelf disagree.
 */
function detectNegativeStock(input: DetectionInput, _t: DetectionThresholds): Anomaly | null {
  const { onHand, sku } = { onHand: input.context.onHand, sku: input.context.sku };
  if (onHand >= 0) return null;

  return {
    ...base(input),
    kind: 'NEGATIVE_STOCK',
    severity: 'critical',
    summary: `On-hand for ${sku.code} is ${onHand}: goods have moved without being recorded. Count immediately.`,
    evidence: { onHand },
    financialImpact: multiply(sku.unitCost, Math.abs(onHand), 'half-even'),
  };
}

function detectStockoutImminent(input: DetectionInput, t: DetectionThresholds): Anomaly | null {
  const { context, dailyDemand } = input;
  if (dailyDemand <= 0 || context.onHand < 0) return null;

  const available = context.onHand - context.reserved;
  const cover = available / dailyDemand;
  if (cover > t.stockoutCoverDays) return null;
  if (context.onOrder > 0 && (available + context.onOrder) / dailyDemand > t.stockoutCoverDays) return null;

  const severity: Severity = cover <= 0 ? 'critical' : cover <= 1 ? 'high' : 'medium';
  // Lost margin, not lost revenue: the cost of goods is not incurred on a sale
  // that never happens.
  const lostMarginPerUnit = unitMargin(input);
  const unitsAtRisk = Math.max(0, Math.ceil((t.stockoutCoverDays - cover) * dailyDemand));

  return {
    ...base(input),
    kind: 'STOCKOUT_IMMINENT',
    severity,
    summary:
      `${context.sku.code} has ${cover.toFixed(1)} days of cover at ${dailyDemand.toFixed(1)}/day` +
      `${context.onOrder > 0 ? ` with ${context.onOrder} inbound` : ' and nothing inbound'}.`,
    evidence: { coverDays: round(cover), available, dailyDemand: round(dailyDemand), onOrder: context.onOrder },
    financialImpact: multiply(lostMarginPerUnit, unitsAtRisk, 'half-even'),
  };
}

function unitMargin(input: DetectionInput): Money {
  const { unitPrice, unitCost } = input.context.sku;
  if (unitPrice.currency !== unitCost.currency) return zero(unitCost.currency);
  return { amount: Math.max(0, unitPrice.amount - unitCost.amount), currency: unitCost.currency };
}

/**
 * Stock that has not moved outward in a long time.
 *
 * Dead stock is a balance-sheet asset that behaves like a liability: it consumes
 * capital and space and will usually end up written off. Flagging it early is what
 * makes a markdown possible while the goods are still worth something.
 */
function detectDeadStock(input: DetectionInput, t: DetectionThresholds): Anomaly | null {
  const { context } = input;
  const idle = context.daysSinceLastIssue;
  if (context.onHand <= 0) return null;
  if (idle === null || idle < t.deadStockDays) return null;

  const value = multiply(context.sku.unitCost, context.onHand, 'half-even');
  const severity: Severity = idle >= t.deadStockDays * 2 ? 'high' : 'medium';

  return {
    ...base(input),
    kind: 'DEAD_STOCK',
    severity,
    summary: `${context.sku.code} has not moved in ${idle} days with ${context.onHand} units on hand.`,
    evidence: { daysSinceLastIssue: idle, onHand: context.onHand, tiedUpValue: value.amount },
    financialImpact: value,
  };
}

/** Perishable stock that cannot plausibly sell before it expires. */
function detectExpiryRisk(input: DetectionInput, _t: DetectionThresholds): Anomaly | null {
  const { context, dailyDemand, today } = input;
  if (!context.sku.perishable || context.lots.length === 0) return null;

  const atRisk = quantityAtExpiryRisk(
    context.lots.map((lot) => ({
      id: lot.id,
      quantity: lot.quantity,
      receivedAt: lot.receivedAt,
      ...(lot.expiresOn === undefined ? {} : { expiresOn: lot.expiresOn }),
    })),
    dailyDemand,
    today,
  );

  if (atRisk <= 0) return null;

  const value = multiply(context.sku.unitCost, atRisk, 'half-even');
  const shareAtRisk = context.onHand > 0 ? atRisk / context.onHand : 1;
  const severity: Severity = shareAtRisk > 0.5 ? 'high' : shareAtRisk > 0.2 ? 'medium' : 'low';

  return {
    ...base(input),
    kind: 'EXPIRY_RISK',
    severity,
    summary: `${atRisk} units of ${context.sku.code} will expire before they can sell at ${dailyDemand.toFixed(1)}/day.`,
    evidence: { unitsAtRisk: atRisk, shareAtRisk: round(shareAtRisk), dailyDemand: round(dailyDemand) },
    financialImpact: value,
  };
}

function detectOverstock(input: DetectionInput, t: DetectionThresholds): Anomaly | null {
  const { context, dailyDemand } = input;
  if (dailyDemand <= 0 || context.onHand <= 0) return null;

  const cover = context.onHand / dailyDemand;
  if (cover <= t.overstockCoverDays) return null;

  const excessUnits = Math.max(0, Math.floor(context.onHand - t.overstockCoverDays * dailyDemand));
  const value = multiply(context.sku.unitCost, excessUnits, 'half-even');

  return {
    ...base(input),
    kind: 'OVERSTOCK',
    severity: cover > t.overstockCoverDays * 3 ? 'medium' : 'low',
    summary: `${context.sku.code} holds ${cover.toFixed(0)} days of cover; ${excessUnits} units are surplus to a ${t.overstockCoverDays}-day target.`,
    evidence: { coverDays: round(cover), excessUnits, onHand: context.onHand },
    financialImpact: value,
  };
}

/**
 * A step change in demand, in either direction.
 *
 * Compares the last week against the preceding baseline using a robust z-score, so
 * one freak day cannot mask a genuine shift and cannot manufacture a false one.
 * Both directions matter: a spike that goes unnoticed becomes a stockout, and a
 * collapse that goes unnoticed becomes dead stock.
 */
function detectDemandShift(input: DetectionInput, t: DetectionThresholds): Anomaly | null {
  const series = input.context.demandHistory.map((d) => d.quantity);
  if (series.length < 21) return null;

  const recent = series.slice(-7);
  const baseline = series.slice(0, -7);
  const recentMean = mean(recent);
  const baselineMean = mean(baseline);

  const z = robustZScore(recentMean, baseline);

  if (Number.isFinite(z) && z >= t.demandSpikeZ) {
    return {
      ...base(input),
      kind: 'DEMAND_SPIKE',
      severity: 'high',
      summary: `Demand for ${input.context.sku.code} is running at ${recentMean.toFixed(1)}/day against a baseline of ${baselineMean.toFixed(1)}/day.`,
      evidence: { recentMean: round(recentMean), baselineMean: round(baselineMean), robustZ: round(z) },
      financialImpact: zero(input.context.sku.unitCost.currency),
    };
  }

  if (baselineMean > 0 && recentMean / baselineMean <= t.demandCollapseRatio) {
    const surplus = Math.max(0, input.context.onHand - Math.ceil(recentMean * 30));
    return {
      ...base(input),
      kind: 'DEMAND_COLLAPSE',
      severity: 'medium',
      summary: `Demand for ${input.context.sku.code} has fallen to ${recentMean.toFixed(1)}/day from ${baselineMean.toFixed(1)}/day; stop replenishing until it recovers.`,
      evidence: {
        recentMean: round(recentMean),
        baselineMean: round(baselineMean),
        ratio: round(recentMean / baselineMean),
      },
      financialImpact: multiply(input.context.sku.unitCost, surplus, 'half-even'),
    };
  }

  return null;
}

/**
 * Persistent unexplained loss.
 *
 * Sums negative adjustments and scrap against total throughput. A single count
 * correction is bookkeeping; a steady drip is theft, damage or a broken process,
 * and it will not appear anywhere else because each individual correction looks
 * unremarkable.
 */
function detectShrinkage(input: DetectionInput, t: DetectionThresholds): Anomaly | null {
  const { movements, context } = input;
  const relevant = movements.filter((m) => m.skuId === context.sku.id && m.siteId === context.siteId);
  if (relevant.length === 0) return null;

  let loss = 0;
  let throughput = 0;
  for (const movement of relevant) {
    if (movement.kind === 'ADJUSTMENT' && movement.quantity < 0) loss += Math.abs(movement.quantity);
    else if (movement.kind === 'SCRAP') loss += movement.quantity;
    else if (movement.kind === 'ISSUE' || movement.kind === 'RECEIPT') throughput += movement.quantity;
  }

  if (throughput === 0 || loss === 0) return null;
  const rate = loss / throughput;
  if (rate < t.shrinkageRate) return null;

  const value = multiply(context.sku.unitCost, loss, 'half-even');

  return {
    ...base(input),
    kind: 'SHRINKAGE',
    severity: rate >= t.shrinkageRate * 3 ? 'high' : 'medium',
    summary: `${(rate * 100).toFixed(1)}% of ${context.sku.code} throughput is being lost to write-offs and negative corrections.`,
    evidence: { lostUnits: loss, throughput, shrinkageRate: round(rate) },
    financialImpact: value,
  };
}

/**
 * A supplier whose lead time is too variable to plan around.
 *
 * Worth separating from lateness: a supplier that is reliably slow is easy to plan
 * for, while one that is sometimes fast and sometimes very late forces safety
 * stock up across everything they supply.
 */
function detectSupplierUnreliability(input: DetectionInput, t: DetectionThresholds): Anomaly | null {
  const observed = input.context.observedLeadTimeDays;
  if (observed.length < 4) return null;

  const cv = coefficientOfVariation(observed);
  if (cv < t.leadTimeCv) return null;

  return {
    ...base(input),
    kind: 'SUPPLIER_UNRELIABLE',
    severity: cv >= t.leadTimeCv * 2 ? 'high' : 'medium',
    summary:
      `Lead times for ${input.context.sku.code} vary by ${(cv * 100).toFixed(0)}% ` +
      `(mean ${mean(observed).toFixed(1)} days over ${observed.length} deliveries), inflating safety stock.`,
    evidence: {
      leadTimeCv: round(cv),
      meanLeadTimeDays: round(mean(observed)),
      deliveries: observed.length,
    },
    financialImpact: zero(input.context.sku.unitCost.currency),
  };
}

function round(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : 0;
}

/** Total money represented by a set of anomalies, for dashboard rollups. */
export function totalImpact(anomalies: readonly Anomaly[], currency: string): Money {
  let amount = 0;
  for (const anomaly of anomalies) {
    if (anomaly.financialImpact.currency === currency) amount += anomaly.financialImpact.amount;
  }
  return { amount, currency };
}

