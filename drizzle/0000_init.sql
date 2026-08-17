CREATE TYPE "public"."autonomy_level" AS ENUM('monitor', 'propose', 'act_within_limits', 'act');--> statement-breakpoint
CREATE TYPE "public"."decision_kind" AS ENUM('REPLENISH', 'HOLD_REPLENISHMENT', 'TRANSFER', 'MARKDOWN', 'WRITE_OFF', 'COUNT', 'ALERT');--> statement-breakpoint
CREATE TYPE "public"."decision_state" AS ENUM('proposed', 'approved', 'rejected', 'executed', 'blocked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."movement_kind" AS ENUM('RECEIPT', 'ISSUE', 'RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'SCRAP', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_state" AS ENUM('draft', 'placed', 'part_received', 'received', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."stock_unit" AS ENUM('each', 'g', 'ml', 'cm');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'planner', 'operator', 'viewer');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"skus_evaluated" integer DEFAULT 0 NOT NULL,
	"decisions_proposed" integer DEFAULT 0 NOT NULL,
	"decisions_executed" integer DEFAULT 0 NOT NULL,
	"decisions_blocked" integer DEFAULT 0 NOT NULL,
	"value_committed" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'operator' NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_demand" (
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"day" date NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"run_id" uuid,
	"sku_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" "decision_kind" NOT NULL,
	"state" "decision_state" DEFAULT 'proposed' NOT NULL,
	"quantity" integer,
	"value" integer DEFAULT 0 NOT NULL,
	"expected_benefit" integer DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'GBP' NOT NULL,
	"confidence" real NOT NULL,
	"severity" text NOT NULL,
	"rationale" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gate_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"method" text NOT NULL,
	"demand_pattern" text NOT NULL,
	"daily_rate" real NOT NULL,
	"residual_std_dev" real NOT NULL,
	"mase" real,
	"confidence" real NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"horizon_days" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"code" text NOT NULL,
	"expires_on" date,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) DEFAULT 'GBP' NOT NULL,
	"timezone" text DEFAULT 'Europe/London' NOT NULL,
	"autonomy" "autonomy_level" DEFAULT 'propose' NOT NULL,
	"max_auto_value" integer DEFAULT 25000 NOT NULL,
	"max_daily_auto_value" integer DEFAULT 250000 NOT NULL,
	"min_confidence" real DEFAULT 0.6 NOT NULL,
	"agent_paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"quantity_ordered" integer NOT NULL,
	"quantity_received" integer DEFAULT 0 NOT NULL,
	"unit_cost" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"state" "purchase_order_state" DEFAULT 'draft' NOT NULL,
	"decision_id" uuid,
	"total_value" integer DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'GBP' NOT NULL,
	"expected_at" date,
	"placed_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"transfers_enabled" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sku_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"abc_class" char(1),
	"xyz_class" char(1),
	"service_level_override" real,
	"autonomy_override" "autonomy_level",
	"reorder_point" integer,
	"safety_stock" integer,
	"order_up_to_level" integer,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"on_order" integer DEFAULT 0 NOT NULL,
	"last_issued_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"stock_unit" "stock_unit" DEFAULT 'each' NOT NULL,
	"unit_cost" integer NOT NULL,
	"unit_price" integer NOT NULL,
	"currency" char(3) DEFAULT 'GBP' NOT NULL,
	"perishable" boolean DEFAULT false NOT NULL,
	"shelf_life_days" integer,
	"supplier_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"lot_id" uuid,
	"kind" "movement_kind" NOT NULL,
	"quantity" integer NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"decision_id" uuid,
	"idempotency_key" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"on_hand" integer NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"movement_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"nominal_lead_time_days" integer DEFAULT 7 NOT NULL,
	"minimum_order_quantity" integer DEFAULT 1 NOT NULL,
	"order_multiple" integer DEFAULT 1 NOT NULL,
	"ordering_cost" integer DEFAULT 2500 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_demand" ADD CONSTRAINT "daily_demand_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_demand" ADD CONSTRAINT "daily_demand_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_demand" ADD CONSTRAINT "daily_demand_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_sites" ADD CONSTRAINT "sku_sites_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_sites" ADD CONSTRAINT "sku_sites_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_sites" ADD CONSTRAINT "sku_sites_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_snapshots" ADD CONSTRAINT "stock_snapshots_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_snapshots" ADD CONSTRAINT "stock_snapshots_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_snapshots" ADD CONSTRAINT "stock_snapshots_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_org_idx" ON "agent_runs" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "audit_org_time_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_demand_unique_idx" ON "daily_demand" USING btree ("sku_id","site_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_fingerprint_idx" ON "decisions" USING btree ("org_id","fingerprint");--> statement-breakpoint
CREATE INDEX "decisions_queue_idx" ON "decisions" USING btree ("org_id","state","created_at");--> statement-breakpoint
CREATE INDEX "decisions_sku_idx" ON "decisions" USING btree ("sku_id","site_id");--> statement-breakpoint
CREATE INDEX "forecasts_lookup_idx" ON "forecasts" USING btree ("sku_id","site_id","computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_unique_idx" ON "idempotency_keys" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "lots_sku_site_idx" ON "lots" USING btree ("sku_id","site_id");--> statement-breakpoint
CREATE INDEX "lots_expiry_idx" ON "lots" USING btree ("org_id","expires_on");--> statement-breakpoint
CREATE INDEX "po_lines_order_idx" ON "purchase_order_lines" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "po_org_reference_idx" ON "purchase_orders" USING btree ("org_id","reference");--> statement-breakpoint
CREATE INDEX "po_state_idx" ON "purchase_orders" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_org_code_idx" ON "sites" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "sku_sites_unique_idx" ON "sku_sites" USING btree ("sku_id","site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skus_org_code_idx" ON "skus" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "skus_org_active_idx" ON "skus" USING btree ("org_id","active");--> statement-breakpoint
CREATE INDEX "movements_sku_site_time_idx" ON "stock_movements" USING btree ("sku_id","site_id","occurred_at");--> statement-breakpoint
CREATE INDEX "movements_org_time_idx" ON "stock_movements" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "movements_idempotency_idx" ON "stock_movements" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "snapshots_lookup_idx" ON "stock_snapshots" USING btree ("sku_id","site_id","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_org_code_idx" ON "suppliers" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_email_idx" ON "users" USING btree ("org_id","email");