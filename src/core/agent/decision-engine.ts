/**
 * The decision engine.
 *
 * This is the autonomous core: given everything known about one SKU at one site,
 * it produces a set of decisions, each with a confidence, a monetary value and a
 * written rationale, and each already passed through the autonomy gate.
 *
 * It is a pure function. No database, no clock, no network — the current date is
 * an argument. That is what makes an autonomous decision reproducible: the exact
 * inputs are persisted alongside the output, so any decision can be replayed
 * months later and will produce the same answer, which is the difference between
 * an auditable system and one that merely logs a lot.
 *
 * Ordering is deliberate. Anomalies are detected *before* replenishment is
 * considered, because several of them (a demand collapse, a spike, a negative
 * balance) must suppress or modify the order rather than sit alongside it. An
 * agent that flags "demand has collapsed" and then places a full replenishment in
 * the same cycle is worse than no agent at all.
 */

import { type Money, multiply, zero, isPositive } from '../money.ts';
import { detectAnomalies, severityRank, type Anomaly, type DetectionThresholds } from '../anomaly.ts';
import { forecastDemand, type DemandForecast, type SelectionOptions, DEFAULT_SELECTION } from '../forecast/select.ts';
import { classifyXyz, classifyAbc, policyFor, type SegmentPolicy } from '../policy/classification.ts';
import { planReplenishment, type ReplenishmentPlan } from '../policy/replenishment.ts';
import { quantityAtExpiryRisk, type StockMovement, daysBetween } from '../ledger.ts';
import { standardDeviation } from '../stats.ts';
import type { IsoDate, Quantity, Severity, StockContext } from '../types.ts';
import { gate, type AutonomyPolicy, type DecisionKind, type GateOutcome, DEFAULT_AUTONOMY } from './autonomy.ts';

export interface Decision {
  /** Deterministic identifier: same inputs, same id. Makes replays idempotent. */
  readonly id: string;
  readonly kind: DecisionKind;
  readonly skuId: string;
  readonly siteId: string;
  /** Units involved. Absent for decisions that do not move stock. */
  readonly quantity?: Quantity;
  /** Money committed (replenishment) or destroyed (write-off). */
  readonly value: Money;
  /** Money the decision is expected to protect or recover. */
  readonly expectedBenefit: Money;
  readonly confidence: number;
  readonly severity: Severity;
  /** Human-readable reasoning, one clause per line, persisted verbatim. */
  readonly rationale: readonly string[];
  readonly evidence: Readonly<Record<string, number | string>>;
  readonly outcome: GateOutcome;
  /** Why the gate reached that outcome. */
  readonly gateReasons: readonly string[];
  readonly createdOn: IsoDate;
}

export interface EvaluationInput {
  readonly context: StockContext;
  readonly movements: readonly StockMovement[];
  readonly today: IsoDate;
  readonly policy?: AutonomyPolicy;
  /** Value the agent has already committed automatically today. */
  readonly committedToday?: Money;
  /** Pre-computed ABC class. Computed catalogue-wide, so it is passed in. */
  readonly abc?: 'A' | 'B' | 'C';
  readonly forecastOptions?: SelectionOptions;
  readonly thresholds?: DetectionThresholds;
  /** Planning horizon in days. Should exceed the longest lead time. */
  readonly horizonDays?: number;
}

export interface Evaluation {
  readonly skuId: string;
  readonly siteId: string;
  readonly forecast: DemandForecast;
  readonly segment: SegmentPolicy;
  readonly plan: ReplenishmentPlan;
  readonly anomalies: readonly Anomaly[];
  readonly decisions: readonly Decision[];
  /** Confidence in the whole evaluation, before per-decision adjustments. */
  readonly confidence: number;
}

/**
 * Evaluate one SKU at one site and emit decisions.
 *
 * The pipeline is: forecast → segment → detect → plan → decide → gate.
 */
