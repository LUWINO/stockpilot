/**
 * Database client.
 *
 * Two things matter here beyond opening a connection:
 *
 *  1. **The pool is a module singleton.** Next.js re-evaluates modules on every
 *     hot reload in development, and a fresh pool per reload exhausts Postgres'
 *     connection limit within a few minutes. Stashing it on `globalThis` survives
 *     the reload.
 *  2. **Tenant context is set inside a transaction.** `withOrg` opens a
 *     transaction, sets the `stockpilot.org_id` GUC transaction-locally, and runs
 *     the caller's work inside it. Row-level security does the rest. Because the
 *     setting is transaction-scoped, a pooled connection handed to the next
 *     request cannot carry the previous tenant's identity with it.
 */

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { getEnv } from '../env.ts';
import * as schema from './schema.ts';

export type Database = PostgresJsDatabase<typeof schema>;

interface GlobalWithPool {
  __stockpilotPool?: postgres.Sql;
  __stockpilotDb?: Database;
}

const globalRef = globalThis as unknown as GlobalWithPool;

function createPool(): postgres.Sql {
  const env = getEnv();

  return postgres(env.DATABASE_URL, {
    // Keep the pool small: the agent and the web app both connect, and Postgres
    // handles a modest number of busy connections far better than a large number
    // of idle ones.
    max: env.NODE_ENV === 'production' ? 10 : 4,
    idle_timeout: 30,
    connect_timeout: 10,
    // Statement-level cap. A runaway query should fail rather than pin a worker.
    connection: { statement_timeout: 30_000 },
    // Never log query parameters: they contain stock data and, on the users
    // table, password hashes.
    debug: false,
    onnotice: () => {},
  });
}

export function getPool(): postgres.Sql {
  if (globalRef.__stockpilotPool === undefined) {
    globalRef.__stockpilotPool = createPool();
  }
  return globalRef.__stockpilotPool;
}

export function getDb(): Database {
  if (globalRef.__stockpilotDb === undefined) {
    globalRef.__stockpilotDb = drizzle(getPool(), { schema });
  }
  return globalRef.__stockpilotDb;
}

/**
 * Run work scoped to one organisation.
 *
 * Every query issued inside the callback is filtered by row-level security. This
 * is the only sanctioned way to read or write tenant data — repositories take the
 * transaction handle rather than the raw database so that calling one outside a
 * tenant scope is a type error rather than a data leak.
 */
export async function withOrg<T>(
  orgId: string,
  work: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  if (!isUuid(orgId)) {
    throw new TypeError(`Refusing to scope a transaction to a malformed organisation id`);
  }

  return getDb().transaction(async (tx) => {
    // `true` scopes the setting to this transaction only.
    await tx.execute(sql`select set_config('stockpilot.org_id', ${orgId}, true)`);
    return work(tx);
  });
}

/**
 * Run work with no tenant scope.
 *
 * Reserved for genuinely cross-tenant operations: authentication (which must find
 * a user before it knows their org), migrations, and the agent's scheduler loop.
 * Every call site should be obvious and rare.
 */
export async function withoutOrgScope<T>(work: (db: Database) => Promise<T>): Promise<T> {
  return work(getDb());
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Take a Postgres advisory lock for the duration of a callback.
 *
 * Used by the agent so that two replicas cannot evaluate the same organisation
 * concurrently and raise the same purchase order twice. `pg_try_advisory_xact_lock`
 * returns immediately rather than queueing — a second replica should skip the
 * cycle, not run it late.
 */
export async function withAdvisoryLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T | null> {
  return getDb().transaction(async (tx) => {
    const lockId = hashToInt64(key);
    const rows = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${lockId}) as locked`,
    );
    const acquired = rows.at(0)?.locked === true;
    if (!acquired) return null;
    return work();
  });
}

/** Fold a string into a signed 64-bit integer for use as an advisory lock key. */
function hashToInt64(value: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash ^ BigInt(value.charCodeAt(i))) * prime) & mask;
  }

  // Postgres advisory keys are signed; fold the top bit into range.
  return hash >= 0x8000000000000000n ? hash - 0x10000000000000000n : hash;
}

/** Close the pool. For graceful shutdown and test teardown. */
export async function closePool(): Promise<void> {
  if (globalRef.__stockpilotPool !== undefined) {
    await globalRef.__stockpilotPool.end({ timeout: 5 });
    globalRef.__stockpilotPool = undefined;
    globalRef.__stockpilotDb = undefined;
  }
}
