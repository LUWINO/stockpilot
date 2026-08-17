/**
 * Structured logging.
 *
 * Emits one JSON object per line so that any log platform can parse it without a
 * custom grok pattern. Deliberately dependency-free — a logger is a small amount
 * of code and a large amount of trust, since everything in the process passes
 * through it.
 *
 * The redaction pass is the important part: inventory systems handle supplier
 * pricing, API keys and password hashes, and the usual way those reach a log
 * aggregator is a well-meaning `logger.info('request', body)`.
 */

import { getEnv } from './env.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Keys whose values are replaced with `[redacted]`, matched case-insensitively
 * anywhere in the key. Broad on purpose: a false positive costs a debugging
 * detail, a false negative puts a credential in a third-party system for ever.
 */
const SENSITIVE_KEY = /pass|secret|token|key|auth|cookie|session|credential|signature|hash/i;

/** Maximum depth to walk when redacting, so a cyclic object cannot hang the process. */
const MAX_DEPTH = 6;

export type LogContext = Record<string, unknown>;

function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value === null || value === undefined) return value;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      // Stacks contain file paths but not secrets, and they are what makes an
      // error log actionable.
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redact(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(nested, depth + 1);
    }
    return out;
  }

  if (typeof value === 'string' && value.length > 2000) {
    return `${value.slice(0, 2000)}…[truncated]`;
  }

  return value;
}

function write(level: LogLevel, message: string, context: LogContext): void {
  const configured = safeLogLevel();
  if (LEVEL_RANK[level] < LEVEL_RANK[configured]) return;

  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...(redact(context) as LogContext),
  };

  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Read the configured level without letting a bad environment break logging.
 *
 * The logger is often the only way to find out *why* configuration failed, so it
 * must keep working when configuration is broken.
 */
function safeLogLevel(): LogLevel {
  try {
    return getEnv().LOG_LEVEL;
  } catch {
    return 'info';
  }
}

export const logger = {
  debug: (message: string, context: LogContext = {}) => write('debug', message, context),
  info: (message: string, context: LogContext = {}) => write('info', message, context),
  warn: (message: string, context: LogContext = {}) => write('warn', message, context),
  error: (message: string, context: LogContext = {}) => write('error', message, context),

  /** Derive a logger that stamps fixed fields onto every entry. */
  child(bound: LogContext) {
    return {
      debug: (message: string, context: LogContext = {}) => write('debug', message, { ...bound, ...context }),
      info: (message: string, context: LogContext = {}) => write('info', message, { ...bound, ...context }),
      warn: (message: string, context: LogContext = {}) => write('warn', message, { ...bound, ...context }),
      error: (message: string, context: LogContext = {}) => write('error', message, { ...bound, ...context }),
    };
  },
};

/** Exposed for tests. */
export const __redactForTest = redact;
