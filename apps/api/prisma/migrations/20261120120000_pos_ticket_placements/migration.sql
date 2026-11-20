-- CreateTable
CREATE TABLE "pos_ticket_placements" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "seq" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_ticket_placements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_ticket_placements_seq_key" ON "pos_ticket_placements"("seq");

-- CreateIndex
CREATE INDEX "pos_ticket_placements_tenant_id_ticket_id_seq_idx" ON "pos_ticket_placements"("tenant_id", "ticket_id", "seq");

-- CreateIndex
CREATE INDEX "pos_ticket_placements_tenant_id_order_id_idx" ON "pos_ticket_placements"("tenant_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_ticket_placements_tenant_id_id_key" ON "pos_ticket_placements"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "pos_ticket_placements" ADD CONSTRAINT "pos_ticket_placements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_ticket_placements" ADD CONSTRAINT "pos_ticket_placements_tenant_id_ticket_id_fkey" FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "pos_kitchen_tickets"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_ticket_placements" ADD CONSTRAINT "pos_ticket_placements_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "pos_orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Backfill (ADR 0069): every existing ticket starts in the order it was sent to. Per tenant with app.tenant_id set
-- (local to this transaction), so FORCE RLS stays on. Runs before the trigger below exists, so no row is written twice.
DO $$
DECLARE
  org RECORD;
BEGIN
  FOR org IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.tenant_id', org.id::text, true);
    INSERT INTO pos_ticket_placements (tenant_id, ticket_id, order_id, created_by_user_id, created_at)
      SELECT t.tenant_id, t.id, t.order_id, t.created_by_user_id, t.created_at
      FROM pos_kitchen_tickets t
      WHERE t.tenant_id = org.id
      ORDER BY t.created_at, t.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- Every new ticket gets its first placement from the database, so a ticket written by an older release (which
-- does not write placements itself) is placed too while both releases run (ADR 0004).
CREATE FUNCTION pos_ticket_first_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pos_ticket_placements (tenant_id, ticket_id, order_id, created_by_user_id, created_at)
  VALUES (NEW.tenant_id, NEW.id, NEW.order_id, NEW.created_by_user_id, NEW.created_at);
  RETURN NULL;
END
$$;
CREATE TRIGGER pos_kitchen_tickets_first_placement
  AFTER INSERT ON pos_kitchen_tickets
  FOR EACH ROW EXECUTE FUNCTION pos_ticket_first_placement();

-- Append-only (CLAUDE.md rule 7): a move adds a placement, it never changes one.
REVOKE UPDATE, DELETE, TRUNCATE ON "pos_ticket_placements" FROM durby_app;
CREATE TRIGGER pos_ticket_placements_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "pos_ticket_placements"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_append_only();

-- Row-level security (ADR 0005).
ALTER TABLE "pos_ticket_placements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_ticket_placements" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_ticket_placements"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
