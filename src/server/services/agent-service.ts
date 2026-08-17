/**
 * The autonomous cycle.
 *
 * One pass over an organisation's stock: load state, evaluate, persist decisions,
 * execute what the guardrails allow, record what happened.
 *
 * Three properties make this safe to run unattended:
 *
 *  - **Idempotent.** Decisions are keyed by a deterministic fingerprint, so a
 *    crashed run that is retried re-proposes the same decisions rather than
 *    duplicating them. Ordering twice is the failure mode that would matter most.
 *  - **Singly-executed.** An advisory lock means only one replica evaluates a given
 *    organisation at a time.
 *  - **Budgeted.** Spend committed earlier in the same day is loaded before the
 *    run starts and passed into every gate check, so the daily cap holds across
 *    runs rather than resetting each cycle.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import { money } from '../../core/money.ts';
import {
  catalogueAbc,
  evaluate,
  proposeTransfers,
  type Decision,
  type Evaluation,
} from '../../core/agent/decision-engine.ts';
import type { AutonomyPolicy } from '../../core/agent/autonomy.ts';
import type { StockContext } from '../../core/types.ts';
import { withAdvisoryLock, withOrg, type Database } from '../db/client.ts';
import { agentRuns, decisions as decisionsTable, organisations, stockMovements } from '../db/schema.ts';
import {
  listActiveSkuSites,
  loadAnnualValues,
  loadStockContext,
  type SkuSiteRef,
} from '../repositories/inventory.ts';
import { logger } from '../logger.ts';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface CycleSummary {
  readonly runId: string | null;
  readonly skusEvaluated: number;
  readonly decisionsProposed: number;
  readonly decisionsExecuted: number;
  readonly decisionsBlocked: number;
  readonly valueCommitted: number;
  /** True when another replica held the lock and this cycle was skipped. */
  readonly skipped: boolean;
}

const SKIPPED: CycleSummary = {
  runId: null,
  skusEvaluated: 0,
  decisionsProposed: 0,
  decisionsExecuted: 0,
  decisionsBlocked: 0,
  valueCommitted: 0,
  skipped: true,
};

/**
 * Run one cycle for one organisation.
 *
 * Returns without doing anything if another replica already holds the lock.
 */
export async function runCycle(orgId: string, today = new Date()): Promise<CycleSummary> {
  const result = await withAdvisoryLock(`agent:${orgId}`, async () => {
    return withOrg(orgId, async (tx) => executeCycle(tx, orgId, today));
  });

  return result ?? SKIPPED;
}

async function executeCycle(tx: Tx, orgId: string, today: Date): Promise<CycleSummary> {
  const log = logger.child({ orgId, component: 'agent' });

  const [org] = await tx.select().from(organisations).where(eq(organisations.id, orgId)).limit(1);
  if (org === undefined) throw new Error(`Organisation ${orgId} not found`);

  const [run] = await tx.insert(agentRuns).values({ orgId }).returning({ id: agentRuns.id });
  if (run === undefined) throw new Error('Failed to open an agent run');

  const policy: AutonomyPolicy = {
    level: org.autonomy,
    maxAutoValue: money(org.maxAutoValue, org.currency),
    maxDailyAutoValue: money(org.maxDailyAutoValue, org.currency),
    minConfidence: org.minConfidence,
    alwaysApprove: ['WRITE_OFF', 'MARKDOWN'],
    paused: org.agentPaused,
  };

  const refs = await listActiveSkuSites(tx);
  const abcBySku = catalogueAbc(await loadAnnualValues(tx, today));

  // The daily budget is shared across every run today, not per run.
  let committedToday = money(await sumCommittedToday(tx, orgId, today), org.currency);

  const isoToday = today.toISOString().slice(0, 10);
  const evaluations: Evaluation[] = [];
  const contexts = new Map<string, StockContext>();
  const allDecisions: Decision[] = [];

  for (const ref of refs) {
    const context = await loadStockContext(tx, ref, today);
    if (context === null) continue;

    // A SKU with no history at all has nothing to forecast and nothing to say.
    if (context.demandHistory.length === 0 && context.onHand === 0) continue;

    const evaluation = evaluate({
      context,
      movements: await loadRecentMovements(tx, ref, today),
      today: isoToday,
      policy,
      committedToday,
      ...(abcBySku.get(ref.skuId) === undefined ? {} : { abc: abcBySku.get(ref.skuId)! }),
    });

    evaluations.push(evaluation);
    contexts.set(`${ref.skuId}:${ref.siteId}`, context);
    allDecisions.push(...evaluation.decisions);

    // Charge executed spend against the budget immediately, so later SKUs in the
    // same pass see a budget that is already partly consumed.
    for (const decision of evaluation.decisions) {
      if (decision.outcome === 'execute' && decision.value.currency === committedToday.currency) {
        committedToday = money(committedToday.amount + decision.value.amount, committedToday.currency);
      }
    }
  }

  // Transfers need the whole network, so they are considered after every site.
  allDecisions.push(
    ...proposeTransfers(evaluations, contexts, isoToday, money(50, org.currency)),
  );

  const persisted = await persistDecisions(tx, orgId, run.id, allDecisions);

  const summary: CycleSummary = {
    runId: run.id,
    skusEvaluated: evaluations.length,
    decisionsProposed: persisted.proposed,
    decisionsExecuted: persisted.executed,
    decisionsBlocked: persisted.blocked,
    valueCommitted: persisted.valueCommitted,
    skipped: false,
  };

  await tx
    .update(agentRuns)
    .set({
      finishedAt: new Date(),
      skusEvaluated: summary.skusEvaluated,
      decisionsProposed: summary.decisionsProposed,
      decisionsExecuted: summary.decisionsExecuted,
      decisionsBlocked: summary.decisionsBlocked,
      valueCommitted: summary.valueCommitted,
    })
    .where(eq(agentRuns.id, run.id));

  log.info('Agent cycle complete', { ...summary });

  return summary;
}

