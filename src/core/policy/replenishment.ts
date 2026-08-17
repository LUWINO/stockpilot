/**
 * Replenishment sizing.
 *
 * Deciding *when* to order is the reorder point. Deciding *how much* is a
 * trade-off between the fixed cost of raising an order and the cost of holding
 * what it brings, subject to whatever the supplier will actually accept.
 */

import type { Money } from '../money.ts';
import { multiply } from '../money.ts';
import type { Quantity, Supplier } from '../types.ts';
import { computeSafetyStock, coverDays, summariseLeadTime, type SafetyStockResult } from './safety-stock.ts';

export interface EoqInput {
  /** Expected demand over a year, in stock units. */
  readonly annualDemand: number;
  /** Fixed cost of raising one order, regardless of size. */
  readonly orderingCost: Money;
  /** Cost of holding one unit for one year. */
  readonly holdingCostPerUnitPerYear: Money;
}

/**
 * Wilson's economic order quantity:
 *
 * ```
 * EOQ = √( 2 × D × S / H )
 * ```
 *
 * The curve is famously flat near its minimum — being 20% away from the optimal
 * quantity costs only about 2% in total cost — which is why rounding the result
 * up to a supplier's case size is nearly free, and why EOQ should never override
 * a hard constraint.
 */
export function economicOrderQuantity(input: EoqInput): Quantity {
  const { annualDemand, orderingCost, holdingCostPerUnitPerYear } = input;

  if (annualDemand <= 0) return 0;
  if (holdingCostPerUnitPerYear.amount <= 0) {
    throw new RangeError('Holding cost must be positive to compute an economic order quantity');
  }
  if (orderingCost.currency !== holdingCostPerUnitPerYear.currency) {
    throw new TypeError('Ordering cost and holding cost must share a currency');
  }

  const eoq = Math.sqrt((2 * annualDemand * orderingCost.amount) / holdingCostPerUnitPerYear.amount);
  return Math.max(1, Math.ceil(eoq));
}

/**
 * Annual cost of holding one unit, as a fraction of its purchase cost.
 *
 * 22% is a standard mid-range figure covering capital, warehousing, insurance,
 * shrinkage and obsolescence. It is a configurable input, not a law of nature.
 */
export const DEFAULT_HOLDING_COST_RATE = 0.22;

export function holdingCostPerUnitPerYear(unitCost: Money, rate = DEFAULT_HOLDING_COST_RATE): Money {
  return multiply(unitCost, rate, 'half-even');
}

/**
 * Snap a quantity to what the supplier will accept.
 *
 * Order of operations matters: raise to the minimum first, then round *up* to the
 * case multiple. Rounding down could land below the minimum, and rounding down a
 * replenishment is how a system quietly re-creates the stockout it was trying to
 * prevent.
 */
export function applyOrderConstraints(quantity: Quantity, minimum: Quantity, multiple: Quantity): Quantity {
  if (quantity <= 0) return 0;
  const raised = Math.max(quantity, Math.max(0, minimum));
  if (multiple <= 1) return Math.ceil(raised);
  return Math.ceil(raised / multiple) * multiple;
}

export interface ReplenishmentInput {
  readonly available: Quantity;
  readonly onOrder: Quantity;
  readonly averageDailyDemand: number;
  /** Standard deviation of daily forecast error. */
  readonly demandStdDev: number;
  readonly serviceLevel: number;
  readonly supplier: Pick<Supplier, 'nominalLeadTimeDays' | 'minimumOrderQuantity' | 'orderMultiple' | 'orderingCost'>;
  readonly observedLeadTimeDays: readonly number[];
  readonly unitCost: Money;
  /** Days between replenishment reviews. Daily for an always-on agent. */
  readonly reviewPeriodDays: number;
  readonly holdingCostRate?: number;
}

export interface ReplenishmentPlan {
  readonly shouldOrder: boolean;
  /** Quantity to order after all constraints. Zero when no order is due. */
  readonly orderQuantity: Quantity;
  readonly reorderPoint: Quantity;
  readonly safetyStock: Quantity;
  /** Target position for a periodic-review policy. */
  readonly orderUpToLevel: Quantity;
  /** Stock plus inbound, which is what the reorder point is actually compared to. */
  readonly inventoryPosition: Quantity;
  readonly economicOrderQuantity: Quantity;
  readonly coverDaysNow: number;
  readonly coverDaysAfterOrder: number;
  readonly leadTime: { readonly days: number; readonly stdDevDays: number; readonly samples: number };
  readonly safety: SafetyStockResult;
  /** Cash committed by the order, at unit cost. */
  readonly orderValue: Money;
  readonly rationale: string;
}

