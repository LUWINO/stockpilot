/**
 * Presentational building blocks for the console.
 *
 * Hand-written rather than pulled from a component library. For a system sold to
 * run inside other companies' infrastructure, a handful of small components is
 * worth more than a dependency tree: nothing to audit, nothing to patch, and no
 * design-system upgrade that reshapes every screen.
 *
 * All server components — none of this needs to be interactive.
 */

import type { ReactNode } from 'react';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

const SEVERITY_COLOUR: Record<Severity, string> = {
  critical: 'var(--color-critical)',
  high: 'var(--color-high)',
  medium: 'var(--color-medium)',
  low: 'var(--color-low)',
  info: 'var(--color-info)',
};

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 ${className}`}
    >
      {children}
    </div>
  );
}

export function PageHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-7">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 max-w-2xl text-sm text-[var(--color-ink-muted)]">{description}</p>
    </div>
  );
}

/**
 * A single headline number.
 *
 * `hint` carries the interpretation. A number on a dashboard without a unit or a
 * comparison is decoration; the hint is what makes it information.
 */
export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <div className="text-xs font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
        {label}
      </div>
      <div className="numeric mt-2 text-3xl font-semibold">{value}</div>
      {hint !== undefined && <div className="mt-1 text-xs text-[var(--color-ink-muted)]">{hint}</div>}
    </Card>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const colour = SEVERITY_COLOUR[severity] ?? SEVERITY_COLOUR.info;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
      style={{ color: colour, borderColor: colour }}
    >
      {/* The dot is decorative; the text alone carries the meaning, so this is
          legible without colour vision too. */}
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: colour }} />
      {severity}
    </span>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  executed: 'Acted automatically',
  proposed: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  blocked: 'Blocked by policy',
  expired: 'Expired',
};

export function StateBadge({ state }: { state: string }) {
  return (
    <span className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-ink-muted)]">
      {OUTCOME_LABEL[state] ?? state}
    </span>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <Card className="text-center">
      <p className="font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-[var(--color-ink-muted)]">{description}</p>
    </Card>
  );
}

/**
 * Shown when the database is unreachable.
 *
 * Deliberately explicit about the likely cause and the fix. A console that says
 * only "something went wrong" turns a two-minute configuration problem into a
 * support ticket.
 */
export function NotConnected({ detail }: { detail?: string }) {
  return (
    <Card>
      <p className="font-medium">No database connection</p>
      <p className="mt-2 max-w-2xl text-sm text-[var(--color-ink-muted)]">
        StockPilot could not reach Postgres. Check that <code className="numeric">DATABASE_URL</code> is set
        and that migrations have been applied with <code className="numeric">npm run db:migrate</code>. The{' '}
        <a className="underline" href="https://github.com/luwino/stockpilot#quick-start">
          quick start
        </a>{' '}
        walks through both.
      </p>
      {detail !== undefined && (
        <p className="mt-3 text-xs text-[var(--color-ink-muted)]">Reported: {detail}</p>
      )}
    </Card>
  );
}

/** Render integer minor units as a currency string. */
export function formatMoney(minorUnits: number, currency = 'GBP'): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(minorUnits / 100);
}

export function formatRelative(date: Date | null): string {
  if (date === null) return 'never';

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [3600, 'minute'],
    [86_400, 'hour'],
    [2_592_000, 'day'],
  ];

  const formatter = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  let previous = 1;

  for (const [limit, unit] of units) {
    if (seconds < limit) return formatter.format(-Math.round(seconds / previous), unit);
    previous = limit;
  }

  return formatter.format(-Math.round(seconds / 2_592_000), 'month');
}
