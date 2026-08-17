/**
 * The autonomous agent process.
 *
 * Runs as a separate process from the web application. That separation is
 * deliberate: a long planning sweep must never compete with user requests for the
 * event loop, and the agent needs to keep running when the web tier is being
 * redeployed.
 *
 * Deploy it as a long-running container (it sleeps between cycles), or set
 * `RUN_ONCE=true` and drive it from cron or a Kubernetes CronJob. Both are
 * supported because both are how real operations teams work.
 *
 * Run with: `npm run agent`
 */

import { getEnv } from '../server/env.ts';
import { closePool, withoutOrgScope } from '../server/db/client.ts';
import { organisations } from '../server/db/schema.ts';
import { runCycle } from '../server/services/agent-service.ts';
import { logger } from '../server/logger.ts';

const log = logger.child({ component: 'worker' });

/** Set by the signal handlers so an in-flight cycle can finish cleanly. */
let shuttingDown = false;

async function runAllOrganisations(): Promise<void> {
  // Listing organisations is inherently cross-tenant, so it runs outside the
  // tenant scope. Everything after this point is scoped to a single org.
  const orgs = await withoutOrgScope(async (db) =>
    db.select({ id: organisations.id, name: organisations.name }).from(organisations),
  );

  log.info('Starting agent sweep', { organisations: orgs.length });

  for (const org of orgs) {
    if (shuttingDown) {
      log.warn('Shutdown requested, stopping sweep early', { remaining: org.id });
      return;
    }

    try {
      const summary = await runCycle(org.id);

      if (summary.skipped) {
        log.info('Skipped: another replica holds the lock', { orgId: org.id });
      } else {
        log.info('Cycle finished', { orgId: org.id, org: org.name, ...summary });
      }
    } catch (error) {
      // One tenant's bad data must never stop the sweep for everyone else.
      log.error('Cycle failed', { orgId: org.id, org: org.name, error });
    }
  }
}

async function main(): Promise<void> {
  const env = getEnv();

  if (!env.AGENT_ENABLED) {
    log.warn('Agent is disabled by configuration; exiting without doing anything');
    return;
  }

  const runOnce = process.env.RUN_ONCE === 'true';
  const intervalMs = env.AGENT_INTERVAL_MINUTES * 60_000;

  log.info('Agent starting', {
    mode: runOnce ? 'single-shot' : 'continuous',
    intervalMinutes: env.AGENT_INTERVAL_MINUTES,
  });

  if (runOnce) {
    await runAllOrganisations();
    return;
  }

  while (!shuttingDown) {
    const startedAt = Date.now();
    await runAllOrganisations();

    // Sleep for the remainder of the interval, so a slow sweep does not push the
    // schedule later and later. If a sweep overruns, the next starts immediately.
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(0, intervalMs - elapsed);

    if (remaining > 0 && !shuttingDown) {
      await sleep(remaining);
    } else if (remaining === 0) {
      log.warn('Sweep took longer than the configured interval', { elapsedMs: elapsed, intervalMs });
    }
  }
}

/** Interruptible sleep, so a shutdown signal is not stuck behind a long wait. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onSignal = (): void => {
      clearTimeout(timer);
      resolve();
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  });
}

/**
 * Shut down gracefully.
 *
 * The agent commits money, so being killed mid-transaction matters. Setting the
 * flag lets the current cycle's transaction commit or roll back cleanly instead of
 * having the connection torn out from under it.
 */
function installSignalHandlers(): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) {
        log.warn('Second signal received, exiting immediately', { signal });
        process.exit(1);
      }
      log.info('Shutdown signal received, finishing the current cycle', { signal });
      shuttingDown = true;
    });
  }
}

installSignalHandlers();

main()
  .then(async () => {
    await closePool();
    log.info('Agent stopped cleanly');
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.error('Agent terminated with an unrecoverable error', { error });
    await closePool().catch(() => undefined);
    process.exit(1);
  });