/**
 * Compute a complete replenishment plan for one SKU at one site.
 *
 * Uses an (s, S) policy: when the inventory *position* — on hand plus already on
 * order, so that yesterday's order is not placed again today — drops to or below
 * the reorder point `s`, order up to `S`. The order-up-to level covers demand over
 * the review period plus the lead time, because after this review the next chance
 * to react is a whole review period away.
 */
export function planReplenishment(input: ReplenishmentInput): ReplenishmentPlan {
  const {
    available,
    onOrder,
    averageDailyDemand,
    demandStdDev,
    serviceLevel,
    supplier,
    observedLeadTimeDays,
    unitCost,
    reviewPeriodDays,
    holdingCostRate = DEFAULT_HOLDING_COST_RATE,
  } = input;

  const leadTime = summariseLeadTime(observedLeadTimeDays, supplier.nominalLeadTimeDays);

  const safety = computeSafetyStock({
    averageDailyDemand,
    demandStdDev,
    // Exposure lasts the lead time *plus* the wait until the next review.
    leadTimeDays: leadTime.leadTimeDays + reviewPeriodDays,
    leadTimeStdDevDays: leadTime.leadTimeStdDevDays,
    serviceLevel,
  });

  const inventoryPosition = available + onOrder;
  const orderUpToLevel = Math.ceil(
    averageDailyDemand * (leadTime.leadTimeDays + reviewPeriodDays) + safety.safetyStock,
  );

  const eoq = economicOrderQuantity({
    annualDemand: averageDailyDemand * 365,
    orderingCost: supplier.orderingCost,
    holdingCostPerUnitPerYear: holdingCostPerUnitPerYear(unitCost, holdingCostRate),
  });

  const shouldOrder = inventoryPosition <= safety.reorderPoint && averageDailyDemand > 0;

  // Order at least back to the target, but take the EOQ if it is larger: the
  // fixed ordering cost is already sunk once the order exists.
  const deficit = Math.max(0, orderUpToLevel - inventoryPosition);
  const rawQuantity = shouldOrder ? Math.max(deficit, eoq) : 0;
  const orderQuantity = applyOrderConstraints(
    rawQuantity,
    supplier.minimumOrderQuantity,
    supplier.orderMultiple,
  );

  const coverNow = coverDays(inventoryPosition, averageDailyDemand);
  const coverAfter = coverDays(inventoryPosition + orderQuantity, averageDailyDemand);

  return {
    shouldOrder: shouldOrder && orderQuantity > 0,
    orderQuantity,
    reorderPoint: safety.reorderPoint,
    safetyStock: safety.safetyStock,
    orderUpToLevel,
    inventoryPosition,
    economicOrderQuantity: eoq,
    coverDaysNow: coverNow,
    coverDaysAfterOrder: coverAfter,
    leadTime: {
      days: leadTime.leadTimeDays,
      stdDevDays: leadTime.leadTimeStdDevDays,
      samples: leadTime.samples,
    },
    safety,
    orderValue: multiply(unitCost, orderQuantity, 'half-even'),
    rationale: shouldOrder
      ? `Position ${inventoryPosition} is at or below the reorder point ${safety.reorderPoint} ` +
        `(${leadTime.leadTimeDays.toFixed(1)}d lead time, ${(serviceLevel * 100).toFixed(1)}% service level). ` +
        `Ordering ${orderQuantity} to reach the target of ${orderUpToLevel}, ` +
        `taking cover from ${formatDays(coverNow)} to ${formatDays(coverAfter)}.`
      : `Position ${inventoryPosition} is above the reorder point ${safety.reorderPoint}; ` +
        `${formatDays(coverNow)} of cover remains.`,
  };
}

function formatDays(days: number): string {
  if (!Number.isFinite(days)) return 'unlimited';
  return `${days.toFixed(1)}d`;
}
