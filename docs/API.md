# API reference

Base path `/api/v1`. JSON in, JSON out, UTF-8 throughout.

The API is versioned in the path. A breaking change means `/api/v2`, with `/v1`
supported for at least twelve months — see [COMMERCIAL.md](COMMERCIAL.md).

---

## Authentication

Two schemes. Both resolve to the same internal identity.

### API keys — for integrations

```http
Authorization: Bearer sk_live_<your api key>
```

Keys are shown **once** at creation and never again: the database stores only a
SHA-256 digest, so a dump of the `api_keys` table yields nothing presentable.
Every key carries a role and can be given an expiry.

The `sk_live_` prefix is deliberate — it makes a leaked key greppable in logs and
searchable on code-hosting platforms.

### Session cookies — for the console

Set at sign-in as `__Host-stockpilot_session`. The `__Host-` prefix is enforced
by the browser: it requires `Secure`, requires `Path=/`, and forbids `Domain`,
so a compromised subdomain cannot set it.

State-changing requests additionally require a CSRF token:

```http
X-StockPilot-CSRF: <value of the __Host-stockpilot_csrf cookie>
```

The token is an HMAC of the session token, so it needs no storage and is
invalidated automatically when the session ends. Bearer-authenticated calls do
not need it — a browser will never attach an `Authorization` header
cross-origin.

---

## Permissions

| Role | Can |
|---|---|
| `viewer` | Read inventory, catalogue, decisions, purchase orders |
| `operator` | The above, plus record movements |
| `planner` | The above, plus adjust stock, edit catalogue, approve decisions, run the agent |
| `admin` | The above, plus configure the agent, read audit, manage users and keys |
| `owner` | Everything, including organisation settings |

Each role is a strict superset of the one below — asserted by a test, so a future
edit cannot accidentally remove a permission from a higher role.

Two boundaries are deliberate: an **operator can move stock but not adjust it**
(booking a receipt is routine; writing off a discrepancy is how shrinkage gets
hidden), and a **planner can approve decisions but not change the agent's
limits** (whoever sets the cap should not also approve spends against it).

---

## Errors

RFC 9457 `application/problem+json`:

```json
{
  "type": "https://stockpilot.dev/problems/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "The movement is not valid",
  "errors": { "quantity": ["Quantity must not be zero"] }
}
```

Branch on `type`, which is stable. `title` and `detail` are free to change.

| Status | `type` | When |
|---|---|---|
| 400 | `/bad-request` | Body is not JSON |
| 401 | `/unauthorised` | Missing or invalid credentials |
| 403 | `/forbidden` | Authenticated, but the role lacks the permission |
| 404 | `/not-found` | Does not exist, or is not yours |
| 409 | `/conflict` | Valid but conflicts with current state |
| 422 | `/validation-failed` | Parsed, but not valid |
| 429 | `/rate-limited` | Too many requests; see `Retry-After` |
| 500 | `/internal` | Carries an `instance` correlation id and nothing else |

A 500 deliberately contains no detail. The real error is logged against the
`instance` id; support can join the two, an attacker cannot. Quote that id when
reporting a problem.

---

## Rate limits

600 requests per minute per key or session by default. Every response carries:

```
RateLimit-Limit: 600
RateLimit-Remaining: 592
RateLimit-Reset: 43
```

Back off when `Remaining` approaches zero rather than waiting for a 429.

The limiter is per-instance and in-memory. Across *n* replicas the effective
limit is *n* × the configured value. It is a fairness guard against a runaway
retry loop, not DDoS protection — that belongs at the edge.

---

## Idempotency

Any unsafe request may carry:

```http
Idempotency-Key: 1f8a4c9e-3b21-4d6f-9a77-2c5e8b0d1f34
```

A retry with the same key returns the original outcome with `"replayed": true`
instead of applying the change twice.

**Use it for every movement.** Warehouse scanners and tills work over unreliable
networks and retry automatically; a retried receipt that books stock twice is a
real and expensive failure. Generate a fresh UUID per logical operation, not per
HTTP attempt.

---

## Endpoints

### `GET /api/v1/health`

Unauthenticated.

- `?probe=liveness` — process check only. Never touches the database, so a
  database blip cannot cause an orchestrator to restart every healthy pod and
  turn a brief outage into a cascading one.
- No parameter — readiness. Checks the database; returns **503** when it cannot
  serve, so the load balancer removes the instance without killing it.

```json
{ "status": "ready", "checks": { "database": { "ok": true, "latencyMs": 3 } } }
```

---

### `POST /api/v1/movements`

Record a stock movement. Requires `inventory:move`; `ADJUSTMENT` and
`allowNegative` additionally require `inventory:adjust`.

