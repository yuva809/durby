-- Table QR menu and kitchen/bar screens (docs/modules/pos.md → QR menu, Kitchen and bar screens, ADR 0026).

-- QR menu token: 24 URL-safe characters from two random UUIDs. A function, so the column default is one call
-- (schema.prisma declares it as dbgenerated("pos_new_menu_token()")). Added nullable, backfilled, then required;
-- the default covers inserts by older releases.
CREATE FUNCTION pos_new_menu_token()
  RETURNS text
  LANGUAGE sql
  VOLATILE
  SET search_path = pg_catalog
AS $$
  SELECT left(translate(encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/=', '-_'), 24)
$$;
-- Column defaults run as the inserting role; new functions aren't executable by PUBLIC (auth migration).
GRANT EXECUTE ON FUNCTION pos_new_menu_token() TO durby_app;

ALTER TABLE "dining_tables" ADD COLUMN "menu_token" TEXT;
ALTER TABLE "dining_tables" ALTER COLUMN "menu_token" SET DEFAULT pos_new_menu_token();
DO $$
DECLARE
  org RECORD;
BEGIN
  FOR org IN SELECT id FROM organizations ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', org.id::text, true);
    UPDATE "dining_tables"
      SET "menu_token" = pos_new_menu_token()
      WHERE "menu_token" IS NULL;
    INSERT INTO roles (tenant_id, system_key, updated_at)
      VALUES (org.id, 'kitchen'::system_role, now()), (org.id, 'bar'::system_role, now())
      ON CONFLICT (tenant_id, system_key) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
ALTER TABLE "dining_tables" ALTER COLUMN "menu_token" SET NOT NULL;
CREATE UNIQUE INDEX "dining_tables_tenant_id_menu_token_key" ON "dining_tables"("tenant_id", "menu_token");

-- CreateEnum
CREATE TYPE "pos_ticket_status" AS ENUM ('preparing', 'ready', 'served');

-- CreateTable
CREATE TABLE "pos_ticket_status_changes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "status" "pos_ticket_status" NOT NULL,
    "changed_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_ticket_status_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pos_ticket_status_changes_tenant_id_ticket_id_created_at_idx" ON "pos_ticket_status_changes"("tenant_id", "ticket_id", "created_at");
CREATE UNIQUE INDEX "pos_ticket_status_changes_tenant_id_id_key" ON "pos_ticket_status_changes"("tenant_id", "id");

ALTER TABLE "pos_ticket_status_changes" ADD CONSTRAINT "pos_ticket_status_changes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pos_ticket_status_changes" ADD CONSTRAINT "pos_ticket_status_changes_tenant_id_ticket_id_fkey" FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "pos_kitchen_tickets"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- History (CLAUDE.md rule 7): append-only like the tickets themselves (test/support/append-only.ts).
CREATE TRIGGER pos_ticket_status_changes_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "pos_ticket_status_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_append_only();
REVOKE UPDATE, DELETE, TRUNCATE ON "pos_ticket_status_changes" FROM durby_app;

-- Row-level security (ADR 0005).
ALTER TABLE "pos_ticket_status_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_ticket_status_changes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_ticket_status_changes"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