export function evaluate(input: EvaluationInput): Evaluation {
  const {
    context,
    movements,
    today,
    policy = DEFAULT_AUTONOMY,
    committedToday = zero(policy.maxAutoValue.currency),
    forecastOptions = DEFAULT_SELECTION,
    horizonDays = 28,
  } = input;

  const currency = context.sku.unitCost.currency;
  const series = context.demandHistory.map((d) => d.quantity);

  // 1. Forecast.
  const forecast = forecastDemand(series, horizonDays, forecastOptions);

  // 2. Segment. XYZ comes from this SKU's own variability; ABC is a catalogue-wide
  //    property and is supplied by the caller, defaulting to C so that an
  //    unclassified SKU gets the *lowest* service level rather than the highest.
  const { xyz } = classifyXyz(series);
  const segment = policyFor(input.abc ?? 'C', xyz);

  // 3. Detect what is already wrong.
  const anomalies = detectAnomalies({
    context,
    dailyDemand: forecast.dailyRate,
    today,
    movements,
    ...(input.thresholds === undefined ? {} : { thresholds: input.thresholds }),
  });

  // 4. Plan replenishment. Safety stock is driven by *forecast error*, not raw
  //    demand variance — a better forecast should buy less stock, not the same.
  const demandStdDev = forecast.result.residualStdDev > 0
    ? forecast.result.residualStdDev
    : standardDeviation(series);

  const supplier = context.supplier ?? {
    nominalLeadTimeDays: 7,
    minimumOrderQuantity: 1,
    orderMultiple: 1,
    orderingCost: multiply(context.sku.unitCost, 2, 'half-even'),
  };

  const plan = planReplenishment({
    available: context.onHand - context.reserved,
    onOrder: context.onOrder,
    averageDailyDemand: forecast.dailyRate,
    demandStdDev,
    serviceLevel: segment.serviceLevel,
    supplier,
    observedLeadTimeDays: context.observedLeadTimeDays,
    unitCost: context.sku.unitCost,
    reviewPeriodDays: segment.reviewPeriodDays,
  });

  // 5. Decide.
  const confidence = evaluationConfidence(forecast, context);
  const decisions: Decision[] = [];
  const collapse = anomalies.find((a) => a.kind === 'DEMAND_COLLAPSE');
  const negative = anomalies.find((a) => a.kind === 'NEGATIVE_STOCK');

  decisions.push(
    ...replenishmentDecisions({
      context, plan, forecast, segment, anomalies, confidence, today, currency, collapse, negative,
    }),
  );
  decisions.push(...expiryDecisions({ context, forecast, today, currency, confidence }));
  decisions.push(...countDecisions({ anomalies, today }));
  decisions.push(...alertDecisions({ anomalies, today, currency }));

  // 6. Gate.
  const gated = decisions.map((decision) => {
    const result = gate({
      kind: decision.kind,
      value: decision.value,
      confidence: decision.confidence,
      segmentAutonomy: segment.autonomy,
      policy,
      committedToday,
    });
    return { ...decision, outcome: result.outcome, gateReasons: result.reasons };
  });

  return {
    skuId: context.sku.id,
    siteId: context.siteId,
    forecast,
    segment,
    plan,
    anomalies,
    decisions: gated,
    confidence,
  };
}

/**
 * How much the engine trusts this evaluation.
 *
 * Starts from the forecast's own out-of-sample confidence and then discounts for
 * thin evidence: short history and never-measured lead times both mean the
 * numbers are extrapolations rather than measurements.
 */
function evaluationConfidence(forecast: DemandForecast, context: StockContext): number {
  let confidence = forecast.confidence;

  const historyDays = context.demandHistory.length;
  if (historyDays < 28) confidence *= 0.5;
  else if (historyDays < 56) confidence *= 0.8;

  if (context.observedLeadTimeDays.length === 0) confidence *= 0.85;
  if (context.onHand < 0) confidence *= 0.5;

  return Number(Math.max(0, Math.min(1, confidence)).toFixed(4));
}

