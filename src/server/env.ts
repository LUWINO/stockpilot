/**
 * Environment configuration.
 *
 * Every setting is validated once, at startup, against a schema. A process that
 * boots with a missing secret and only discovers it when the first request
 * arrives is a process that fails in production at the worst possible moment, so
 * this module fails loudly and immediately instead.
 *
 * No default is ever supplied for a secret. Defaults for credentials are how
 * development keys reach production.
 */

import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Postgres connection string. Must use TLS outside development. */
  DATABASE_URL: z.string().url(),

  /**
   * 32+ byte secret used to derive session and CSRF tokens.
   * Generate with `openssl rand -base64 48`.
   */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

  /** Absolute base URL of the deployment, used for cookie and CORS scoping. */
  APP_URL: z.string().url().default('http://localhost:3000'),

  /** Comma-separated origins permitted to call the API from a browser. */
  ALLOWED_ORIGINS: z.string().default(''),

  /** How often the autonomous agent runs, in minutes. */
  AGENT_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),

  /** Set false to run the agent in observe-only mode across the whole install. */
  AGENT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /** Requests per minute per API key before throttling. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(600),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Parse and cache the environment.
 *
 * Errors list every problem at once rather than only the first, so a misconfigured
 * deployment can be fixed in one pass instead of one restart per missing variable.
 */
export function getEnv(): Env {
  if (cached !== null) return cached;

  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  if (parsed.data.NODE_ENV === 'production') {
    assertProductionSafety(parsed.data);
  }

  cached = parsed.data;
  return cached;
}

/**
 * Extra checks that only make sense in production.
 *
 * These are the settings that are harmless locally and dangerous in production —
 * exactly the class of mistake that survives code review because it looks fine on
 * a developer's machine.
 */
function assertProductionSafety(env: Env): void {
  const problems: string[] = [];

  if (env.DATABASE_URL.startsWith('postgres://') && !env.DATABASE_URL.includes('sslmode=')) {
    problems.push('DATABASE_URL must specify sslmode in production (e.g. ?sslmode=require)');
  }

  if (!env.APP_URL.startsWith('https://')) {
    problems.push('APP_URL must use HTTPS in production; cookies are set Secure and will not be sent otherwise');
  }

  if (/^(changeme|secret|password|test)/i.test(env.SESSION_SECRET)) {
    problems.push('SESSION_SECRET looks like a placeholder value');
  }

  if (problems.length > 0) {
    throw new Error(`Unsafe production configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

/** Origins allowed to make browser calls, always including the app's own origin. */
export function allowedOrigins(env: Env = getEnv()): string[] {
  const extra = env.ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return [...new Set([env.APP_URL, ...extra])];
}

/** Reset the cache. Test-only. */
export function resetEnvCache(): void {
  cached = null;
}
