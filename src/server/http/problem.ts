/**
 * HTTP error responses, in RFC 9457 `application/problem+json`.
 *
 * A single, machine-readable error shape across the whole API means an integrator
 * writes one error handler instead of one per endpoint. Every problem carries a
 * stable `type` URI, so clients can branch on the URI rather than string-matching
 * a message that is free to change.
 *
 * The other job here is not leaking. `internal()` deliberately discards the
 * underlying error's message and returns only a correlation id: stack traces and
 * driver messages routinely contain table names, query fragments and connection
 * strings, and none of that belongs in a response body.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../logger.ts';

export const PROBLEM_BASE = 'https://stockpilot.dev/problems';

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  /** Correlation id, echoed in the logs so support can find the same event. */
  readonly instance?: string;
  /** Field-level validation failures, when the status is 422. */
  readonly errors?: Readonly<Record<string, readonly string[]>>;
}

function problemResponse(problem: Problem, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: {
      'content-type': 'application/problem+json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export const badRequest = (detail: string): Response =>
  problemResponse({
    type: `${PROBLEM_BASE}/bad-request`,
    title: 'Malformed request',
    status: 400,
    detail,
  });

export const unauthorised = (detail = 'Authentication is required'): Response =>
  problemResponse(
    {
      type: `${PROBLEM_BASE}/unauthorised`,
      title: 'Not authenticated',
      status: 401,
      detail,
    },
    // Naming the scheme lets a client know what to present, without hinting at
    // whether the credential it tried exists.
    { 'www-authenticate': 'Bearer realm="stockpilot"' },
  );

export const forbidden = (detail = 'You do not have permission to perform this action'): Response =>
  problemResponse({
    type: `${PROBLEM_BASE}/forbidden`,
    title: 'Insufficient permission',
    status: 403,
    detail,
  });

export const notFound = (resource = 'Resource'): Response =>
  problemResponse({
    type: `${PROBLEM_BASE}/not-found`,
    title: 'Not found',
    status: 404,
    detail: `${resource} does not exist, or you do not have access to it`,
  });

export const conflict = (detail: string): Response =>
  problemResponse({
    type: `${PROBLEM_BASE}/conflict`,
    title: 'Conflicting request',
    status: 409,
    detail,
  });

/** 422 with field-level detail, for a request that parses but is not valid. */
export const unprocessable = (
  detail: string,
  errors?: Record<string, string[]>,
): Response =>
  problemResponse({
    type: `${PROBLEM_BASE}/validation-failed`,
    title: 'Validation failed',
    status: 422,
    detail,
    ...(errors === undefined ? {} : { errors }),
  });

export const tooManyRequests = (retryAfterSeconds: number): Response =>
  problemResponse(
    {
      type: `${PROBLEM_BASE}/rate-limited`,
      title: 'Too many requests',
      status: 429,
      detail: `Rate limit exceeded. Retry in ${retryAfterSeconds} seconds.`,
    },
    { 'retry-after': String(retryAfterSeconds) },
  );

/**
 * 500 with no detail whatsoever.
 *
 * The real error goes to the log against a correlation id; the client gets the id
 * and nothing else. Support can join the two, an attacker cannot.
 */
export function internal(error: unknown, context: Record<string, unknown> = {}): Response {
  const instance = randomUUID();

  logger.error('Unhandled error serving request', {
    instance,
    error: error instanceof Error ? error : new Error(String(error)),
    ...context,
  });

  return problemResponse({
    type: `${PROBLEM_BASE}/internal`,
    title: 'Internal server error',
    status: 500,
    detail: 'The request could not be completed. Quote the instance id when contacting support.',
    instance,
  });
}

/** Success helper, so no route hand-rolls its cache headers. */
export function ok<T>(body: T, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Inventory data is per-tenant and changes constantly; nothing should cache it.
      'cache-control': 'no-store',
      ...headers,
    },
  });
}
