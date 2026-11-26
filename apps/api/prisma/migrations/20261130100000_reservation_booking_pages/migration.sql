-- Online booking pages (R2.1, ADR 0085). Expand only: one new table and one allow-listed definer function; a rollback
-- needs nothing.

-- CreateTable
CREATE TABLE "reservation_booking_pages" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reservation_booking_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservation_booking_pages_slug_key" ON "reservation_booking_pages"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_booking_pages_tenant_id_id_key" ON "reservation_booking_pages"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_booking_pages_tenant_id_location_id_key" ON "reservation_booking_pages"("tenant_id", "location_id");

-- AddForeignKey
ALTER TABLE "reservation_booking_pages" ADD CONSTRAINT "reservation_booking_pages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservation_booking_pages" ADD CONSTRAINT "reservation_booking_pages_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE "reservation_booking_pages" ADD CONSTRAINT "reservation_booking_pages_slug_check"
  CHECK (char_length("slug") BETWEEN 3 AND 60 AND "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- Row-level security (ADR 0005).
ALTER TABLE "reservation_booking_pages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservation_booking_pages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reservation_booking_pages"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The only cross-tenant read (ADR 0085, allow-listed per ADR 0006): a public request knows a slug, never an
-- organization. Returns the page's organization, location and whether it is on; nothing else. Owned by
-- durby_rls_definer, which bypasses RLS and may read only these columns.
GRANT SELECT ("slug", "tenant_id", "location_id", "enabled") ON "reservation_booking_pages" TO durby_rls_definer;
GRANT CREATE ON SCHEMA public TO durby_rls_definer;
SET ROLE durby_rls_definer;

CREATE FUNCTION booking_page_by_slug(p_slug text)
  RETURNS TABLE (tenant_id uuid, location_id uuid, enabled boolean)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT p.tenant_id, p.location_id, p.enabled
  FROM public.reservation_booking_pages p
  WHERE p.slug = p_slug
$$;
REVOKE ALL ON FUNCTION booking_page_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking_page_by_slug(text) TO durby_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM durby_rls_definer;
