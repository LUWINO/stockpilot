/**
 * The StockPilot domain core.
 *
 * Everything exported here is pure: no I/O, no clock, no randomness, no
 * environment. That constraint is the reason the system can be trusted to act on
 * its own — the decision logic can be exhaustively tested, and any decision it
 * ever made can be replayed from its recorded inputs and will produce the same
 * answer.
 *
 * Nothing in this directory may import from `src/server`, `src/app` or `src/worker`.
 * The dependency arrow points inward, always.
 */

export * from './types.ts';
export * from './money.ts';
export * from './stats.ts';
export * from './ledger.ts';
export * from './anomaly.ts';

export * from './forecast/methods.ts';
export * from './forecast/backtest.ts';
export * from './forecast/select.ts';

export * from './policy/safety-stock.ts';
export * from './policy/replenishment.ts';
export * from './policy/classification.ts';

export * from './agent/autonomy.ts';
export * from './agent/decision-engine.ts';
