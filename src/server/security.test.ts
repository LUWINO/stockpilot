import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, SCRYPT_PARAMS, verifyPassword } from './auth/password.ts';
import {
  API_KEY_PREFIX,
  deriveCsrfToken,
  generateApiKey,
  generateToken,
  hashToken,
  looksLikeApiKey,
  safeEqual,
  sessionCookieOptions,
  verifyCsrfToken,
} from './auth/tokens.ts';
import { can, canAssignRole, ForbiddenError, permissionsFor, requirePermission } from './auth/rbac.ts';
import { checkRateLimit, MemoryRateLimitStore, rateLimitKey } from './http/rate-limit.ts';
import { __redactForTest } from './logger.ts';
import { resetEnvCache } from './env.ts';

// The token helpers derive from SESSION_SECRET, so the environment must be valid.
process.env.DATABASE_URL ??= 'postgres://localhost:5432/stockpilot_test';
process.env.SESSION_SECRET ??= 'test-secret-that-is-comfortably-long-enough-for-the-schema';
resetEnvCache();

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('incorrect horse battery staple', hash)).toBe(false);
  });

  it('produces a different hash every time, so identical passwords are not linkable', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');

    expect(first).not.toBe(second);
    expect(await verifyPassword('correct horse battery staple', second)).toBe(true);
  });

  it('records its parameters in the hash so cost can be raised later', async () => {
    const hash = await hashPassword('correct horse battery staple');
    const [scheme, n, r, p] = hash.split('$');

    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBe(SCRYPT_PARAMS.N);
    expect(Number(r)).toBe(SCRYPT_PARAMS.r);
    expect(Number(p)).toBe(SCRYPT_PARAMS.p);
  });

  it('normalises Unicode so the same password typed two ways still verifies', async () => {
    // U+00E9 versus e + U+0301: identical to a human, different bytes.
    const hash = await hashPassword('mot de passe café très long');
    expect(await verifyPassword('mot de passe café très long', hash)).toBe(true);
  });

  it('refuses a short password and an absurdly long one', async () => {
    await expect(hashPassword('short')).rejects.toThrow(RangeError);
    await expect(hashPassword('x'.repeat(2000))).rejects.toThrow(RangeError);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    for (const corrupt of ['', 'not-a-hash', 'scrypt$1$1$1$aaaa$bbbb', 'bcrypt$1$2$3$a$b', 'scrypt$x$8$1$a$b']) {
      expect(await verifyPassword('correct horse battery staple', corrupt)).toBe(false);
    }
  });

  it('flags weaker legacy hashes for upgrade', () => {
    expect(needsRehash('scrypt$16384$8$1$c2FsdA$aGFzaA')).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });

  it('does not flag a current hash', async () => {
    expect(needsRehash(await hashPassword('correct horse battery staple'))).toBe(false);
  });
});

describe('tokens', () => {
  it('generates high-entropy, unique tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(42);
  });

  it('hashes deterministically and irreversibly', () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
  });

  it('mints API keys with an identifiable prefix and stores only the digest', () => {
    const generated = generateApiKey();

    expect(generated.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(generated.prefix.length).toBeLessThan(generated.key.length);
    expect(generated.keyHash).toBe(hashToken(generated.key));
    expect(generated.keyHash).not.toContain(generated.key);
  });

  it('recognises well-formed keys and rejects malformed ones', () => {
    expect(looksLikeApiKey(generateApiKey().key)).toBe(true);
    expect(looksLikeApiKey('sk_live_short')).toBe(false);
    expect(looksLikeApiKey('bearer abc')).toBe(false);
    expect(looksLikeApiKey('')).toBe(false);
  });

  it('binds a CSRF token to its session', () => {
    const session = generateToken();
    const other = generateToken();

    expect(verifyCsrfToken(session, deriveCsrfToken(session))).toBe(true);
    expect(verifyCsrfToken(session, deriveCsrfToken(other))).toBe(false);
    expect(verifyCsrfToken(session, '')).toBe(false);
  });

  it('compares in constant time without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('sets cookies that a subdomain cannot forge', () => {
    const options = sessionCookieOptions();

    expect(options.httpOnly).toBe(true);
    expect(options.secure).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
  });
});

