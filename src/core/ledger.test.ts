import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDays,
  allocateFefo,
  daysBetween,
  InvalidMovementError,
  movementDelta,
  projectPosition,
  quantityAtExpiryRisk,
  validateMovement,
  type StockMovement,
} from './ledger.ts';
import { makeMovement, resetMovementIds } from '@/testing/fixtures';

beforeEach(resetMovementIds);

describe('movementDelta', () => {
  it('adds for inbound kinds', () => {
    expect(movementDelta(makeMovement({ kind: 'RECEIPT', quantity: 10 }))).toBe(10);
    expect(movementDelta(makeMovement({ kind: 'RETURN', quantity: 3 }))).toBe(3);
    expect(movementDelta(makeMovement({ kind: 'TRANSFER_IN', quantity: 7 }))).toBe(7);
  });

  it('subtracts for outbound kinds', () => {
    expect(movementDelta(makeMovement({ kind: 'ISSUE', quantity: 10 }))).toBe(-10);
    expect(movementDelta(makeMovement({ kind: 'SCRAP', quantity: 2 }))).toBe(-2);
    expect(movementDelta(makeMovement({ kind: 'TRANSFER_OUT', quantity: 5 }))).toBe(-5);
  });

  it('takes the sign from the caller only for adjustments', () => {
    expect(movementDelta(makeMovement({ kind: 'ADJUSTMENT', quantity: -4 }))).toBe(-4);
    expect(movementDelta(makeMovement({ kind: 'ADJUSTMENT', quantity: 4 }))).toBe(4);
  });

  it('refuses a negative quantity on a directional kind', () => {
    expect(() => movementDelta(makeMovement({ kind: 'ISSUE', quantity: -5 }))).toThrow(
      InvalidMovementError,
    );
  });

  it('refuses a fractional quantity', () => {
    expect(() => movementDelta(makeMovement({ quantity: 1.5 }))).toThrow(InvalidMovementError);
  });
});

describe('projectPosition', () => {
  it('derives on-hand by replaying the movement sequence', () => {
    const movements = [
      makeMovement({ kind: 'RECEIPT', quantity: 100, occurredAt: '2026-06-01T09:00:00.000Z' }),
      makeMovement({ kind: 'ISSUE', quantity: 30, occurredAt: '2026-06-02T09:00:00.000Z' }),
      makeMovement({ kind: 'ISSUE', quantity: 20, occurredAt: '2026-06-03T09:00:00.000Z' }),
      makeMovement({ kind: 'RETURN', quantity: 5, occurredAt: '2026-06-04T09:00:00.000Z' }),
    ];

    const position = projectPosition('sku_flour', 'site_main', movements);

    expect(position.onHand).toBe(55);
    expect(position.available).toBe(55);
    expect(position.movementCount).toBe(4);
    expect(position.asOf).toBe('2026-06-04T09:00:00.000Z');
  });

  it('gives the same answer regardless of the order movements arrive in', () => {
    const movements = [
      makeMovement({ kind: 'RECEIPT', quantity: 100, occurredAt: '2026-06-01T09:00:00.000Z' }),
      makeMovement({ kind: 'ISSUE', quantity: 30, occurredAt: '2026-06-02T09:00:00.000Z' }),
      makeMovement({ kind: 'SCRAP', quantity: 4, occurredAt: '2026-06-03T09:00:00.000Z' }),
    ];

    const forwards = projectPosition('sku_flour', 'site_main', movements);
    const backwards = projectPosition('sku_flour', 'site_main', [...movements].reverse());

    expect(backwards.onHand).toBe(forwards.onHand);
    expect(backwards.asOf).toBe(forwards.asOf);
  });

  it('ignores movements belonging to other SKUs or sites', () => {
    const movements = [
      makeMovement({ kind: 'RECEIPT', quantity: 100 }),
      makeMovement({ kind: 'RECEIPT', quantity: 999, skuId: 'sku_other' }),
      makeMovement({ kind: 'RECEIPT', quantity: 999, siteId: 'site_other' }),
    ];

    expect(projectPosition('sku_flour', 'site_main', movements).onHand).toBe(100);
  });

  it('reconstructs a historical position with asOf', () => {
    const movements = [
      makeMovement({ kind: 'RECEIPT', quantity: 100, occurredAt: '2026-06-01T09:00:00.000Z' }),
      makeMovement({ kind: 'ISSUE', quantity: 40, occurredAt: '2026-06-10T09:00:00.000Z' }),
    ];

    const asOf = projectPosition('sku_flour', 'site_main', movements, {
      asOf: '2026-06-05T00:00:00.000Z',
    });

    expect(asOf.onHand).toBe(100);
    expect(asOf.movementCount).toBe(1);
  });

  it('replays from a snapshot without re-reading history', () => {
    const movements = [makeMovement({ kind: 'ISSUE', quantity: 10 })];
    expect(projectPosition('sku_flour', 'site_main', movements, { openingBalance: 500 }).onHand).toBe(490);
  });

  it('subtracts reservations to give a committable figure', () => {
    const movements = [makeMovement({ kind: 'RECEIPT', quantity: 100 })];
    const position = projectPosition('sku_flour', 'site_main', movements, { reserved: 30 });

    expect(position.onHand).toBe(100);
    expect(position.reserved).toBe(30);
    expect(position.available).toBe(70);
  });

  it('tracks per-lot balances and drops lots that net to zero', () => {
    const movements = [
      makeMovement({ kind: 'RECEIPT', quantity: 50, lotId: 'lot_a' }),
      makeMovement({ kind: 'RECEIPT', quantity: 50, lotId: 'lot_b' }),
      makeMovement({ kind: 'ISSUE', quantity: 50, lotId: 'lot_a' }),
    ];

    const position = projectPosition('sku_flour', 'site_main', movements);

    expect(position.byLot).toEqual([{ lotId: 'lot_b', quantity: 50 }]);
  });

  it('returns an empty position for a SKU with no history', () => {
    const position = projectPosition('sku_flour', 'site_main', []);
    expect(position.onHand).toBe(0);
    expect(position.asOf).toBeNull();
  });
});

