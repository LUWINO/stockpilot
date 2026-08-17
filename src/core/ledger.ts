/**
 * The stock ledger.
 *
 * Stock levels are never stored as a mutable number. They are *derived* by
 * replaying an append-only sequence of movements. This is the single most
 * important design decision in the system, and it buys three things:
 *
 *  - **Auditability.** Every unit that entered or left is attributable to an
 *    actor, a reason and a timestamp. "Why is on-hand 47?" always has an answer.
 *  - **Correctness under concurrency.** Appending an immutable fact never
 *    conflicts with another append, so two receipts booked at the same instant
 *    cannot lose an update the way `UPDATE stock SET qty = qty + n` can if it is
 *    ever run outside a transaction.
 *  - **Safe autonomy.** An agent that acts on stale state writes a movement that
 *    is still individually valid, and reconciliation is a replay rather than a
 *    forensic exercise.
 *
 * Snapshots exist purely as a performance optimisation and are always
 * reconstructible from the movements that precede them.
 */

import type { IsoDate, IsoTimestamp, LotId, Quantity, SiteId, SkuId, UserId } from './types.ts';

/**
 * Why stock moved. The kind determines the sign, so the sign is never a caller's
 * responsibility and can never disagree with the reason.
 */
export type MovementKind =
  /** Goods received from a supplier. */
  | 'RECEIPT'
  /** Goods consumed, sold or shipped. */
  | 'ISSUE'
  /** Customer or internal return coming back into stock. */
  | 'RETURN'
  /** Outbound leg of a site-to-site transfer. */
  | 'TRANSFER_OUT'
  /** Inbound leg of a site-to-site transfer. */
  | 'TRANSFER_IN'
  /** Damaged, expired or otherwise destroyed stock. */
  | 'SCRAP'
  /** Correction booked against a physical count. Signed by the caller. */
  | 'ADJUSTMENT';

/** Movements whose quantity always increases on-hand. */
const INBOUND: ReadonlySet<MovementKind> = new Set<MovementKind>(['RECEIPT', 'RETURN', 'TRANSFER_IN']);

/** Movements whose quantity always decreases on-hand. */
const OUTBOUND: ReadonlySet<MovementKind> = new Set<MovementKind>(['ISSUE', 'TRANSFER_OUT', 'SCRAP']);

export interface StockMovement {
  readonly id: string;
  readonly skuId: SkuId;
  readonly siteId: SiteId;
  readonly kind: MovementKind;
  /**
   * Always a positive integer, except for `ADJUSTMENT`, which is signed because
   * a count correction is genuinely directional.
   */
  readonly quantity: Quantity;
  readonly lotId?: LotId;
  readonly occurredAt: IsoTimestamp;
  /** Who or what caused the movement. `system:agent` for autonomous actions. */
  readonly actor: UserId | string;
  /** Free-text or coded reason, surfaced verbatim in the audit trail. */
  readonly reason?: string;
  /** Links the movement to the decision that caused it, when autonomous. */
  readonly decisionId?: string;
}

export class InvalidMovementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMovementError';
  }
}

/** Signed effect of a movement on on-hand quantity. */
export function movementDelta(movement: StockMovement): number {
  const { kind, quantity } = movement;

  if (!Number.isInteger(quantity)) {
    throw new InvalidMovementError(`Movement ${movement.id} has a non-integer quantity ${quantity}`);
  }

  if (kind === 'ADJUSTMENT') return quantity;

  if (quantity < 0) {
    throw new InvalidMovementError(
      `Movement ${movement.id} of kind ${kind} must carry a positive quantity; use ADJUSTMENT for corrections`,
    );
  }

  if (INBOUND.has(kind)) return quantity;
  if (OUTBOUND.has(kind)) return -quantity;

  throw new InvalidMovementError(`Unhandled movement kind ${String(kind)}`);
}

export interface LotBalance {
  readonly lotId: LotId;
  readonly quantity: Quantity;
}

export interface StockPosition {
  readonly skuId: SkuId;
  readonly siteId: SiteId;
  /** Physical units present. */
  readonly onHand: Quantity;
  /** Units promised to orders but not yet issued. */
  readonly reserved: Quantity;
  /** What the business can actually commit: `onHand − reserved`. */
  readonly available: Quantity;
  /** Per-lot breakdown for lot-tracked SKUs. Empty when the SKU is not lot-tracked. */
  readonly byLot: readonly LotBalance[];
  /** Timestamp of the newest movement folded into this position. */
  readonly asOf: IsoTimestamp | null;
  readonly movementCount: number;
}

export interface ProjectOptions {
  /** Ignore movements after this instant, for point-in-time reconstruction. */
  readonly asOf?: IsoTimestamp;
  /** Reservations held against the SKU/site, sourced from open orders. */
  readonly reserved?: Quantity;
  /** Balance to start from, when replaying only movements after a snapshot. */
  readonly openingBalance?: Quantity;
}

/**
 * Fold a movement sequence into a position.
 *
 * Movements are sorted by `occurredAt` before folding so that out-of-order
 * arrival — normal when several sites sync independently — cannot change the
 * result. Addition is commutative, so the sort matters only for `asOf` cutoffs
 * and per-lot ordering, but determinism is worth the negligible cost.
 */
