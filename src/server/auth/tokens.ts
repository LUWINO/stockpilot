/**
 * Session tokens, API keys and CSRF tokens.
 *
 * One rule governs all three: **the database never stores a usable credential.**
 * It stores a SHA-256 digest. A dump of the users or api_keys table therefore
 * yields nothing an attacker can present back to the system.
 *
 * SHA-256 rather than scrypt here, deliberately: these tokens are 256 bits of
 * cryptographic randomness, not human-chosen secrets, so there is no dictionary to
 * attack and no reason to pay a slow hash on every request. The slow hash is for
 * passwords, where the input has low entropy.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../env.ts';

/** Bytes of entropy in a generated token. 32 bytes is 256 bits. */
const TOKEN_BYTES = 32;

/** How long a browser session stays valid without re-authentication. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Prefix on every API key, so a leaked key is greppable in logs and repos. */
export const API_KEY_PREFIX = 'sk_live_';

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** One-way digest of a token, for storage and lookup. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export interface GeneratedApiKey {
  /** The full key. Shown to the user exactly once and never persisted. */
  readonly key: string;
  /** Non-secret leading fragment, safe to display so a key can be identified. */
  readonly prefix: string;
  /** What actually goes in the database. */
  readonly keyHash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(TOKEN_BYTES).toString('base64url');
  const key = `${API_KEY_PREFIX}${secret}`;
  return {
    key,
    prefix: key.slice(0, API_KEY_PREFIX.length + 6),
    keyHash: hashToken(key),
  };
}

/** Cheap shape check, so a malformed key never reaches the database. */
export function looksLikeApiKey(candidate: string): boolean {
  return candidate.startsWith(API_KEY_PREFIX) && candidate.length >= API_KEY_PREFIX.length + 40;
}

/**
 * Derive a CSRF token bound to a session.
 *
 * The double-submit pattern: this value goes in a readable cookie *and* must be
 * echoed in a request header. A cross-origin attacker can cause the cookie to be
 * sent but cannot read it to set the header, so the two only match on a
 * same-origin request.
 *
 * It is an HMAC of the session token rather than an independent random value, so
 * it needs no storage of its own and is invalidated automatically when the
 * session ends.
 */
export function deriveCsrfToken(sessionToken: string): string {
  return createHmac('sha256', getEnv().SESSION_SECRET)
    .update(`csrf:${sessionToken}`)
    .digest('base64url');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which itself leaks length. Compare
  // digests instead so the buffers are always the same size.
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function verifyCsrfToken(sessionToken: string, presented: string): boolean {
  if (presented.length === 0) return false;
  return safeEqual(deriveCsrfToken(sessionToken), presented);
}

export const SESSION_COOKIE = '__Host-stockpilot_session';
export const CSRF_COOKIE = '__Host-stockpilot_csrf';
export const CSRF_HEADER = 'x-stockpilot-csrf';

/**
 * Cookie attributes for the session.
 *
 * The `__Host-` prefix is enforced by the browser: it requires Secure, requires
 * Path=/, and forbids Domain, which makes the cookie impossible to set from a
 * subdomain. `SameSite=Lax` blocks cross-site POSTs while still allowing a normal
 * top-level navigation into the console.
 */
export function sessionCookieOptions(maxAgeMs = SESSION_TTL_MS) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

/** The CSRF cookie must be readable by client script, so it is not httpOnly. */
export function csrfCookieOptions(maxAgeMs = SESSION_TTL_MS) {
  return {
    httpOnly: false,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}