/**
 * Deterministic decision id.
 *
 * A hash of the fields that define the decision, so re-running a cycle over
 * unchanged inputs produces the same id and the write is a no-op. This is what
 * makes the agent loop safe to retry after a crash without double-ordering.
 */
export function decisionId(parts: readonly (string | number)[]): string {
  const input = parts.join('|');
  // FNV-1a, 64-bit via two 32-bit lanes. Not cryptographic — it only needs to be
  // stable, fast and collision-resistant enough for one org's daily decisions.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 5) | (c >>> 3)), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

interface ReplenishmentArgs {
  readonly context: StockContext;
  readonly plan: ReplenishmentPlan;
  readonly forecast: DemandForecast;
  readonly segment: SegmentPolicy;
  readonly anomalies: readonly Anomaly[];
  readonly confidence: number;
  readonly today: IsoDate;
  readonly currency: string;
  readonly collapse: Anomaly | undefined;
  readonly negative: Anomaly | undefined;
}

function replenishmentDecisions(args: ReplenishmentArgs): Decision[] {
  const { context, plan, forecast, segment, confidence, today, currency, collapse, negative } = args;

  // A negative balance means the books are wrong. Ordering against wrong books
  // compounds the error, so replenishment is suspended until a count clears it.
  if (negative !== undefined) {
    return [
      {
        id: decisionId(['HOLD', context.sku.id, context.siteId, today, 'negative']),
        kind: 'HOLD_REPLENISHMENT',
        skuId: context.sku.id,
        siteId: context.siteId,
        value: zero(currency),
        expectedBenefit: zero(currency),
        confidence: 1,
        severity: 'high',
        rationale: [
          `On-hand is ${context.onHand}, which cannot be physically true.`,
          'Replenishment is suspended: ordering against an incorrect balance would compound the error.',
          'A physical count has been raised; replenishment resumes once the balance is corrected.',
        ],
        evidence: { onHand: context.onHand },
        outcome: 'execute',
        gateReasons: [],
        createdOn: today,
      },
    ];
  }

  if (collapse !== undefined && plan.shouldOrder) {
    return [
      {
        id: decisionId(['HOLD', context.sku.id, context.siteId, today, 'collapse']),
        kind: 'HOLD_REPLENISHMENT',
        skuId: context.sku.id,
        siteId: context.siteId,
        value: zero(currency),
        expectedBenefit: plan.orderValue,
        confidence,
        severity: 'medium',
        rationale: [
          `The reorder point would normally trigger an order of ${plan.orderQuantity} units.`,
          collapse.summary,
          'Holding the order: the reorder point is derived from a demand level that no longer applies.',
          `Avoided committing ${plan.orderValue.amount / 100} ${currency} against stale demand.`,
        ],
        evidence: { ...collapse.evidence, withheldQuantity: plan.orderQuantity },
        outcome: 'execute',
        gateReasons: [],
        createdOn: today,
      },
    ];
  }

  if (!plan.shouldOrder) return [];

  const stockout = args.anomalies.find((a) => a.kind === 'STOCKOUT_IMMINENT');
  const severity: Severity = stockout ? stockout.severity : plan.coverDaysNow < 7 ? 'medium' : 'low';

  const rationale = [
    plan.rationale,
    `Forecast: ${forecast.dailyRate.toFixed(2)} units/day by ${forecast.method} ` +
      `(${forecast.classification.pattern} demand, MASE ${forecast.metrics ? forecast.metrics.mase.toFixed(2) : 'n/a'}).`,
    `Segment ${segment.abc}${segment.xyz} targets a ${(segment.serviceLevel * 100).toFixed(1)}% service level, ` +
      `reviewed every ${segment.reviewPeriodDays} day(s).`,
    `Safety stock ${plan.safetyStock} units covers demand and lead-time variability ` +
      `(${(plan.safety.leadTimeVarianceShare * 100).toFixed(0)}% of the buffer is lead-time risk over ` +
      `${plan.leadTime.samples} observed deliveries).`,
  ];

  if (plan.orderQuantity > plan.orderUpToLevel - plan.inventoryPosition) {
    rationale.push(
      `Rounded up from the ${plan.orderUpToLevel - plan.inventoryPosition}-unit deficit to satisfy the ` +
        `economic order quantity (${plan.economicOrderQuantity}) and supplier constraints.`,
    );
  }

  return [
    {
      id: decisionId(['REPLENISH', context.sku.id, context.siteId, today, plan.orderQuantity]),
      kind: 'REPLENISH',
      skuId: context.sku.id,
      siteId: context.siteId,
      quantity: plan.orderQuantity,
      value: plan.orderValue,
      expectedBenefit: stockout?.financialImpact ?? zero(currency),
      confidence,
      severity,
      rationale,
      evidence: {
        inventoryPosition: plan.inventoryPosition,
        reorderPoint: plan.reorderPoint,
        safetyStock: plan.safetyStock,
        orderUpToLevel: plan.orderUpToLevel,
        economicOrderQuantity: plan.economicOrderQuantity,
        coverDaysNow: Number(plan.coverDaysNow.toFixed(2)),
        coverDaysAfterOrder: Number(plan.coverDaysAfterOrder.toFixed(2)),
        leadTimeDays: Number(plan.leadTime.days.toFixed(2)),
        forecastMethod: forecast.method,
      },
      outcome: 'propose',
      gateReasons: [],
      createdOn: today,
    },
  ];
}

interface ExpiryArgs {
  readonly context: StockContext;
  readonly forecast: DemandForecast;
  readonly today: IsoDate;
  readonly currency: string;
  readonly confidence: number;
}

/**
 * Decisions about perishable stock.
 *
 * Already-expired stock is a write-off; stock that *will* expire is a markdown
 * opportunity while it still has value. Both always route to a human, because
 * both permanently give up margin.
 */
function expiryDecisions(args: ExpiryArgs): Decision[] {
  const { context, forecast, today, currency, confidence } = args;
  if (!context.sku.perishable || context.lots.length === 0) return [];

  const allocatable = context.lots.map((lot) => ({
    id: lot.id,
    quantity: lot.quantity,
    receivedAt: lot.receivedAt,
    ...(lot.expiresOn === undefined ? {} : { expiresOn: lot.expiresOn }),
  }));

  const decisions: Decision[] = [];

  const expired = context.lots
    .filter((lot) => lot.expiresOn !== undefined && daysBetween(today, lot.expiresOn) <= 0)
    .reduce((acc, lot) => acc + lot.quantity, 0);

  if (expired > 0) {
    const value = multiply(context.sku.unitCost, expired, 'half-even');
    decisions.push({
      id: decisionId(['WRITE_OFF', context.sku.id, context.siteId, today, expired]),
      kind: 'WRITE_OFF',
      skuId: context.sku.id,
      siteId: context.siteId,
      quantity: expired,
      value,
      expectedBenefit: zero(currency),
      confidence: 1,
      severity: 'high',
      rationale: [
        `${expired} units of ${context.sku.code} are past their expiry date as of ${today}.`,
        'They cannot legally or safely be sold and must leave the ledger to keep on-hand truthful.',
        `Writing them off recognises a loss of ${value.amount / 100} ${currency}.`,
      ],
      evidence: { expiredUnits: expired },
      outcome: 'propose',
      gateReasons: [],
      createdOn: today,
    });
  }

  const atRisk = quantityAtExpiryRisk(allocatable, forecast.dailyRate, today) - expired;

  if (atRisk > 0) {
    const costValue = multiply(context.sku.unitCost, atRisk, 'half-even');
    // A markdown that clears the stock recovers cost plus whatever margin the
    // discount leaves; the alternative recovers nothing at all.
    const recoverable = multiply(costValue, 0.6, 'half-even');
    decisions.push({
      id: decisionId(['MARKDOWN', context.sku.id, context.siteId, today, atRisk]),
      kind: 'MARKDOWN',
      skuId: context.sku.id,
      siteId: context.siteId,
      quantity: atRisk,
      value: costValue,
      expectedBenefit: recoverable,
      confidence,
      severity: 'medium',
      rationale: [
        `${atRisk} units will expire before demand of ${forecast.dailyRate.toFixed(1)}/day can absorb them.`,
        'Discounting now converts stock that would be scrapped into partial recovery.',
        `Approximately ${recoverable.amount / 100} ${currency} of the ${costValue.amount / 100} ${currency} at risk is recoverable at a 40% discount.`,
      ],
      evidence: { unitsAtRisk: atRisk, dailyDemand: Number(forecast.dailyRate.toFixed(2)) },
      outcome: 'propose',
      gateReasons: [],
      createdOn: today,
    });
  }

  return decisions;
}

/** Raise a physical count when the ledger and reality have visibly diverged. */
function countDecisions(args: { anomalies: readonly Anomaly[]; today: IsoDate }): Decision[] {
  const triggers = args.anomalies.filter((a) => a.kind === 'NEGATIVE_STOCK' || a.kind === 'SHRINKAGE');

  return triggers.map((anomaly) => ({
    id: decisionId(['COUNT', anomaly.skuId, anomaly.siteId, args.today, anomaly.kind]),
    kind: 'COUNT' as const,
    skuId: anomaly.skuId,
    siteId: anomaly.siteId,
    value: zero(anomaly.financialImpact.currency),
    expectedBenefit: anomaly.financialImpact,
    confidence: 1,
    severity: anomaly.severity,
    rationale: [
      anomaly.summary,
      'A physical count is the only way to re-establish a trustworthy balance.',
      'Replenishment for this SKU stays suspended until the count is booked.',
    ],
    evidence: anomaly.evidence,
    outcome: 'execute' as const,
    gateReasons: [],
    createdOn: args.today,
  }));
}

/** Everything else becomes an alert, carrying its evidence and its cost. */
function alertDecisions(args: {
  anomalies: readonly Anomaly[];
  today: IsoDate;
  currency: string;
}): Decision[] {
  const alertable = args.anomalies.filter(
    (a) =>
      a.kind === 'DEAD_STOCK' ||
      a.kind === 'OVERSTOCK' ||
      a.kind === 'DEMAND_SPIKE' ||
      a.kind === 'SUPPLIER_UNRELIABLE',
  );

  return alertable.map((anomaly) => ({
    id: decisionId(['ALERT', anomaly.skuId, anomaly.siteId, args.today, anomaly.kind]),
    kind: 'ALERT' as const,
    skuId: anomaly.skuId,
    siteId: anomaly.siteId,
    value: zero(args.currency),
    expectedBenefit: anomaly.financialImpact,
    confidence: 1,
    severity: anomaly.severity,
    rationale: [anomaly.summary],
    evidence: anomaly.evidence,
    outcome: 'execute' as const,
    gateReasons: [],
    createdOn: args.today,
  }));
}

/**
 * Propose stock transfers between sites.
 *
 * Run after per-site evaluation, because it needs the whole network. Moving stock
 * that already exists is almost always cheaper than buying more and scrapping the
 * surplus elsewhere, so transfers are considered before the purchase decisions
 * they may replace.
 *
 * The rule is conservative: a donor must retain its own reorder point after
 * giving, so solving one site's problem can never create another's.
 */
export function proposeTransfers(
  evaluations: readonly Evaluation[],
  contexts: ReadonlyMap<string, StockContext>,
  today: IsoDate,
  transferCostPerUnit: Money,
): Decision[] {
  const bySku = new Map<string, Evaluation[]>();
  for (const evaluation of evaluations) {
    const list = bySku.get(evaluation.skuId) ?? [];
    list.push(evaluation);
    bySku.set(evaluation.skuId, list);
  }

  const decisions: Decision[] = [];

  for (const [skuId, group] of bySku) {
    if (group.length < 2) continue;

    const needy = group
      .filter((e) => e.plan.shouldOrder && e.plan.orderQuantity > 0)
      .sort((a, b) => a.plan.coverDaysNow - b.plan.coverDaysNow);

    const donors = group
      .filter((e) => !e.plan.shouldOrder && e.plan.inventoryPosition > e.plan.reorderPoint)
      .sort((a, b) => b.plan.coverDaysNow - a.plan.coverDaysNow);

    for (const receiver of needy) {
      let outstanding = receiver.plan.orderQuantity;

      for (const donor of donors) {
        if (outstanding <= 0) break;

        const spare = donor.plan.inventoryPosition - donor.plan.reorderPoint;
        if (spare <= 0) continue;

        const quantity = Math.min(spare, outstanding);
        if (quantity <= 0) continue;

        const context = contexts.get(`${skuId}:${receiver.siteId}`);
        const currency = transferCostPerUnit.currency;
        const moveCost = multiply(transferCostPerUnit, quantity, 'half-even');
        const purchaseAvoided = context
          ? multiply(context.sku.unitCost, quantity, 'half-even')
          : zero(currency);

        // Only worth doing if moving is genuinely cheaper than buying.
        if (isPositive(purchaseAvoided) && moveCost.amount >= purchaseAvoided.amount) continue;

        decisions.push({
          id: decisionId(['TRANSFER', skuId, donor.siteId, receiver.siteId, today, quantity]),
          kind: 'TRANSFER',
          skuId,
          siteId: receiver.siteId,
          quantity,
          value: moveCost,
          expectedBenefit: purchaseAvoided,
          confidence: Math.min(donor.confidence, receiver.confidence),
          severity: receiver.plan.coverDaysNow < 3 ? 'high' : 'medium',
          rationale: [
            `Site ${receiver.siteId} needs ${receiver.plan.orderQuantity} units and holds ` +
              `${receiver.plan.coverDaysNow.toFixed(1)} days of cover.`,
            `Site ${donor.siteId} holds ${donor.plan.coverDaysNow.toFixed(1)} days and can release ` +
              `${quantity} units while staying above its own reorder point of ${donor.plan.reorderPoint}.`,
            `Transferring costs ${moveCost.amount / 100} ${currency} against ` +
              `${purchaseAvoided.amount / 100} ${currency} to purchase the same quantity.`,
          ],
          evidence: {
            fromSite: donor.siteId,
            toSite: receiver.siteId,
            quantity,
            donorCoverDays: Number(donor.plan.coverDaysNow.toFixed(2)),
            receiverCoverDays: Number(receiver.plan.coverDaysNow.toFixed(2)),
          },
          outcome: 'propose',
          gateReasons: [],
          createdOn: today,
        });

        outstanding -= quantity;
      }
    }
  }

  return decisions;
}

/** Rank decisions for a human queue: severity first, then money at stake. */
export function prioritise(decisions: readonly Decision[]): Decision[] {
  return [...decisions].sort((a, b) => {
    const bySeverity = severityRank(b.severity) - severityRank(a.severity);
    if (bySeverity !== 0) return bySeverity;
    const byBenefit = b.expectedBenefit.amount - a.expectedBenefit.amount;
    if (byBenefit !== 0) return byBenefit;
    return a.id < b.id ? -1 : 1;
  });
}

/** Catalogue-wide ABC classes, for feeding back into `evaluate`. */
export function catalogueAbc(
  items: readonly { readonly skuId: string; readonly annualValue: number }[],
): Map<string, 'A' | 'B' | 'C'> {
  return new Map(classifyAbc(items).map((r) => [r.skuId, r.abc]));
}
