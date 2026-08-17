# Architecture

## The one rule

```
      app/  worker/          ← delivery: HTTP, UI, process lifecycle
         │
         ▼
      server/                ← I/O: database, auth, repositories, services
         │
         ▼
      core/                  ← pure domain: no I/O, no clock, no randomness
```

**Dependencies point inward, never outward.** `src/core` must not import from
`server`, `app` or `worker`. Everything else follows from this.

It is worth being precise about what the rule buys, because it costs something —
loading a `StockContext` is more code than querying inside the decision logic
would be:

1. **The decision engine is testable without a database.** All 288 tests run in
   about five seconds with no container, no fixture database and no cleanup.
2. **Decisions are reproducible.** The engine is a pure function of its inputs,
   and the inputs are persisted with the decision. A decision from eight months
   ago can be replayed today and will produce the same answer — which is the
   difference between an auditable system and one that merely logs a lot.
3. **The maths can be reviewed by someone who does not know the stack.** An
   inventory specialist can read `src/core/policy/safety-stock.ts` and check the
   formula without knowing what Drizzle is.

CI does not currently enforce the import direction mechanically; adding a lint
rule for it is tracked in [ADR-0004](adr/0004-pure-domain-core.md).

## Layers

### `src/core` — the domain

| Module | Responsibility |
|---|---|
| `money.ts` | Integer minor units with an explicit currency. Every operation exact; `multiply` names its rounding rule. |
| `stats.ts` | Sample variance, robust statistics (MAD), the inverse normal CDF, demand-shape measures. |
| `ledger.ts` | Movement semantics, position projection, FEFO allocation, expiry exposure. |
| `forecast/` | Six methods, rolling-origin backtesting, and automatic selection by demand pattern. |
| `policy/` | Safety stock, reorder points, EOQ, order constraints, ABC/XYZ segmentation. |
| `anomaly.ts` | Eight detectors, each returning quantified evidence and a monetary impact. |
| `agent/` | The decision engine, and the autonomy gate that constrains it. |

No module here imports anything outside `src/core`. There are no runtime
dependencies at all — not one npm package is imported by the domain.

### `src/server` — I/O

- `db/` — schema, connection pool, tenant-scoped transactions, advisory locks.
- `repositories/` — the only place that knows SQL. Translates rows to domain types.
- `services/` — orchestration; the agent cycle lives here.
- `auth/` — password hashing, tokens, RBAC.
- `http/` — request guards, RFC 9457 errors, rate limiting.
- `env.ts` — configuration, validated once at startup.
- `logger.ts` — structured JSON with credential redaction.

Repositories take a **transaction handle**, never the database itself. A
repository can therefore only be called from inside `withOrg()`, which means it
can only ever run with row-level security in force. Tenant isolation is a type
constraint, not a convention.

### `src/app` — delivery

Next.js App Router. Server components render the console; route handlers under
`/api/v1` serve the REST API. Both are thin: they authenticate, validate, call a
service, and format the result.

### `src/worker` — the agent

A standalone Node process, not a thread in the web server. Separated because a
sweep over a large catalogue must not compete with user requests for the event
loop, and because the agent must keep running while the web tier is redeployed.

Runs continuously (sleeping between cycles) or once (`RUN_ONCE=true`) under cron
or a Kubernetes CronJob.

## The autonomous cycle

