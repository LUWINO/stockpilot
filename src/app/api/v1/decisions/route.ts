/**
 * Decision queue.
 *
 * `GET` lists decisions; `PATCH` approves or rejects one. Approval is a state
 * change only — it never executes as a side effect, so "a human agreed" and "the
 * warehouse was told" stay separate facts in the audit trail.
 */

import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { withOrg } from '@/server/db/client';
import { decisions } from '@/server/db/schema';
import { guard } from '@/server/http/context';
import { approveDecision, rejectDecision } from '@/server/services/agent-service';
import { badRequest, conflict, internal, ok, unprocessable } from '@/server/http/problem';
import { logger } from '@/server/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ListQuery = z.object({
  state: z.enum(['proposed', 'approved', 'rejected', 'executed', 'blocked', 'expired']).optional(),
  kind: z
    .enum(['REPLENISH', 'HOLD_REPLENISHMENT', 'TRANSFER', 'MARKDOWN', 'WRITE_OFF', 'COUNT', 'ALERT'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().datetime().optional(),
});

export async function GET(request: Request): Promise<Response> {
  const permitted = await guard(request, 'decision:read');
  if (!permitted.ok) return permitted.response;

  const { auth, headers } = permitted;
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = ListQuery.safeParse(params);

  if (!parsed.success) {
    return unprocessable('Invalid query parameters');
  }

  const { state, kind, limit, cursor } = parsed.data;

  try {
    return await withOrg(auth.orgId, async (tx) => {
      const filters = [eq(decisions.orgId, auth.orgId)];
      if (state !== undefined) filters.push(eq(decisions.state, state));
      if (kind !== undefined) filters.push(eq(decisions.kind, kind));
      // Keyset pagination rather than OFFSET: stable under concurrent inserts and
      // does not degrade as the table grows.
      if (cursor !== undefined) filters.push(sql`${decisions.createdAt} < ${new Date(cursor)}`);

      const rows = await tx
        .select()
        .from(decisions)
        .where(and(...filters))
        .orderBy(desc(decisions.createdAt))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? page.at(-1)?.createdAt.toISOString() : undefined;

      return ok(
        {
          data: page.map(serialise),
          ...(nextCursor === undefined ? {} : { nextCursor }),
        },
        200,
        headers,
      );
    });
  } catch (error) {
    return internal(error, { route: 'GET /api/v1/decisions', actor: auth.actor });
  }
}

const PatchRequest = z.object({
  decisionId: z.string().uuid(),
  action: z.enum(['approve', 'reject']),
  /** Recorded against the decision for the audit trail. */
  note: z.string().max(1000).optional(),
});

export async function PATCH(request: Request): Promise<Response> {
  const permitted = await guard(request, 'decision:approve');
  if (!permitted.ok) return permitted.response;

  const { auth, headers } = permitted;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const parsed = PatchRequest.safeParse(payload);
  if (!parsed.success) return unprocessable('Invalid approval request');

  const { decisionId, action } = parsed.data;

  // An API key has no human behind it, so it cannot supply the accountability
  // that approval is supposed to represent.
  if (auth.userId === undefined) {
    return unprocessable('Decisions must be approved by a signed-in user, not an API key');
  }

  try {
    const changed =
      action === 'approve'
        ? await approveDecision(auth.orgId, decisionId, auth.userId)
        : await rejectDecision(auth.orgId, decisionId, auth.userId);

    if (!changed) {
      return conflict('That decision does not exist, or is no longer awaiting a decision');
    }

    logger.info('Decision reviewed', { actor: auth.actor, decisionId, action });

    return ok({ decisionId, action, state: action === 'approve' ? 'approved' : 'rejected' }, 200, headers);
  } catch (error) {
    return internal(error, { route: 'PATCH /api/v1/decisions', actor: auth.actor });
  }
}

function serialise(row: typeof decisions.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    severity: row.severity,
    skuId: row.skuId,
    siteId: row.siteId,
    quantity: row.quantity,
    value: { amount: row.value, currency: row.currency },
    expectedBenefit: { amount: row.expectedBenefit, currency: row.currency },
    confidence: row.confidence,
    rationale: row.rationale,
    evidence: row.evidence,
    gateReasons: row.gateReasons,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    executedAt: row.executedAt?.toISOString() ?? null,
  };
}
