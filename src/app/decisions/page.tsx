/**
 * The decision queue.
 *
 * This is the human-in-the-loop surface, and its design goal is that a planner can
 * approve or reject without opening anything else. Every decision therefore shows
 * its full rationale and the evidence behind it inline — a queue that requires
 * investigation before every approval gets rubber-stamped instead, which quietly
 * removes the oversight it was built to provide.
 */

import { desc, sql } from 'drizzle-orm';
import { withoutOrgScope } from '@/server/db/client';
import { decisions, sites, skus } from '@/server/db/schema';
import {
  Card,
  EmptyState,
  formatMoney,
  formatRelative,
  NotConnected,
  PageHeading,
  SeverityBadge,
  StateBadge,
  type Severity,
} from '../_components/ui';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Decisions' };

interface DecisionView {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly severity: string;
  readonly quantity: number | null;
  readonly value: number;
  readonly expectedBenefit: number;
  readonly currency: string;
  readonly confidence: number;
  readonly rationale: string[];
  readonly gateReasons: string[];
  readonly evidence: Record<string, unknown>;
  readonly createdAt: Date;
  readonly skuCode: string;
  readonly skuName: string;
  readonly siteCode: string;
}

async function loadDecisions(): Promise<DecisionView[] | { error: string }> {
  try {
    return await withoutOrgScope(async (db) => {
      const rows = await db
        .select({
          id: decisions.id,
          kind: decisions.kind,
          state: decisions.state,
          severity: decisions.severity,
          quantity: decisions.quantity,
          value: decisions.value,
          expectedBenefit: decisions.expectedBenefit,
          currency: decisions.currency,
          confidence: decisions.confidence,
          rationale: decisions.rationale,
          gateReasons: decisions.gateReasons,
          evidence: decisions.evidence,
          createdAt: decisions.createdAt,
          skuCode: skus.code,
          skuName: skus.name,
          siteCode: sites.code,
        })
        .from(decisions)
        .innerJoin(skus, sql`${skus.id} = ${decisions.skuId}`)
        .innerJoin(sites, sql`${sites.id} = ${decisions.siteId}`)
        .orderBy(desc(decisions.createdAt))
        .limit(50);

      return rows.map((row) => ({
        ...row,
        rationale: Array.isArray(row.rationale) ? (row.rationale as string[]) : [],
        gateReasons: Array.isArray(row.gateReasons) ? (row.gateReasons as string[]) : [],
        evidence: (row.evidence ?? {}) as Record<string, unknown>,
      }));
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Unknown database error' };
  }
}

export default async function DecisionsPage() {
  const result = await loadDecisions();

  if ('error' in result) {
    return (
      <>
        <PageHeading title="Decisions" description="Everything the agent has decided, and why." />
        <NotConnected detail={result.error} />
      </>
    );
  }

  if (result.length === 0) {
    return (
      <>
        <PageHeading title="Decisions" description="Everything the agent has decided, and why." />
        <EmptyState
          title="Nothing decided yet"
          description="Once the agent has run against a catalogue with movement history, its decisions will appear here — including the ones it chose not to act on alone."
        />
      </>
    );
  }

  return (
    <>
      <PageHeading
        title="Decisions"
        description="Everything the agent has decided, and why. Each entry carries the reasoning and the numbers behind it, so it can be judged without leaving this page."
      />

      <ul className="space-y-4">
        {result.map((decision) => (
          <li key={decision.id}>
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{decision.kind.replaceAll('_', ' ').toLowerCase()}</span>
                    <SeverityBadge severity={decision.severity as Severity} />
                    <StateBadge state={decision.state} />
                  </div>
                  <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
                    <span className="numeric">{decision.skuCode}</span> · {decision.skuName} · site{' '}
                    <span className="numeric">{decision.siteCode}</span>
                  </p>
                </div>

                <div className="text-right text-sm">
                  {decision.quantity !== null && (
                    <div className="numeric font-medium">{decision.quantity} units</div>
                  )}
                  {decision.value > 0 && (
                    <div className="numeric text-[var(--color-ink-muted)]">
                      {formatMoney(decision.value, decision.currency)} committed
                    </div>
                  )}
                  {decision.expectedBenefit > 0 && (
                    <div className="numeric text-[var(--color-low)]">
                      {formatMoney(decision.expectedBenefit, decision.currency)} protected
                    </div>
                  )}
                </div>
              </div>

              {decision.rationale.length > 0 && (
                <ul className="mt-4 space-y-1 border-l-2 border-[var(--color-border)] pl-3 text-sm">
                  {decision.rationale.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              )}

              {decision.gateReasons.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-[var(--color-ink-muted)]">
                    Why the policy gate reached this outcome
                  </summary>
                  <ul className="mt-2 space-y-1 text-xs text-[var(--color-ink-muted)]">
                    {decision.gateReasons.map((line, index) => (
                      <li key={index}>· {line}</li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-[var(--color-ink-muted)]">
                <span className="numeric">confidence {(decision.confidence * 100).toFixed(0)}%</span>
                <span>{formatRelative(decision.createdAt)}</span>
                {Object.entries(decision.evidence)
                  .slice(0, 4)
                  .map(([key, value]) => (
                    <span key={key} className="numeric">
                      {key}: {String(value)}
                    </span>
                  ))}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
