# StockPilot

**Autonomous inventory management.** An event-sourced stock ledger, statistical
demand forecasting, and a policy-gated decision engine that replenishes,
rebalances and protects inventory without waiting to be asked.

Built to be dropped into any company that holds physical stock — retail,
hospitality, manufacturing, distribution, healthcare — and to be defensible under
audit from the first day it runs.

```
┌──────────────┐     ┌────────────────┐     ┌─────────────────┐     ┌──────────┐
│  Stock       │────▶│  Forecast &    │────▶│  Decide         │────▶│  Gate    │
│  ledger      │     │  classify      │     │                 │     │          │
│              │     │                │     │  replenish      │     │  execute │
│  append-only │     │  auto-selected │     │  transfer       │     │  propose │
│  immutable   │     │  by backtest   │     │  mark down      │     │  block   │
│  replayable  │     │  ABC / XYZ     │     │  write off      │     │          │
└──────────────┘     └────────────────┘     └─────────────────┘     └──────────┘
       ▲                                              │                   │
       └──────────────────────────────────────────────┴───────────────────┘
                        every action written back as a movement
```

---

## What makes it autonomous

Most "inventory systems" are databases with forms. StockPilot decides and acts,
inside limits you set:

| It does this | Instead of |
|---|---|
| Picks the forecasting method that backtests best, per SKU | One formula for 20,000 different products |
| Sizes safety stock from *forecast error* and *supplier lateness* | A reorder point somebody typed in two years ago |
| Raises the order, or explains why it would not | A report nobody reads |
| Suspends replenishment when the books look wrong | Ordering against a balance that cannot be true |
| Withholds an order when demand has collapsed | Buying to a reorder point derived from demand that is gone |
| Moves stock between sites before buying more | Buying at one site while another scraps the same item |
| Refuses to act above a value or below a confidence | Acting confidently on a forecast nobody trusts |

Every decision carries its reasoning, its evidence, its confidence and its
monetary value, and every one is reproducible from the inputs recorded with it.

## What makes it safe

Autonomy that can spend money needs a boundary it cannot argue past.

- **Deny by default.** Anything not explicitly permitted is proposed to a human.
- **Three limits, always the tighter one wins.** A per-decision cap, a daily
  budget, and a confidence floor — combined with the SKU segment's own autonomy
  level, so loosening the global setting can never promote a volatile,
  high-value item to fully automatic.
- **Write-offs and markdowns always ask.** Both destroy value irreversibly and
  neither is ever urgent enough to skip a human.
- **A kill switch that takes effect on the next cycle**, per tenant and globally.
- **An append-only ledger** that a database trigger will not let anyone rewrite —
  corrections are appended, so the error *and* its correction both stay visible.
- **Row-level security** on every tenant table, so a forgotten `WHERE` clause
  returns nothing rather than another customer's stock.

Read [docs/AUTONOMY.md](docs/AUTONOMY.md) for how the guardrails compose.

---

## Quick start

Requires **Node 22.12+** and **PostgreSQL 15+**.

```bash
git clone https://github.com/luwino/stockpilot.git
cd stockpilot
npm install

cp .env.example .env.local
# Set DATABASE_URL, then generate a secret:
#   openssl rand -base64 48   →   SESSION_SECRET

npm run db:migrate    # schema, row-level security, append-only triggers
npm run seed          # a demo tenant with a year of history
npm run dev           # console on http://localhost:3000
```

Then let the agent take one pass over the seeded data:

```bash
RUN_ONCE=true npm run agent
```

Open `/decisions` and you will see it has already worked out that the sourdough
line is weekly-seasonal, that the mixer bearing is intermittent and needs
Croston's method rather than exponential smoothing, and that a butter lot is
going to expire before it can sell.

Or bring the whole stack up in containers:

```bash
docker compose up -d
docker compose exec web npm run db:migrate
docker compose exec web npm run seed
```

---

## The stack, and why

Chosen for a system that has to run inside *someone else's* infrastructure for
years. The guiding principle is a **small dependency surface**: six runtime
dependencies, no native modules, no service you must also buy.

