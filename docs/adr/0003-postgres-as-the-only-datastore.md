# ADR-0003: PostgreSQL as the only datastore

**Status:** Accepted · **Date:** 2026-08-17

## Context

A system like this conventionally acquires Redis for caching, locking and rate
limiting, and a queue broker for background work. Both are reasonable choices in
a platform team that already runs them.

The deciding constraint here is different: **StockPilot is sold to run inside
other companies' infrastructure.** Every additional service is something the
customer must provision, secure, monitor, back up, upgrade and pay for — and it
is a reason for a deal to stall while their platform team schedules the work.

## Decision

PostgreSQL is the only required service. Nothing else is mandatory.

| Need | Postgres feature used |
|---|---|
| Single execution across agent replicas | `pg_try_advisory_xact_lock` |
| Tenant isolation | Row-level security with `FORCE` |
| Immutable audit trail | Triggers refusing `UPDATE`/`DELETE` |
| Exact money | `integer` minor units |
| Fast decision inbox | Partial index on `state = 'proposed'` |
| Idempotency | Unique index + `ON CONFLICT DO NOTHING` |
| Background work | A separate process on a timer, not a queue |

`pg_try_advisory_xact_lock` is the load-bearing choice for the agent: it returns
immediately rather than queueing, so a second replica *skips* the cycle instead
of running it late — which is the correct behaviour for periodic work.

## Alternatives considered

**Redis for locking and rate limiting.** Better distributed rate limiting, and
that is a genuine loss (see below). But it adds a service whose failure mode —
being unavailable while Postgres is fine — needs its own handling.

**A queue broker for the agent.** The agent is periodic, not event-driven. A
timer plus a lock expresses that directly; a broker would add delivery semantics
nobody needs.

**SQLite.** Attractive for single-tenant installs, but no row-level security and
poor concurrent-write behaviour.

## Consequences

**Good.** One service to run. One backup. One connection string. One set of
credentials. Deployment fits on a page, and a customer's platform team can say
yes without scheduling work.

**Bad, and honestly so.** Rate limiting is per-instance and in-memory: across *n*
replicas the effective limit is *n* × the configured value. It is a fairness
guard against a runaway retry loop, not DDoS protection. `RateLimitStore` is an
interface precisely so a shared backend can replace it without touching call
sites.

Postgres also becomes the single point of failure. That is acceptable: it already
holds the data, so its availability bounds the system's regardless.

**Revisit when** a deployment runs enough replicas that per-instance rate limits
stop being meaningful, or when agent throughput needs work sharded across
machines rather than serialised per organisation.
