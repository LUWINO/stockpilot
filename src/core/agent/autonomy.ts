/**
 * Autonomy guardrails.
 *
 * An autonomous system that can spend money needs a boundary it cannot argue its
 * way past. This module is that boundary. It is deliberately dumb: no forecasting,
 * no optimisation, just a set of hard limits applied to a finished decision.
 *
 * Three properties make it trustworthy:
 *
 *  - **Deny by default.** Anything not explicitly permitted is proposed to a human
 *    rather than executed.
 *  - **Pure.** The gate is a function of the decision, the policy and the day's
 *    spend so far. It cannot be influenced by anything else, and the same inputs
 *    always produce the same outcome.
 *  - **Explained.** Every outcome carries the reasons that produced it, and those
 *    reasons are persisted with the decision.
 *
 * The effective limit is always the *tighter* of the organisation-wide policy and
 * the SKU segment's own autonomy level, so loosening the global setting can never
 * silently promote an AZ item to fully automatic.
 */

import { compare, type Money, add, isPositive } from '../money.ts';
import type { AutonomyLevel } from '../policy/classification.ts';

/** What the agent is permitted to do with a decision. */
export type GateOutcome =
  /** Carry it out now. */
  | 'execute'
  /** Write it to the approval queue for a human. */
  | 'propose'
  /** Record it but take no action — a limit or a kill switch forbids it. */
  | 'block';

export type DecisionKind =
  | 'REPLENISH'
  | 'HOLD_REPLENISHMENT'
  | 'TRANSFER'
  | 'MARKDOWN'
  | 'WRITE_OFF'
  | 'COUNT'
  | 'ALERT';

export interface AutonomyPolicy {
  /** Organisation-wide ceiling. Never overridden upward by a segment. */
  readonly level: AutonomyLevel;
  /** Largest value a single decision may commit without approval. */
  readonly maxAutoValue: Money;
  /** Cumulative value the agent may commit per day without approval. */
  readonly maxDailyAutoValue: Money;
  /** Minimum confidence for automatic execution, in [0, 1]. */
  readonly minConfidence: number;
  /** Kinds that always require a human regardless of value or confidence. */
  readonly alwaysApprove: readonly DecisionKind[];
  /** Global kill switch. When true, nothing executes automatically. */
  readonly paused: boolean;
}

/**
 * Conservative starting configuration.
 *
 * Write-offs and markdowns always ask, because both destroy value irreversibly and
 * neither is ever urgent enough to justify skipping a human. Replenishment is the
 * only kind that spends money automatically, and only within limits.
 */
export const DEFAULT_AUTONOMY: AutonomyPolicy = {
  level: 'act_within_limits',
  maxAutoValue: { amount: 250_00, currency: 'GBP' },
  maxDailyAutoValue: { amount: 2_500_00, currency: 'GBP' },
  minConfidence: 0.6,
  alwaysApprove: ['WRITE_OFF', 'MARKDOWN'],
  paused: false,
};

export interface GateInput {
  readonly kind: DecisionKind;
  /** Money the decision commits or destroys. Zero for advisory decisions. */
  readonly value: Money;
  readonly confidence: number;
  /** The SKU segment's own ceiling, from the ABC/XYZ policy matrix. */
  readonly segmentAutonomy: AutonomyLevel;
  readonly policy: AutonomyPolicy;
  /** Value already committed automatically today, for the daily budget check. */
  readonly committedToday: Money;
}

export interface GateResult {
  readonly outcome: GateOutcome;
  /** Every rule that fired, in evaluation order. Persisted with the decision. */
  readonly reasons: readonly string[];
  /** The tighter of the org and segment levels, recorded for the audit trail. */
  readonly effectiveLevel: AutonomyLevel;
}

const LEVEL_RANK: Record<AutonomyLevel, number> = {
  monitor: 0,
  propose: 1,
  act_within_limits: 2,
  act: 3,
};

/** The more restrictive of two autonomy levels. */
export function tightest(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b;
}

/**
 * Decide what may happen to a decision.
 *
 * Checks run cheapest and most absolute first, and every failed check is recorded
 * even once the outcome is settled — an operator asking "why did this not run?"
 * deserves all of the reasons, not just the first one.
 */
export function gate(input: GateInput): GateResult {
  const { kind, value, confidence, segmentAutonomy, policy, committedToday } = input;
  const effectiveLevel = tightest(policy.level, segmentAutonomy);
  const reasons: string[] = [];

  // Advisory decisions commit nothing, so they are always allowed to be recorded.
  if (kind === 'ALERT' || kind === 'COUNT' || kind === 'HOLD_REPLENISHMENT') {
    return {
      outcome: 'execute',
      reasons: ['Advisory decision: records a finding without committing value.'],
      effectiveLevel,
    };
  }

  let blocked = false;
  let mustPropose = false;

  if (policy.paused) {
    reasons.push('Autonomy is paused organisation-wide; no decision executes automatically.');
    blocked = true;
  }

  if (effectiveLevel === 'monitor') {
    reasons.push('Effective autonomy is monitor-only: findings are recorded, nothing acts.');
    blocked = true;
  }

  if (effectiveLevel === 'propose') {
    reasons.push(
      `Effective autonomy is propose-only for this segment (org: ${policy.level}, segment: ${segmentAutonomy}).`,
    );
    mustPropose = true;
  }

  if (policy.alwaysApprove.includes(kind)) {
    reasons.push(`${kind} always requires human approval by policy.`);
    mustPropose = true;
  }

  if (confidence < policy.minConfidence) {
    reasons.push(
      `Confidence ${confidence.toFixed(2)} is below the automatic-execution floor of ${policy.minConfidence.toFixed(2)}.`,
    );
    mustPropose = true;
  }

  if (effectiveLevel !== 'act' && isPositive(value)) {
    if (value.currency !== policy.maxAutoValue.currency) {
      reasons.push(
        `Decision is denominated in ${value.currency} but limits are set in ${policy.maxAutoValue.currency}; cannot verify the limit.`,
      );
      mustPropose = true;
    } else {
      if (compare(value, policy.maxAutoValue) > 0) {
        reasons.push(
          `Value ${value.amount / 100} exceeds the per-decision limit of ${policy.maxAutoValue.amount / 100}.`,
        );
        mustPropose = true;
      }

      if (committedToday.currency === value.currency) {
        const projected = add(committedToday, value);
        if (compare(projected, policy.maxDailyAutoValue) > 0) {
          reasons.push(
            `Would take today's automatic spend to ${projected.amount / 100}, past the daily cap of ${policy.maxDailyAutoValue.amount / 100}.`,
          );
          mustPropose = true;
        }
      }
    }
  }

  if (blocked) return { outcome: 'block', reasons, effectiveLevel };
  if (mustPropose) return { outcome: 'propose', reasons, effectiveLevel };

  return {
    outcome: 'execute',
    reasons: [
      `Within all limits: value ${value.amount / 100} ${value.currency} ≤ ${policy.maxAutoValue.amount / 100}, ` +
        `confidence ${confidence.toFixed(2)} ≥ ${policy.minConfidence.toFixed(2)}, effective autonomy ${effectiveLevel}.`,
    ],
    effectiveLevel,
  };
}
