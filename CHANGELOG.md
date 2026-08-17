# Changelog

All notable changes are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Changes to decision behaviour are called out explicitly**, even when they are
not breaking API changes. If a release changes how safety stock is calculated or
which forecasting method is selected, someone's warehouse changes shape — and
that deserves the same prominence as a broken endpoint.

---

## [1.0.0] — 2026-08-17

First release.

### Domain core

- **Event-sourced stock ledger.** Append-only movements; positions derived by
  replay, with snapshots as a read optimisation. Point-in-time reconstruction
  supported.
- **FEFO allocation** and expiry-exposure calculation for perishable stock,
  accounting for demand already claimed by earlier-expiring lots.
- **Six forecasting methods** — naive, moving average, simple exponential
  smoothing, damped Holt, additive Holt–Winters, and Croston with the
  Syntetos–Boylan correction — selected automatically per SKU.
- **Rolling-origin backtesting** with MAE, RMSE, sMAPE, MASE and bias. Selection
  is by out-of-sample MASE; a candidate is kept only if it beats the naive
  benchmark.
- **Syntetos–Boylan demand classification** (smooth, erratic, intermittent,
  lumpy) restricting which methods are admissible for a given series.
- **Safety stock under dual variance** — King's formula, combining demand
  forecast error and observed lead-time variability.
- **(s, S) replenishment** with EOQ, order-up-to levels, and supplier minimum and
  case-multiple constraints.
- **ABC/XYZ segmentation** driving service level, review frequency and autonomy
  per SKU.
- **Eight anomaly detectors** with quantified evidence and monetary impact:
  negative stock, imminent stockout, dead stock, expiry risk, overstock, demand
  spike, demand collapse, shrinkage, and supplier unreliability.
- **Integer money** with explicit rounding modes, defaulting to banker's rounding.

### Autonomous agent

- Decision engine emitting replenishment, hold, transfer, markdown, write-off,
  count and alert decisions, each with rationale, evidence, confidence and value.
- Anomalies evaluated **before** replenishment, so a negative balance suspends
  ordering and a demand collapse withholds it.
- Multi-site transfer proposals that never push a donor below its own reorder
  point.
- **Autonomy gate** — four levels, per-decision and daily value caps, a confidence
  floor, and always-approve kinds. The tighter of organisation and segment level
  always wins.
- Deterministic decision fingerprints, so a retried run cannot double-order.
- Advisory-locked cycles, so replicas cannot evaluate a tenant concurrently.
- Daily budget continuity across runs.
- Standalone worker process, continuous or single-shot, with graceful shutdown.

### Platform

- PostgreSQL schema with row-level security on every tenant table, append-only
  triggers on the ledger and audit log, and integrity constraints mirroring the
  domain rules.
- REST API at `/api/v1` with Zod validation, idempotency keys, keyset pagination,
  RFC 9457 problem responses and per-key rate limiting.
- Session and API-key authentication; five-role RBAC with a flat permission
  matrix.
- scrypt password hashing with in-place parameter upgrade.
- Per-request CSP nonce with `strict-dynamic`; `__Host-` cookies; CSRF protected
  by HMAC double-submit, `SameSite` and Origin checking.
- Structured JSON logging with credential redaction at source.
- Next.js console: overview, decision queue with full reasoning, and inventory
  positions ordered by urgency.

### Verification

- 288 tests; 98% statement and 90% branch coverage of the domain core.
- CI applies every migration to a clean database and **fails the build** if any
  table lacks row-level security or if the append-only triggers are missing.
- CodeQL, weekly dependency audit, and lockfile drift detection.

### Documentation

Architecture, domain mathematics with citations, autonomy and rollout guidance,
data model, API reference, deployment, operations runbook, threat model, security
policy, six ADRs, and commercial notes.

---

## Unreleased

Nothing yet. Candidates, in rough priority order:

- Multi-factor authentication (the largest known security gap — see
  [SECURITY.md](SECURITY.md#known-gaps))
- A lint rule enforcing the `src/core` import boundary mechanically rather than
  by convention ([ADR-0004](docs/adr/0004-pure-domain-core.md))
- Shared-backend rate limiting for multi-replica deployments
- Purchase-order dispatch to suppliers (EDI, email, API)
- Agent batching, for catalogues beyond roughly 100k SKU/site pairs

[1.0.0]: https://github.com/luwino/stockpilot/releases/tag/v1.0.0
