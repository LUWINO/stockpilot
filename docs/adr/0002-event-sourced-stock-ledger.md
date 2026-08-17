# ADR-0002: Event-source the stock ledger

**Status:** Accepted · **Date:** 2026-08-17

## Context

The obvious design is a `quantity` column updated in place. It is simple, fast
and what most inventory systems do.

It has three problems, and all three matter more here than usual:

1. **It destroys evidence.** "Why is on-hand 47?" has no answer beyond "because
   it is." Shrinkage becomes undetectable, because the individual losses that
   caused it were overwritten.
2. **It loses updates.** `UPDATE stock SET qty = qty + n` is only safe inside a
   transaction with appropriate isolation. Every integration that ever forgets is
   a silent data-loss bug that appears under load and vanishes when investigated.
3. **An autonomous agent makes both worse.** An agent acting on stale state needs
   its actions to be individually valid and individually attributable. With a
   mutable balance, reconciliation is a forensic exercise.

## Decision

Stock is derived by replaying an append-only sequence of movements. Balances are
never stored as the source of truth.

- The sign of a movement comes from its *kind*, so the sign can never disagree
  with the reason. `ADJUSTMENT` is the sole signed kind, because a count
  correction is genuinely directional.
- `UPDATE` and `DELETE` on `stock_movements` are refused by a database trigger.
  Corrections are appended, leaving both the error and its correction visible.
- Snapshots exist purely as a read optimisation and are always reconstructible.
- `sku_sites.on_hand` is a cache for listing screens. If it ever disagrees with
  the ledger, the ledger is right by definition.

## Alternatives considered

**Mutable balance with an audit table.** The audit table drifts from reality the
first time someone writes to the balance without writing the audit row — and
being able to do so is exactly what makes it a separate table.

**Full event sourcing with a general event store.** Considerable machinery
(projections, versioning, replay tooling) for one aggregate. The ledger is the
only thing that needs it.

## Consequences

**Good.** Complete auditability. Point-in-time reconstruction — "what did we
think we had on 3 March?" — is a query, which makes a past year-end valuation
defensible. Appends never conflict. Shrinkage is detectable because the evidence
still exists.

**Bad.** Reading a balance costs more than reading a column; snapshots are needed
to bound it. The table grows without limit and eventually needs partitioning or
archival. Developers must learn that a correction is an append, not an edit.

**Accepted risk.** Snapshot staleness lengthens replays. Mitigated by weekly
snapshots and the `movements_replay_idx` index.
