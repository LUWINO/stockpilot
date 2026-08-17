# ADR-0004: Keep the domain core pure

**Status:** Accepted · **Date:** 2026-08-17

## Context

The decision engine decides how to spend money. Three things follow from that:

- Its logic must be **exhaustively testable**, because a bug is an incorrect
  purchase order rather than a broken page.
- Its decisions must be **reproducible**, because an auditor may ask why a
  particular order was raised eight months ago.
- Its mathematics must be **reviewable by an inventory specialist**, who will not
  know what an ORM is.

The conventional approach — services that query the database as they reason —
satisfies none of these. Testing needs a database and fixtures; reproducing a
past decision needs the database as it was; and the formula is buried among
queries.

## Decision

`src/core` contains no I/O, no clock, no randomness and no dependencies. The
current date is a parameter. Everything the engine needs arrives as a
`StockContext` assembled by the caller.

**Nothing in `src/core` may import from `server`, `app` or `worker`.**
Dependencies point inward, always.

## Consequences

**Good.**

- 288 tests run in about five seconds with no container and no fixture database.
- A decision is a pure function of recorded inputs, so any decision can be
  replayed and verified rather than merely believed. This is a security property
  as much as an engineering one — "the system did something inexplicable" becomes
  a falsifiable claim.
- The maths sits in files a specialist can read end to end.
- The domain has **zero runtime dependencies**, so it cannot be affected by a
  supply-chain compromise.

**Bad.**

- Assembling a `StockContext` is more code than querying inline would be, and it
  loads some data a given evaluation will not use.
- The whole context must be materialised in memory per SKU/site pair, which sets
  the agent's memory profile.
- Contributors must be told the rule; it is not self-evident from the layout.

**Not yet enforced mechanically.** The import direction is currently maintained by
convention and review. A lint rule (`import/no-restricted-paths`) should enforce
it, and until it does, this ADR is the only thing standing between the codebase
and a convenient `import { getDb }` inside the decision engine.

## Evidence it is working

During development the compiler and tests caught two real defects in this layer
that would otherwise have shipped: an ABC classifier that filed the single most
valuable SKU in a catalogue as class C, and a gate outcome compared against
`'blocked'` when the value was `'block'` — which would have recorded every
blocked decision as merely proposed. Both were caught in seconds, without a
database, because the logic was pure enough to test directly.
