/**
 * Inventory data access.
 *
 * Repositories are the only place that knows SQL. They translate between database
 * rows and the domain's own types, which keeps `src/core` free of any awareness
 * that a database exists — the property that makes the decision logic testable
 * without one.
 *
 * Every function takes a transaction handle rather than reaching for the database
 * itself, so it can only be called from inside `withOrg` and therefore only ever
 * runs with row-level security in force.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { money } from '../../core/money.ts';
import { projectPosition, type StockMovement } from '../../core/ledger.ts';
import type { DemandPoint, Sku, StockContext, Supplier } from '../../core/types.ts';
import type { Database } from '../db/client.ts';
import {
  dailyDemand,
  lots,
  purchaseOrderLines,
  purchaseOrders,
  sites,
  skuSites,
  skus,
  stockMovements,
  stockSnapshots,
  suppliers,
  type NewStockMovement,
} from '../db/schema.ts';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** How much demand history to load. Two years covers annual seasonality twice. */
const HISTORY_DAYS = 730;

export interface SkuSiteRef {
  readonly skuId: string;
  readonly siteId: string;
}

/**
 * Rebuild a stock position from the ledger.
 *
 * Starts from the newest snapshot at or before `asOf` and replays only the
 * movements after it. Without the snapshot this would be correct but linear in the
 * whole history of the SKU, which stops being acceptable somewhere around the
 * first year of trading.
 */
export async function loadPosition(tx: Tx, ref: SkuSiteRef): Promise<{ onHand: number; movementCount: number }> {
  const [snapshot] = await tx
    .select()
    .from(stockSnapshots)
    .where(and(eq(stockSnapshots.skuId, ref.skuId), eq(stockSnapshots.siteId, ref.siteId)))
    .orderBy(desc(stockSnapshots.asOf))
    .limit(1);

  const since = snapshot?.asOf ?? new Date(0);

  const rows = await tx
    .select()
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.skuId, ref.skuId),
        eq(stockMovements.siteId, ref.siteId),
        gte(stockMovements.occurredAt, since),
      ),
    )
    .orderBy(stockMovements.occurredAt);

  const position = projectPosition(ref.skuId, ref.siteId, rows.map(toDomainMovement), {
    openingBalance: snapshot?.onHand ?? 0,
  });

  return { onHand: position.onHand, movementCount: position.movementCount };
}

function toDomainMovement(row: typeof stockMovements.$inferSelect): StockMovement {
  return {
    id: row.id,
    skuId: row.skuId,
    siteId: row.siteId,
    kind: row.kind,
    quantity: row.quantity,
    occurredAt: row.occurredAt.toISOString(),
    actor: row.actor,
    ...(row.lotId === null ? {} : { lotId: row.lotId }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.decisionId === null ? {} : { decisionId: row.decisionId }),
  };
}

/**
 * Append a movement.
 *
 * The cached `sku_sites.on_hand` is updated in the same transaction. The cache is
 * a convenience for listing screens and is always reconcilable against the
 * ledger; if the two ever disagree, the ledger is right by definition.
 */
export async function recordMovement(tx: Tx, movement: NewStockMovement): Promise<string> {
  const [inserted] = await tx.insert(stockMovements).values(movement).returning({ id: stockMovements.id });

  if (inserted === undefined) throw new Error('Movement insert returned no row');

  const delta =
    movement.kind === 'ADJUSTMENT'
      ? movement.quantity
      : movement.kind === 'RECEIPT' || movement.kind === 'RETURN' || movement.kind === 'TRANSFER_IN'
        ? Math.abs(movement.quantity)
        : -Math.abs(movement.quantity);

  await tx
    .insert(skuSites)
    .values({
      orgId: movement.orgId,
      skuId: movement.skuId,
      siteId: movement.siteId,
      onHand: delta,
      ...(delta < 0 ? { lastIssuedAt: new Date() } : {}),
    })
    .onConflictDoUpdate({
      target: [skuSites.skuId, skuSites.siteId],
      set: {
        onHand: sql`${skuSites.onHand} + ${delta}`,
        updatedAt: new Date(),
        ...(delta < 0 ? { lastIssuedAt: new Date() } : {}),
      },
    });

  // Outbound movements are demand. Recording them daily gives the forecaster a
  // dense series without an expensive aggregation at read time.
  if (delta < 0 && movement.kind === 'ISSUE') {
    const day = (movement.occurredAt ?? new Date()).toISOString().slice(0, 10);
    await tx
      .insert(dailyDemand)
      .values({
        orgId: movement.orgId,
        skuId: movement.skuId,
        siteId: movement.siteId,
        day,
        quantity: Math.abs(delta),
      })
      .onConflictDoUpdate({
        target: [dailyDemand.skuId, dailyDemand.siteId, dailyDemand.day],
        set: { quantity: sql`${dailyDemand.quantity} + ${Math.abs(delta)}` },
      });
  }

  return inserted.id;
}

