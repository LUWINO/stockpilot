# ADR-0006: Integer money, and scrypt over Argon2

**Status:** Accepted · **Date:** 2026-08-17

Two decisions, grouped because they share a rationale: prefer the option with the
smaller failure surface, even when it is not the theoretically optimal one.

---

## Part 1: Money is an integer

### Context

`0.1 + 0.2 === 0.30000000000000004` in IEEE 754. Summing a million ledger lines
in `double` accumulates drift, and an inventory valuation that does not reconcile
to the penny fails audit.

### Decision

Money is a whole number of minor units plus an ISO 4217 currency, in both the
domain and the database. Quantities are likewise integers in the SKU's smallest
countable unit, so a SKU sold by weight declares `g` and 1.5 kg is `1500`.

`multiply` is the only operation that can round, and it takes the rule as an
argument. The default is banker's rounding, so a long series of tie-roundings
does not accumulate an upward bias — there is a test asserting that drift over
100 exact ties stays within one minor unit.

`parseFloat` is banned by an ESLint rule.

### Alternatives

**`numeric` in Postgres, `Decimal` in the application.** Correct, and a
reasonable choice. Rejected because it needs a decimal library in the domain —
which would break the zero-dependency property of `src/core` — and because
integers are exact rather than merely precise.

**Floats with rounding at the boundary.** The standard approach, and the source
of the standard bug.

### Consequences

Exact arithmetic everywhere; no drift possible. The cost is that every developer
must remember `1850` means £18.50, and that a currency with a different number of
minor units (JPY has none) needs care at the formatting boundary.

---

## Part 2: scrypt rather than Argon2id

### Context

Argon2id is the current recommendation and won the Password Hashing Competition.
It is, in isolation, the better algorithm.

Every Node binding for it is a **native module**. That means a compiler in the
build image, a prebuilt binary that can break on a Node upgrade, and one more
package with publish access to the production runtime of every customer running
this software.

### Decision

scrypt, from Node's built-in `crypto`, at N=65536, r=8, p=1 — roughly 64 MB and
~100 ms per hash.

scrypt is memory-hard, so it resists the GPU and ASIC attacks that make PBKDF2
and low-cost bcrypt weak. It is recommended by OWASP and approved in NIST
SP 800-63B. The gap to Argon2id is real but modest.

The hash records its own parameters (`scrypt$N$r$p$salt$hash`), so cost can be
raised later while old hashes still verify, and `needsRehash` tells the caller
when to upgrade one on next login.

### Rationale

For software that runs inside other companies' infrastructure, an implementation
with **no supply-chain surface** is worth more than the marginal hardening. The
realistic threat to a customer's deployment is a compromised transitive
dependency, not an attacker with enough of the password database and enough GPU
time for the scrypt/Argon2 difference to decide the outcome.

The same reasoning produced the wider dependency posture: six runtime
dependencies, no native modules, and `--ignore-scripts` in both CI and the image
build.

### Consequences

**Good.** No compiler in any build stage. No binary to break on a Node upgrade.
Nothing to audit beyond Node itself. Parameters are upgradable in place.

**Bad.** Marginally weaker than Argon2id against a dedicated cracking rig. 64 MB
per concurrent login sizes the web tier by simultaneous sign-ins rather than user
count.

**Revisit if** Argon2id lands in Node core, at which point the trade-off
disappears entirely.
