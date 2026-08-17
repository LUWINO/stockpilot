# The inventory mathematics

Every formula the system uses, why it was chosen over the alternative, and what
it costs when it is wrong. Written to be checkable by an inventory specialist who
has never read TypeScript.

---

## 1. Integers everywhere

**Money** is a whole number of minor units plus a currency. **Quantity** is a
whole number of the SKU's stock unit — a SKU sold by weight declares `g`, and
1.5 kg is stored as `1500`.

Binary floating point cannot represent 0.1. Summing a million ledger lines in
`double` accumulates drift, and an inventory valuation that does not reconcile to
the penny fails audit. `multiply` is the only operation that can round, and it
takes the rule as an argument; the default is banker's rounding, so a long series
of roundings does not accumulate an upward bias.

*Implementation: `src/core/money.ts`.*

---

## 2. The stock ledger

Stock is never stored as a mutable number. It is derived by replaying an
append-only sequence of movements.

| Kind | Sign | Meaning |
|---|---|---|
| `RECEIPT`, `RETURN`, `TRANSFER_IN` | + | Stock arrives |
| `ISSUE`, `TRANSFER_OUT`, `SCRAP` | − | Stock leaves |
| `ADJUSTMENT` | signed | A correction booked against a physical count |

The sign comes from the kind, never from the caller — so the sign can never
disagree with the reason. `ADJUSTMENT` is the sole exception, because a count
correction is genuinely directional.

**Why event sourcing.** `UPDATE stock SET qty = qty + n` loses an update if it is
ever run outside a transaction, and it destroys the evidence of what happened.
Appending an immutable fact never conflicts, and "why is on-hand 47?" always has
an answer. Negative stock is *allowed to exist* in the ledger — it is a real
signal that reality diverged from the books — but is never allowed to be created
deliberately.

**Snapshots** are a read optimisation only. Replaying five years of movements is
correct but slow, so projection starts from the newest snapshot. A snapshot is
always reconstructible and may be deleted at any time.

*Implementation: `src/core/ledger.ts`.*

### FEFO, not FIFO

Perishable stock is allocated **first-expired-first-out**. For goods with a date,
the order they arrived is irrelevant; what matters is what spoils soonest. Lots
without an expiry sort last and then by receipt date, so the rule degrades
gracefully to FIFO for everything else.

### Expiry exposure

For each lot in expiry order:

```
days_remaining      = expires_on − today
demand_before_expiry = ⌊daily_demand × days_remaining⌋
sellable            = min(lot_quantity, demand_before_expiry − demand_already_claimed)
at_risk            += lot_quantity − sellable
```

Demand claimed by an earlier-expiring lot is not available to a later one. Without
that subtraction, every lot is measured against the same demand and the exposure
is wildly understated.

---

## 3. Forecasting

There is no single best method. A supermarket staple and a spare gearbox need
different mathematics, and a system that applies one to both will be wrong about
at least one.

### Classifying the demand

Syntetos–Boylan, from two measures:

- **ADI** — average interval between non-zero demands.
- **CV²** — squared coefficient of variation of the *non-zero* demands.

| | CV² < 0.49 | CV² ≥ 0.49 |
|---|---|---|
| **ADI < 1.32** | Smooth | Erratic |
| **ADI ≥ 1.32** | Intermittent | Lumpy |

The cutoffs are the published values at which Croston's method starts to beat
exponential smoothing.

### The methods

| Method | Recurrence | Use |
|---|---|---|
| Naive | `ŷ = yₜ` | The benchmark everything must beat |
| Moving average | mean of last *w* | Stable, noisy demand |
| **SES** | `ℓₜ = αyₜ + (1−α)ℓₜ₋₁` | Smooth demand, no trend |
| **Holt (damped)** | level + `φ`-damped trend | Genuine trend |
| **Holt–Winters** | level + trend + additive season | Weekly rhythm |
| Seasonal naive | `ŷ = yₜ₋ₘ` | Strong season, little data |
| **Croston (SBA)** | smooth size and interval separately | Intermittent and lumpy |

