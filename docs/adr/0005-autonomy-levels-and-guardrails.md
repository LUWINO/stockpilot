# ADR-0005: Autonomy levels and guardrails

**Status:** Accepted · **Date:** 2026-08-17

## Context

An inventory system that can raise purchase orders can lose money quickly and
quietly. The failure is rarely a dramatic bug; it is a plausible-looking decision
made from bad data, repeated across a catalogue before anyone notices.

Two designs fail in opposite directions. **Fully manual** means the system is a
report, and its value depends on somebody reading it. **Fully automatic** means a
data quality problem becomes a five-figure purchasing problem overnight.

The organisations buying this also differ enormously in appetite. A bakery with
forty SKUs and a hospital pharmacy should not be forced to the same setting.

## Decision

A **pure, deny-by-default gate** through which every decision passes before
anything happens.

Four levels — `monitor`, `propose`, `act_within_limits`, `act` — set both
organisation-wide and per SKU segment, with **the tighter of the two always
winning.** Raising the global setting can never promote a volatile, high-value
item to fully automatic.

Three independent limits: a per-decision value cap, a daily budget, and a
confidence floor. Any one failing downgrades to `propose`.

Two kinds always require a human: `WRITE_OFF` and `MARKDOWN`. Both permanently
give up value, and neither is ever urgent enough to justify skipping a human. A
wrong replenishment can be returned or sold later; a wrong write-off is gone.
That asymmetry, not the size of the number, is the criterion.

Every rule that fires is recorded on the decision, including rules that fire
after the outcome is already settled.

## Why the gate is pure and separate

It contains no forecasting and no optimisation — just limits applied to a
finished decision. That makes it small enough to read in one sitting, exhaustively
testable, and impossible to influence from anywhere else. A guardrail whose
behaviour depends on context you have to reason about is not a guardrail.

## Alternatives considered

**A single "automation level" dial.** Too coarse. Value, predictability and
decision kind are genuinely different axes, and collapsing them means either
over-restricting the routine or under-restricting the risky.

**Learned thresholds.** A system that adjusts its own limits based on past
approvals is a system that can be trained to approve anything. The limits are the
one thing that must not adapt.

**Approval workflows with escalation chains.** Real need in large organisations,
but it belongs in a workflow tool. The gate produces the decision and the reason;
routing is somebody else's problem.

## Consequences

**Good.** A conservative default that a cautious customer can accept unchanged. A
documented rollout path from observation to autonomy. Blast radius bounded by two
independent caps. Every automatic action explainable after the fact.

**Bad.** More configuration to understand. Set too conservatively, the queue
grows and gets rubber-stamped — which produces the cost of oversight without the
benefit. [AUTONOMY.md](../AUTONOMY.md) calls this out as the thing to watch for.

**Accepted risk.** A patient attacker inflating demand slowly, staying inside the
caps, would not be caught by the current detectors. Mitigated operationally by
reviewing committed value per SKU over time. Recorded in the
[threat model](../THREAT-MODEL.md).
