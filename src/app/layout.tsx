import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'StockPilot',
    template: '%s · StockPilot',
  },
  description:
    'Autonomous inventory management: an event-sourced stock ledger, statistical demand forecasting, and a policy-gated decision engine.',
  // The console shows tenant data and must never be indexed, even if a
  // deployment is accidentally exposed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
};

const NAVIGATION = [
  { href: '/', label: 'Overview' },
  { href: '/decisions', label: 'Decisions' },
  { href: '/inventory', label: 'Inventory' },
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="min-h-screen">
        {/* A keyboard user should not have to tab through the whole nav to reach
            the content on every page. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-[var(--color-surface)] focus:px-3 focus:py-2 focus:shadow"
        >
          Skip to content
        </a>

        <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-5">
          <header className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-[var(--color-border)] py-5">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              Stock<span className="text-[var(--color-brand)]">Pilot</span>
            </Link>

            <nav aria-label="Primary" className="flex gap-5 text-sm">
              {NAVIGATION.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </header>

          <main id="main" className="flex-1 py-8">
            {children}
          </main>

          <footer className="border-t border-[var(--color-border)] py-6 text-xs text-[var(--color-ink-muted)]">
            StockPilot — every autonomous action is logged, attributable and reversible.
          </footer>
        </div>
      </body>
    </html>
  );
}
