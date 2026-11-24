-- Floor plans per area (ADR 0073). Expand only: two new tables; a rollback needs nothing.

-- CreateTable
CREATE TABLE "pos_floor_plan_versions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "area_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "restored_from" INTEGER,
    "layout" JSONB NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_floor_plan_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_floor_plan_publications" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "seq" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "area_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_floor_plan_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_floor_plan_versions_tenant_id_id_key" ON "pos_floor_plan_versions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_floor_plan_versions_tenant_id_area_id_version_key" ON "pos_floor_plan_versions"("tenant_id", "area_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "pos_floor_plan_versions_tenant_id_location_id_area_id_id_key" ON "pos_floor_plan_versions"("tenant_id", "location_id", "area_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_floor_plan_publications_seq_key" ON "pos_floor_plan_publications"("seq");

-- CreateIndex
CREATE INDEX "pos_floor_plan_publications_tenant_id_area_id_seq_idx" ON "pos_floor_plan_publications"("tenant_id", "area_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "pos_floor_plan_publications_tenant_id_id_key" ON "pos_floor_plan_publications"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "pos_floor_plan_versions" ADD CONSTRAINT "pos_floor_plan_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_floor_plan_versions" ADD CONSTRAINT "pos_floor_plan_versions_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_floor_plan_publications" ADD CONSTRAINT "pos_floor_plan_publications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_floor_plan_publications" ADD CONSTRAINT "pos_floor_plan_publications_tenant_id_location_id_area_id__fkey" FOREIGN KEY ("tenant_id", "location_id", "area_id", "version_id") REFERENCES "pos_floor_plan_versions"("tenant_id", "location_id", "area_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE "pos_floor_plan_versions" ADD CONSTRAINT "pos_floor_plan_versions_check"
  CHECK ("version" >= 1 AND ("restored_from" IS NULL OR "restored_from" BETWEEN 1 AND "version" - 1));
ALTER TABLE "pos_floor_plan_versions" ADD CONSTRAINT "pos_floor_plan_versions_layout_check"
  CHECK (jsonb_typeof("layout") = 'object' AND octet_length("layout"::text) <= 100000);

-- Append-only (CLAUDE.md rule 7): a change is a new version, publishing is a new publication.
REVOKE UPDATE, DELETE, TRUNCATE ON "pos_floor_plan_versions", "pos_floor_plan_publications" FROM durby_app;
CREATE TRIGGER pos_floor_plan_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "pos_floor_plan_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_append_only();
CREATE TRIGGER pos_floor_plan_publications_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "pos_floor_plan_publications"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_append_only();

-- Row-level security (ADR 0005).
ALTER TABLE "pos_floor_plan_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_floor_plan_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_floor_plan_versions"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "pos_floor_plan_publications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_floor_plan_publications" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_floor_plan_publications"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