```
┌─ withAdvisoryLock('agent:<org>') ──────────────────────────────────────────┐
│                                                                            │
│  ┌─ withOrg(orgId) ── transaction, RLS active ──────────────────────────┐  │
│  │                                                                      │  │
│  │  open agent_run                                                      │  │
│  │  load autonomy policy                                                │  │
│  │  load today's committed spend        ← daily budget spans runs       │  │
│  │  compute catalogue-wide ABC classes                                  │  │
│  │                                                                      │  │
│  │  for each SKU × site:                                                │  │
│  │      loadStockContext()              ← the only I/O in the cycle     │  │
│  │      evaluate()                      ← pure                          │  │
│  │      charge executed value against the running budget                │  │
│  │                                                                      │  │
│  │  proposeTransfers()                  ← needs the whole network       │  │
│  │  persistDecisions()                  ← ON CONFLICT DO NOTHING        │  │
│  │  close agent_run with counts                                         │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

Three properties make this safe to run unattended:

**Single execution.** `pg_try_advisory_xact_lock` returns immediately rather than
queueing, so a second replica *skips* the cycle instead of running it late. Two
replicas cannot evaluate the same organisation concurrently and raise the same
order twice.

**Idempotency.** Each decision carries a deterministic fingerprint — an FNV-1a
hash of kind, SKU, site, date and quantity. With a unique index on
`(org_id, fingerprint)` and `ON CONFLICT DO NOTHING`, a run that crashes and is
retried writes nothing the second time. Double-ordering is the failure mode that
would matter most, so it is designed out rather than monitored for.

**Budget continuity.** Spend committed earlier the same day is loaded *before*
the sweep and passed into every gate check, then incremented as the sweep
proceeds. The daily cap therefore holds across runs and across SKUs, rather than
resetting each cycle.

## Ordering inside `evaluate()`

Anomalies are detected **before** replenishment is planned, because several must
suppress or modify the order rather than sit alongside it:

- `NEGATIVE_STOCK` → replenishment suspended entirely. Ordering against a
  balance that cannot be physically true compounds the error.
- `DEMAND_COLLAPSE` → order withheld, with the avoided spend recorded. The
  reorder point was derived from a demand level that no longer applies.
- `STOCKOUT_IMMINENT` → raises the severity of the resulting order.

An agent that flags "demand has collapsed" and then places a full replenishment
in the same cycle is worse than no agent at all.

## Data flow for a stock movement

```
POST /api/v1/movements
  │
  ├─ guard()            authenticate → rate limit → permission
  ├─ Zod parse          shape and range
  ├─ withOrg()          transaction with RLS
  │   ├─ idempotency check on (org_id, idempotency_key)
  │   ├─ loadPosition() replay ledger from newest snapshot
  │   ├─ validateMovement()   pure — would this go negative?
  │   └─ recordMovement()
  │        ├─ INSERT stock_movements       (append-only, trigger-protected)
  │        ├─ UPSERT sku_sites.on_hand     (cache; ledger remains authoritative)
  │        └─ UPSERT daily_demand          (dense series for the forecaster)
  └─ 201 { id, replayed: false }
```

`sku_sites.on_hand` is a cache. If it ever disagrees with the ledger, **the
ledger is right by definition** and the cache is rebuilt.

## Why Postgres alone

No Redis, no queue, no search cluster. Each would be one more thing to secure,
back up, monitor and pay for in every customer's environment.

| Need | Postgres feature |
|---|---|
| Single execution across replicas | Advisory locks |
| Tenant isolation | Row-level security |
| Immutable audit trail | Triggers refusing UPDATE/DELETE |
| Exact money | `integer` minor units |
| Fast decision inbox | Partial index on `state = 'proposed'` |
| Idempotency | Unique index + `ON CONFLICT DO NOTHING` |

Rate limiting is the one honest exception: it is per-instance and in-memory. Past
a handful of replicas, swap the store for Redis — `RateLimitStore` is an
interface for exactly that reason. See
[ADR-0003](adr/0003-postgres-as-the-only-datastore.md).

## Scaling

| Dimension | Approach | Limit before rework |
|---|---|---|
| Read traffic | Stateless web tier, scale horizontally | Postgres connections |
| Write traffic | Append-only inserts, no update contention | Single-writer Postgres |
| Catalogue size | Snapshots bound ledger replay | ~100k SKU/site pairs per hourly cycle |
| Tenants | RLS on shared tables | Partition by `org_id` when a tenant dominates |
| Agent | One lock per organisation, so tenants run independently | Shard by tenant across workers |

The likeliest first bottleneck is the agent cycle: it evaluates SKUs
sequentially inside one transaction. For a very large catalogue, batch by SKU
range and run several workers — the per-organisation lock would then move to a
per-batch lock.
