/**
 * Request authentication and authorisation.
 *
 * Resolves an incoming request to a caller: either an API key (for integrations)
 * or a session cookie (for the console). Everything downstream receives an
 * `AuthContext` and never touches headers again, so there is exactly one place
 * where a credential is turned into an identity.
 *
 * Failures are deliberately uninformative. "Invalid credentials" is returned
 * whether the key does not exist, is revoked, or is expired — telling an attacker
 * which of those it was helps only the attacker.
 */

import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { withoutOrgScope } from '../db/client.ts';
import { apiKeys, sessions, users } from '../db/schema.ts';
import { CSRF_HEADER, hashToken, looksLikeApiKey, SESSION_COOKIE, verifyCsrfToken } from '../auth/tokens.ts';
import type { Permission, Role } from '../auth/rbac.ts';
import { can } from '../auth/rbac.ts';
import { checkRateLimit, rateLimitHeaders, rateLimitKey } from './rate-limit.ts';
import { forbidden, tooManyRequests, unauthorised } from './problem.ts';
import { getEnv } from '../env.ts';
import { logger } from '../logger.ts';

export interface AuthContext {
  readonly orgId: string;
  readonly role: Role;
  /** Present for session callers. */
  readonly userId?: string;
  /** Present for API-key callers. */
  readonly apiKeyId?: string;
  /** How the caller authenticated, recorded in the audit trail. */
  readonly method: 'session' | 'api_key';
  /** Value written to `actor` columns. */
  readonly actor: string;
}

/**
 * Identify the caller.
 *
 * Returns `null` rather than throwing so the route can decide the response shape.
 * Runs outside tenant scope by necessity — the whole point is to discover which
 * tenant the caller belongs to.
 */
export async function authenticate(request: Request): Promise<AuthContext | null> {
  const bearer = readBearerToken(request);
  if (bearer !== null) return authenticateApiKey(bearer);

  const sessionToken = readSessionCookie(request);
  if (sessionToken !== null) return authenticateSession(request, sessionToken);

  return null;
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;

  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined) return null;
  return value.trim();
}

function readSessionCookie(request: Request): string | null {
  const cookies = request.headers.get('cookie');
  if (cookies === null) return null;

  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function authenticateApiKey(presented: string): Promise<AuthContext | null> {
  // Reject anything that is not shaped like one of our keys before hitting the
  // database, so a flood of junk tokens cannot be used to generate query load.
  if (!looksLikeApiKey(presented)) return null;

  const keyHash = hashToken(presented);

  const [row] = await withoutOrgScope(async (db) =>
    db
      .select({ id: apiKeys.id, orgId: apiKeys.orgId, role: apiKeys.role })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.keyHash, keyHash),
          isNull(apiKeys.revokedAt),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
        ),
      )
      .limit(1),
  );

  if (row === undefined) return null;

  // Best-effort last-used stamp; a failure here must not fail the request.
  void withoutOrgScope(async (db) =>
    db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)),
  ).catch(() => undefined);

  return {
    orgId: row.orgId,
    role: row.role,
    apiKeyId: row.id,
    method: 'api_key',
    actor: `api_key:${row.id}`,
  };
}

async function authenticateSession(request: Request, token: string): Promise<AuthContext | null> {
  const [row] = await withoutOrgScope(async (db) =>
    db
      .select({ userId: sessions.userId, orgId: sessions.orgId, role: users.role, active: users.active })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
      .limit(1),
  );

  if (row === undefined || !row.active) return null;

  // Cookie-authenticated state changes need a CSRF token; bearer tokens do not,
  // because a browser will never attach an Authorization header cross-origin.
  if (isStateChanging(request)) {
    const presented = request.headers.get(CSRF_HEADER) ?? '';
    if (!verifyCsrfToken(token, presented)) {
      logger.warn('Rejected a state-changing request with an invalid CSRF token', {
        userId: row.userId,
        path: new URL(request.url).pathname,
      });
      return null;
    }

    if (!isSameOrigin(request)) {
      logger.warn('Rejected a cross-origin state-changing request', {
        origin: request.headers.get('origin'),
      });
      return null;
    }
  }

  return {
    orgId: row.orgId,
    role: row.role,
    userId: row.userId,
    method: 'session',
    actor: `user:${row.userId}`,
  };
}

function isStateChanging(request: Request): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase());
}

/**
 * Verify the Origin header against the configured allow-list.
 *
 * Defence in depth behind SameSite and CSRF tokens. Each of the three has a known
 * bypass in some browser or configuration; all three together do not.
 */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true; // Same-origin form posts may omit it.

  const env = getEnv();
  const permitted = [env.APP_URL, ...env.ALLOWED_ORIGINS.split(',')]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return permitted.includes(origin);
}

export type GuardResult =
  | { readonly ok: true; readonly auth: AuthContext; readonly headers: Record<string, string> }
  | { readonly ok: false; readonly response: Response };

/**
 * The standard route guard: authenticate, rate limit, then check permission.
 *
 * Ordering matters. Rate limiting comes after authentication so that limits are
 * per-tenant rather than per-address, and before the permission check so that a
 * caller cannot probe for permissions at an unlimited rate.
 */
export async function guard(request: Request, permission: Permission): Promise<GuardResult> {
  const auth = await authenticate(request);
  if (auth === null) return { ok: false, response: unauthorised('Invalid or missing credentials') };

  const limit = checkRateLimit(rateLimitKey(auth), { limit: getEnv().RATE_LIMIT_PER_MINUTE });
  if (!limit.allowed) {
    return { ok: false, response: tooManyRequests(limit.retryAfterSeconds) };
  }

  if (!can(auth.role, permission)) {
    logger.warn('Permission denied', { actor: auth.actor, role: auth.role, permission });
    return { ok: false, response: forbidden(`This action requires the ${permission} permission`) };
  }

  return { ok: true, auth, headers: rateLimitHeaders(limit) };
}
