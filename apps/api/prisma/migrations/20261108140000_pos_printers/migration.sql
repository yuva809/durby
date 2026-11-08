-- Printers as a list per location (ADR 0033): each printer prints bills and/or the tickets of chosen stations. Expand
-- only: two new tables, a nullable column on pos_printer_commands, and a copy of each location's version 1 bill printer
-- (setting pos.printers) into a row. The setting stays as it is, so the previous release still prints bills.

-- CreateTable
CREATE TABLE "pos_printers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "width_dots" INTEGER NOT NULL,
    "cutter" BOOLEAN NOT NULL,
    "image_mode" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "prints_bills" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pos_printers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_printer_stations" (
    "tenant_id" UUID NOT NULL,
    "printer_id" UUID NOT NULL,
    "station_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_printer_stations_pkey" PRIMARY KEY ("tenant_id", "printer_id", "station_key")
);

-- AlterTable
ALTER TABLE "pos_printer_commands" ADD COLUMN "printer_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "pos_printers_tenant_id_id_key" ON "pos_printers"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "pos_printers_tenant_id_location_id_idx" ON "pos_printers"("tenant_id", "location_id");

-- CreateIndex
CREATE INDEX "pos_printer_stations_tenant_id_station_key_idx" ON "pos_printer_stations"("tenant_id", "station_key");

-- AddForeignKey
ALTER TABLE "pos_printers" ADD CONSTRAINT "pos_printers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_printers" ADD CONSTRAINT "pos_printers_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_printer_stations" ADD CONSTRAINT "pos_printer_stations_tenant_id_printer_id_fkey" FOREIGN KEY ("tenant_id", "printer_id") REFERENCES "pos_printers"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_printer_commands" ADD CONSTRAINT "pos_printer_commands_tenant_id_printer_id_fkey" FOREIGN KEY ("tenant_id", "printer_id") REFERENCES "pos_printers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

-- The same rules as the api and the Android app (ADR 0032): a private IPv4 literal, ports 9100–9102, whole bytes.
ALTER TABLE "pos_printers" ADD CONSTRAINT "pos_printers_host_check"
  CHECK ("host" ~ '^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$');
ALTER TABLE "pos_printers" ADD CONSTRAINT "pos_printers_port_check" CHECK ("port" BETWEEN 9100 AND 9102);
ALTER TABLE "pos_printers" ADD CONSTRAINT "pos_printers_width_check"
  CHECK ("width_dots" BETWEEN 8 AND 2040 AND "width_dots" % 8 = 0);
ALTER TABLE "pos_printers" ADD CONSTRAINT "pos_printers_image_mode_check" CHECK ("image_mode" IN ('gsV0', 'escStar'));
ALTER TABLE "pos_printers" ADD CONSTRAINT "pos_printers_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 60);
-- Names tell printers apart at a location: unique among the printers that aren't archived.
CREATE UNIQUE INDEX "pos_printers_location_name_key" ON "pos_printers"("tenant_id", "location_id", lower("name"))
  WHERE "archived_at" IS NULL;

-- Station keys (ADR 0033): today's two stations. "Stations as a list" replaces this CHECK with a foreign key to its
-- table, whose keys include these, without touching printers.
ALTER TABLE "pos_printer_stations" ADD CONSTRAINT "pos_printer_stations_station_key_check"
  CHECK ("station_key" IN ('kitchen', 'bar'));

-- A test print names its printer (checked by the api). No CHECK yet: the previous release still inserts test prints
-- without one; the contract step that drops pos.printers adds it.

-- Row-level security (ADR 0005).
ALTER TABLE "pos_printers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_printers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_printers"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "pos_printer_stations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_printer_stations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_printer_stations"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Printers are archived, never deleted: print jobs and audit entries keep pointing at them (a location's own deletion
-- cascades as the owner). A printer's stations are replaced when it is edited, so those rows may be deleted.
REVOKE DELETE, TRUNCATE ON "pos_printers" FROM durby_app;
REVOKE TRUNCATE ON "pos_printer_stations" FROM durby_app;

-- Version 1's bill printer → one row per location (ADR 0033): the value the location resolves today (location, then
-- brand, then organization; partner values hold no printers). It already prints bills, so the row is on and prints
-- bills; its name is its address, since stored names can't be labels (rename it in Settings → Printers). A value that
-- fails today's rules is skipped, as the api skips it. Per tenant with app.tenant_id set, so FORCE RLS stays on;
-- every row audited as the migration. Idempotent: a location that already has a printer is left alone.
DO $$
DECLARE
  org record;
  printer record;
BEGIN
  FOR org IN SELECT "id" FROM "organizations" ORDER BY "id" LOOP
    PERFORM set_config('app.tenant_id', org."id"::text, true);
    FOR printer IN
      WITH effective AS (
        SELECT l."id" AS location_id, v."value"->'bill' AS bill
        FROM "locations" l
        CROSS JOIN LATERAL (
          SELECT sv."value"
          FROM "setting_values" sv
          WHERE sv."tenant_id" = l."tenant_id" AND sv."key" = 'pos.printers'
            AND ((sv."scope_type" = 'location' AND sv."location_id" = l."id")
              OR (sv."scope_type" = 'brand' AND sv."brand_id" = l."brand_id")
              OR sv."scope_type" = 'organization')
          ORDER BY CASE sv."scope_type" WHEN 'location' THEN 1 WHEN 'brand' THEN 2 ELSE 3 END
          LIMIT 1
        ) v
        WHERE l."tenant_id" = org."id"
      )
      INSERT INTO "pos_printers"
        ("tenant_id", "location_id", "name", "host", "port", "width_dots", "cutter", "image_mode", "enabled",
         "prints_bills", "updated_at")
      SELECT org."id", e.location_id, (e.bill->>'host') || ':' || (e.bill->>'port'), e.bill->>'host',
             (e.bill->>'port')::int, (e.bill->>'widthDots')::int, (e.bill->>'cutter')::boolean, e.bill->>'imageMode',
             true, true, now()
      FROM effective e
      WHERE jsonb_typeof(e.bill) = 'object'
        AND e.bill->>'host' ~ '^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$'
        AND e.bill->>'port' IN ('9100', '9101', '9102')
        AND e.bill->>'widthDots' ~ '^\d{1,4}$' AND (e.bill->>'widthDots')::int BETWEEN 8 AND 2040
        AND (e.bill->>'widthDots')::int % 8 = 0
        AND jsonb_typeof(e.bill->'cutter') = 'boolean'
        AND e.bill->>'imageMode' IN ('gsV0', 'escStar')
        AND NOT EXISTS (SELECT 1 FROM "pos_printers" p WHERE p."tenant_id" = org."id" AND p."location_id" = e.location_id)
      RETURNING *
    LOOP
      INSERT INTO "audit_logs"
        ("tenant_id", "actor_type", "actor_system", "action", "entity_type", "entity_id", "after")
      VALUES
        (org."id", 'system', 'migration', 'pos.printer.created', 'printer', printer."id",
         jsonb_build_object('id', printer."id", 'locationId', printer."location_id", 'name', printer."name", 'host', printer."host",
           'port', printer."port", 'widthDots', printer."width_dots", 'cutter', printer."cutter", 'imageMode', printer."image_mode",
           'enabled', printer."enabled", 'printsBills', printer."prints_bills", 'stations', '[]'::jsonb,
           'archivedAt', NULL));
    END LOOP;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
