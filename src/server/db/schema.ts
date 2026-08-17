/**
 * Database schema.
 *
 * Conventions that hold throughout:
 *
 *  - **Every tenant-scoped table carries `orgId`** and is protected by a
 *    row-level security policy (see `drizzle/0000_init.sql`). Multi-tenancy that
 *    depends on the application remembering a `WHERE` clause is multi-tenancy that
 *    leaks the first time someone forgets one.
 *  - **Money is two columns**: an integer of minor units and a currency code.
 *    There is no `numeric` money column anywhere, and no floats.
 *  - **Quantities are integers** in the SKU's stock unit.
 *  - **`stockMovements` is append-only.** A database trigger rejects UPDATE and
 *    DELETE, so the audit trail cannot be rewritten even with table access.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const now = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const userRole = pgEnum('user_role', ['owner', 'admin', 'planner', 'operator', 'viewer']);
export const movementKind = pgEnum('movement_kind', [
  'RECEIPT',
  'ISSUE',
  'RETURN',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'SCRAP',
  'ADJUSTMENT',
]);
export const decisionKind = pgEnum('decision_kind', [
  'REPLENISH',
  'HOLD_REPLENISHMENT',
  'TRANSFER',
  'MARKDOWN',
  'WRITE_OFF',
  'COUNT',
  'ALERT',
]);
export const decisionState = pgEnum('decision_state', [
  'proposed',
  'approved',
  'rejected',
  'executed',
  'blocked',
  'expired',
]);
export const autonomyLevel = pgEnum('autonomy_level', ['monitor', 'propose', 'act_within_limits', 'act']);
export const purchaseOrderState = pgEnum('purchase_order_state', [
  'draft',
  'placed',
  'part_received',
  'received',
  'cancelled',
]);
export const stockUnit = pgEnum('stock_unit', ['each', 'g', 'ml', 'cm']);

export const organisations = pgTable('organisations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** Default currency for the whole tenant. Per-SKU currencies must match it. */
  currency: char('currency', { length: 3 }).notNull().default('GBP'),
  /** IANA timezone, used to decide what "today" means for this tenant. */
  timezone: text('timezone').notNull().default('Europe/London'),
  autonomy: autonomyLevel('autonomy').notNull().default('propose'),
  /** Per-decision automatic spend limit, in minor units. */
  maxAutoValue: integer('max_auto_value').notNull().default(25_000),
  /** Daily automatic spend limit, in minor units. */
  maxDailyAutoValue: integer('max_daily_auto_value').notNull().default(250_000),
  minConfidence: real('min_confidence').notNull().default(0.6),
  agentPaused: boolean('agent_paused').notNull().default(false),
  createdAt: now(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    /** scrypt hash, formatted `scrypt$N$r$p$salt$hash`. Never a bare digest. */
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    role: userRole('role').notNull().default('viewer'),
    active: boolean('active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: now(),
  },
  (table) => [uniqueIndex('users_org_email_idx').on(table.orgId, table.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 of the session token. The raw token exists only in the cookie. */
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: now(),
  },
  (table) => [index('sessions_user_idx').on(table.userId)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Short non-secret prefix, so a key can be identified without revealing it. */
    prefix: text('prefix').notNull(),
    /** SHA-256 of the full key. The key itself is shown once and never stored. */
    keyHash: text('key_hash').notNull(),
    role: userRole('role').notNull().default('operator'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: now(),
  },
  (table) => [
    uniqueIndex('api_keys_hash_idx').on(table.keyHash),
    index('api_keys_org_idx').on(table.orgId),
  ],
);

export const sites = pgTable(
  'sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Whether the agent may propose transfers into and out of this site. */
    transfersEnabled: boolean('transfers_enabled').notNull().default(true),
    active: boolean('active').notNull().default(true),
    createdAt: now(),
  },
  (table) => [uniqueIndex('sites_org_code_idx').on(table.orgId, table.code)],
);

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    email: text('email'),
    nominalLeadTimeDays: integer('nominal_lead_time_days').notNull().default(7),
    minimumOrderQuantity: integer('minimum_order_quantity').notNull().default(1),
    orderMultiple: integer('order_multiple').notNull().default(1),
    /** Fixed cost of raising one order, in minor units. */
    orderingCost: integer('ordering_cost').notNull().default(2_500),
    active: boolean('active').notNull().default(true),
    createdAt: now(),
  },
  (table) => [uniqueIndex('suppliers_org_code_idx').on(table.orgId, table.code)],
);

