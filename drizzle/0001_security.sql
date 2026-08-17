-- StockPilot security migration.
--
-- The generated 0000_init.sql creates the shape of the database. This migration
-- adds the guarantees: tenant isolation that does not depend on the application
-- remembering a WHERE clause, an audit trail that cannot be rewritten, and
-- integrity constraints that make invalid states unrepresentable.
--
-- Everything here is idempotent so that re-running a partially applied migration
-- is safe.

--------------------------------------------------------------------------------
-- 1. Integrity constraints
--------------------------------------------------------------------------------
-- These encode domain rules that the application also enforces. The duplication
-- is deliberate: the application check gives a good error message, the database
-- check means a bug, a migration script or a psql session cannot bypass it.

ALTER TABLE "stock_movements"
  DROP CONSTRAINT IF EXISTS "movements_quantity_nonzero",
  ADD CONSTRAINT "movements_quantity_nonzero" CHECK (quantity <> 0);

-- Only an ADJUSTMENT may carry a negative quantity; for every other kind the
-- direction comes from the kind itself, so a negative value would mean the sign
-- was applied twice.
ALTER TABLE "stock_movements"
  DROP CONSTRAINT IF EXISTS "movements_sign_matches_kind",
  ADD CONSTRAINT "movements_sign_matches_kind"
    CHECK (kind = 'ADJUSTMENT' OR quantity > 0);

ALTER TABLE "skus"
  DROP CONSTRAINT IF EXISTS "skus_costs_non_negative",
  ADD CONSTRAINT "skus_costs_non_negative" CHECK (unit_cost >= 0 AND unit_price >= 0);

ALTER TABLE "skus"
  DROP CONSTRAINT IF EXISTS "skus_shelf_life_positive",
  ADD CONSTRAINT "skus_shelf_life_positive"
    CHECK (shelf_life_days IS NULL OR shelf_life_days > 0);

-- A perishable SKU without a shelf life cannot have its expiry risk computed.
ALTER TABLE "skus"
  DROP CONSTRAINT IF EXISTS "skus_perishable_has_shelf_life",
  ADD CONSTRAINT "skus_perishable_has_shelf_life"
    CHECK (perishable = false OR shelf_life_days IS NOT NULL);

ALTER TABLE "suppliers"
  DROP CONSTRAINT IF EXISTS "suppliers_order_rules_positive",
  ADD CONSTRAINT "suppliers_order_rules_positive"
    CHECK (nominal_lead_time_days >= 0 AND minimum_order_quantity >= 0 AND order_multiple >= 1);

ALTER TABLE "decisions"
  DROP CONSTRAINT IF EXISTS "decisions_confidence_range",
  ADD CONSTRAINT "decisions_confidence_range" CHECK (confidence >= 0 AND confidence <= 1);

ALTER TABLE "organisations"
  DROP CONSTRAINT IF EXISTS "organisations_limits_sane",
  ADD CONSTRAINT "organisations_limits_sane"
    CHECK (
      max_auto_value >= 0
      AND max_daily_auto_value >= max_auto_value
      AND min_confidence >= 0
      AND min_confidence <= 1
    );

ALTER TABLE "purchase_order_lines"
  DROP CONSTRAINT IF EXISTS "po_lines_quantities_sane",
  ADD CONSTRAINT "po_lines_quantities_sane"
    CHECK (quantity_ordered > 0 AND quantity_received >= 0 AND quantity_received <= quantity_ordered);

--------------------------------------------------------------------------------
-- 2. Append-only enforcement
--------------------------------------------------------------------------------
-- The stock ledger and the audit log are the two tables whose value depends
-- entirely on being unfalsifiable. A trigger refuses UPDATE and DELETE outright.
-- Corrections happen by appending an ADJUSTMENT, which leaves both the original
-- error and its correction on the record.

CREATE OR REPLACE FUNCTION stockpilot_refuse_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only; % is not permitted. Append a correcting row instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "stock_movements_append_only" ON "stock_movements";
CREATE TRIGGER "stock_movements_append_only"
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION stockpilot_refuse_mutation();

DROP TRIGGER IF EXISTS "audit_log_append_only" ON "audit_log";
CREATE TRIGGER "audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION stockpilot_refuse_mutation();

--------------------------------------------------------------------------------
-- 3. Row-level security
--------------------------------------------------------------------------------
-- Every tenant-scoped table is filtered by the org id carried in a session-local
-- GUC. The application sets it once when it checks out a connection
-- (`set_config('stockpilot.org_id', $1, true)`), and from then on a forgotten
-- WHERE clause returns nothing rather than another tenant's data.
--
-- `true` as the third argument to set_config scopes the setting to the
-- transaction, so a pooled connection cannot leak it into the next request.

CREATE OR REPLACE FUNCTION stockpilot_current_org() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('stockpilot.org_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  target text;
  tenant_tables text[] := ARRAY[
    'users', 'sessions', 'api_keys', 'sites', 'suppliers', 'skus', 'sku_sites',
    'lots', 'stock_movements', 'stock_snapshots', 'daily_demand', 'forecasts',
    'decisions', 'purchase_orders', 'purchase_order_lines', 'agent_runs',
    'audit_log', 'idempotency_keys'
  ];
BEGIN
  FOREACH target IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    -- FORCE applies the policy to the table owner too. Without it, the role that
    -- owns the schema silently bypasses every policy, which is usually the same
    -- role the application connects as.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', target || '_tenant_isolation', target);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = stockpilot_current_org()) WITH CHECK (org_id = stockpilot_current_org())',
      target || '_tenant_isolation', target
    );
  END LOOP;
END;
$$;

-- The organisations table is keyed by `id` rather than `org_id`, so it needs its
-- own policy: a tenant may read only its own row.
ALTER TABLE "organisations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organisations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organisations_tenant_isolation" ON "organisations";
CREATE POLICY "organisations_tenant_isolation" ON "organisations"
  USING (id = stockpilot_current_org())
  WITH CHECK (id = stockpilot_current_org());

--------------------------------------------------------------------------------
-- 4. Operational indexes
--------------------------------------------------------------------------------
-- Partial indexes for the two hot paths: the decision inbox (a handful of
-- proposed rows out of millions) and expiry sweeps (only dated lots matter).

CREATE INDEX IF NOT EXISTS "decisions_pending_idx"
  ON "decisions" (org_id, created_at DESC)
  WHERE state = 'proposed';

CREATE INDEX IF NOT EXISTS "lots_expiring_idx"
  ON "lots" (org_id, expires_on)
  WHERE expires_on IS NOT NULL;

CREATE INDEX IF NOT EXISTS "sessions_expiry_idx"
  ON "sessions" (expires_at);

-- Rebuilding a position replays movements for one SKU at one site in time order.
CREATE INDEX IF NOT EXISTS "movements_replay_idx"
  ON "stock_movements" (org_id, sku_id, site_id, occurred_at, id);

--------------------------------------------------------------------------------
-- 5. Retention helper
--------------------------------------------------------------------------------
-- Idempotency keys are a replay guard, not a record. They expire.

CREATE OR REPLACE FUNCTION stockpilot_purge_expired() RETURNS void AS $$
BEGIN
  DELETE FROM idempotency_keys WHERE expires_at < now();
  DELETE FROM sessions WHERE expires_at < now();
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION stockpilot_purge_expired() IS
  'Removes expired idempotency keys and sessions. Run hourly; see docs/OPERATIONS.md.';