**Damping matters.** An undamped upward trend extrapolates linearly forever and
will order a warehouse full of stock off the back of one good fortnight. With
`φ < 1` the trend accumulates as a geometric series and converges.

**Additive, not multiplicative, seasonality.** Demand series routinely contain
zeros — closed days, stockouts — and the multiplicative form is undefined there.

**Croston exists for a specific failure.** A series that is 90% zeros drags
exponential smoothing toward a mean that includes the zeros, systematically
under-forecasting the days that actually matter. Croston smooths *how much* and
*how often* separately and divides. The Syntetos–Boylan `(1 − α/2)` factor
corrects the upward bias in the original method.

### Choosing between them

Rolling-origin backtesting. At each origin the forecaster sees only prior data,
projects the horizon, and is scored against what actually happened.

Selection is by **MASE**:

```
MASE = MAE(forecast) / MAE(in-sample naive one-step)
```

Scale-free, defined when actuals are zero (unlike MAPE), and directly
interpretable: **below 1 beats doing nothing, above 1 is worse than doing
nothing.**

Fitting accuracy is never used for selection — it always improves with model
complexity, so selecting on it reliably picks the most overfitted candidate.

**Confidence** falls out of the same evidence: MASE mapped onto [0, 1], then
discounted when few origins were available. A good score measured twice is not
the same evidence as a good score measured twenty times. The decision engine
multiplies its own confidence by this, so a poorly understood SKU cannot trigger
a large automatic order.

*Implementation: `src/core/forecast/`.*

---

## 4. Safety stock

The most expensive modelling error in inventory management is sizing safety
stock against demand variability alone. Supplier lateness is usually the larger
variance.

King's formula, with both sources:

```
SS = z × √( LT × σ_d²  +  d̄² × σ_LT² )
     └─┬─┘   └────┬────┘   └────┬────┘
   service    demand         lead-time
    level    variability    variability
```

The variances add under the root because the sources are independent.

```
Reorder point = d̄ × LT + SS
```

**σ_d is the standard deviation of forecast *error*, not of raw demand.** This is
what makes a better forecast translate into *less stock* rather than merely a
different number. A forecaster that captures the weekly cycle has small
residuals, so it earns a smaller buffer.

**Exposure spans lead time *plus* review period.** After this review, the next
chance to react is a whole review period away.

**A new supplier has not earned trust.** With no observed deliveries, lead-time
variability defaults to a 25% coefficient of variation. With one observation you
know the mean but nothing about spread, so the pessimistic default persists until
there are at least two.

| Service level | z |
|---|---|
| 90% | 1.28 |
| 95% | 1.64 |
| 98% | 2.05 |
| 99% | 2.33 |

Clamped to [0.50, 0.9999]: below 0.5 the buffer is negative, which is a modelling
error rather than a policy; above 0.9999 it grows without bound for no measurable
service improvement.

*Implementation: `src/core/policy/safety-stock.ts`.*

---

## 5. How much to order

Wilson's EOQ:

```
EOQ = √( 2 × D × S / H )
```

D = annual demand, S = fixed cost of raising an order, H = cost of holding one
unit for a year (default 22% of unit cost — capital, warehousing, insurance,
shrinkage, obsolescence).

The total-cost curve is famously **flat near its minimum**: being 20% away from
optimal costs about 2%. That is why rounding up to a supplier's case size is
nearly free, and why EOQ must never override a hard constraint.

### The (s, S) policy

Order when the inventory **position** — on hand *plus already on order* — falls to
the reorder point `s`, then order up to `S`.

Counting stock already on order is what stops the agent placing yesterday's order
again today. It is a one-line condition and its absence is one of the most common
causes of runaway automatic ordering.

```
order_up_to = d̄ × (LT + R) + SS
deficit     = order_up_to − position
quantity    = max(deficit, EOQ)                    then snapped to supplier rules
```

**Constraints in this order:** raise to the minimum first, then round *up* to the
case multiple. Rounding down could land below the minimum — and rounding down a
replenishment is how a system quietly re-creates the stockout it was preventing.

*Implementation: `src/core/policy/replenishment.ts`.*

---

## 6. Segmentation

A catalogue of 20,000 SKUs cannot be managed with one policy.

