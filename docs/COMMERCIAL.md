# Commercial notes

This document exists because the codebase was built to be **sold or deployed
commercially**, and the licensing decision should be an informed one rather than
a default.

---

## The licence you have

[`LICENSE`](../LICENSE) is a proprietary commercial licence: free to evaluate,
paid for production use, no redistribution or resale as a service.

It is the right default for a product you intend to sell, and it is deliberately
easy to change.

## Changing it

**Nothing in this codebase constrains the choice.** The runtime dependencies are
MIT and Apache-2.0 licensed, there are no native modules, no GPL or AGPL
components, and no third-party code was copied in. Verify before committing to a
model:

```bash
npx license-checker --production --summary
```

Three models are viable:

### Fully proprietary — as shipped

Sell licences per deployment or per site. Simplest commercially; means every
evaluation goes through a sales conversation.

### Open core — Apache-2.0 with a commercial edition

Replace `LICENSE` with the Apache-2.0 text, add a `NOTICE` file, and keep
higher-tier features (multi-site optimisation, SSO, advanced reporting) in a
separate private package.

The natural seam already exists: `src/core` is dependency-free and pure, so it
can be published openly while `src/server` and the console stay commercial —
or the reverse. Adopters get real value; the commercially interesting parts stay
yours.

### Source-available — BSL or Elastic Licence 2.0

Source visible, production use restricted, converting to open source after a set
period. A middle path with growing precedent.

Whichever you pick, decide **before** the first external user. Relicensing later
requires the agreement of every contributor whose code is still present, which is
why `CONTRIBUTING.md` includes an inbound licence grant from the outset.

---

## What is actually saleable here

Being direct about where the value sits, because it shapes both pricing and what
to protect:

| Asset | Why it is hard to replicate |
|---|---|
| **The decision engine** | Forecast selection, safety stock under dual variance, and the guardrail model are the parts that take domain expertise to get right. 288 tests encode that expertise. |
| **The autonomy model** | The gate, the nine-box policy matrix and the documented rollout path are the answer to "how do I trust this?" — the question that actually blocks purchases of autonomous software. |
| **The audit posture** | Append-only ledger, reproducible decisions, RLS asserted in CI. This is what a regulated buyer's assessor asks for, and most competitors cannot demonstrate it. |
| **The documentation** | An evaluator can assess this in an afternoon without a call. That shortens sales cycles measurably. |

The console UI is the least differentiated part and the easiest to rebuild. Price
and protect accordingly.

---

## Deployment models

| Model | Fits | Watch out for |
|---|---|---|
| **Self-hosted** | Regulated buyers, existing platform teams | Support burden across many environments; version fragmentation |
| **Single-tenant hosted** | Mid-market wanting no operations | Per-customer infrastructure cost |
| **Multi-tenant SaaS** | Volume, self-service | RLS is already built for it — but audit it seriously before relying on it commercially |

Multi-tenancy is implemented and enforced at the database level, which is the
right layer. Before selling it, have an independent party test tenant isolation.

---

## Before you sell it

- [ ] Decide the licence model and apply it consistently across every file header
- [ ] Register trademarks for the product name if you intend to keep it
- [ ] Replace `security@stockpilot.dev` and the GitHub URLs with real ones
- [ ] Get an independent penetration test, focused on tenant isolation
- [ ] Decide the support model: hours, response times, supported versions
- [ ] Write a data processing agreement if you host on customers' behalf
- [ ] Confirm insurance covers software that takes autonomous commercial actions
- [ ] Have the liability limitations in `LICENSE` reviewed by a qualified lawyer

That last point matters more than usual. This software can raise purchase orders
on its own. Sections 8 and 9 of the licence are drafted to address that
specifically, but they are a starting point drafted by an engineer, not legal
advice.

---

## Versioning commitments

Semantic versioning. For a commercial product the promises worth making
explicitly:

- The REST API is versioned in the path; `/api/v1` is supported for at least
  twelve months after `/api/v2` ships.
- Database migrations are additive and forward-only. No down migrations, because
  an untested down migration is a false sense of safety.
- Breaking changes to decision *behaviour* — not just APIs — are called out in the
  changelog, because a customer's stock levels depend on them.

That third commitment is unusual and worth keeping. If a release changes how
safety stock is calculated, someone's warehouse changes shape.