/**
 * Load everything the decision engine needs for one SKU at one site.
 *
 * This is the only I/O in an autonomous cycle. Everything downstream is pure,
 * which is what makes a decision reproducible from its recorded inputs.
 */
export async function loadStockContext(
  tx: Tx,
  ref: SkuSiteRef,
  today: Date = new Date(),
): Promise<StockContext | null> {
  const [skuRow] = await tx.select().from(skus).where(eq(skus.id, ref.skuId)).limit(1);
  if (skuRow === undefined) return null;

  const [siteRow] = await tx.select().from(sites).where(eq(sites.id, ref.siteId)).limit(1);
  if (siteRow === undefined) return null;

  const [planning] = await tx
    .select()
    .from(skuSites)
    .where(and(eq(skuSites.skuId, ref.skuId), eq(skuSites.siteId, ref.siteId)))
    .limit(1);

  const supplierRow =
    skuRow.supplierId === null
      ? undefined
      : (await tx.select().from(suppliers).where(eq(suppliers.id, skuRow.supplierId)).limit(1)).at(0);

  const position = await loadPosition(tx, ref);
  const history = await loadDemandHistory(tx, ref, today);
  const openLots = await loadOpenLots(tx, ref);
  const onOrder = await loadOnOrder(tx, ref);
  const leadTimes = await loadObservedLeadTimes(tx, skuRow.supplierId);

  const sku: Sku = {
    id: skuRow.id,
    orgId: skuRow.orgId,
    code: skuRow.code,
    name: skuRow.name,
    stockUnit: skuRow.stockUnit,
    unitCost: money(skuRow.unitCost, skuRow.currency),
    unitPrice: money(skuRow.unitPrice, skuRow.currency),
    perishable: skuRow.perishable,
    active: skuRow.active,
    ...(skuRow.shelfLifeDays === null ? {} : { shelfLifeDays: skuRow.shelfLifeDays }),
    ...(skuRow.supplierId === null ? {} : { supplierId: skuRow.supplierId }),
  };

  const supplier: Supplier | undefined =
    supplierRow === undefined
      ? undefined
      : {
          id: supplierRow.id,
          orgId: supplierRow.orgId,
          name: supplierRow.name,
          nominalLeadTimeDays: supplierRow.nominalLeadTimeDays,
          minimumOrderQuantity: supplierRow.minimumOrderQuantity,
          orderMultiple: supplierRow.orderMultiple,
          orderingCost: money(supplierRow.orderingCost, skuRow.currency),
        };

  const lastIssued = planning?.lastIssuedAt ?? null;

  return {
    sku,
    siteId: ref.siteId,
    demandHistory: history,
    onHand: position.onHand,
    reserved: planning?.reserved ?? 0,
    onOrder,
    lots: openLots,
    observedLeadTimeDays: leadTimes,
    daysSinceLastIssue:
      lastIssued === null ? null : Math.floor((today.getTime() - lastIssued.getTime()) / 86_400_000),
    ...(supplier === undefined ? {} : { supplier }),
  };
}

/**
 * Load daily demand, zero-filling the gaps.
 *
 * The zero-fill is essential rather than cosmetic. A sparse series silently
 * removes the days on which nothing sold, which makes intermittent demand look
 * continuous and causes the system to order far too much of a slow mover.
 */
export async function loadDemandHistory(
  tx: Tx,
  ref: SkuSiteRef,
  today: Date,
  days = HISTORY_DAYS,
): Promise<DemandPoint[]> {
  const start = new Date(today.getTime() - days * 86_400_000);
  const startDay = start.toISOString().slice(0, 10);

  const rows = await tx
    .select({ day: dailyDemand.day, quantity: dailyDemand.quantity })
    .from(dailyDemand)
    .where(
      and(
        eq(dailyDemand.skuId, ref.skuId),
        eq(dailyDemand.siteId, ref.siteId),
        gte(dailyDemand.day, startDay),
      ),
    )
    .orderBy(dailyDemand.day);

  const observed = new Map(rows.map((row) => [row.day, row.quantity]));
  const earliest = rows.at(0)?.day;
  const latest = rows.at(-1)?.day;
  if (earliest === undefined || latest === undefined) return [];

  const out: DemandPoint[] = [];
  const from = Date.parse(`${earliest}T00:00:00Z`);

  // End at the last day that actually has data, NOT at today.
  //
  // Zero-filling interior gaps is essential — a missing day genuinely means zero
  // sold, and dropping it makes intermittent demand look continuous. But
  // extending that logic to *today* invents a zero for a day that is still in
  // progress, or that has simply not been written yet by a till or depot that
  // syncs overnight.
  //
  // That single fabricated zero is not harmless. It tilts the estimated trend
  // downward, and a trend method extrapolating over a 28-day horizon turns the
  // tilt into a collapsed forecast — so the agent stops replenishing a product
  // that is selling perfectly well. Every forecast would carry this bias, every
  // day, because there is always a partially complete day at the end.
  const to = Date.parse(`${latest}T00:00:00Z`);

  for (let t = from; t <= to; t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push({ date, quantity: observed.get(date) ?? 0 });
  }

  return out;
}

