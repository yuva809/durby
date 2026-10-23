-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "plan_id" UUID;

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_features" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "plan_id" UUID NOT NULL,
    "feature_key" TEXT NOT NULL,
    "limits" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plan_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_feature_overrides" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "feature_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "limits" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_feature_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_key_key" ON "plans"("key");

-- CreateIndex
CREATE UNIQUE INDEX "plan_features_plan_id_feature_key_key" ON "plan_features"("plan_id", "feature_key");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_feature_overrides_tenant_id_id_key" ON "tenant_feature_overrides"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_feature_overrides_tenant_id_feature_key_key" ON "tenant_feature_overrides"("tenant_id", "feature_key");

-- CreateIndex
CREATE INDEX "organizations_plan_id_idx" ON "organizations"("plan_id");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_feature_overrides" ADD CONSTRAINT "tenant_feature_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Shape checks (ADR 0009). Feature keys and limits are validated against the registry in packages/shared by the
-- api; SQL checks only the shape, like permission and audit keys.
ALTER TABLE "plans" ADD CONSTRAINT "plans_key_format_check" CHECK ("key" ~ '^[a-z][a-z0-9_]*$');
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_feature_key_format_check"
  CHECK ("feature_key" ~ '^[a-z]+(\.[a-z_]+)*$');
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_limits_check"
  CHECK ("limits" IS NULL OR jsonb_typeof("limits") = 'object');
ALTER TABLE "tenant_feature_overrides" ADD CONSTRAINT "tenant_feature_overrides_feature_key_format_check"
  CHECK ("feature_key" ~ '^[a-z]+(\.[a-z_]+)*$');
-- Limits only on an enabling override.
ALTER TABLE "tenant_feature_overrides" ADD CONSTRAINT "tenant_feature_overrides_limits_check"
  CHECK ("limits" IS NULL OR ("enabled" AND jsonb_typeof("limits") = 'object'));

-- Row-level security (ADR 0005).
ALTER TABLE "tenant_feature_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_feature_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_feature_overrides"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Plans are read-only for the app (ADR 0009 §2): contents change only through reviewed migrations. The default
-- privileges of ADR 0002 grant DML to durby_app; take back everything but SELECT. A catalog test guards this.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "plans", "plan_features" FROM durby_app;

-- Seed plans (docs/platform/entitlements.md → Seeded plans). Keys match PLAN_KEYS in packages/shared.
INSERT INTO "plans" ("key", "name", "updated_at") VALUES
  ('inventory', 'Inventory', now()),
  ('inventory_billing', 'Inventory + Billing', now()),
  ('full', 'Full', now());

INSERT INTO "plan_features" ("plan_id", "feature_key", "updated_at")
SELECT p."id", f.feature_key, now()
FROM "plans" p
JOIN (VALUES
  ('inventory', 'inventory'), ('inventory', 'inventory.counts'),
  ('inventory', 'inventory.purchasing'), ('inventory', 'reports'),
  ('inventory_billing', 'inventory'), ('inventory_billing', 'inventory.counts'),
  ('inventory_billing', 'inventory.purchasing'), ('inventory_billing', 'reports'),
  ('inventory_billing', 'billing'), ('inventory_billing', 'billing.einvoice'),
  ('full', 'inventory'), ('full', 'inventory.counts'), ('full', 'inventory.purchasing'),
  ('full', 'reports'), ('full', 'billing'), ('full', 'billing.einvoice'),
  ('full', 'pos'), ('full', 'pos.fiscal'), ('full', 'api.public'), ('full', 'whitelabel')
) AS f(plan_key, feature_key) ON p."key" = f.plan_key;

-- Backfill (expand/contract, ADR 0004): existing organizations (e.g. staging's Durby Demo) get "full", with an
-- audit row each (actor `migration`, snapshot fields as in audit-snapshots.ts). Runs per tenant with app.tenant_id
-- set (local to this transaction), so FORCE RLS on audit_logs stays on.
DO $$
DECLARE
  org record;
  full_id uuid;
BEGIN
  SELECT "id" INTO STRICT full_id FROM "plans" WHERE "key" = 'full';
  FOR org IN SELECT "id" FROM "organizations" WHERE "plan_id" IS NULL ORDER BY "id" LOOP
    PERFORM set_config('app.tenant_id', org.id::text, true);
    UPDATE "organizations" SET "plan_id" = full_id WHERE "id" = org.id;
    INSERT INTO "audit_logs"
      ("tenant_id", "actor_type", "actor_system", "action", "entity_type", "entity_id", "before", "after")
    VALUES
      (org.id, 'system', 'migration', 'platform.organization.plan_changed', 'organization', org.id,
       jsonb_build_object('id', org.id, 'planId', NULL),
       jsonb_build_object('id', org.id, 'planId', full_id));
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
