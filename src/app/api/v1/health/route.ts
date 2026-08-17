/**
 * Health checks.
 *
 * Two distinct questions, deliberately not conflated:
 *
 *  - `?probe=liveness` — is the process alive? Never touches the database, so a
 *    database blip cannot cause the orchestrator to restart every healthy pod and
 *    turn a brief outage into a cascading one.
 *  - default (readiness) — can this instance actually serve traffic? Checks the
 *    database, and returns 503 when it cannot, so the load balancer takes it out
 *    of rotation without killing it.
 *
 * Unauthenticated by necessity, so it reveals nothing beyond up or down: no
 * version, no hostname, no dependency detail.
 */

import { sql } from 'drizzle-orm';
import { withoutOrgScope } from '@/server/db/client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const probe = new URL(request.url).searchParams.get('probe');

  if (probe === 'liveness') {
    return json({ status: 'alive' }, 200);
  }

  const startedAt = Date.now();

  try {
    await withoutOrgScope(async (db) => db.execute(sql`select 1`));

    return json({ status: 'ready', checks: { database: { ok: true, latencyMs: Date.now() - startedAt } } }, 200);
  } catch {
    // No error detail: this endpoint is public, and driver errors carry
    // connection strings and host names.
    return json({ status: 'unavailable', checks: { database: { ok: false } } }, 503);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