describe('validateMovement', () => {
  const position = projectPosition('sku_flour', 'site_main', [
    makeMovement({ kind: 'RECEIPT', quantity: 20, lotId: 'lot_a' }),
  ]);

  it('accepts an issue that stock can cover', () => {
    const movement = makeMovement({ kind: 'ISSUE', quantity: 10 });
    expect(validateMovement(movement, position)).toEqual({ ok: true });
  });

  it('rejects an issue that would drive on-hand negative', () => {
    const movement = makeMovement({ kind: 'ISSUE', quantity: 50 });
    const result = validateMovement(movement, position);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/negative/i);
  });

  it('allows the override, because a stock-take must be able to book reality', () => {
    const movement = makeMovement({ kind: 'ISSUE', quantity: 50 });
    expect(validateMovement(movement, position, { allowNegative: true })).toEqual({ ok: true });
  });

  it('rejects a zero-quantity movement as meaningless', () => {
    const result = validateMovement(makeMovement({ quantity: 0 }), position);
    expect(result.ok).toBe(false);
  });

  it('rejects issuing more than a specific lot holds, even when total stock covers it', () => {
    // 50 on hand across two lots, so the aggregate check passes and only the
    // per-lot rule can catch this.
    const twoLots = projectPosition('sku_flour', 'site_main', [
      makeMovement({ kind: 'RECEIPT', quantity: 20, lotId: 'lot_a' }),
      makeMovement({ kind: 'RECEIPT', quantity: 30, lotId: 'lot_b' }),
    ]);
    const movement = makeMovement({ kind: 'ISSUE', quantity: 25, lotId: 'lot_a' });
    const result = validateMovement(movement, twoLots);

    expect(twoLots.onHand).toBe(50);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/lot_a/);
  });

  it('surfaces a malformed movement as a reason rather than throwing', () => {
    const movement = { ...makeMovement({ kind: 'ISSUE' }), quantity: -5 } as StockMovement;
    const result = validateMovement(movement, position);
    expect(result.ok).toBe(false);
  });
});

