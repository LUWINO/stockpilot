# ADR-0001: Record architecture decisions

**Status:** Accepted · **Date:** 2026-08-17

## Context

StockPilot is intended to run inside other companies' infrastructure for years,
maintained by people who were not present when it was designed. The expensive
question in that situation is never "what does this do?" — the code answers that —
but "why is it like this, and may I change it?"

Without a record, every non-obvious decision is eventually either cargo-culted or
reversed by someone who did not know what it was protecting against.

## Decision

Significant decisions are recorded as short, numbered, immutable documents in
`docs/adr/`, in Michael Nygard's format.

A decision is significant if reversing it would be expensive, or if a competent
engineer would plausibly do the opposite.

ADRs are never edited once accepted. A changed decision gets a new ADR that
supersedes the old one, and the old one is marked as superseded. The history of
what was believed is part of the value.

## Consequences

- Onboarding gets faster; the rationale is in the repository, not in someone's head.
- Reversing a decision requires engaging with why it was made.
- A small ongoing cost in discipline, and some ADRs will look obvious in hindsight.