| Layer | Choice | Why this one |
|---|---|---|
| Language | TypeScript 5.9, `strict` + `noUncheckedIndexedAccess` | The compiler caught real bugs during this build, including one that would have filed blocked decisions as merely proposed |
| Runtime | Node 22 LTS | Long-term support; native TypeScript execution, so the agent runs from source with no build step |
| Web | Next.js 16 / React 19 | One toolchain for console and API; standalone output for a minimal container |
| Database | PostgreSQL 15+ | Row-level security, advisory locks, partial indexes and exact integer arithmetic — all four are load-bearing here |
| Data access | Drizzle ORM | Types generated from the schema, SQL you can read, no runtime query builder in the hot path |
| Validation | Zod 4 | One schema validates the request and types the handler |
| Styling | Tailwind 4 | Tokens in CSS custom properties, so the palette can be rebranded without touching components |
| Tests | Vitest 4 | 288 tests, 98% statement coverage of the domain core |
| Passwords | scrypt, from Node's `crypto` | Memory-hard and OWASP-recommended, with **no native module** — nothing to compile, nothing extra with publish access to your runtime |

There is no Redis, no queue broker and no vector database, because nothing here
needs one. Postgres advisory locks give single-execution; the decision
fingerprint gives idempotency.

---

## How a cycle works

```
load state ──▶ forecast ──▶ segment ──▶ detect ──▶ plan ──▶ decide ──▶ gate ──▶ persist
    │                                                                              │
    └────────────── the only I/O ──────────────┘        everything between is pure ─┘
```

1. **Load** every stock position by replaying the ledger from its last snapshot.
2. **Forecast** demand. Candidates are backtested on rolling origins and ranked
   by MASE; the winner is kept only if it beats the naive benchmark.
3. **Segment** by ABC (value) and XYZ (predictability). The nine-box matrix sets
   service level, review frequency and how much autonomy that SKU gets.
4. **Detect** what is already wrong — imminent stockouts, expiry risk, shrinkage,
   dead stock, unreliable suppliers, demand shifts.
5. **Plan** replenishment: safety stock from *forecast error* and *lead-time
   variance*, reorder point, order-up-to level, EOQ, supplier constraints.
6. **Decide**, with anomalies able to suppress or modify the order.
7. **Gate** against the autonomy policy.
8. **Persist** — decisions are keyed by a deterministic fingerprint, so a retried
   run re-proposes rather than double-orders.

Steps 2 to 7 are pure functions with no clock, no database and no randomness.
That is what makes a decision from six months ago replayable today, and what
lets the whole engine be tested without a database.

---

## Documentation

| Document | What it covers |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Layers, dependency rules, the cycle in detail |
| [DOMAIN](docs/DOMAIN.md) | Every formula, why it was chosen, and what it costs when wrong |
| [AUTONOMY](docs/AUTONOMY.md) | Autonomy levels, guardrails, how to roll it out safely |
| [DATA-MODEL](docs/DATA-MODEL.md) | Tables, event sourcing, tenancy, retention |
| [API](docs/API.md) | REST reference, auth, idempotency, errors |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Docker, Kubernetes, managed platforms, configuration |
| [OPERATIONS](docs/OPERATIONS.md) | Runbook, SLOs, backup and restore, incident response |
| [SECURITY](SECURITY.md) | Controls, disclosure policy |
| [THREAT-MODEL](docs/THREAT-MODEL.md) | STRIDE analysis and mitigations |
| [ADRs](docs/adr/) | Why each significant decision was made |

---

## Project layout

```
src/
  core/          Pure domain. No I/O, no clock, no dependencies. 100% of the risk.
    money.ts       Integer money. Never a float.
    ledger.ts      Event-sourced stock, FEFO allocation, expiry maths
    forecast/      SES, Holt, Holt–Winters, Croston, backtesting, auto-selection
    policy/        Safety stock, reorder points, EOQ, ABC/XYZ segmentation
    agent/         The decision engine and the autonomy gate
    anomaly.ts     Eight detectors, each with quantified evidence and a cost
  server/        I/O. Database, auth, HTTP concerns, repositories, services.
  app/           Next.js console and REST API.
  worker/        The standalone autonomous agent process.
drizzle/         Migrations, including row-level security and append-only triggers.
docs/            The documentation above.
```

**The dependency arrow points inward, always.** Nothing in `src/core` may import
from `server`, `app` or `worker`. That single rule is what keeps the business
logic testable and the decisions reproducible.

---

## Verification

```bash
npm run verify   # typecheck → lint → test → build
```

CI additionally applies every migration to a clean Postgres and asserts that
**row-level security is enabled on every table** and that the **append-only
triggers exist** — so a future migration that forgets either one fails the build
rather than shipping quietly.

---

## Licence

Commercial. See [LICENSE](LICENSE) and [docs/COMMERCIAL.md](docs/COMMERCIAL.md)
for licensing options, including relicensing this codebase under Apache-2.0 if
you would rather run it as open core.