export function projectPosition(
  skuId: SkuId,
  siteId: SiteId,
  movements: readonly StockMovement[],
  options: ProjectOptions = {},
): StockPosition {
  const relevant = movements
    .filter((m) => m.skuId === skuId && m.siteId === siteId)
    .filter((m) => (options.asOf ? m.occurredAt <= options.asOf : true))
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id < b.id ? -1 : 1));

  let onHand = options.openingBalance ?? 0;
  const lots = new Map<LotId, number>();
  let asOf: IsoTimestamp | null = null;

  for (const movement of relevant) {
    const delta = movementDelta(movement);
    onHand += delta;
    if (movement.lotId !== undefined) {
      lots.set(movement.lotId, (lots.get(movement.lotId) ?? 0) + delta);
    }
    asOf = movement.occurredAt;
  }

  const reserved = options.reserved ?? 0;

  return {
    skuId,
    siteId,
    onHand,
    reserved,
    available: onHand - reserved,
    byLot: [...lots.entries()]
      .filter(([, quantity]) => quantity !== 0)
      .map(([lotId, quantity]) => ({ lotId, quantity })),
    asOf,
    movementCount: relevant.length,
  };
}

/**
 * Check a proposed movement against the current position.
 *
 * Returning a reason rather than throwing lets the caller decide: the API rejects
 * with 422, while the autonomous agent downgrades the decision and records why it
 * could not act. Negative stock is *allowed* to exist in the ledger (it is a real
 * signal that reality diverged from the books) but it is never allowed to be
 * created deliberately.
 */
export function validateMovement(
  movement: StockMovement,
  position: StockPosition,
  options: { readonly allowNegative?: boolean } = {},
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (movement.quantity === 0) {
    return { ok: false, reason: 'Movement quantity must not be zero' };
  }

  let delta: number;
  try {
    delta = movementDelta(movement);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Invalid movement' };
  }

  if (delta < 0 && !options.allowNegative && position.onHand + delta < 0) {
    return {
      ok: false,
      reason: `Movement would drive on-hand negative: ${position.onHand} ${delta >= 0 ? '+' : '−'} ${Math.abs(delta)}`,
    };
  }

  if (delta < 0 && movement.lotId !== undefined) {
    const lot = position.byLot.find((l) => l.lotId === movement.lotId);
    const lotQuantity = lot?.quantity ?? 0;
    if (lotQuantity + delta < 0 && !options.allowNegative) {
      return { ok: false, reason: `Lot ${movement.lotId} holds ${lotQuantity}, cannot issue ${Math.abs(delta)}` };
    }
  }

  return { ok: true };
}

export interface LotAllocation {
  readonly lotId: LotId;
  readonly quantity: Quantity;
  readonly expiresOn?: IsoDate;
}

export interface AllocationResult {
  readonly allocations: readonly LotAllocation[];
  /** Units that could not be covered by available lots. Zero on a full allocation. */
  readonly shortfall: Quantity;
}

export interface AllocatableLot {
  readonly id: LotId;
  readonly quantity: Quantity;
  readonly expiresOn?: IsoDate;
  readonly receivedAt: IsoTimestamp;
}

/**
 * Allocate demand across lots, first-expired-first-out.
 *
 * FEFO, not FIFO: for perishable goods the received order is irrelevant, what
 * matters is what spoils soonest. Lots with no expiry sort last and then by
 * receipt date, which degrades gracefully to FIFO for non-perishables.
 */
export function allocateFefo(lots: readonly AllocatableLot[], demand: Quantity): AllocationResult {
  if (demand < 0) throw new RangeError(`Cannot allocate a negative demand of ${demand}`);

  const ordered = [...lots]
    .filter((lot) => lot.quantity > 0)
    .sort((a, b) => {
      if (a.expiresOn !== undefined && b.expiresOn !== undefined) {
        if (a.expiresOn !== b.expiresOn) return a.expiresOn < b.expiresOn ? -1 : 1;
      } else if (a.expiresOn !== undefined) {
        return -1;
      } else if (b.expiresOn !== undefined) {
        return 1;
      }
      if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

  const allocations: LotAllocation[] = [];
  let outstanding = demand;

  for (const lot of ordered) {
    if (outstanding === 0) break;
    const take = Math.min(lot.quantity, outstanding);
    allocations.push(
      lot.expiresOn === undefined
        ? { lotId: lot.id, quantity: take }
        : { lotId: lot.id, quantity: take, expiresOn: lot.expiresOn },
    );
    outstanding -= take;
  }

  return { allocations, shortfall: outstanding };
}

/**
 * Quantity that will expire before it can plausibly be sold.
 *
 * Compares each lot against the demand expected to arrive before that lot's
 * expiry date, consuming lots in FEFO order. Anything left over is at risk and is
 * what a markdown or transfer decision is trying to rescue.
 */
export function quantityAtExpiryRisk(
  lots: readonly AllocatableLot[],
  dailyDemand: number,
  today: IsoDate,
): Quantity {
  if (dailyDemand < 0) throw new RangeError('Daily demand cannot be negative');

  const dated = [...lots]
    .filter((lot) => lot.quantity > 0 && lot.expiresOn !== undefined)
    .sort((a, b) => ((a.expiresOn ?? '') < (b.expiresOn ?? '') ? -1 : 1));

  let consumedByEarlierLots = 0;
  let atRisk = 0;

  for (const lot of dated) {
    const daysRemaining = daysBetween(today, lot.expiresOn ?? today);
    if (daysRemaining <= 0) {
      atRisk += lot.quantity;
      continue;
    }
    const demandBeforeExpiry = Math.floor(dailyDemand * daysRemaining);
    const demandAvailableToThisLot = Math.max(0, demandBeforeExpiry - consumedByEarlierLots);
    const sellable = Math.min(lot.quantity, demandAvailableToThisLot);
    atRisk += lot.quantity - sellable;
    consumedByEarlierLots += sellable;
  }

  return atRisk;
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const MS_PER_DAY = 86_400_000;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new TypeError(`Invalid ISO date in range ${from}..${to}`);
  }
  return Math.round((end - start) / MS_PER_DAY);
}

/** Add whole days to an ISO date, returning a new ISO date. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new TypeError(`Invalid ISO date ${date}`);
  const shifted = new Date(ms + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}
