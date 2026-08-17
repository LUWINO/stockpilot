/**
 * Shared domain vocabulary.
 *
 * Two rules govern every number in this codebase:
 *
 *  1. **Money is an integer** count of minor units (pence, cents, …) plus a
 *     currency. Binary floating point cannot represent 0.1 exactly, so it must
 *     never be used to hold a monetary amount.
 *  2. **Quantity is an integer** count of a SKU's *stock unit* — the smallest
 *     unit the business is willing to count (each, gram, millilitre). A SKU sold
 *     by weight declares `stockUnit: 'g'`; 1.5 kg is stored as `1500`.
 *
 * Following both rules means the ledger can be summed, replayed and reconciled
 * without any rounding drift at all.
 */

import type { Money } from './money.ts';

/** Calendar date in `YYYY-MM-DD` form, always interpreted in the org's timezone. */
export type IsoDate = string;

/** Instant in RFC 3339 / ISO 8601 form, always UTC. */
export type IsoTimestamp = string;

export type OrgId = string;
export type SiteId = string;
export type SkuId = string;
export type LotId = string;
export type SupplierId = string;
export type UserId = string;

/** Integer count of a SKU's stock unit. Never fractional. */
export type Quantity = number;

/** Units a SKU is counted in. Purely descriptive — the ledger only sees integers. */
export type StockUnit = 'each' | 'g' | 'ml' | 'cm';

/** How urgently a situation needs a human. */
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface Sku {
  readonly id: SkuId;
  readonly orgId: OrgId;
  readonly code: string;
  readonly name: string;
  readonly stockUnit: StockUnit;
  /** Cost to buy one stock unit. Drives holding cost and write-off value. */
  readonly unitCost: Money;
  /** Price one stock unit sells for. Drives lost-margin estimates. */
  readonly unitPrice: Money;
  /** Whether the SKU is lot-tracked and therefore subject to expiry logic. */
  readonly perishable: boolean;
  /** Shelf life in days from receipt, when perishable. */
  readonly shelfLifeDays?: number;
  readonly supplierId?: SupplierId;
  readonly active: boolean;
}

export interface Supplier {
  readonly id: SupplierId;
  readonly orgId: OrgId;
  readonly name: string;
  /** Contractual lead time in days. Observed lead times override this. */
  readonly nominalLeadTimeDays: number;
  /** Smallest quantity the supplier will accept on a line. */
  readonly minimumOrderQuantity: Quantity;
  /** Orders must be a multiple of this (case/pallet rounding). */
  readonly orderMultiple: Quantity;
  /** Fixed administrative cost of raising one purchase order. */
  readonly orderingCost: Money;
}

export interface Lot {
  readonly id: LotId;
  readonly skuId: SkuId;
  readonly siteId: SiteId;
  readonly quantity: Quantity;
  readonly receivedAt: IsoTimestamp;
  readonly expiresOn?: IsoDate;
}

/** One day of observed demand for a SKU at a site. */
export interface DemandPoint {
  readonly date: IsoDate;
  readonly quantity: Quantity;
}

/**
 * Everything the decision engine is allowed to know about one SKU at one site.
 *
 * Assembling this object is the only I/O-bound step in an autonomous cycle; the
 * reasoning that follows is pure and therefore reproducible and testable.
 */
export interface StockContext {
  readonly sku: Sku;
  readonly siteId: SiteId;
  readonly supplier?: Supplier;
  /** Daily demand history, oldest first, with zero-filled gaps. */
  readonly demandHistory: readonly DemandPoint[];
  readonly onHand: Quantity;
  readonly reserved: Quantity;
  /** Quantity already ordered and not yet received. */
  readonly onOrder: Quantity;
  readonly lots: readonly Lot[];
  /** Observed supplier lead times in days, used to model lead-time variance. */
  readonly observedLeadTimeDays: readonly number[];
  /** Days since the SKU last moved outward at this site; `null` if it never has. */
  readonly daysSinceLastIssue: number | null;
}
