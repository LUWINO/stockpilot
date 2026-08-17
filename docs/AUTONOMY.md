# Autonomy and guardrails

A system that can spend money on its own needs a boundary it cannot argue past.
This document describes that boundary, and how to widen it safely.

---

## The gate

Every decision passes through one pure function before anything happens:
`gate()` in `src/core/agent/autonomy.ts`. It has no forecasting, no
optimisation and no cleverness — just limits applied to a finished decision.

Three properties make it trustworthy:

- **Deny by default.** Anything not explicitly permitted is proposed to a human.
- **Pure.** Its output is a function of the decision, the policy and the day's
  spend so far. Nothing else can influence it, and the same inputs always give
  the same outcome.
- **Explained.** Every rule that fired is recorded on the decision, including the
  ones that fired after the outcome was already settled. An operator asking "why
  did this not run?" deserves all the reasons, not just the first.

### Outcomes

| Outcome | Meaning |
|---|---|
| `execute` | Carried out now, recorded as `executed`. |
| `propose` | Written to the approval queue as `proposed`. |
| `block` | Recorded as `blocked`. Never acted on. |

### Levels

| Level | The agent may |
|---|---|
| `monitor` | Record findings. Take no action of any kind. |
| `propose` | Draft actions for a human to approve. |
| `act_within_limits` | Act, subject to value and confidence limits. |
| `act` | Act without value limits. For low-value, highly predictable stock only. |

**The effective level is always the tighter of the organisation setting and the
SKU segment's own level.** Raising the global setting to `act` can never promote
an AZ item — expensive and unpredictable — to fully automatic. That combination
is the single most important line in the module, and it is covered by a test that
asserts a permissive org policy cannot override a restricted segment.

### The checks, in order

1. **Advisory kinds pass immediately.** `ALERT`, `COUNT` and `HOLD_REPLENISHMENT`
   commit nothing, so they are always recorded.
2. **Paused?** The kill switch blocks everything.
3. **Monitor-only?** Blocks.
4. **Propose-only?** Downgrades to `propose`.
5. **Always-approve kind?** `WRITE_OFF` and `MARKDOWN` always downgrade.
6. **Confidence below the floor?** Downgrades.
7. **Value above the per-decision cap?** Downgrades.
8. **Would breach the daily budget?** Downgrades.
9. **Currency mismatch with the configured limits?** Downgrades — an unverifiable
   limit is treated as a failed limit.

---

## Why write-offs and markdowns always ask

Both permanently give up value, and neither is ever urgent enough to justify
skipping a human. A wrong replenishment can be returned or sold later; a wrong
write-off is gone. That asymmetry, not the size of the number, is why these two
kinds are in `alwaysApprove` by default.

## Why the daily budget spans runs

The budget is loaded from the database *before* the sweep starts and incremented
as decisions execute. If it reset each cycle, an hourly agent would have
twenty-four times the intended daily authority — a limit that reads as £2,500 but
is really £60,000.

---

## Rolling it out

Do not start at `act`. The recommended progression, with the exit criterion for
each stage:

### Stage 1 — `monitor` (2–4 weeks)

The agent forecasts, detects and reasons, but does nothing. Read the decision
queue as a report.

*Move on when* the replenishment quantities look sane to your buyers, and the
anomalies it raises are real. If it is flagging dead stock that is actually
seasonal, fix `deadStockDays` before granting any authority.

### Stage 2 — `propose` (4–8 weeks)

Every decision queues for approval. Nothing happens without a human click.

*Move on when* your approval rate is consistently high — say, above 90% — and the
rejections cluster in a pattern you have since fixed. A steady 60% approval rate
means the model does not yet understand your business, and automating it would
merely make the same wrong calls faster.

*Watch for* rubber-stamping. If approvals are being clicked without reading,
you have the cost of oversight without the benefit; either fix the queue volume
or move to limits.

### Stage 3 — `act_within_limits`, low caps

Start deliberately low — perhaps £100 per decision and £1,000 per day. Most
decisions still queue; the trivial ones stop consuming attention.

*Move on when* a month has passed with no automatic decision you would have
rejected.

### Stage 4 — raise the caps

Raise gradually, and re-check after each raise. There is no target: many
businesses settle permanently with meaningful decisions queued, which is a
perfectly good outcome. The goal is to remove the *routine* from a planner's day,
not to remove the planner.

---

## Configuration

Per organisation, in the `organisations` table:

| Column | Default | Meaning |
|---|---|---|
| `autonomy` | `propose` | Organisation-wide ceiling |
| `max_auto_value` | 25000 (£250) | Per-decision cap, minor units |
| `max_daily_auto_value` | 250000 (£2,500) | Daily budget, minor units |
| `min_confidence` | 0.6 | Floor for automatic execution |
| `agent_paused` | `false` | Kill switch |

A database constraint enforces `max_daily_auto_value ≥ max_auto_value` and
`0 ≤ min_confidence ≤ 1`, so an impossible policy cannot be saved.

Per SKU/site, `sku_sites.autonomy_override` can tighten (or loosen) the segment's
derived level — but the effective level is still the tighter of that and the
organisation setting.

---

## Stopping it

**Per tenant, the normal route.** Set `agent_paused = true`. Takes effect on the
next cycle. Findings are still recorded and decisions still proposed; nothing
executes.

**Globally, for an incident.** Set `AGENT_ENABLED=false` and restart the worker,
or scale it to zero replicas. The web console and API keep working.

**Mid-cycle.** Send `SIGTERM`. The worker finishes the current organisation's
transaction and exits cleanly. A second signal exits immediately — but the
in-flight transaction rolls back, so no partial state is persisted either way.

---

## What is *not* automated, by design

- Changing autonomy limits. Only an `admin` or `owner`, never the agent.
- Approving decisions. Requires a signed-in user; an API key cannot approve,
  because an API key has no human behind it to supply the accountability that
  approval represents.
- Creating or deactivating SKUs and suppliers.
- Anything touching users, roles or API keys.

The agent proposes and, within limits, acts on inventory. It has no authority
over the rules that constrain it.

---

## Auditing what it did

Every decision row carries:

| Field | Contents |
|---|---|
| `rationale` | Ordered, human-readable reasoning |
| `evidence` | The numbers behind it — reorder point, cover days, forecast method |
| `gate_reasons` | Every guardrail rule that fired |
| `confidence` | What the engine thought it knew |
| `fingerprint` | Deterministic id, so a replay is verifiable |
| `run_id` | The sweep it belonged to |

Because the engine is pure and its inputs are recorded, any decision can be
replayed months later and will produce the same answer. That is the difference
between an auditable system and one that merely logs a lot.

Query it directly:

```sql
-- Everything the agent did on its own last week, most expensive first.
SELECT created_at, kind, quantity, value, confidence, rationale
FROM decisions
WHERE state = 'executed'
  AND created_at > now() - interval '7 days'
ORDER BY value DESC;

-- Everything it wanted to do but was not allowed to.
SELECT kind, severity, gate_reasons, value
FROM decisions
WHERE state IN ('proposed', 'blocked')
  AND created_at > now() - interval '7 days';
```