```json
{
  "skuId": "3f1c...",
  "siteId": "9b2e...",
  "kind": "RECEIPT",
  "quantity": 240,
  "lotId": "7a4d...",
  "reason": "PO-2026-0481",
  "occurredAt": "2026-08-17T09:14:00Z"
}
```

| Field | Notes |
|---|---|
| `kind` | `RECEIPT`, `ISSUE`, `RETURN`, `TRANSFER_IN`, `TRANSFER_OUT`, `SCRAP`, `ADJUSTMENT` |
| `quantity` | Integer in the SKU's stock unit. Positive except for `ADJUSTMENT`, which is signed. Never zero. |
| `occurredAt` | When it physically happened. Defaults to now. Backdating is supported and correct — the ledger sorts by this. |
| `allowNegative` | Permits a negative balance. For stock-takes, where the count *is* the truth. |

**201**

```json
{ "id": "c4e1...", "replayed": false }
```

**409** when the movement would drive stock negative, with the reason:

```json
{ "status": 409, "detail": "Movement would drive on-hand negative: 20 − 25" }
```

---

### `GET /api/v1/decisions`

List decisions, newest first. Requires `decision:read`.

| Parameter | Notes |
|---|---|
| `state` | `proposed`, `approved`, `rejected`, `executed`, `blocked`, `expired` |
| `kind` | `REPLENISH`, `HOLD_REPLENISHMENT`, `TRANSFER`, `MARKDOWN`, `WRITE_OFF`, `COUNT`, `ALERT` |
| `limit` | 1–200, default 50 |
| `cursor` | From `nextCursor`. Keyset pagination — stable under concurrent inserts, and does not degrade as the table grows |

```json
{
  "data": [
    {
      "id": "8c7b...",
      "kind": "REPLENISH",
      "state": "proposed",
      "severity": "medium",
      "quantity": 480,
      "value": { "amount": 888000, "currency": "GBP" },
      "expectedBenefit": { "amount": 121500, "currency": "GBP" },
      "confidence": 0.83,
      "rationale": [
        "Position 40 is at or below the reorder point 138 (5.2d lead time, 95.0% service level). Ordering 480 to reach the target of 512, taking cover from 2.0d to 26.0d.",
        "Forecast: 19.74 units/day by holt_winters (smooth demand, MASE 0.61).",
        "Segment BX targets a 95.0% service level, reviewed every 3 day(s).",
        "Safety stock 62 units covers demand and lead-time variability (71% of the buffer is lead-time risk over 4 observed deliveries)."
      ],
      "evidence": { "reorderPoint": 138, "coverDaysNow": 2.03, "forecastMethod": "holt_winters" },
      "gateReasons": ["Value 8880 exceeds the per-decision limit of 250."],
      "createdAt": "2026-08-17T06:00:12Z"
    }
  ],
  "nextCursor": "2026-08-17T06:00:12.000Z"
}
```

`rationale` is the product. It is written to be read by a buyer, not parsed.

---

### `PATCH /api/v1/decisions`

Approve or reject. Requires `decision:approve` **and a signed-in user** — an API
key cannot approve, because it carries no human accountability.

```json
{ "decisionId": "8c7b...", "action": "approve", "note": "Confirmed with the mill" }
```

Approval changes state only; it never executes as a side effect. "A human
agreed" and "the warehouse was told" stay separate facts in the audit trail.

**409** if the decision is not in `proposed`.

---

### `POST /api/v1/agent/run`

Trigger a cycle immediately. Requires `agent:run`.

For when waiting is wrong: after a bulk catalogue import, after correcting a bad
stock count, or to see the effect of a policy change.

**200** with the summary, or **202** with `"skipped": true` when another replica
holds the lock.

```json
{
  "runId": "1a9f...",
  "skusEvaluated": 1284,
  "decisionsProposed": 37,
  "decisionsExecuted": 12,
  "decisionsBlocked": 0,
  "valueCommitted": 184200,
  "skipped": false
}
```

Safe to call repeatedly.

---

## A worked integration

Booking a day's sales from a till, with retries:

```bash
#!/usr/bin/env bash
set -euo pipefail

KEY="$STOCKPILOT_API_KEY"
BASE="https://stockpilot.example.com/api/v1"

book_sale() {
  local sku=$1 site=$2 qty=$3 idem=$4
  curl -sS --fail-with-body \
    --retry 3 --retry-connrefused --retry-delay 2 \
    -X POST "$BASE/movements" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: $idem" \
    -d "{\"skuId\":\"$sku\",\"siteId\":\"$site\",\"kind\":\"ISSUE\",\"quantity\":$qty}"
}

# The key is derived from the till transaction, so curl's own retries and any
# outer retry both collapse to a single booking.
book_sale "$SKU" "$SITE" 12 "till-7-txn-84213"
```
