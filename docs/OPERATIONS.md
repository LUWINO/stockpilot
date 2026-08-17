# Operations runbook

---

## Daily

Two questions, both answerable in under a minute.

**Did the agent run?**

```sql
SELECT started_at, finished_at, skus_evaluated,
       decisions_proposed, decisions_executed, decisions_blocked, error
FROM agent_runs
ORDER BY started_at DESC
LIMIT 5;
```

`finished_at IS NULL` on an old row means a crashed cycle. The transaction rolled
back, so nothing partial was persisted — but find out why.

**Is anything urgent waiting?**

```sql
SELECT severity, count(*), sum(expected_benefit)/100 AS value_at_stake
FROM decisions
WHERE state = 'proposed'
GROUP BY severity
ORDER BY min(CASE severity
  WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3
  WHEN 'low' THEN 4 ELSE 5 END);
```

---

## Scheduled maintenance

**Hourly** — purge expired keys and sessions:

```sql
SELECT stockpilot_purge_expired();
```

**Weekly** — snapshot positions to keep ledger replay fast. **Monthly** — review
autonomy limits and approval rates (see below). **Quarterly** — rotate API keys;
restore a backup into a scratch database and confirm it works.

---

## Service levels

| Indicator | Target | Query or source |
|---|---|---|
| Console availability | 99.9% | Health checks |
| API p99 latency | < 500 ms | Application logs |
| Agent cycle completion | > 99% of scheduled | `agent_runs` |
| Movement write success | > 99.99% | 5xx rate |
| Decision queue age | p95 < 24 h | `decisions.created_at` where proposed |

The last one is a *business* indicator, not a technical one, and it is the one
that degrades first. A growing queue means either the agent is proposing too much
or nobody is reviewing — both are worth knowing before someone notices a stockout.

---

## Monitoring

Logs are single-line JSON with credential redaction at source. Alert on:

| Condition | Severity | Why |
|---|---|---|
| No `agent_runs` row in 2× the interval | High | The agent is dead; stock is drifting |
| `agent_runs.error IS NOT NULL` | High | Cycles are failing |
| 5xx rate > 1% over 5 min | High | |
| `NEGATIVE_STOCK` decision created | High | Books and shelf have diverged |
| Database connections > 80% of max | Medium | |
| Proposed decisions older than 48 h | Medium | Oversight has stopped happening |
| `blocked` decisions rising | Medium | Limits may be miscalibrated |
| Repeated CSRF rejections | Medium | Misconfiguration, or an attack |

---

## Incidents

### The agent is not running

```bash
kubectl logs -l component=agent --tail=100
# or: docker logs stockpilot-agent
```

1. Is `AGENT_ENABLED` true? Is the tenant's `agent_paused` false?
2. Can it reach the database? `GET /api/v1/health`
3. Is a stale lock held? Advisory locks are transaction-scoped and released on
   disconnect, so this should be self-healing — verify:
   ```sql
   SELECT pid, granted, query_start FROM pg_locks
   JOIN pg_stat_activity USING (pid) WHERE locktype = 'advisory';
   ```
4. Force a cycle: `RUN_ONCE=true npm run agent`

### It ordered something it should not have

1. **Stop the bleeding.** `UPDATE organisations SET agent_paused = true WHERE id = …`
   Takes effect on the next cycle.
2. **Find it.**
   ```sql
   SELECT * FROM decisions WHERE id = '…';
   ```
   `rationale`, `evidence` and `gate_reasons` explain exactly what it believed
   and which limits it passed.
3. **Diagnose.** Almost always one of:
   - Bad demand data — a bulk import booked as `ISSUE`, inflating the forecast.
   - A supplier record with a wrong lead time or case multiple.
   - Limits set too high for the segment.
4. **Fix the cause, not the symptom.** Correct the data with an `ADJUSTMENT`,
   then re-run. Lower the caps if the limits were wrong.
5. **Resume**, and watch the next cycle.

### Stock has gone negative

The agent already suspended replenishment for that SKU and raised a `COUNT` —
that is the designed response.

1. Physically count it.
2. Book the truth:
   ```json
   { "kind": "ADJUSTMENT", "quantity": -37, "reason": "Cycle count 2026-08-17", "allowNegative": true }
   ```
3. Find out how it happened: goods left without being booked out, or a receipt
   was never recorded. Check `stock_movements` around the divergence.

### Database is unreachable

Readiness returns 503 and instances leave the load balancer automatically;
liveness keeps them alive, so they recover without a restart storm. Movements
fail with 5xx — **clients must retry with the same `Idempotency-Key`**, which
makes the retry safe.

---

## Backup and restore

**Backups.** Point-in-time recovery, retained 30 days minimum. `pg_dump` nightly
as a second line.

**A backup you have not restored is not a backup.** Test quarterly:

```bash
pg_dump "$DATABASE_URL" -Fc -f stockpilot-$(date +%F).dump
createdb stockpilot_restore_test
pg_restore -d stockpilot_restore_test stockpilot-$(date +%F).dump

psql -d stockpilot_restore_test -c "
  SELECT (SELECT count(*) FROM stock_movements) AS movements,
         (SELECT count(*) FROM decisions) AS decisions,
         (SELECT count(*) FROM skus) AS skus;"
```

**Recovery targets.** RTO 4 hours, RPO 5 minutes with PITR.

After a restore, the ledger is authoritative: rebuild the `sku_sites` cache and
snapshots from `stock_movements` rather than trusting whatever the cache held.

---

## Tuning

**The agent is too slow.** Snapshot more often; raise
`AGENT_INTERVAL_MINUTES`; deactivate SKUs that no longer trade. The cycle is
sequential within an organisation — a very large catalogue needs the batching
described in [ARCHITECTURE.md](ARCHITECTURE.md).

**Too many decisions to review.** This is usually a signal, not a volume problem.
Check the mix first: a flood of `ALERT` rows means detector thresholds are wrong
for your business (`deadStockDays` is the usual culprit for seasonal stock). A
flood of `REPLENISH` rows awaiting approval means the caps are too low for the
value of what you actually sell.

**Forecasts look wrong.** Look at the SKU's classification before the method.
Intermittent demand misclassified as smooth is the common case, and it is nearly
always caused by sparse `daily_demand` — gaps that should be zeros. Confirm the
series is dense:

```sql
SELECT count(*) AS days_with_rows,
       max(day) - min(day) AS span
FROM daily_demand WHERE sku_id = '…' AND site_id = '…';
```

If `days_with_rows` is far below `span`, demand is not being recorded on
zero-sale days and the forecaster is seeing a distorted series.

---

## Upgrading

1. Read the changelog.
2. Back up.
3. Apply migrations: `npm run db:migrate`
4. Deploy the web tier; confirm readiness.
5. Deploy the agent.
6. Watch one full cycle before walking away.

Pause the agent during any upgrade that changes decision logic, and review the
first cycle's output before resuming automatic execution.