export const skus = pgTable(
  'skus',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    stockUnit: stockUnit('stock_unit').notNull().default('each'),
    /** Purchase cost of one stock unit, in minor units. */
    unitCost: integer('unit_cost').notNull(),
    /** Sale price of one stock unit, in minor units. */
    unitPrice: integer('unit_price').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('GBP'),
    perishable: boolean('perishable').notNull().default(false),
    shelfLifeDays: integer('shelf_life_days'),
    supplierId: uuid('supplier_id').references(() => suppliers.id, { onDelete: 'set null' }),
    active: boolean('active').notNull().default(true),
    createdAt: now(),
  },
  (table) => [
    uniqueIndex('skus_org_code_idx').on(table.orgId, table.code),
    index('skus_org_active_idx').on(table.orgId, table.active),
  ],
);

/**
 * Per-SKU, per-site planning state.
 *
 * Segmentation and policy live here rather than on the SKU, because the same
 * product can be an A item at a flagship site and a C item at a depot, and it
 * should be managed differently at each.
 */
export const skuSites = pgTable(
  'sku_sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    abcClass: char('abc_class', { length: 1 }),
    xyzClass: char('xyz_class', { length: 1 }),
    /** Overrides the class-derived service level when set. */
    serviceLevelOverride: real('service_level_override'),
    /** Overrides the class-derived autonomy when set. */
    autonomyOverride: autonomyLevel('autonomy_override'),
    reorderPoint: integer('reorder_point'),
    safetyStock: integer('safety_stock'),
    orderUpToLevel: integer('order_up_to_level'),
    /** Cached on-hand, rebuilt from the ledger. Never the source of truth. */
    onHand: integer('on_hand').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    onOrder: integer('on_order').notNull().default(0),
    lastIssuedAt: timestamp('last_issued_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('sku_sites_unique_idx').on(table.skuId, table.siteId)],
);

export const lots = pgTable(
  'lots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    expiresOn: date('expires_on'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (table) => [
    index('lots_sku_site_idx').on(table.skuId, table.siteId),
    index('lots_expiry_idx').on(table.orgId, table.expiresOn),
  ],
);

/**
 * The append-only stock ledger. The single source of truth for what is in stock.
 *
 * `UPDATE` and `DELETE` are refused by a trigger. Corrections are made by
 * appending an `ADJUSTMENT`, which leaves both the error and its correction
 * visible — which is the entire point of an audit trail.
 */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'restrict' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'restrict' }),
    lotId: uuid('lot_id').references(() => lots.id, { onDelete: 'restrict' }),
    kind: movementKind('kind').notNull(),
    /** Positive for every kind except ADJUSTMENT, which is signed. */
    quantity: integer('quantity').notNull(),
    /** Who caused it: a user id, or `system:agent` for autonomous actions. */
    actor: text('actor').notNull(),
    reason: text('reason'),
    /** Links the movement to the decision that produced it, when autonomous. */
    decisionId: uuid('decision_id'),
    /** Caller-supplied key that makes a retried write a no-op. */
    idempotencyKey: text('idempotency_key'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (table) => [
    index('movements_sku_site_time_idx').on(table.skuId, table.siteId, table.occurredAt),
    index('movements_org_time_idx').on(table.orgId, table.occurredAt),
    uniqueIndex('movements_idempotency_idx').on(table.orgId, table.idempotencyKey),
  ],
);

/**
 * Periodic balance checkpoints.
 *
 * Purely a read optimisation: replaying five years of movements to answer "what
 * is on hand?" is correct but slow, so the projection starts from the newest
 * snapshot. A snapshot is always reconstructible and may be deleted at any time.
 */
export const stockSnapshots = pgTable(
  'stock_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    onHand: integer('on_hand').notNull(),
    /** Movements at or before this instant are folded into `onHand`. */
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    movementCount: integer('movement_count').notNull().default(0),
    createdAt: now(),
  },
  (table) => [index('snapshots_lookup_idx').on(table.skuId, table.siteId, table.asOf)],
);

export const dailyDemand = pgTable(
  'daily_demand',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    quantity: integer('quantity').notNull().default(0),
  },
  (table) => [uniqueIndex('daily_demand_unique_idx').on(table.skuId, table.siteId, table.day)],
);

export const forecasts = pgTable(
  'forecasts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    method: text('method').notNull(),
    demandPattern: text('demand_pattern').notNull(),
    dailyRate: real('daily_rate').notNull(),
    residualStdDev: real('residual_std_dev').notNull(),
    mase: real('mase'),
    confidence: real('confidence').notNull(),
    /** Fitted parameters and leaderboard, kept so a forecast can be reproduced. */
    detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
    horizonDays: integer('horizon_days').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('forecasts_lookup_idx').on(table.skuId, table.siteId, table.computedAt)],
);

/**
 * Autonomous decisions, with the reasoning that produced them.
 *
 * `inputHash` fingerprints the state the decision was made from, so a decision can
 * be replayed and verified rather than merely believed.
 */
