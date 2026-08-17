/**
 * Trigger an agent cycle on demand.
 *
 * The agent normally runs on its own schedule. This endpoint exists for the cases
 * where waiting is wrong: after a bulk catalogue import, after correcting a bad
 * stock count, or when an operator wants to see the effect of a policy change
 * immediately.
 *
 * It is safe to call repeatedly. The advisory lock means a concurrent call
 * returns `skipped` rather than running a second overlapping sweep.
 */

import { guard } from '@/server/http/context';
import { runCycle } from '@/server/services/agent-service';
import { internal, ok } from '@/server/http/problem';
import { logger } from '@/server/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * A sweep over a large catalogue takes minutes, which is longer than most proxies
 * will hold a connection open.
 */
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  const permitted = await guard(request, 'agent:run');
  if (!permitted.ok) return permitted.response;

  const { auth, headers } = permitted;

  try {
    logger.info('Manual agent run requested', { actor: auth.actor, orgId: auth.orgId });

    const summary = await runCycle(auth.orgId);

    // 202 when another replica already holds the lock: the request was accepted,
    // but this call did not perform the work.
    return ok(summary, summary.skipped ? 202 : 200, headers);
  } catch (error) {
    return internal(error, { route: 'POST /api/v1/agent/run', actor: auth.actor });
  }
}
