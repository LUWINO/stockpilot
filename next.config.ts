import type { NextConfig } from 'next';

/**
 * Content-Security-Policy.
 *
 * Next.js injects inline bootstrap scripts, so `'unsafe-inline'` would normally be
 * required for scripts. We avoid that by relying on Next's built-in nonce support
 * (see `src/middleware.ts`), which rewrites the CSP per request. The policy below is
 * the static fallback applied to assets that bypass middleware.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=()',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle so the runtime image needs no node_modules.
  output: 'standalone',

  reactStrictMode: true,

  // Never leak framework version fingerprints.
  poweredByHeader: false,

  typedRoutes: true,

  experimental: {
    // Restrict Server Action invocations to known origins (CSRF hardening).
    serverActions: {
      bodySizeLimit: '1mb',
    },
  },

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