export const decisions = pgTable(
  'decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    /** Deterministic id from the engine. Makes a re-run idempotent. */
    fingerprint: text('fingerprint').notNull(),
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    kind: decisionKind('kind').notNull(),
    state: decisionState('state').notNull().default('proposed'),
    quantity: integer('quantity'),
    /** Value committed or destroyed, in minor units. */
    value: integer('value').notNull().default(0),
    /** Value the decision is expected to protect, in minor units. */
    expectedBenefit: integer('expected_benefit').notNull().default(0),
    currency: char('currency', { length: 3 }).notNull().default('GBP'),
    confidence: real('confidence').notNull(),
    severity: text('severity').notNull(),
    /** Ordered rationale lines, shown verbatim in the console. */
    rationale: jsonb('rationale').notNull().default(sql`'[]'::jsonb`),
    evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
    /** Why the autonomy gate reached its outcome. */
    gateReasons: jsonb('gate_reasons').notNull().default(sql`'[]'::jsonb`),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    createdAt: now(),
  },
  (table) => [
    uniqueIndex('decisions_fingerprint_idx').on(table.orgId, table.fingerprint),
    index('decisions_queue_idx').on(table.orgId, table.state, table.createdAt),
    index('decisions_sku_idx').on(table.skuId, table.siteId),
  ],
);

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    reference: text('reference').notNull(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'restrict' }),
    state: purchaseOrderState('state').notNull().default('draft'),
    /** The decision that raised it, when the agent did. */
    decisionId: uuid('decision_id').references(() => decisions.id, { onDelete: 'set null' }),
    totalValue: integer('total_value').notNull().default(0),
    currency: char('currency', { length: 3 }).notNull().default('GBP'),
    expectedAt: date('expected_at'),
    placedAt: timestamp('placed_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    createdAt: now(),
  },
  (table) => [
    uniqueIndex('po_org_reference_idx').on(table.orgId, table.reference),
    index('po_state_idx').on(table.orgId, table.state),
  ],
);

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'restrict' }),
    quantityOrdered: integer('quantity_ordered').notNull(),
    quantityReceived: integer('quantity_received').notNull().default(0),
    unitCost: integer('unit_cost').notNull(),
  },
  (table) => [index('po_lines_order_idx').on(table.purchaseOrderId)],
);

/** One execution of the autonomous agent. The unit of operational observability. */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    skusEvaluated: integer('skus_evaluated').notNull().default(0),
    decisionsProposed: integer('decisions_proposed').notNull().default(0),
    decisionsExecuted: integer('decisions_executed').notNull().default(0),
    decisionsBlocked: integer('decisions_blocked').notNull().default(0),
    /** Value automatically committed during the run, in minor units. */
    valueCommitted: integer('value_committed').notNull().default(0),
    error: text('error'),
  },
  (table) => [index('agent_runs_org_idx').on(table.orgId, table.startedAt)],
);

/**
 * Immutable audit trail of every state-changing action.
 *
 * Separate from `stockMovements`, which records what happened to *stock*; this
 * records what happened to the *system* — logins, approvals, policy changes, key
 * rotations. Both are append-only.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    /** Before/after payload, with secrets already redacted by the caller. */
    detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: now(),
  },
  (table) => [index('audit_org_time_idx').on(table.orgId, table.createdAt)],
);

/** Replay protection for unsafe API calls. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** Hash of the request body, so the same key with a different body is rejected. */
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: now(),
  },
  (table) => [uniqueIndex('idempotency_unique_idx').on(table.orgId, table.key)],
);

export const organisationsRelations = relations(organisations, ({ many }) => ({
  users: many(users),
  sites: many(sites),
  skus: many(skus),
}));

export const skusRelations = relations(skus, ({ one, many }) => ({
  organisation: one(organisations, { fields: [skus.orgId], references: [organisations.id] }),
  supplier: one(suppliers, { fields: [skus.supplierId], references: [suppliers.id] }),
  movements: many(stockMovements),
  skuSites: many(skuSites),
}));

export const stockMovementsRelations = relations(stockMovements, ({ one }) => ({
  sku: one(skus, { fields: [stockMovements.skuId], references: [skus.id] }),
  site: one(sites, { fields: [stockMovements.siteId], references: [sites.id] }),
  lot: one(lots, { fields: [stockMovements.lotId], references: [lots.id] }),
}));

export const decisionsRelations = relations(decisions, ({ one }) => ({
  sku: one(skus, { fields: [decisions.skuId], references: [skus.id] }),
  site: one(sites, { fields: [decisions.siteId], references: [sites.id] }),
  run: one(agentRuns, { fields: [decisions.runId], references: [agentRuns.id] }),
}));

export type Organisation = typeof organisations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Site = typeof sites.$inferSelect;
export type SkuRow = typeof skus.$inferSelect;
export type SupplierRow = typeof suppliers.$inferSelect;
export type StockMovementRow = typeof stockMovements.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type NewStockMovement = typeof stockMovements.$inferInsert;
export type NewDecision = typeof decisions.$inferInsert;
