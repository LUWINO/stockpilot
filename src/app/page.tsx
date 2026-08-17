/**
 * Overview.
 *
 * The question this page answers is "is the agent working, and should I be
 * worried?" — not "how much stock do we have?", which is what the inventory page
 * is for. Everything here is either a sign of health or a call to action.
 */

import Link from 'next/link';
import { desc, eq, sql } from 'drizzle-orm';
import { withoutOrgScope } from '@/server/db/client';
import { agentRuns, decisions, organisations, skus } from '@/server/db/schema';
import {
  Card,
  EmptyState,
  formatMoney,
  formatRelative,
  NotConnected,
  PageHeading,
  Stat,
} from './_components/ui';

// Every figure here is live tenant data, so nothing may be cached or
// pre-rendered at build time.
export const dynamic = 'force-dynamic';

interface Overview {
  readonly orgName: string;
  readonly currency: string;
  readonly agentPaused: boolean;
  readonly skuCount: number;
  readonly pendingDecisions: number;
  readonly valueAtStake: number;
  readonly executedToday: number;
  readonly lastRun: { finishedAt: Date | null; skusEvaluated: number } | null;
}

async function loadOverview(): Promise<Overview | { error: string }> {
  try {
    return await withoutOrgScope(async (db) => {
      const [org] = await db.select().from(organisations).limit(1);

      if (org === undefined) {
        return { error: 'No organisation has been created yet. Run the seed script to get started.' };
      }

      const [skuCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(skus)
        .where(eq(skus.orgId, org.id));

      const [pending] = await db
        .select({
          count: sql<number>`count(*)::int`,
          benefit: sql<number>`coalesce(sum(${decisions.expectedBenefit}), 0)::bigint`,
        })
        .from(decisions)
        .where(sql`${decisions.orgId} = ${org.id} and ${decisions.state} = 'proposed'`);

      const [executed] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(decisions)
        .where(
          sql`${decisions.orgId} = ${org.id} and ${decisions.state} = 'executed' and ${decisions.createdAt} > now() - interval '24 hours'`,
        );

      const [lastRun] = await db
        .select({ finishedAt: agentRuns.finishedAt, skusEvaluated: agentRuns.skusEvaluated })
        .from(agentRuns)
        .where(eq(agentRuns.orgId, org.id))
        .orderBy(desc(agentRuns.startedAt))
        .limit(1);

      return {
        orgName: org.name,
        currency: org.currency,
        agentPaused: org.agentPaused,
        skuCount: skuCount?.count ?? 0,
        pendingDecisions: pending?.count ?? 0,
        valueAtStake: Number(pending?.benefit ?? 0),
        executedToday: executed?.count ?? 0,
        lastRun: lastRun ?? null,
      };
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Unknown database error' };
  }
}

export default async function OverviewPage() {
  const overview = await loadOverview();

  if ('error' in overview) {
    return (
      <>
        <PageHeading
          title="Overview"
          description="Agent health, outstanding decisions and the money currently at stake."
        />
        <NotConnected detail={overview.error} />
      </>
    );
  }

  return (
    <>
      <PageHeading
        title={overview.orgName}
        description="Agent health, outstanding decisions and the money currently at stake."
      />

      {overview.agentPaused && (
        <Card className="mb-6 border-[var(--color-high)]">
          <p className="font-medium text-[var(--color-high)]">The agent is paused</p>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            Findings are still recorded and decisions are still proposed, but nothing will be carried out
            automatically until autonomy is resumed.
          </p>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Active SKUs" value={String(overview.skuCount)} hint="Evaluated every cycle" />
        <Stat
          label="Awaiting approval"
          value={String(overview.pendingDecisions)}
          hint="Decisions the agent would not take alone"
        />
        <Stat
          label="Value at stake"
          value={formatMoney(overview.valueAtStake, overview.currency)}
          hint="Protected if the queue is cleared"
        />
        <Stat
          label="Acted on today"
          value={String(overview.executedToday)}
          hint="Automatic actions in the last 24 hours"
        />
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="font-medium">Last agent run</h2>
          {overview.lastRun === null ? (
            <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
              The agent has not run yet. Start it with <code className="numeric">npm run agent</code>, or
              trigger a single sweep with <code className="numeric">RUN_ONCE=true npm run agent</code>.
            </p>
          ) : (
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-[var(--color-ink-muted)]">Finished</dt>
                <dd className="numeric">{formatRelative(overview.lastRun.finishedAt)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--color-ink-muted)]">SKU/site pairs evaluated</dt>
                <dd className="numeric">{overview.lastRun.skusEvaluated}</dd>
              </div>
            </dl>
          )}
        </Card>

        <Card>
          <h2 className="font-medium">What the agent does each cycle</h2>
          <ol className="mt-3 space-y-1.5 text-sm text-[var(--color-ink-muted)]">
            <li>1. Rebuilds every stock position from the ledger.</li>
            <li>2. Re-forecasts demand and picks the method that backtests best.</li>
            <li>3. Recomputes safety stock and reorder points from forecast error.</li>
            <li>4. Detects what is already wrong: stockouts, expiry, shrinkage, dead stock.</li>
            <li>5. Decides, then applies the autonomy limits before anything happens.</li>
          </ol>
          <Link
            href="/decisions"
            className="mt-4 inline-block text-sm text-[var(--color-brand)] underline"
          >
            Review the decision queue →
          </Link>
        </Card>
      </div>

      {overview.skuCount === 0 && (
        <div className="mt-8">
          <EmptyState
            title="No SKUs yet"
            description="Load a catalogue and some movement history, and the agent will begin forecasting on its next cycle. See the quick start in the README."
          />
        </div>
      )}
    </>
  );
}