/**
 * Persist decisions, skipping any that already exist.
 *
 * The unique index on `(org_id, fingerprint)` plus `onConflictDoNothing` is what
 * makes a retried run harmless: the second attempt writes nothing rather than
 * proposing the same purchase twice.
 */
async function persistDecisions(
  tx: Tx,
  orgId: string,
  runId: string,
  decisions: readonly Decision[],
): Promise<{ proposed: number; executed: number; blocked: number; valueCommitted: number }> {
  let proposed = 0;
  let executed = 0;
  let blocked = 0;
  let valueCommitted = 0;

  for (const decision of decisions) {
    const state =
      decision.outcome === 'execute' ? 'executed' : decision.outcome === 'block' ? 'blocked' : 'proposed';

    const [row] = await tx
      .insert(decisionsTable)
      .values({
        orgId,
        runId,
        fingerprint: decision.id,
        skuId: decision.skuId,
        siteId: decision.siteId,
        kind: decision.kind,
        state,
        ...(decision.quantity === undefined ? {} : { quantity: decision.quantity }),
        value: decision.value.amount,
        expectedBenefit: decision.expectedBenefit.amount,
        currency: decision.value.currency,
        confidence: decision.confidence,
        severity: decision.severity,
        rationale: decision.rationale,
        evidence: decision.evidence,
        gateReasons: decision.gateReasons,
        ...(state === 'executed' ? { executedAt: new Date() } : {}),
      })
      .onConflictDoNothing({ target: [decisionsTable.orgId, decisionsTable.fingerprint] })
      .returning({ id: decisionsTable.id });

    // No row means the fingerprint already existed: this decision was made in an
    // earlier run and must not be counted or acted on again.
    if (row === undefined) continue;

    if (state === 'executed') {
      executed += 1;
      valueCommitted += decision.value.amount;
    } else if (state === 'blocked') {
      blocked += 1;
    } else {
      proposed += 1;
    }
  }

  return { proposed, executed, blocked, valueCommitted };
}

/** Value automatically committed so far today, for the daily budget check. */
async function sumCommittedToday(tx: Tx, orgId: string, today: Date): Promise<number> {
  const startOfDay = new Date(today);
  startOfDay.setUTCHours(0, 0, 0, 0);

  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${decisionsTable.value}), 0)::bigint` })
    .from(decisionsTable)
    .where(
      and(
        eq(decisionsTable.orgId, orgId),
        eq(decisionsTable.state, 'executed'),
        gte(decisionsTable.createdAt, startOfDay),
      ),
    );

  return Number(row?.total ?? 0);
}

/** Recent movements, for the shrinkage detector. */
async function loadRecentMovements(tx: Tx, ref: SkuSiteRef, today: Date, days = 90) {
  const since = new Date(today.getTime() - days * 86_400_000);

  const rows = await tx
    .select()
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.skuId, ref.skuId),
        eq(stockMovements.siteId, ref.siteId),
        gte(stockMovements.occurredAt, since),
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    skuId: row.skuId,
    siteId: row.siteId,
    kind: row.kind,
    quantity: row.quantity,
    occurredAt: row.occurredAt.toISOString(),
    actor: row.actor,
  }));
}

/**
 * Approve a proposed decision.
 *
 * Approval only changes state; it never executes as a side effect. Carrying out
 * the action is a separate, explicit step, which keeps "a human agreed" and "the
 * warehouse was told" as two distinct facts in the audit trail.
 */
export async function approveDecision(
  orgId: string,
  decisionId: string,
  userId: string,
): Promise<boolean> {
  return withOrg(orgId, async (tx) => {
    const updated = await tx
      .update(decisionsTable)
      .set({ state: 'approved', decidedBy: userId, decidedAt: new Date() })
      .where(and(eq(decisionsTable.id, decisionId), eq(decisionsTable.state, 'proposed')))
      .returning({ id: decisionsTable.id });

    return updated.length > 0;
  });
}

export async function rejectDecision(
  orgId: string,
  decisionId: string,
  userId: string,
): Promise<boolean> {
  return withOrg(orgId, async (tx) => {
    const updated = await tx
      .update(decisionsTable)
      .set({ state: 'rejected', decidedBy: userId, decidedAt: new Date() })
      .where(and(eq(decisionsTable.id, decisionId), eq(decisionsTable.state, 'proposed')))
      .returning({ id: decisionsTable.id });

    return updated.length > 0;
  });
}

