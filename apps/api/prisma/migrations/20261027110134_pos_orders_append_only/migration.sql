-- Kitchen tickets and order lines are append-only (CLAUDE.md rule 7, docs/modules/pos.md → Step 3), like audit_logs
-- (ADR 0008 §6): durby_app lost UPDATE/DELETE/TRUNCATE in pos_orders; these statement-level triggers also stop the
-- owner. A catalog test (test/support/append-only.ts) fails if a trigger is dropped or disabled.
CREATE FUNCTION pos_append_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER pos_kitchen_tickets_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "pos_kitchen_tickets"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_append_only();

CREATE TRIGGER pos_order_lines_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "pos_order_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_append_only();