describe('allocateFefo', () => {
  const lots = [
    { id: 'lot_late', quantity: 10, receivedAt: '2026-01-01T00:00:00.000Z', expiresOn: '2026-12-31' },
    { id: 'lot_soon', quantity: 5, receivedAt: '2026-06-01T00:00:00.000Z', expiresOn: '2026-07-01' },
    { id: 'lot_mid', quantity: 8, receivedAt: '2026-03-01T00:00:00.000Z', expiresOn: '2026-09-01' },
  ];

  it('consumes the soonest-expiring lot first, not the oldest', () => {
    // lot_soon was received *last* but expires first, so FEFO must pick it.
    const result = allocateFefo(lots, 6);

    expect(result.allocations[0]?.lotId).toBe('lot_soon');
    expect(result.allocations[0]?.quantity).toBe(5);
    expect(result.allocations[1]?.lotId).toBe('lot_mid');
    expect(result.allocations[1]?.quantity).toBe(1);
    expect(result.shortfall).toBe(0);
  });

  it('reports the uncovered remainder rather than over-allocating', () => {
    const result = allocateFefo(lots, 100);
    const allocated = result.allocations.reduce((acc, a) => acc + a.quantity, 0);

    expect(allocated).toBe(23);
    expect(result.shortfall).toBe(77);
  });

  it('falls back to FIFO for lots with no expiry date', () => {
    const undated = [
      { id: 'lot_new', quantity: 5, receivedAt: '2026-06-01T00:00:00.000Z' },
      { id: 'lot_old', quantity: 5, receivedAt: '2026-01-01T00:00:00.000Z' },
    ];

    expect(allocateFefo(undated, 3).allocations[0]?.lotId).toBe('lot_old');
  });

  it('places dated lots ahead of undated ones', () => {
    const mixed = [
      { id: 'lot_undated', quantity: 5, receivedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'lot_dated', quantity: 5, receivedAt: '2026-06-01T00:00:00.000Z', expiresOn: '2026-08-01' },
    ];

    expect(allocateFefo(mixed, 1).allocations[0]?.lotId).toBe('lot_dated');
  });

  it('skips empty lots and handles zero demand', () => {
    expect(allocateFefo([{ id: 'empty', quantity: 0, receivedAt: '2026-01-01T00:00:00.000Z' }], 5))
      .toEqual({ allocations: [], shortfall: 5 });
    expect(allocateFefo(lots, 0)).toEqual({ allocations: [], shortfall: 0 });
  });

  it('rejects negative demand', () => {
    expect(() => allocateFefo(lots, -1)).toThrow(RangeError);
  });
});

describe('quantityAtExpiryRisk', () => {
  it('counts only what demand cannot absorb before expiry', () => {
    const lots = [
      { id: 'a', quantity: 10, receivedAt: '2026-01-01T00:00:00.000Z', expiresOn: '2026-01-03' },
      { id: 'b', quantity: 10, receivedAt: '2026-01-01T00:00:00.000Z', expiresOn: '2026-01-11' },
    ];

    // At 2/day: lot a has 2 days (4 units sellable, 6 at risk); lot b has 10 days
    // (20 units of demand, less the 4 already claimed, so all 10 sell).
    expect(quantityAtExpiryRisk(lots, 2, '2026-01-01')).toBe(6);
  });

  it('treats already-expired stock as entirely at risk', () => {
    const lots = [
      { id: 'a', quantity: 10, receivedAt: '2026-01-01T00:00:00.000Z', expiresOn: '2025-12-31' },
    ];
    expect(quantityAtExpiryRisk(lots, 100, '2026-01-01')).toBe(10);
  });

  it('puts everything at risk when there is no demand at all', () => {
    const lots = [
      { id: 'a', quantity: 10, receivedAt: '2026-01-01T00:00:00.000Z', expiresOn: '2026-06-01' },
    ];
    expect(quantityAtExpiryRisk(lots, 0, '2026-01-01')).toBe(10);
  });

  it('ignores lots with no expiry date', () => {
    const lots = [{ id: 'a', quantity: 10, receivedAt: '2026-01-01T00:00:00.000Z' }];
    expect(quantityAtExpiryRisk(lots, 0, '2026-01-01')).toBe(0);
  });

  it('rejects negative demand', () => {
    expect(() => quantityAtExpiryRisk([], -1, '2026-01-01')).toThrow(RangeError);
  });
});

describe('date helpers', () => {
  it('counts whole days between dates', () => {
    expect(daysBetween('2026-01-01', '2026-01-11')).toBe(10);
    expect(daysBetween('2026-01-11', '2026-01-01')).toBe(-10);
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('crosses month and year boundaries', () => {
    expect(daysBetween('2026-02-27', '2026-03-01')).toBe(2);
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });

  it('handles a leap day', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('adds days across boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('rejects malformed dates instead of returning NaN', () => {
    expect(() => daysBetween('not-a-date', '2026-01-01')).toThrow(TypeError);
    expect(() => addDays('2026-13-45', 1)).toThrow(TypeError);
  });
});