describe('RBAC', () => {
  it('gives a viewer read access and nothing else', () => {
    expect(can('viewer', 'inventory:read')).toBe(true);
    expect(can('viewer', 'inventory:move')).toBe(false);
    expect(can('viewer', 'decision:approve')).toBe(false);
  });

  it('lets an operator move stock but not adjust it', () => {
    expect(can('operator', 'inventory:move')).toBe(true);
    expect(can('operator', 'inventory:adjust')).toBe(false);
  });

  it('lets a planner approve decisions but not change the agent’s limits', () => {
    expect(can('planner', 'decision:approve')).toBe(true);
    expect(can('planner', 'agent:configure')).toBe(false);
  });

  it('reserves organisation management for the owner', () => {
    expect(can('admin', 'org:manage')).toBe(false);
    expect(can('owner', 'org:manage')).toBe(true);
  });

  it('grants every role strictly more than the one below it', () => {
    const ladder = ['viewer', 'operator', 'planner', 'admin', 'owner'] as const;

    for (let i = 1; i < ladder.length; i += 1) {
      const lower = new Set(permissionsFor(ladder[i - 1]!));
      const higher = new Set(permissionsFor(ladder[i]!));

      for (const permission of lower) expect(higher.has(permission)).toBe(true);
      expect(higher.size).toBeGreaterThan(lower.size);
    }
  });

  it('throws a typed error when a permission is missing', () => {
    expect(() => requirePermission('viewer', 'inventory:adjust')).toThrow(ForbiddenError);
    expect(() => requirePermission('owner', 'inventory:adjust')).not.toThrow();
  });

  it('stops anyone granting a role at or above their own', () => {
    expect(canAssignRole('admin', 'admin_1', 'user_2', 'planner')).toBe(true);
    expect(canAssignRole('admin', 'admin_1', 'user_2', 'admin')).toBe(false);
    expect(canAssignRole('admin', 'admin_1', 'user_2', 'owner')).toBe(false);
  });

  it('stops anyone changing their own role', () => {
    expect(canAssignRole('owner', 'owner_1', 'owner_1', 'admin')).toBe(false);
  });

  it('refuses role changes from anyone without user management', () => {
    expect(canAssignRole('planner', 'planner_1', 'user_2', 'viewer')).toBe(false);
  });
});

describe('rate limiting', () => {
  let store: MemoryRateLimitStore;

  beforeEach(() => {
    store = new MemoryRateLimitStore();
  });

  it('allows requests up to the limit and refuses the next', () => {
    const now = 1_000_000;

    for (let i = 0; i < 5; i += 1) {
      expect(checkRateLimit('k', { limit: 5, store, now }).allowed).toBe(true);
    }

    const refused = checkRateLimit('k', { limit: 5, store, now });
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts down the remaining budget', () => {
    const now = 1_000_000;
    expect(checkRateLimit('k', { limit: 3, store, now }).remaining).toBe(2);
    expect(checkRateLimit('k', { limit: 3, store, now }).remaining).toBe(1);
    expect(checkRateLimit('k', { limit: 3, store, now }).remaining).toBe(0);
  });

  it('slides, rather than resetting on a fixed boundary', () => {
    const start = 1_000_000;
    for (let i = 0; i < 3; i += 1) checkRateLimit('k', { limit: 3, store, now: start });

    expect(checkRateLimit('k', { limit: 3, store, now: start + 59_000 }).allowed).toBe(false);
    expect(checkRateLimit('k', { limit: 3, store, now: start + 61_000 }).allowed).toBe(true);
  });

  it('keeps buckets separate per key', () => {
    const now = 1_000_000;
    checkRateLimit('a', { limit: 1, store, now });

    expect(checkRateLimit('a', { limit: 1, store, now }).allowed).toBe(false);
    expect(checkRateLimit('b', { limit: 1, store, now }).allowed).toBe(true);
  });

  it('prefers the API key, then the user, then the address for bucketing', () => {
    expect(rateLimitKey({ apiKeyId: 'k1', userId: 'u1', ip: '1.2.3.4' })).toBe('key:k1');
    expect(rateLimitKey({ userId: 'u1', ip: '1.2.3.4' })).toBe('user:u1');
    expect(rateLimitKey({ ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
    expect(rateLimitKey({})).toBe('ip:unknown');
  });
});

describe('log redaction', () => {
  it('redacts anything that looks like a credential', () => {
    const redacted = __redactForTest({
      email: 'user@example.com',
      password: 'hunter2',
      passwordHash: 'scrypt$...',
      apiKey: 'sk_live_abc',
      sessionToken: 'abc',
      authorization: 'Bearer abc',
      quantity: 42,
    }) as Record<string, unknown>;

    expect(redacted.email).toBe('user@example.com');
    expect(redacted.quantity).toBe(42);
    for (const key of ['password', 'passwordHash', 'apiKey', 'sessionToken', 'authorization']) {
      expect(redacted[key]).toBe('[redacted]');
    }
  });

  it('redacts through nested structures', () => {
    const redacted = __redactForTest({
      request: { headers: { cookie: 'session=abc' }, body: { sku: 'FLOUR' } },
    }) as { request: { headers: { cookie: string }; body: { sku: string } } };

    expect(redacted.request.headers.cookie).toBe('[redacted]');
    expect(redacted.request.body.sku).toBe('FLOUR');
  });

  it('preserves errors in a readable shape', () => {
    const redacted = __redactForTest(new Error('boom')) as { name: string; message: string };
    expect(redacted.name).toBe('Error');
    expect(redacted.message).toBe('boom');
  });

  it('truncates rather than hanging on deep or huge values', () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };

    expect(JSON.stringify(__redactForTest(deep))).toContain('[truncated]');
    expect(__redactForTest('x'.repeat(5000))).toContain('[truncated]');
  });

  it('caps long arrays', () => {
    const redacted = __redactForTest(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
    expect(redacted).toHaveLength(100);
  });
});