**ABC** by annual consumption value: A to 80% of cumulative value, B to 95%, C
the tail. The SKU that *crosses* a threshold joins the higher class — otherwise a
single dominant SKU worth 98% of the catalogue lands in class C, which is exactly
backwards. (This was a real defect caught by a test during development.)

**XYZ** by coefficient of variation of demand: X ≤ 0.5, Y ≤ 1.0, Z above.

The nine boxes set service level, review frequency and autonomy:

| | X (steady) | Y (variable) | Z (unpredictable) |
|---|---|---|---|
| **A** (98%, daily) | act within limits | act within limits | **propose only** |
| **B** (95%, 3-daily) | act within limits | act within limits | **propose only** |
| **C** (90%, weekly) | **act** | act within limits | act within limits |

The shape: **value raises the service level**, because a stockout on an A item
costs more; **unpredictability lowers autonomy**, because acting confidently on a
forecast nobody trusts is how an autonomous system destroys value. AZ always asks
a human; CX never needs to.

Ties are broken by SKU id so classes are stable between runs — a SKU flipping
between B and C on consecutive nights would churn its service level and its stock
with it.

*Implementation: `src/core/policy/classification.ts`.*

---

## 7. Anomaly detection

Separate from replenishment on purpose. An anomaly is a statement about the world
that a human can verify; a replenishment is a proposal about the future. Mixing
them produces alerts nobody can check and orders nobody can explain.

| Detector | Fires when | Costed as |
|---|---|---|
| `NEGATIVE_STOCK` | on-hand < 0 | Value of the discrepancy |
| `STOCKOUT_IMMINENT` | cover ≤ 3 days, nothing inbound | **Lost margin**, not lost revenue |
| `DEAD_STOCK` | no issue in 90 days, stock on hand | Capital tied up |
| `EXPIRY_RISK` | lots cannot sell before their date | Cost of the exposed units |
| `OVERSTOCK` | cover > 120 days | Cost of the surplus |
| `DEMAND_SPIKE` | robust z ≥ 3.5 against baseline | — |
| `DEMAND_COLLAPSE` | recent ≤ 35% of baseline | Cost of now-surplus stock |
| `SHRINKAGE` | losses ≥ 2% of throughput | Value lost |
| `SUPPLIER_UNRELIABLE` | lead-time CV ≥ 0.5 over ≥ 4 deliveries | — |

**Lost margin, not lost revenue.** The cost of goods is not incurred on a sale
that never happens. Reporting revenue overstates the impact by the cost of goods
and distorts every prioritisation built on it.

**Robust statistics for shift detection.** The standard deviation is inflated by
a single enormous outlier — exactly the thing being detected — enough to hide it.
The median absolute deviation, scaled by 1.4826, is unmoved by up to half the
sample being corrupt. There is a test that demonstrates the difference: one
outlier moves σ by more than 1000 while moving the MAD by less than 1.

**Shrinkage is cumulative.** A single count correction is bookkeeping; a steady
drip of them is theft, damage or a broken process, and it appears nowhere else
because each individual correction looks unremarkable.

*Implementation: `src/core/anomaly.ts`.*

---

## 8. Transfers before purchases

Moving stock that already exists is almost always cheaper than buying more while
a sister site scraps the same item.

The rule is deliberately conservative: **a donor must remain above its own
reorder point after giving.** Solving one site's problem can never create
another's. A transfer is proposed only when the movement cost is genuinely below
the purchase cost it avoids.

*Implementation: `proposeTransfers` in `src/core/agent/decision-engine.ts`.*

---

## References

- Syntetos, A. & Boylan, J. (2005). *The accuracy of intermittent demand estimates.*
- Croston, J. (1972). *Forecasting and stock control for intermittent demands.*
- Hyndman, R. & Koehler, A. (2006). *Another look at measures of forecast accuracy.* (MASE)
- Hyndman, R. & Athanasopoulos, G. *Forecasting: Principles and Practice.*
- Silver, Pyke & Thomas. *Inventory and Production Management in Supply Chains.*
- King, P. (2011). *Crack the code: understanding safety stock formulas.*