async function loadOpenLots(tx: Tx, ref: SkuSiteRef): Promise<StockContext['lots']> {
  const rows = await tx
    .select({
      id: lots.id,
      expiresOn: lots.expiresOn,
      receivedAt: lots.receivedAt,
      quantity: sql<number>`coalesce(sum(
        case
          when ${stockMovements.kind} = 'ADJUSTMENT' then ${stockMovements.quantity}
          when ${stockMovements.kind} in ('RECEIPT', 'RETURN', 'TRANSFER_IN') then ${stockMovements.quantity}
          else -${stockMovements.quantity}
        end
      ), 0)::int`,
    })
    .from(lots)
    .leftJoin(stockMovements, eq(stockMovements.lotId, lots.id))
    .where(and(eq(lots.skuId, ref.skuId), eq(lots.siteId, ref.siteId)))
    .groupBy(lots.id, lots.expiresOn, lots.receivedAt);

  return rows
    .filter((row) => row.quantity > 0)
    .map((row) => ({
      id: row.id,
      skuId: ref.skuId,
      siteId: ref.siteId,
      quantity: row.quantity,
      receivedAt: row.receivedAt.toISOString(),
      ...(row.expiresOn === null ? {} : { expiresOn: row.expiresOn }),
    }));
}

/** Quantity ordered but not yet received, so the agent does not order it twice. */
async function loadOnOrder(tx: Tx, ref: SkuSiteRef): Promise<number> {
  const [row] = await tx
    .select({
      outstanding: sql<number>`coalesce(sum(${purchaseOrderLines.quantityOrdered} - ${purchaseOrderLines.quantityReceived}), 0)::int`,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
    .where(
      and(
        eq(purchaseOrderLines.skuId, ref.skuId),
        eq(purchaseOrders.siteId, ref.siteId),
        sql`${purchaseOrders.state} in ('placed', 'part_received')`,
      ),
    );

  return row?.outstanding ?? 0;
}

/**
 * Observed lead times, in days, from completed purchase orders.
 *
 * What the supplier actually did, not what the contract says. The gap between the
 * two is usually the single largest driver of safety stock.
 */
async function loadObservedLeadTimes(tx: Tx, supplierId: string | null, limit = 20): Promise<number[]> {
  if (supplierId === null) return [];

  const rows = await tx
    .select({
      placedAt: purchaseOrders.placedAt,
      receivedAt: purchaseOrders.receivedAt,
    })
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.supplierId, supplierId),
        eq(purchaseOrders.state, 'received'),
        sql`${purchaseOrders.placedAt} is not null`,
      ),
    )
    .orderBy(desc(purchaseOrders.receivedAt))
    .limit(limit);

  return rows
    .filter((row) => row.placedAt !== null && row.receivedAt !== null)
    .map((row) => (row.receivedAt!.getTime() - row.placedAt!.getTime()) / 86_400_000)
    .filter((days) => Number.isFinite(days) && days >= 0);
}

/**
 * Every SKU/site pair the agent should evaluate.
 *
 * The join is intentionally a cross product within the organisation: an active
 * SKU is stockable at every active site, whether or not it has ever been held
 * there. A site that has never stocked an item still needs to be considered — that
 * is exactly the case a transfer proposal exists to solve.
 */
export async function listActiveSkuSites(tx: Tx): Promise<SkuSiteRef[]> {
  return tx
    .select({ skuId: skus.id, siteId: sites.id })
    .from(skus)
    .innerJoin(sites, eq(sites.orgId, skus.orgId))
    .where(and(eq(skus.active, true), eq(sites.active, true)));
}

/** Annual consumption value per SKU, the input to ABC classification. */
export async function loadAnnualValues(
  tx: Tx,
  today: Date = new Date(),
): Promise<{ skuId: string; annualValue: number }[]> {
  const yearAgo = new Date(today.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);

  const rows = await tx
    .select({
      skuId: dailyDemand.skuId,
      annualValue: sql<number>`coalesce(sum(${dailyDemand.quantity} * ${skus.unitCost}), 0)::bigint`,
    })
    .from(dailyDemand)
    .innerJoin(skus, eq(skus.id, dailyDemand.skuId))
    .where(gte(dailyDemand.day, yearAgo))
    .groupBy(dailyDemand.skuId);

  return rows.map((row) => ({ skuId: row.skuId, annualValue: Number(row.annualValue) }));
}

/** Write a checkpoint so future replays start from here rather than the beginning. */
export async function writeSnapshot(tx: Tx, orgId: string, ref: SkuSiteRef): Promise<void> {
  const position = await loadPosition(tx, ref);

  await tx.insert(stockSnapshots).values({
    orgId,
    skuId: ref.skuId,
    siteId: ref.siteId,
    onHand: position.onHand,
    asOf: new Date(),
    movementCount: position.movementCount,
  });
}
