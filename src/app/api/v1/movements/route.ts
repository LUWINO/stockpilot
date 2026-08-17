/**
 * Stock movements.
 *
 * The busiest endpoint in the system: every receipt, sale, pick and correction
 * arrives here from tills, warehouse scanners and ERP integrations.
 *
 * Two properties matter more than anything else on this route:
 *
 *  - **Idempotency.** Scanners work over unreliable networks and retry. A retried
 *    receipt that books stock twice is a real and expensive failure, so an
 *    `Idempotency-Key` header makes the write exactly-once.
 *  - **Validation before persistence.** A movement that would drive stock negative
 *    is refused with a reason rather than silently accepted, because negative
 *    stock means the books and the shelf have diverged.
 */

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { withOrg } from '@/server/db/client';
import { stockMovements } from '@/server/db/schema';
import { loadPosition, recordMovement } from '@/server/repositories/inventory';
import { projectPosition, validateMovement } from '@/core/ledger';
import { guard } from '@/server/http/context';
import { badRequest, conflict, internal, ok, unprocessable } from '@/server/http/problem';
import { logger } from '@/server/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MovementRequest = z.object({
  skuId: z.string().uuid(),
  siteId: z.string().uuid(),
  kind: z.enum(['RECEIPT', 'ISSUE', 'RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'SCRAP', 'ADJUSTMENT']),
  quantity: z.number().int().refine((v) => v !== 0, 'Quantity must not be zero'),
  lotId: z.string().uuid().optional(),
  reason: z.string().max(500).optional(),
  occurredAt: z.string().datetime().optional(),
  /**
   * Permits a movement that drives stock negative. Reserved for stock-takes,
   * where the count *is* the truth however unwelcome, and gated on the
   * `inventory:adjust` permission.
   */
  allowNegative: z.boolean().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const permitted = await guard(request, 'inventory:move');
  if (!permitted.ok) return permitted.response;

  const { auth, headers } = permitted;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const parsed = MovementRequest.safeParse(payload);
  if (!parsed.success) {
    return unprocessable('The movement is not valid', fieldErrors(parsed.error));
  }

  const movement = parsed.data;

  // Adjustments rewrite the balance rather than recording a physical event, so
  // they need the stronger permission.
  if (movement.kind === 'ADJUSTMENT' || movement.allowNegative === true) {
    const adjustPermitted = await guard(request, 'inventory:adjust');
    if (!adjustPermitted.ok) return adjustPermitted.response;
  }

  const idempotencyKey = request.headers.get('idempotency-key');

  try {
    return await withOrg(auth.orgId, async (tx) => {
      // Replay guard. The unique index is the real defence; this check exists to
      // return the original outcome rather than a constraint-violation error.
      if (idempotencyKey !== null) {
        const [existing] = await tx
          .select({ id: stockMovements.id })
          .from(stockMovements)
          .where(
            and(
              eq(stockMovements.orgId, auth.orgId),
              eq(stockMovements.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);

        if (existing !== undefined) {
          return ok({ id: existing.id, replayed: true }, 200, headers);
        }
      }

      const position = await loadPosition(tx, { skuId: movement.skuId, siteId: movement.siteId });

      const candidate = {
        id: 'pending',
        skuId: movement.skuId,
        siteId: movement.siteId,
        kind: movement.kind,
        quantity: movement.quantity,
        occurredAt: movement.occurredAt ?? new Date().toISOString(),
        actor: auth.actor,
        ...(movement.lotId === undefined ? {} : { lotId: movement.lotId }),
      };

      const validation = validateMovement(
        candidate,
        projectPosition(movement.skuId, movement.siteId, [], { openingBalance: position.onHand }),
        { allowNegative: movement.allowNegative ?? false },
      );

      if (!validation.ok) {
        return conflict(validation.reason);
      }

      const id = await recordMovement(tx, {
        orgId: auth.orgId,
        skuId: movement.skuId,
        siteId: movement.siteId,
        kind: movement.kind,
        quantity: movement.quantity,
        actor: auth.actor,
        ...(movement.lotId === undefined ? {} : { lotId: movement.lotId }),
        ...(movement.reason === undefined ? {} : { reason: movement.reason }),
        ...(movement.occurredAt === undefined ? {} : { occurredAt: new Date(movement.occurredAt) }),
        ...(idempotencyKey === null ? {} : { idempotencyKey }),
      });

      logger.info('Movement recorded', {
        actor: auth.actor,
        movementId: id,
        kind: movement.kind,
        quantity: movement.quantity,
      });

      return ok({ id, replayed: false }, 201, headers);
    });
  } catch (error) {
    return internal(error, { route: 'POST /api/v1/movements', actor: auth.actor });
  }
}

function fieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}
