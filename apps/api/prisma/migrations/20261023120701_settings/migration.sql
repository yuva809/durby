-- CreateEnum
CREATE TYPE "setting_scope_type" AS ENUM ('organization', 'brand', 'location');

-- CreateTable
CREATE TABLE "partner_setting_values" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "partner_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_setting_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting_values" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "scope_type" "setting_scope_type" NOT NULL,
    "brand_id" UUID,
    "location_id" UUID,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "setting_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partner_setting_values_partner_id_key_key" ON "partner_setting_values"("partner_id", "key");

-- CreateIndex
CREATE INDEX "setting_values_tenant_id_brand_id_idx" ON "setting_values"("tenant_id", "brand_id");

-- CreateIndex
CREATE INDEX "setting_values_tenant_id_location_id_idx" ON "setting_values"("tenant_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "setting_values_tenant_id_id_key" ON "setting_values"("tenant_id", "id");

-- CreateIndex
-- One value per key and scope (ADR 0010 §3). The unused scope columns are NULL, so NULLS NOT DISTINCT
-- (Prisma can't express it; the schema's @@unique names this index).
CREATE UNIQUE INDEX "setting_values_scope_key_key" ON "setting_values"("tenant_id", "scope_type", "brand_id", "location_id", "key") NULLS NOT DISTINCT;

-- AddForeignKey
ALTER TABLE "partner_setting_values" ADD CONSTRAINT "partner_setting_values_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_tenant_id_brand_id_fkey" FOREIGN KEY ("tenant_id", "brand_id") REFERENCES "brands"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Shape checks (ADR 0010). Keys, scopes per key and values are validated against the registry in
-- packages/shared by the api; SQL checks only the shape, like feature and permission keys.
ALTER TABLE "partner_setting_values" ADD CONSTRAINT "partner_setting_values_key_format_check"
  CHECK ("key" ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$');
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_key_format_check"
  CHECK ("key" ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$');
-- A JSON null is not a value: delete the row to inherit.
ALTER TABLE "partner_setting_values" ADD CONSTRAINT "partner_setting_values_value_check"
  CHECK (jsonb_typeof("value") <> 'null');
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_value_check"
  CHECK (jsonb_typeof("value") <> 'null');
-- Exactly the scope's own column is set (no polymorphic scope id).
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_scope_check" CHECK (
  ("scope_type" = 'organization' AND "brand_id" IS NULL AND "location_id" IS NULL) OR
  ("scope_type" = 'brand' AND "brand_id" IS NOT NULL AND "location_id" IS NULL) OR
  ("scope_type" = 'location' AND "location_id" IS NOT NULL AND "brand_id" IS NULL));

-- Row-level security (ADR 0005).
ALTER TABLE "setting_values" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "setting_values" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "setting_values"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Partner values are read-only for the app (ADR 0010 §2): they change only through reviewed
-- migrations. The default privileges of ADR 0002 grant DML to durby_app; take back everything but
-- SELECT. A catalog test guards this.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "partner_setting_values" FROM durby_app;
