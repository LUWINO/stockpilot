/**
 * Edge proxy: per-request Content-Security-Policy.
 *
 * A CSP is only worth having if it forbids inline script. Next.js injects inline
 * bootstrap and hydration scripts, so the usual workaround is `'unsafe-inline'` —
 * which disables the single most valuable protection the header offers.
 *
 * Instead a fresh nonce is minted per request, passed to the framework through the
 * `x-nonce` header (which Next reads and stamps onto every script tag it emits),
 * and named in the policy. Inline script therefore runs only if it carries a value
 * an attacker cannot predict.
 */

import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest): NextResponse {
  const nonce = generateNonce();

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // Tailwind emits a style element; styles carry far less risk than script.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    // No plugins, no embedded objects, no framing of any kind.
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    // Constrain where a compromised page could post data or navigate the top frame.
    `form-action 'self'`,
    `base-uri 'none'`,
    `upgrade-insecure-requests`,
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);

  return response;
}

/**
 * A 128-bit random nonce.
 *
 * `crypto.getRandomValues` rather than `Math.random`: the whole guarantee rests on
 * an attacker being unable to predict this value.
 */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export const config = {
  /**
   * Skip static assets. They are served straight from the CDN or the filesystem,
   * carry no user data, and minting a nonce for each one is pure overhead.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
