# Contributing

## Before you start

```bash
npm install
cp .env.example .env.local     # set DATABASE_URL and SESSION_SECRET
npm run db:migrate
npm run seed
npm run dev
```

Everything must pass before you open a pull request:

```bash
npm run verify    # typecheck → lint → test → build
```

---

## The rules that matter

Most conventions here are ordinary. These five are not, and a change that
violates one will be sent back.

**1. `src/core` stays pure.** No I/O, no clock, no randomness, no dependencies.
The current date is a parameter. Nothing in `src/core` may import from `server`,
`app` or `worker`. This is what makes decisions reproducible and testable — see
[ADR-0004](docs/adr/0004-pure-domain-core.md).

**2. Money and quantities are integers.** Never a float, never a `numeric`
column, never `parseFloat` (lint will stop you). See
[ADR-0006](docs/adr/0006-integer-money-and-scrypt.md).

**3. The ledger is append-only.** A correction is a new `ADJUSTMENT` movement, not
an edit. The database will refuse an update anyway.

**4. Every tenant table gets row-level security.** A new table without it fails
CI. Not a review comment — a build failure.

**5. Adding a dependency needs a reason in the pull request.** Six runtime
dependencies is a feature of this codebase, not an accident. A native module
needs a much better reason than convenience.

---

## Tests

Test **behaviour and its rationale**, not implementation. A good test here reads
like a claim about inventory management:

```ts
it('holds more stock for an unreliable supplier than a dependable one', () => {
  const dependable = planReplenishment({ ...base, observedLeadTimeDays: [5, 5, 5, 5] });
  const erratic    = planReplenishment({ ...base, observedLeadTimeDays: [1, 9, 2, 14] });

  expect(erratic.safetyStock).toBeGreaterThan(dependable.safetyStock);
});
```

That test would survive a complete rewrite of the internals, and it fails loudly
if someone drops the lead-time variance term.

- **No randomness.** Use `buildSeries` from `src/testing/fixtures.ts`, which is
  seeded. A test that fails one run in fifty is worse than no test, because the
  team learns to re-run it rather than read it.
- **Comment the arithmetic** when an expected value is derived:
  `// z(0.95) × √(4 × 5²) = 1.645 × 10 = 16.45, rounded up to 17.`
- **When a test fails, work out which is wrong** — the test or the code. Two of
  the defects fixed during the initial build were found exactly this way, and one
  of them (ABC misclassifying the most valuable SKU as class C) looked at first
  like a wrong expectation.
- `src/core` is held to 85% statements and 80% branches. It carries the risk.

---

## Commits and pull requests

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(forecast): add multiplicative Holt–Winters for non-zero series
fix(ledger): reject fractional quantities in movement validation
docs(autonomy): document the daily-budget continuity guarantee
```

A pull request should say **what changed, why, and how you know it works.** If it
changes decision behaviour — safety stock, forecast selection, the gate — say so
explicitly and loudly. Someone's warehouse changes shape as a result, and it
needs a changelog entry.

---

## Changing the domain maths

Held to a higher bar, because it decides how money is spent.

1. **Cite the source.** Textbook, paper, or a clearly reasoned argument in the
   pull request. [DOMAIN.md](docs/DOMAIN.md) lists the current references.
2. **Say what it costs when wrong.** Every formula in this system has a failure
   mode — under-forecast becomes stockouts, over-forecast becomes dead stock.
   Name yours.
3. **Show the comparison.** A backtest against the existing method on a realistic
   series, with MASE. "It seems better" is not enough.
4. **Update [DOMAIN.md](docs/DOMAIN.md)** in the same pull request. Maths that is
   in the code but not the document does not exist as far as reviewers and
   customers are concerned.

---

## Reporting security issues

Not here. See [SECURITY.md](SECURITY.md).

---

## Licence of contributions

By contributing you agree that your contribution is licensed under the terms in
[LICENSE](LICENSE), and you grant the project maintainers a perpetual,
irrevocable, worldwide, royalty-free licence to use, modify, sublicense and
relicense it as part of the Software.

The relicensing right is deliberate: it keeps the option of moving to Apache-2.0
or another model open (see [COMMERCIAL.md](docs/COMMERCIAL.md)). Without it,
relicensing later would require tracking down every past contributor.
