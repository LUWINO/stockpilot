/**
 * Stock positions.
 *
 * Sorted by days of cover ascending, so whatever is closest to running out is at
 * the top. Sorting by SKU code instead — the obvious default — puts the most
 * urgent line halfway down page four.
 */

import { asc, eq, sql } from 'drizzle-orm';
import { withoutOrgScope } from '@/server/db/client';
import { sites, skuSites, skus } from '@/server/db/schema';
import {
  Card,
  EmptyState,
  formatMoney,
  NotConnected,
  PageHeading,
} from '../_components/ui';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Inventory' };

interface PositionView {
  readonly skuCode: string;
  readonly skuName: string;
  readonly siteCode: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly onOrder: number;
  readonly reorderPoint: number | null;
  readonly abcClass: string | null;
  readonly xyzClass: string | null;
  readonly unitCost: number;
  readonly currency: string;
}

async function loadPositions(): Promise<PositionView[] | { error: string }> {
  try {
    return await withoutOrgScope(async (db) =>
      db
        .select({
          skuCode: skus.code,
          skuName: skus.name,
          siteCode: sites.code,
          onHand: skuSites.onHand,
          reserved: skuSites.reserved,
          onOrder: skuSites.onOrder,
          reorderPoint: skuSites.reorderPoint,
          abcClass: skuSites.abcClass,
          xyzClass: skuSites.xyzClass,
          unitCost: skus.unitCost,
          currency: skus.currency,
        })
        .from(skuSites)
        .innerJoin(skus, eq(skus.id, skuSites.skuId))
        .innerJoin(sites, eq(sites.id, skuSites.siteId))
        .orderBy(asc(sql`${skuSites.onHand} - coalesce(${skuSites.reorderPoint}, 0)`))
        .limit(100),
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Unknown database error' };
  }
}

/** Below the reorder point is the line that matters; everything else is context. */
function health(position: PositionView): { label: string; colour: string } {
  const available = position.onHand - position.reserved;

  if (available < 0) return { label: 'negative', colour: 'var(--color-critical)' };
  if (available === 0) return { label: 'out of stock', colour: 'var(--color-critical)' };
  if (position.reorderPoint !== null && available + position.onOrder <= position.reorderPoint) {
    return { label: 'below reorder point', colour: 'var(--color-high)' };
  }
  return { label: 'healthy', colour: 'var(--color-low)' };
}

export default async function InventoryPage() {
  const result = await loadPositions();

  if ('error' in result) {
    return (
      <>
        <PageHeading title="Inventory" description="Live positions, most urgent first." />
        <NotConnected detail={result.error} />
      </>
    );
  }

  if (result.length === 0) {
    return (
      <>
        <PageHeading title="Inventory" description="Live positions, most urgent first." />
        <EmptyState
          title="No stock positions"
          description="Positions appear once movements have been recorded. Every figure here is derived from the ledger, never entered directly."
        />
      </>
    );
  }

  return (
    <>
      <PageHeading
        title="Inventory"
        description="Live positions, ordered by how close each one is to its reorder point. Every quantity is derived from the append-only ledger."
      />

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[46rem] text-sm">
          <caption className="sr-only">Stock positions by SKU and site, most urgent first</caption>
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-xs tracking-wide text-[var(--color-ink-muted)] uppercase">
              <th scope="col" className="px-4 py-3 font-medium">SKU</th>
              <th scope="col" className="px-4 py-3 font-medium">Site</th>
              <th scope="col" className="px-4 py-3 font-medium">Class</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Available</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">On order</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Reorder pt</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Value</th>
              <th scope="col" className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {result.map((position) => {
              const status = health(position);
              const available = position.onHand - position.reserved;

              return (
                <tr
                  key={`${position.skuCode}:${position.siteCode}`}
                  className="border-b border-[var(--color-border)] last:border-0"
                >
                  <td className="px-4 py-3">
                    <div className="numeric font-medium">{position.skuCode}</div>
                    <div className="text-xs text-[var(--color-ink-muted)]">{position.skuName}</div>
                  </td>
                  <td className="numeric px-4 py-3">{position.siteCode}</td>
                  <td className="numeric px-4 py-3">
                    {position.abcClass ?? '–'}
                    {position.xyzClass ?? ''}
                  </td>
                  <td className="numeric px-4 py-3 text-right">{available}</td>
                  <td className="numeric px-4 py-3 text-right">{position.onOrder}</td>
                  <td className="numeric px-4 py-3 text-right">{position.reorderPoint ?? '–'}</td>
                  <td className="numeric px-4 py-3 text-right">
                    {formatMoney(Math.max(0, position.onHand) * position.unitCost, position.currency)}
                  </td>
                  <td className="px-4 py-3">
                    <span style={{ color: status.colour }}>{status.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </>
  );
}
