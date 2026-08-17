# Threat model

STRIDE, scoped to what this system actually holds: stock levels, supplier pricing,
purchasing authority, and an agent that can commit money on its own.

---

## Assets

| Asset | Why an attacker wants it |
|---|---|
| Stock positions and demand history | Competitive intelligence — volumes, seasonality, margins |
| Supplier terms and unit costs | Commercially sensitive; useful for undercutting |
| **Purchasing authority** | The agent can raise orders. Subverting it spends real money |
| The audit trail | Falsifying it hides theft |
| Credentials | Lateral movement |

The second and third are what make this different from a generic CRUD
application. An attacker who can quietly raise the reorder point on one SKU, or
suppress a shrinkage alert, extracts value without ever exfiltrating a record.

## Trust boundaries

```
   internet  │  application  │  database
─────────────┼───────────────┼──────────────
   browser   │  web tier     │  Postgres
   API       │  agent        │  RLS enforced
   clients   │               │  triggers
```

Everything crossing a boundary is untrusted until validated.

---

## Spoofing

| Threat | Mitigation |
|---|---|
| Stolen session cookie | `__Host-` prefix (Secure, Path=/, no Domain), `HttpOnly`, `SameSite=Lax`, 12-hour expiry; only a SHA-256 digest is stored |
| Stolen API key | Digest-only storage, `sk_live_` prefix so leaks are greppable, revocation and expiry, per-key roles |
| Password brute force | scrypt (N=65536, r=8) ≈ 100 ms per attempt; login limited to 10 per 15 min **keyed on the account**, so rotating source addresses does not help |
| Account enumeration | Failed logins run a dummy hash so timing does not distinguish "no such user" from "wrong password" |
| Session fixation | A new token is issued on authentication |

**Residual:** no MFA. For an internet-facing deployment, put an SSO or identity
proxy in front. This is the largest single gap and is tracked for a future
release.

---

## Tampering

| Threat | Mitigation |
|---|---|
| Rewriting stock history | `stock_movements` is append-only, enforced by a trigger. `UPDATE`/`DELETE` raise `restrict_violation` |
| Falsifying the audit log | Same trigger on `audit_log` |
| Hiding shrinkage via adjustments | Adjustments need `inventory:adjust`, which `operator` does not have; the shrinkage detector sums them regardless |
| SQL injection | Parameterised throughout via Drizzle; no string-built SQL |
| CSRF | Double-submit token (HMAC of the session), `SameSite=Lax`, and Origin checking — three independent controls, because each has a known bypass in some configuration |
| Invalid state via the API | Zod at the boundary; CHECK constraints in the database |
| Corrupted money | Integers only. `parseFloat` is banned by lint |

---

## Repudiation

| Threat | Mitigation |
|---|---|
| "I never approved that" | `decisions.decided_by` and `decided_at`; approval requires a signed-in user, never an API key |
| "The agent did it, not me" | Decisions record their fingerprint, inputs and gate reasons, and are reproducible by replay |
| "That order was never raised" | Append-only ledger, immutable audit log |

The pure-domain design is a security control here, not just an engineering one: a
decision can be recomputed from its recorded inputs and shown to produce the same
answer, so "the system did something inexplicable" is a falsifiable claim.

---

## Information disclosure

| Threat | Mitigation |
|---|---|
| **Cross-tenant leakage** | Row-level security with `FORCE`, keyed on a transaction-local setting; repositories cannot be called outside a tenant scope; CI fails if any table lacks RLS |
| Secrets in logs | Redaction at source on any key matching `pass\|secret\|token\|key\|auth\|cookie\|session\|credential\|hash` |
| Stack traces to clients | 500 responses carry only a correlation id |
| Version fingerprinting | `poweredByHeader: false`; health endpoint reveals nothing but up/down |
| Console indexed by search engines | `robots: noindex, nofollow` |
| XSS reading data | Per-request CSP nonce with `strict-dynamic`; no `unsafe-inline` for script |

**The superuser caveat is worth restating:** RLS does not apply to a Postgres
superuser. Connecting the application as one silently disables tenant isolation.
This is in the deployment checklist for that reason.

**Residual:** no encryption at rest inside the application. Use the database's
own encryption. Field-level encryption for supplier pricing is a possible future
addition.

---

## Denial of service

| Threat | Mitigation |
|---|---|
| Request flood | Per-key rate limiting; **edge protection is required** for volumetric attacks |
| Password-hash CPU exhaustion | Passwords capped at 1024 characters; login rate-limited |
| Runaway query | 30-second `statement_timeout` |
| Oversized payload | 1 MB body limit |
| Agent starving the web tier | Separate process; separate resource limits |
| Unbounded log growth | Values truncated at 2 kB, arrays at 100 entries, depth at 6 |

**Residual:** in-memory rate limiting is per-instance. Across *n* replicas the
effective limit is *n* × the configured value. `RateLimitStore` is an interface
so a shared backend can replace it.

---

## Elevation of privilege

| Threat | Mitigation |
|---|---|
| Self-promotion by an admin | `canAssignRole` forbids granting a role at or above your own, and forbids changing your own role at all |
| Role confusion | Flat permission matrix, no inheritance; a test asserts each role is a strict superset of the one below |
| Agent exceeding authority | The gate is pure, deny-by-default, and takes the **tighter** of org and segment level |
| Compromised dependency | Six runtime dependencies, no native modules; `--ignore-scripts` in CI and in the image build; weekly audit; grouped Dependabot |
| Container escape as root | Runs as `node`, `readOnlyRootFilesystem`, all capabilities dropped |

---

## Agent-specific risks

The ones that do not appear in a normal application threat model.

### Poisoned demand data

**Threat.** An attacker with `inventory:move` books fabricated `ISSUE` movements
to inflate demand, causing large automatic orders.

**Mitigations.** Value caps bound the damage per decision and per day. The demand
spike detector flags the anomaly. Every movement is attributable. Confidence
falls when history is short, so a newly manipulated series does not immediately
earn automatic execution.

**Residual.** A patient attacker inflating demand slowly over months, staying
inside the caps, would not be detected by the current detectors. Mitigate
operationally: review the monthly trend in `value_committed` per SKU.

### Suppressing an alert

**Threat.** Adjusting stock upward to hide theft, so shrinkage never crosses its
threshold.

**Mitigations.** `inventory:adjust` is restricted to planner and above.
Adjustments are permanent and attributable. The detector measures cumulative loss
against throughput, so a series of small corrections still accumulates.

### Confidence manipulation

**Threat.** Making a SKU's history look artificially clean so confidence rises
above the automatic-execution floor.

**Mitigations.** Confidence is derived from *out-of-sample* backtest accuracy and
discounted by the number of origins available, so it cannot be raised without
genuinely predictable history. Value caps still apply regardless of confidence.

---

## Compliance mapping

Not certification, but a starting point for an assessor.

| Framework | Relevant controls |
|---|---|
| **SOC 2** | CC6.1 RBAC + RLS · CC6.6 encryption in transit · CC7.2 audit logging · CC8.1 change management via CI |
| **ISO 27001** | A.8.2 privileged access · A.8.15 logging · A.8.24 cryptography · A.8.28 secure coding |
| **UK GDPR / EU GDPR** | Minimal personal data — name, email, role. No customer PII. Article 32 addressed by scrypt, TLS, RLS and audit logging |
| **PCI DSS** | Out of scope: no cardholder data is stored or processed |

Personal data is limited to staff accounts. There is no data-subject export
endpoint; for a deployment where that is required, it is a straightforward query
across `users`, `sessions` and `audit_log`.

---

## Reporting

See [SECURITY.md](../SECURITY.md).
