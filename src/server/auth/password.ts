/**
 * Password hashing.
 *
 * Uses scrypt from Node's built-in `crypto`. The choice is deliberate:
 *
 *  - scrypt is memory-hard, so it resists the GPU and ASIC attacks that make
 *    PBKDF2 and bcrypt-with-low-cost weak. It is recommended by OWASP and
 *    approved in NIST SP 800-63B.
 *  - It ships with Node. Argon2id is marginally stronger, but every Argon2
 *    binding is a native module — a compiler in the build image, a binary that
 *    can break on a Node upgrade, and one more package with publish access to
 *    your production runtime. For a system sold to run inside other companies'
 *    infrastructure, an implementation with no supply-chain surface is worth more
 *    than the marginal hardening.
 *
 * The hash format records its own parameters, so cost can be raised later and old
 * hashes still verify — and `needsRehash` tells the caller when to upgrade one.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * `promisify` resolves to the three-argument overload and loses the options
 * parameter, so the signature is restated here. Without the options the cost
 * parameters silently fall back to Node's defaults, which are far too weak.
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * scrypt cost parameters.
 *
 * N=2^16 with r=8 uses roughly 64 MiB per hash and takes on the order of 100 ms
 * on current server hardware — slow enough to make offline cracking expensive,
 * fast enough that a login does not feel broken. Raising N is the intended way to
 * keep pace with hardware.
 */
export const SCRYPT_PARAMS = {
  N: 65_536,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 32,
} as const;

/** Node caps scrypt memory by default; this must exceed 128 × N × r. */
const MAX_MEMORY = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2;

/**
 * Hash a password.
 *
 * Returns `scrypt$N$r$p$salt$hash`, all base64url. The parameters travel with the
 * hash so verification never has to guess what produced it.
 */
export async function hashPassword(password: string): Promise<string> {
  assertReasonableLength(password);

  const salt = randomBytes(SCRYPT_PARAMS.saltLength);
  const derived = (await scrypt(password.normalize('NFKC'), salt, SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: MAX_MEMORY,
  }));

  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Verify a password against a stored hash.
 *
 * Always returns a boolean, never throws on a malformed hash — a corrupt row
 * should fail the login, not crash the endpoint. The comparison is constant-time
 * so that response timing does not reveal how much of the hash matched.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parsed = parseHash(storedHash);
  if (parsed === null) return false;

  try {
    const derived = (await scrypt(password.normalize('NFKC'), parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: 128 * parsed.N * parsed.r * 2,
    }));

    if (derived.length !== parsed.hash.length) return false;
    return timingSafeEqual(derived, parsed.hash);
  } catch {
    return false;
  }
}

/** Whether a stored hash was produced with weaker parameters than current policy. */
export function needsRehash(storedHash: string): boolean {
  const parsed = parseHash(storedHash);
  if (parsed === null) return true;
  return parsed.N < SCRYPT_PARAMS.N || parsed.r < SCRYPT_PARAMS.r || parsed.p < SCRYPT_PARAMS.p;
}

interface ParsedHash {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltPart = parts[4];
  const hashPart = parts[5];

  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 1024 || r < 1 || p < 1) return null;
  if (saltPart === undefined || hashPart === undefined) return null;

  try {
    return {
      N,
      r,
      p,
      salt: Buffer.from(saltPart, 'base64url'),
      hash: Buffer.from(hashPart, 'base64url'),
    };
  } catch {
    return null;
  }
}

/**
 * Reject passwords that are absurdly long.
 *
 * Not a strength rule — length is good — but a denial-of-service guard: hashing is
 * intentionally expensive, so an unbounded input is an unbounded amount of CPU
 * per unauthenticated request.
 */
function assertReasonableLength(password: string): void {
  if (password.length < 12) {
    throw new RangeError('Password must be at least 12 characters');
  }
  if (password.length > 1024) {
    throw new RangeError('Password must be at most 1024 characters');
  }
}

/**
 * Add a delay so that a failed login takes about as long as a successful one.
 *
 * Without this, "no such user" returns in a millisecond while "wrong password"
 * takes the full hashing time, and the difference enumerates valid accounts.
 */
export async function equaliseFailureTiming(): Promise<void> {
  await hashPassword('timing-equalisation-placeholder-value');
}
